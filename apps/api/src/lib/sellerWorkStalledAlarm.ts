import { prisma } from "../db.js";
import { sellersWithPropertyInWork } from "./sellerCardState.js";
import { evaluateWorkStalled } from "./clientWorkStalled.js";
import { calendarFor, loadCompanyDaysOff } from "./daysOffCalendar.js";
import {
  loadWorkWindow,
  outagesBetween,
  workingOutageMs,
} from "./stationOutage.js";

/**
 * «АГЕНТ САМ ПЕРЕСТАЛ ПЫТАТЬСЯ» — читатель вердикта, которого не было (владелец
 * 16.09.2026: «согласен, но слишком долгие паузы не делай — решить всё максимум
 * за 2-3 дня»).
 *
 * ЧТО ЭТО ЗАКРЫВАЕТ. Отметка попытки агента (Client.lastAgentAttemptAt) писалась из
 * трёх мест, вердикт «работа встала» (lib/clientWorkStalled.ts) был написан и покрыт
 * тестами — а читать его было НЕКОМУ: ни один тик не спрашивал, встала ли работа.
 * Фундамент контроля из docs/voronka-prodavca-08-09-2026.md ни разу не сработал.
 *
 * Дыру видно на обычном случае. Продавец звонит сам; агент принимает лид и
 * перезванивает в срок — штрафа нет. Разговор ни к чему не обязывающий, даты не
 * называли, поэтому ИИ её не услышал. Номер агент не спрашивал — клиент позвонил
 * сам. Клиент больше не пишет. Ни один из трёх существующих крючков не взведён:
 *
 *   - «продавец написал, агент молчит» требует сообщения КЛИЕНТА;
 *   - «похоже на увод в обход CRM» требует, чтобы агент спросил номер;
 *   - «продавец без объекта» требует услышанной даты приёмки.
 *
 * Карточка живёт активной вечно. В светофор она не попадёт: светофор работает с
 * теми, кого уже перевели в «Неактивные», а перевести её некому.
 *
 * ЛЕСЕНКА, А НЕ ОДИН УДАР. Владелец одобрил тот же порядок, что в антифрод-воронке:
 * дешёвый порог раньше дорогого, и весь случай закрывается за три дня.
 *
 *   2 рабочих дня без попытки → ПУШ АГЕНТУ. Половина случаев — агент просто забыл,
 *                                и здесь всё заканчивается, до владельца не дойдя.
 *   3 рабочих дня без попытки → строка ВЛАДЕЛЬЦУ, но только после ИИ-проверки, не
 *                                объяснил ли клиент паузу сам.
 *
 * ОДНО УВЕДОМЛЕНИЕ НА ЧЕЛОВЕКА В ДЕНЬ, А НЕ НА КАРТОЧКУ. Агент с восемью забытыми
 * карточками получает один пуш со списком, владелец — одну строку со сводкой. Иначе
 * первое же утро после выката даёт пачку одинаковых уведомлений, их перестают
 * читать, и механизм умирает не от ошибки, а от шума. Дедуп держится на tag с датой
 * по Душанбе: тик ходит каждый час, а пишет по разу в сутки.
 *
 * ЧЕГО ТУТ НАМЕРЕННО НЕТ. Автопередачи карточки нет: решение забрать продавца у
 * агента — владельца, а не тика. Вторая ступень уже существует отдельно для другого
 * случая (lib/unansweredAutoTransfer.ts), и смешивать их значило бы отнимать
 * клиента за то, что агент два дня не звонил.
 */

/** Сколько рабочих дней тишины — повод написать САМОМУ агенту. */
export const STALLED_AGENT_WORKING_DAYS = 2;
/** Сколько — повод дойти до владельца. Дальше этого случай не тянется. */
export const STALLED_DIRECTOR_WORKING_DAYS = 3;

interface StalledCard {
  id: string;
  shortId: number;
  fullName: string;
  agentId: string;
  agentName: string;
  workingDaysSilent: number;
}

/**
 * Собрать продавцов, по которым работа встала. Отдельно от рассылки, чтобы дашборд
 * владельца мог показать тот же список, не заводя вторую копию правила, — тот же
 * приём, что у findUnansweredSellers.
 */
