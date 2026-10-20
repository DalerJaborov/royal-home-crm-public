import { prisma } from "../db.js";
import { COUNTED_SHOWING_WHERE } from "./tasks.js";
import { agentsWithOpenCallStub, hasLiveCall } from "./telephony/callTracker.js";
import { incomingInteractionIds } from "./telephony/incomingInteractions.js";

const MINUTE_MS = 60_000;

/**
 * ЩИТОК ЗАНЯТОСТИ АГЕНТА В РАЗДАЧЕ (мозговой штурм 20-21.08.2026, «рубеж 1: вход»).
 *
 * Вероятный корень случая 18.08.2026 с Нурмухаммадом (см. комментарий у
 * Settings.leadReassignOnMissedCallEnabled, apps/api/prisma/schema.prisma): агент
 * вёл показ или разговор с клиентом, а система тем временем отсчитывала таймер на
 * приём нового лида — человек физически не мог ни принять его, ни тем более
 * успеть позвонить вовремя. Из-за этого автопередачу при непозвонившем агенте
 * тогда выключили насовсем (см. leads.ts::penalizeMissedFirstCalls). Щиток
 * закрывает именно эту дыру: агент, занятый ПРЯМО СЕЙЧАС, из раздачи новых лидов
 * временно выпадает — не наказание, а просто честность: не выдавать работу
 * тому, кто физически не может её начать.
 *
 * ДВА ПРИЗНАКА ЗАНЯТОСТИ:
 *
 * 1) ПОКАЗ ПО КАЛЕНДАРЮ — Interaction type=SHOWING, чьё nextActionDate попало в
 *    окно [сейчас − agentOccupancyShieldAfterMinutes; сейчас], ещё не отмечен
 *    выполненным (completedAt) и не отменён. Отмену считаем ТЕМ ЖЕ составным
 *    предикатом, что и везде в отчётах (COUNTED_SHOWING_WHERE, см. lib/tasks.ts):
 *    показ отменён, только когда `nextAction` пуст И `declinedAt` заполнен
 *    (см. lib/showingBooking.ts::applyCancellation) — второе, отдельное понимание
 *    «отменён» в этом файле рано или поздно разошлось бы с тем, что реально
 *    снимает встречу с календаря.
 *
 * 2) ЖИВОЙ ЗВОНОК ЧЕРЕЗ CRM — hasLiveCall(agentId) из lib/telephony/callTracker.ts,
 *    состояние в памяти процесса, которое ведут события ARI (см. подробный разбор
 *    прямо там: звонок живёт минуты и умирает вместе с разговором, поэтому не в
 *    базе). Это ПРЯМОЙ признак реального времени, а не догадка по хронологии:
 *    звонок через кнопку «Позвонить» в CRM НЕ оставляет в Interaction записи «в
 *    процессе» — запись заводится при начале звонка и дополняется исходом только
 *    по завершении (см. callTracker.ts::finishCall), отдельного поля вида «звонок
 *    ещё идёт» у неё нет, так что запрашивать это из базы попросту нечем.
 *
 *    В worker карта пуста — там признак читается из базы: свежая заготовка
 *    звонка без итога (agentsWithOpenCallStub, 02.10.2026). Поэтому фраза ниже
 *    «запрашивать это из базы попросту нечем» верна только для входящих.
 *
 *    ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: звонок, который агент принял прямо на физическом
 *    аппарате в обход кнопки CRM (входящий, например), этим признаком не виден —
 *    такие звонки пишутся в хронологию клиента ПОСТФАКТУМ, уже с готовым исходом
 *    и длительностью (см. lib/telephony/incomingCalls.ts), то есть узнать о них
 *    в реальном времени сейчас в системе нечем вовсе. Живой звонок через CRM —
 *    сценарий, который и породил случай с Нурмухаммадом (см. выше), поэтому он и
 *    закрыт первым; входящие без click-to-call — известный, осознанно принятый
 *    пробел, а не забытый случай.
 */
export async function loadOccupancyShieldSettings(): Promise<{ enabled: boolean; afterMinutes: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return {
    enabled: settings?.agentOccupancyShieldEnabled ?? true,
    afterMinutes: settings?.agentOccupancyShieldAfterMinutes ?? 30,
  };
}

/** Кто из перечисленных агентов занят ПРЯМО СЕЙЧАС — показом или звонком через CRM. */
export async function agentsOnShowingOrCall(agentIds: string[], now: Date = new Date()): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const { enabled, afterMinutes } = await loadOccupancyShieldSettings();
  if (!enabled) return new Set();

  const busy = new Set<string>();

  // Живой звонок — в памяти процесса api. В worker (раздача, переназначение
  // протухших лидов) эта карта пуста, поэтому тот же признак берётся и из
  // базы: свежая заготовка звонка из CRM без итога (E4 глубокой проверки
  // 02.10.2026, см. agentsWithOpenCallStub).
  for (const id of agentIds) {
    if (hasLiveCall(id)) busy.add(id);
  }
  for (const id of await agentsWithOpenCallStub(agentIds, now)) busy.add(id);

  const since = new Date(now.getTime() - Math.max(0, afterMinutes) * MINUTE_MS);
  const activeShowings = await prisma.interaction.findMany({
    where: {
      agentId: { in: agentIds },
      type: "SHOWING",
      nextActionDate: { gte: since, lte: now },
      completedAt: null,
      ...COUNTED_SHOWING_WHERE,
    },
    select: { agentId: true },
    distinct: ["agentId"],
  });
  for (const s of activeShowings) if (s.agentId) busy.add(s.agentId);

  return busy;
}

