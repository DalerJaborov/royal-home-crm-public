import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { createNotifications } from "./notifications.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { loadWorkWindow, outagesBetween, workingOutageMs } from "./stationOutage.js";
import { checkClientExplainedPause } from "../ai/offCrmPauseCheck.js";

/**
 * АЛАРМ «АГЕНТ, ПОХОЖЕ, УВЁЛ КЛИЕНТА В ОБХОД CRM» (владелец 07.09.2026).
 *
 * Триггер — ДВА события вместе, не одно: (1) агент спросил номер телефона
 * клиента (lib/agentPhoneAskDetector.ts помечает Client.phoneAskFlaggedAt,
 * БЕЗ немедленного пуша — «не нужно вмешиваться в онлайн»), и (2) ПОСЛЕ этого
 * что-то останавливается:
 *   A) Молчание — 2 дня без единого контакта через CRM (Client.lastContactAt),
 *      хотя клиент ещё «активный» (не потерян/не в архиве).
 *   B) Брошенная договорённость — была назначена встреча/показ на дату X
 *      (Interaction.nextActionDate), X+2 дня прошли, а исход не отмечен
 *      (completedAt=null) и не отменена (declinedAt=null) — то есть агент её
 *      просто не закрыл и не перенёс.
 *
 * ПЕРЕД тем как будить директора — ИИ-проверка (ai/offCrmPauseCheck.ts):
 * не объяснил ли САМ клиент паузу (отложил, заболел, гости, уехал, передумал).
 * Если объяснил — это не вина агента, аларма нет. Дополнительно: у пункта A
 * есть и more дешёвая, не-ИИ подстраховка — lastContactAt теперь двигается и
 * от ручного ответа агента в переписке (см. lib/conversationDelivery.ts,
 * правка 07.09.2026), и от ЛЮБОЙ заметки/интеракции, которую агент оставил
 * сам — то есть если агент оставил заметку-объяснение по клиенту, тишина уже
 * не тишина, до ИИ дело не доходит вовсе.
 *
 * Дедуп: Client.offCrmAlarmNotifiedAt — «этот конкретный случай (текущий
 * phoneAskFlaggedAt) уже разобран», не гонять дорогую ИИ-проверку повторно на
 * каждом тике, пока ситуация не изменилась. Новый, более поздний
 * phoneAskFlaggedAt (повторный вопрос про номер) делает отметку устаревшей —
 * аларм может сработать заново. Уведомление — tag `agent-off-crm-{clientId}`,
 * НЕ смешиваем с client-property-count: это разные по духу сигналы (доверие к
 * агенту vs операционный бэклог), смешивание в одной карточке прятало бы
 * тревожный случай среди рутинных «забыл добавить объект».
 *
 * Намеренно НЕ эскалируем в СБ и не считаем повторы на агента (владелец
 * 07.09.2026: «каждый случай важен, ждать несколько — то поздно, деньги уже
 * не маленькие») — каждый случай уходит директору сразу и отдельно.
 */
export const OFF_CRM_SILENCE_DAYS = 2;
const OFF_CRM_SILENCE_MS = OFF_CRM_SILENCE_DAYS * 24 * 60 * 60 * 1000;

const ACTIVE_CLIENT_FILTER: Prisma.ClientWhereInput = {
  workStatus: "ACTIVE",
  deletedAt: null,
  status: { notIn: ["LOST", "ARCHIVED", "DEAL_CLOSED"] },
  assignedAgentId: { not: null },
};

interface Candidate {
  id: string;
  shortId: number;
  fullName: string;
  lastContactAt: Date;
  phoneAskFlaggedAt: Date;
  assignedAgent: { fullName: string } | null;
}

async function findFrozenAppointment(clientId: string, cutoff: Date): Promise<boolean> {
  const overdue = await prisma.interaction.findFirst({
    where: {
      clientId,
      type: { in: ["MEETING", "SHOWING"] },
      nextAction: { not: null },
      nextActionDate: { lte: cutoff },
      completedAt: null, taskCancelledAt: null,
      declinedAt: null,
    },
    select: { id: true },
  });
  return overdue !== null;
}