export async function findStalledSellers(
  now: Date = new Date(),
): Promise<StalledCard[]> {
  const candidates = await prisma.client.findMany({
    where: {
      // dualIntent: человек мог числиться покупателем, но всё ещё продаёт свою
      // квартиру — этот тик обязан видеть и его (то же правило, что в аларме
      // «заявлено N, сделано M»).
      OR: [{ kind: "SELLER" }, { dualIntent: true }],
      workStatus: "ACTIVE",
      deletedAt: null,
      status: { notIn: ["LOST", "ARCHIVED", "DEAL_CLOSED"] },
      assignedAgentId: { not: null },
    },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      assignedAgentId: true,
      assignedAgent: { select: { fullName: true, weeklyDaysOff: true } },
      lastAgentAttemptAt: true,
      lastClientMessageAt: true,
      acceptedAt: true,
      assignedAt: true,
      createdAt: true,
    },
    take: 500,
  });
  if (candidates.length === 0) return [];

  /**
   * ОБЪЕКТ В ПРОДАЖЕ — РАБОТА ИДЁТ (владелец 23.09.2026). Агент предлагает объект
   * покупателям, звонить собственнику без повода незачем, и «продавец без
   * движения» про него — неправда.
   */
  const onSale = await sellersWithPropertyInWork(
    candidates.map((c) => c.id),
    { onSaleOnly: true },
  );

  /**
   * НАЗНАЧЕННЫЙ СЛЕДУЮЩИЙ ШАГ СНИМАЕТ ВОПРОС. Открытая задача или встреча на будущее
   * — это и есть работа: агент вправе молчать до своей же даты. Одним запросом на
   * весь тик, а не по карточке.
   */
  const planned = await prisma.interaction.findMany({
    where: {
      clientId: { in: candidates.map((c) => c.id) },
      completedAt: null,
      nextActionDate: { gt: now },
    },
    select: { clientId: true },
    distinct: ["clientId"],
  });
  const hasNextStep = new Set(planned.map((p) => p.clientId));

  // Простои станции — тоже одним запросом: в часы, когда звонить было физически
  // некуда, тишина агента ничего о нём не говорит (lib/stationOutage.ts).
  const earliest = candidates.reduce<Date>((min, c) => {
    const since = c.acceptedAt ?? c.assignedAt ?? c.createdAt;
    return since < min ? since : min;
  }, now);
  const [outages, workWindow, companyDaysOff] = await Promise.all([
    outagesBetween(earliest, now),
    loadWorkWindow(),
    // Выходные компании и агента карточки не идут в «тишину» (владелец 11.10.2026).
    loadCompanyDaysOff(),
  ]);

  const stalled: StalledCard[] = [];
  for (const c of candidates) {
    if (onSale.has(c.id)) continue;
    if (hasNextStep.has(c.id)) continue;
    const since = c.acceptedAt ?? c.assignedAt ?? c.createdAt;
    const from = [since, c.lastAgentAttemptAt, c.lastClientMessageAt]
      .filter((d): d is Date => d !== null)
      .reduce((a, b) => (a > b ? a : b));
    const calendar = calendarFor(companyDaysOff, c.assignedAgent);
    const verdict = evaluateWorkStalled(
      {
        since,
        lastAgentAttemptAt: c.lastAgentAttemptAt,
        lastClientMessageAt: c.lastClientMessageAt,
        outageMs: workingOutageMs(from, now, outages, workWindow, calendar),
        calendar,
      },
      now,
    );
    if (verdict.workingDaysSince < STALLED_AGENT_WORKING_DAYS) continue;
    stalled.push({
      id: c.id,
      shortId: c.shortId,
      fullName: c.fullName,
      agentId: c.assignedAgentId!,
      agentName: c.assignedAgent?.fullName ?? "",
      workingDaysSilent: verdict.workingDaysSince,
    });
  }
  // От самых запущенных к свежим: и в пуше агенту, и в сводке владельцу поимённо
  // называются те, где тишина дольше.
  return stalled.sort((a, b) => b.workingDaysSilent - a.workingDaysSilent);
}

/**
 * Рассылка убрана по решению владельца 02.10.2026: ни пуша агенту, ни строки
 * «Продавцы без движения» владельцу, ни ИИ-проверки «объяснил ли клиент паузу».
 * Вердикт остаётся в findStalledSellers (его читает дашборд). Заглушка нужна,
 * потому что cron.ts вызывает тик с прежней сигнатурой.
 */
export async function runSellerWorkStalledAlarmTick(
  _now: Date = new Date(),
): Promise<{
  pokedAgents: number;
  reportedToDirector: number;
  skipped: number;
}> {
  return { pokedAgents: 0, reportedToDirector: 0, skipped: 0 };
}