/**
 * ТРЕТИЙ ПРИЗНАК ЗАНЯТОСТИ — ПРИНЯЛ ЛИД, ЕЩЁ НЕ ПОЗВОНИЛ (14.09.2026, живая
 * проверка владельца на телефоне: «принимаю лиды один за другим, второй
 * приходит раньше, чем успеваю позвонить первому»).
 *
 * Те же два признака выше защищают от прямо сейчас идущей работы (показ,
 * живой звонок), но НЕ от окна между «принял» и «позвонил»: агент только что
 * нажал Принять, ещё набирает номер — и в эту же секунду карусель могла
 * отдать ему второй лид, потому что формально он «не занят». Ровно та же
 * природа дыры, что породила случай с Нурмухаммадом 18.08.2026 (см. шапку
 * файла) — здесь закрывается её третье, до сих пор не прикрытое ребро.
 *
 * ОКНО — `Settings.leadCallMinutes` (по умолчанию 15), ТА ЖЕ настройка, что
 * задаёт срок обязательного первого звонка в services/leads/firstCall.ts:
 * не отдельное число, которое рано или поздно разойдётся со сроком обязанности.
 *
 * «ПОЗВОНИЛ» ПЕРЕСТАЛО БЫТЬ ТОЛЬКО ЗВОНКОМ (17.09.2026, закон о владении
 * клиентом П-2 — `services/leads/ownershipPolicy.ts::hasContactAttempt`,
 * `docs/law/lead-ownership.md`). Единое определение контакта — ЛЮБАЯ попытка
 * агента: звонок (дозвонился или нет — не важно для СЛЕДУЮЩЕГО лида, важно для
 * судьбы этого, чем и занимается firstCall.ts отдельно), сообщение из CRM,
 * показ, встреча. До этой правки щиток снимал занятость только звонком
 * (`type: "CALL"`) — агент, который вместо звонка сразу написал клиенту в
 * WhatsApp (первый контакт сообщением — обычное дело для интернет-лида),
 * технически «не позвонил» и получал бы второй лид поверх первого, хотя по
 * закону уже сделал попытку. Теперь любая запись НЕ SYSTEM/STATUS_CHANGE
 * (CALL/MESSAGE/SHOWING/MEETING) снимает занятость — та же логика, что у
 * `firstContactAt`/`OwnershipSnapshot.contactAttempts`. Входящий звонок
 * клиента не считается (incomingInteractionIds — тот же фильтр; на
 * MESSAGE/SHOWING/MEETING он не даёт совпадений вовсе, там понятия «входящий»
 * не существует).
 *
 * Гейтится тем же `agentOccupancyShieldEnabled`, что и остальной щиток —
 * один рубильник на все признаки занятости, а не третий, который забудут
 * выключить вместе с остальными.
 */
export async function agentsWithUncalledAcceptedLead(agentIds: string[], now: Date = new Date()): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { agentOccupancyShieldEnabled: true, leadCallMinutes: true },
  });
  if (!(settings?.agentOccupancyShieldEnabled ?? true)) return new Set();
  const minutes = settings?.leadCallMinutes ?? 15;
  const since = new Date(now.getTime() - Math.max(0, minutes) * MINUTE_MS);

  const pending = await prisma.client.findMany({
    where: {
      assignedAgentId: { in: agentIds },
      acceptedAt: { not: null, gte: since },
      kind: { not: "OTHER" },
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      deletedAt: null,
    },
    select: { id: true, assignedAgentId: true, acceptedAt: true },
  });
  if (pending.length === 0) return new Set();

  const calls = await prisma.interaction.findMany({
    where: {
      clientId: { in: pending.map((c) => c.id) },
      // П-2 (закон о владении клиентом, 17.09.2026): любая попытка агента, не
      // только звонок — см. разбор у объявления функции выше.
      type: { notIn: ["SYSTEM", "STATUS_CHANGE"] },
      createdAt: { gte: since },
    },
    select: { id: true, clientId: true, createdAt: true },
  });
  const incomingIds = calls.length > 0 ? await incomingInteractionIds(calls.map((c) => c.id)) : new Set<string>();
  // Звонок должен быть ПОСЛЕ приёма именно ЭТОГО круга — иначе старый звонок
  // из прошлого раза (например, до возврата потерянного клиента) засчитался бы
  // за только что принятый лид: `since` общий на всех, а `acceptedAt` у
  // каждого клиента своё, где-то внутри того же окна.
  const acceptedAtByClient = new Map(pending.map((c) => [c.id, c.acceptedAt!.getTime()]));
  const calledClientIds = new Set(
    calls
      .filter((c) => !incomingIds.has(c.id) && c.createdAt.getTime() >= (acceptedAtByClient.get(c.clientId) ?? Infinity))
      .map((c) => c.clientId)
  );

  const busy = new Set<string>();
  for (const client of pending) {
    if (!client.assignedAgentId) continue;
    if (calledClientIds.has(client.id)) continue;
    busy.add(client.assignedAgentId);
  }
  return busy;
}