export async function runAgentOffCrmAlarmTick(now: Date = new Date()): Promise<{ alerted: number; skipped: number }> {
  if (!(await isWithinAlarmHours(now))) return { alerted: 0, skipped: 0 };
  const silenceCutoff = new Date(now.getTime() - OFF_CRM_SILENCE_MS);

  const raw = await prisma.client.findMany({
    where: { phoneAskFlaggedAt: { not: null }, ...ACTIVE_CLIENT_FILTER },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      lastContactAt: true,
      phoneAskFlaggedAt: true,
      offCrmAlarmNotifiedAt: true,
      assignedAgent: { select: { fullName: true } },
    },
    take: 500,
  });

  // Уже разобранный случай (offCrmAlarmNotifiedAt свежее текущего флага) —
  // пропускаем без единого обращения к ИИ.
  const candidates: Candidate[] = raw
    .filter((c) => !c.offCrmAlarmNotifiedAt || c.offCrmAlarmNotifiedAt < c.phoneAskFlaggedAt!)
    .map((c) => ({
      id: c.id,
      shortId: c.shortId,
      fullName: c.fullName,
      lastContactAt: c.lastContactAt,
      phoneAskFlaggedAt: c.phoneAskFlaggedAt!,
      assignedAgent: c.assignedAgent,
    }));

  if (candidates.length === 0) return { alerted: 0, skipped: 0 };

  // ADMIN тоже получает — «всё в общем доступе видно администратору и директору,
  // даже если это не их обязанность» (решение владельца, применено уже в
  // voiceSecurityAlert.ts, sellerPropertyMissingAntifraud.ts, financeAutomation.ts).
  const directorIds = (
    await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true }, select: { id: true } })
  ).map((d) => d.id);

  /**
   * ПРОСТОЙ СТАНЦИИ СДВИГАЕТ СРОК (дыра 4.2 карты решений). Здесь тишина считается
   * по «ни звонка, ни сообщения через CRM» — а в часы, когда АТС лежала, позвонить
   * было физически некуда. Без этой поправки день без телефонии дал бы владельцу
   * пачку «похоже на увод клиента» про честных людей: обвинение тяжёлое, и
   * ошибиться в нём дороже, чем опоздать. Простои — одним запросом на тик.
   */
  const [outages, workWindow] = await Promise.all([outagesBetween(silenceCutoff, now), loadWorkWindow()]);

  let alerted = 0;
  let skipped = 0;

  for (const c of candidates) {
    // Сдвигаем отсечку назад ровно на рабочие часы простоя, накопленные с момента
    // последнего контакта: чем позже был контакт, тем меньше простоя ему засчитано.
    const downMs = workingOutageMs(c.lastContactAt, now, outages, workWindow);
    const cutoffForClient = downMs > 0 ? new Date(silenceCutoff.getTime() - downMs) : silenceCutoff;
    const silent = c.lastContactAt <= cutoffForClient;
    const frozen = !silent && (await findFrozenAppointment(c.id, cutoffForClient));
    if (!silent && !frozen) continue;

    const { explained, unchecked } = await checkClientExplainedPause(c.id);
    if (explained) {
      // Разобрано без аларма — клиент сам всё объяснил, агент не виноват.
      // Отмечаем, чтобы не гонять ИИ-проверку повторно на каждом тике.
      await prisma.client.update({ where: { id: c.id }, data: { offCrmAlarmNotifiedAt: now } }).catch(() => {});
      skipped++;
      continue;
    }

    if (directorIds.length === 0) continue;

    const reasonLine = silent
      ? `после вопроса о номере — ${OFF_CRM_SILENCE_DAYS}+ дн. без единого звонка или сообщения через CRM`
      : "после вопроса о номере — назначенная встреча/показ прошли без исхода и без переноса";
    const tag = `agent-off-crm-${c.id}`;
    const payload = {
      title: `🚩 Похоже на увод клиента в обход CRM: ${c.fullName}`,
      // Google отклонил текст переписки — ИИ её не прочёл; не выдаём это за
      // «клиент паузу не объяснял» (аудит 10.10.2026, P1-8).
      body:
        `Агент ${c.assignedAgent?.fullName ?? ""} ${reasonLine}. ` +
        (unchecked
          ? "Объяснил ли клиент паузу, ИИ проверить не смог (Google отклонил текст переписки) — посмотрите переписку сами."
          : "Проверьте карточку."),
      url: `/clients/${c.shortId}`,
      tag,
      kind: "oversight" as const,
    };
    try {
      await createNotifications(directorIds, payload);
      void sendPushToAgents(directorIds, payload).catch((err) =>
        console.error("[alarm] agent-off-crm push:", err)
      );
      await prisma.client.update({ where: { id: c.id }, data: { offCrmAlarmNotifiedAt: now } });
      alerted++;
    } catch (err) {
      console.error("[alarm] agent-off-crm notification:", err);
    }
  }

  return { alerted, skipped };
}
