import {
  ROBOT_CALL_DAILY_MAX_DEFAULT,
  ROBOT_CALL_DAILY_SESSIONS_FUSE,
  ROBOT_CALL_DEFER_CODES,
  ROBOT_CALL_WEEKLY_MAX_DEFAULT,
  robotCallLimitOrDefault,
  robotCallRefusalText,
  isDialableTajikNumber,
  nextRobotCallWindowStart,
  normalizeCompanyHolidays,
  normalizeDaysOff,
  robotCallWindowRefusal,
  type RobotCallCalendar,
  type RobotCallRefusalCode,
  type RobotCallStopSource,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { clientLinesOf, looksLikeVoicemail } from "../ai/scenarioTranscript.js";
import { dushanbeDayRange } from "./dushanbeTime.js";
import { refreshLiveVoiceSpend } from "./liveVoiceSpend.js";
import { logSystemError } from "./systemError.js";
import { normalizeDialNumber } from "./telephony/ariClient.js";
import { NO_STATION_AUDIO_REASON } from "./telephony/liveVoiceAudioPath.js";
import { isNumberBlocked } from "./telephony/stationBlacklist.js";

/**
 * МОЖНО ЛИ ЗВОНИТЬ РОБОТОМ — ОДНА ДВЕРЬ (П3, 11.11.2026, находки аудита В3 и В4).
 *
 * До этой правки каждый вид звонка робота решал сам: опрос после показа и проверка
 * продавца спрашивали «не беспокойте» и чёрный список станции, приглашение кандидата и
 * рекрутинг — нет, а кнопка «Звонок роботом» в карточке не спрашивала ни часов, ни
 * запретов вообще: руководитель мог поднять клиента роботом в 23:00.
 *
 * Теперь любой набор робота проходит `robotCallAllowed`, и зовёт её не вызывающий, а сам
 * мост живого голоса — первой строкой каждой своей функции набора (lib/telephony/
 * liveVoiceBridge.ts). Новый вид звонка без этой проверки набрать не сможет: сторож
 * tests/robot-call-policy-architecture.test.ts читает исходник моста.
 *
 * Что проверяется, по порядку (дешёвое — первым):
 *  1. номер вообще набирается;
 *  2. часы 09:00–19:00 по Душанбе, общие выходные (Settings.companyDaysOff) и праздники
 *     (Settings.companyHolidays) — кроме проверочного звонка из Настроек;
 *  2а. потолок минут робота за сутки и месяц (П5, lib/liveVoiceSpend.ts) — кроме
 *     проверочного звонка;
 *  3. отметка «Не звонить роботом» (модель RobotCallStop) — по номеру в девяти цифрах
 *     и по карточке клиента;
 *  4. «не беспокойте» в переписке (BotConversation.optedOutAt);
 *  5. частота на номер: разговоров робота за сутки по Душанбе и за семь суток — по всем
 *     видам вместе (Settings.robotCallDailyMaxPerNumber / robotCallWeeklyMaxPerNumber),
 *     и предохранитель поднятых звонков на номер за сутки (ROBOT_CALL_DAILY_SESSIONS_FUSE) —
 *     кроме проверочного звонка;
 *  6. чёрный список станции (Asterisk, семейство blacklist) — последним, он самый
 *     медленный (AMI, до трёх секунд).
 *
 * Отказ по времени и частоте — «перенести» (`defer: true`, мост отвечает «занято», и
 * сценарий пробует позже, не тратя попытку). Отказ по запрету человека — окончательный.
 *
 * Сбой базы при проверке — отказ «попробуйте позже», а не «можно»: защита по умолчанию.
 * Сбой станции при проверке чёрного списка — «не заблокирован» (решение 02.10.2026,
 * С6): прочитать список нечем, а замолчать из-за этого всем звонкам сразу хуже.
 */

/** Кто набирает: от вида зависят исключения (проверочному звонку часы и частота не нужны). */
export type RobotCallKind = "client_card" | "scenario" | "test";

export interface RobotCallTarget {
  phone: string;
  kind: RobotCallKind;
  /** Карточка клиента (покупатель, собственник). */
  clientId?: string | null;
  /** Диалог бота, из которого пришёл человек (у кандидата — JobApplication.conversationId). */
  conversationId?: string | null;
  /** Досье собеседника. */
  contactProfileId?: string | null;
  /**
   * Зачем звонок. `interview_invite` — приглашение на собеседование с назначенным
   * временем: суточный предел его не держит (недельный — держит), иначе утренний звонок
   * рекрутинга убивал бы приглашение днём (решение по умолчанию, ревью П3 11.11).
   */
  purpose?: "interview_invite";
  now?: Date;
}

export type RobotCallDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: RobotCallRefusalCode;
      /** Простыми словами — показывает кнопка, пишет журнал. */
      message: string;
      /** true — перенести (время, частота), false — не звонить совсем (запрет человека, номер). */
      defer: boolean;
      /** Когда можно попробовать снова, если это известно. */
      retryAt?: Date;
    };

function refuse(code: RobotCallRefusalCode, retryAt?: Date, limits?: { weeklyMax?: number }): Extract<RobotCallDecision, { allowed: false }> {
  return { allowed: false, code, message: robotCallRefusalText(code, limits), defer: ROBOT_CALL_DEFER_CODES.has(code), ...(retryAt ? { retryAt } : {}) };
}

/** Девять местных цифр номера — ключ отметки «не звонить» и счёта частоты. */
export function robotCallPhoneKey(phone: string): string {
  return normalizeDialNumber(phone);
}

const DAY_MS = 24 * 3600_000;
/** Окно «за неделю»: сегодня и шесть предыдущих суток по Душанбе. */
const WEEK_DAYS = 7;

interface PolicySettings {
  calendar: RobotCallCalendar;
  dailyMax: number;
  weeklyMax: number;
}

async function loadPolicySettings(): Promise<PolicySettings> {
  const row = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { companyDaysOff: true, companyHolidays: true, robotCallDailyMaxPerNumber: true, robotCallWeeklyMaxPerNumber: true },
  });
  return {
    calendar: { companyDaysOff: normalizeDaysOff(row?.companyDaysOff), companyHolidays: normalizeCompanyHolidays(row?.companyHolidays) },
    dailyMax: robotCallLimitOrDefault(row?.robotCallDailyMaxPerNumber, ROBOT_CALL_DAILY_MAX_DEFAULT),
    weeklyMax: robotCallLimitOrDefault(row?.robotCallWeeklyMaxPerNumber, ROBOT_CALL_WEEKLY_MAX_DEFAULT),
  };
}

/** Действующая отметка «Не звонить роботом» по номеру или по карточке. */
export async function activeRobotCallStop(
  phoneKey: string,
  clientId?: string | null
): Promise<{ id: string; source: RobotCallStopSource; createdAt: Date; phone: string; clientId: string | null } | null> {
  const or: Array<Record<string, unknown>> = [];
  if (phoneKey) or.push({ phone: phoneKey });
  if (clientId) or.push({ clientId });
  if (or.length === 0) return null;
  return prisma.robotCallStop.findFirst({
    where: { clearedAt: null, OR: or },
    orderBy: { createdAt: "asc" },
    select: { id: true, source: true, createdAt: true, phone: true, clientId: true },
  });
}

/** Все действующие отметки по номеру или по карточке (для экрана: кто вправе снять). */
export async function activeRobotCallStops(phoneKey: string, clientId?: string | null): Promise<Array<{ source: RobotCallStopSource; createdAt: Date }>> {
  const or: Array<Record<string, unknown>> = [];
  if (phoneKey) or.push({ phone: phoneKey });
  if (clientId) or.push({ clientId });
  if (or.length === 0) return [];
  return prisma.robotCallStop.findMany({
    where: { clearedAt: null, OR: or },
    orderBy: { createdAt: "asc" },
    select: { source: true, createdAt: true },
    take: 20,
  });
}

/** Просил ли человек не писать и не звонить — по любому его диалогу с ботом. */
export async function hasOptedOutOfContact(
  target: {
    clientId?: string | null;
    conversationId?: string | null;
    contactProfileId?: string | null;
  },
  /** Учитывать только просьбы ПОЗЖЕ этого момента (после разрешения руководства). */
  after?: Date | null
): Promise<boolean> {
  const or: Array<Record<string, unknown>> = [];
  if (target.conversationId) or.push({ id: target.conversationId });
  if (target.clientId) {
    or.push({ clientId: target.clientId });
    or.push({ contactProfile: { is: { clientId: target.clientId } } });
  }
  if (target.contactProfileId) or.push({ contactProfileId: target.contactProfileId });
  if (or.length === 0) return false;

  const found = await prisma.botConversation.findFirst({
    where: { optedOutAt: after ? { gt: after } : { not: null }, OR: or },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Карточки с этим номером — для звонка, вызывающий которого карточку не назвал
 * (приглашение кандидата, рекрутинг, проверочный): «не беспокойте» в переписке
 * привязано к карточке, а не к номеру.
 */
async function clientIdsByPhone(phoneKey: string): Promise<string[]> {
  if (phoneKey.length !== 9) return [];
  const rows = await prisma.client.findMany({ where: { phone: { endsWith: phoneKey } }, select: { id: true }, take: 5 });
  return rows.map((r) => r.id);
}

/**
 * Сколько ждём станцию с проверкой чёрного списка. Прежде зависший AMI держал каждый
 * набор до ~10 с (две попытки по 5 с и пауза), а блокировать звонок при сбое всё равно
 * не должен (третий аудит 02.10.2026, С6): короткий предел, «не заблокирован».
 */
export const BLACKLIST_CHECK_TIMEOUT_MS = 3000;

/** Номер в чёрном списке станции. Станция недоступна или не ответила за предел — «нет», звонок не блокируем. */
export async function isOnStationBlacklist(phone: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), BLACKLIST_CHECK_TIMEOUT_MS);
    });
    const result = await Promise.race([isNumberBlocked(phone), timeout]);
    return result !== null && result.ok && result.blocked;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Запреты человека: отметка «не звонить», «не беспокойте» в переписке, чёрный список
 * станции. Общая часть двери и прежней проверки сценариев (scenarioCallEligibility.ts).
 */
export async function robotCallStopReason(target: Omit<RobotCallTarget, "kind" | "now">): Promise<"stopped" | "opted_out" | "blacklisted" | null> {
  return (await storedStopReason(target)) ?? ((await isOnStationBlacklist(target.phone)) ? "blacklisted" : null);
}

/**
 * Только записанные в базе запреты (без станции) — для предварительной проверки
 * сценариев: чёрный список станции дверь спросит сама перед набором, второй раз ждать
 * AMI до трёх секунд незачем.
 */
export async function robotCallStoredStopReason(target: Omit<RobotCallTarget, "kind" | "now">): Promise<"stopped" | "opted_out" | null> {
  return storedStopReason(target);
}

/** Запреты, записанные в базе: отметка «не звонить» и «не беспокойте» в переписке. */
async function storedStopReason(target: Omit<RobotCallTarget, "kind" | "now">): Promise<"stopped" | "opted_out" | null> {
  const key = robotCallPhoneKey(target.phone);
  if (await activeRobotCallStop(key, target.clientId)) return "stopped";
  const clientIds = target.clientId ? [target.clientId] : await clientIdsByPhone(key);
  // Разрешение руководства снимает «не беспокойте» переписки ТОЛЬКО для робота, только по
  // той карточке, где его дали, и только просьбы, сделанные ДО разрешения: новая просьба
  // клиента (optedOutAt позже разрешения) снова закрывает робозвонок.
  const allowedAt = clientIds.length ? await robotCallAllowMoments(clientIds) : new Map<string, Date>();
  const own = { conversationId: target.conversationId, contactProfileId: target.contactProfileId };
  if (own.conversationId || own.contactProfileId) {
    const ownClient = await clientOfConversation(own);
    const ownAllowedAt = ownClient ? allowedAt.get(ownClient) ?? (await robotCallAllowMoments([ownClient])).get(ownClient) ?? null : null;
    if (await hasOptedOutOfContact(own, ownAllowedAt)) return "opted_out";
  }
  for (const clientId of clientIds) {
    if (await hasOptedOutOfContact({ clientId }, allowedAt.get(clientId) ?? null)) return "opted_out";
  }
  return null;
}

/**
 * «Не беспокойте» переписки по карточке: была ли просьба, есть ли разрешение руководства и
 * закрывает ли она робозвонок сейчас (просьба позже разрешения — закрывает).
 */
export async function chatOptOutState(clientId: string): Promise<{ optedOut: boolean; allowed: boolean; blocks: boolean }> {
  const allowedAt = (await robotCallAllowMoments([clientId])).get(clientId) ?? null;
  const optedOut = await hasOptedOutOfContact({ clientId });
  const blocks = optedOut && (allowedAt ? await hasOptedOutOfContact({ clientId }, allowedAt) : true);
  return { optedOut, allowed: !!allowedAt, blocks };
}

/** Снять только отметки сотрудника (просьбы клиента остаются). */
export async function clearStaffRobotCallStops(input: { phone: string; clientId?: string | null; clearedByAgentId: string | null; now?: Date }): Promise<number> {
  const phone = robotCallPhoneKey(input.phone);
  const or: Array<Record<string, unknown>> = [{ phone }];
  if (input.clientId) or.push({ clientId: input.clientId });
  const result = await prisma.robotCallStop.updateMany({
    where: { clearedAt: null, source: "STAFF", OR: or },
    data: { clearedAt: input.now ?? new Date(), clearedByAgentId: input.clearedByAgentId },
  });
  return result.count;
}

/** Действующие разрешения руководства: карточка → когда дано. */
async function robotCallAllowMoments(clientIds: string[]): Promise<Map<string, Date>> {
  const rows = await prisma.robotCallAllow.findMany({
    where: { clientId: { in: clientIds }, revokedAt: null },
    select: { clientId: true, createdAt: true },
  });
  return new Map(rows.map((r) => [r.clientId, r.createdAt]));
}

/**
 * Клиент снова написал «не беспокойте» — разрешение руководства по его карточке гаснет
 * (переписка ставит optedOutAt только один раз, поэтому одной сверки дат мало).
 */
export async function revokeRobotCallAllowOnOptOut(conversationId: string): Promise<number> {
  const conv = await prisma.botConversation.findUnique({
    where: { id: conversationId },
    select: { clientId: true, contactProfile: { select: { clientId: true } } },
  });
  const ids = [...new Set([conv?.clientId, conv?.contactProfile?.clientId].filter((x): x is string => !!x))];
  if (ids.length === 0) return 0;
  const r = await prisma.robotCallAllow.updateMany({ where: { clientId: { in: ids }, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count;
}

/** Карточка, к которой привязан диалог или досье (если есть). */
async function clientOfConversation(target: { conversationId?: string | null; contactProfileId?: string | null }): Promise<string | null> {
  if (target.conversationId) {
    const conv = await prisma.botConversation.findUnique({ where: { id: target.conversationId }, select: { clientId: true } });
    if (conv?.clientId) return conv.clientId;
  }
  if (target.contactProfileId) {
    const profile = await prisma.contactProfile.findUnique({ where: { id: target.contactProfileId }, select: { clientId: true } });
    if (profile?.clientId) return profile.clientId;
  }
  return null;
}

/** Карточки, по которым руководство разрешило робота вопреки «не беспокойте» в переписке. */
export async function clientsAllowedDespiteOptOut(clientIds: string[]): Promise<string[]> {
  const rows = await prisma.robotCallAllow.findMany({ where: { clientId: { in: clientIds }, revokedAt: null }, select: { clientId: true } });
  return rows.map((r) => r.clientId);
}

/** Разрешить роботу звонить вопреки «не беспокойте» в переписке (одно действующее на карточку). */
export async function allowRobotCallDespiteOptOut(clientId: string, agentId: string): Promise<{ created: boolean }> {
  const active = () => prisma.robotCallAllow.findFirst({ where: { clientId, revokedAt: null }, select: { id: true } });
  if (await active()) return { created: false };
  try {
    await prisma.robotCallAllow.create({ data: { clientId, allowedByAgentId: agentId } });
    return { created: true };
  } catch (err) {
    if (await active()) return { created: false };
    throw err;
  }
}

/** Отозвать разрешение: просьба в переписке снова закрывает робозвонок. */
export async function revokeRobotCallAllow(clientId: string, agentId: string | null, now: Date = new Date()): Promise<number> {
  const r = await prisma.robotCallAllow.updateMany({ where: { clientId, revokedAt: null }, data: { revokedAt: now, revokedByAgentId: agentId } });
  return r.count;
}

/**
 * Причины конца сессии «сбой на нашей стороне» — одно место (его же зовёт приглашение
 * кандидата, interviewInviteCall.ts::isOurCallFailure): связь, голос не поднялся, немая
 * линия, процесс перезапустился.
 */
export function isRobotCallOurFailure(reason: string | null | undefined, transcript?: readonly string[] | string | null): boolean {
  if (!reason) return false;
  // Сбой до разговора или прежний список приглашения (02.10.2026) — сбой всегда.
  if (
    reason.startsWith("start_failed") ||
    reason === "gemini_error" ||
    reason === "gemini_closed" ||
    reason === "rtp_socket_error" ||
    reason === "listener_stopped" ||
    reason === "ari_error" ||
    reason === NO_STATION_AUDIO_REASON ||
    reason === "no_caller_speech"
  ) {
    return true;
  }
  // Оборвалось посреди (перезапуск, зависший голос, отказ поставщика): если разговор уже
  // был — это не сбой, иначе человеку позвонят второй раз о том же (ревью П3).
  if (
    reason.startsWith("gemini_") ||
    reason.startsWith("elevenlabs_") ||
    reason.startsWith("orphan_") ||
    reason === "ended_while_offline"
  ) {
    const lines = clientLinesOf(typeof transcript === "string" ? transcript.split("\n") : [...(transcript ?? [])]);
    return lines.length < SUBSTANTIAL_CLIENT_LINES;
  }
  return false;
}

/** Модель закончила звонок как «автоответчик» или «взял не тот» (слова причины end_call). */
function endedAsNotReached(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const tokens = reason.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  return tokens.includes("voicemail") || tokens.includes("wrong_person") || tokens.some((t) => t.startsWith("автоответчик"));
}

/** Сессия без итога (ещё идёт или оборвалась) считается разговором столько времени. */
const LIVE_SESSION_COUNTS_MS = 30 * 60_000;
/** При нашем сбое разговор всё же был, если собеседник сказал хотя бы столько реплик (ОЦЕНКА). */
const SUBSTANTIAL_CLIENT_LINES = 3;

/**
 * БЫЛ ЛИ РАЗГОВОР, который тратит частоту на номер (ревью П3, 11.11). Строка сессии
 * заводится по ответу, поэтому одна строка — ещё не разговор: автоответчик, «взял не
 * тот», немая линия и голос, который не поднялся, частоту не тратят — иначе повтор после
 * нашего сбоя получал бы «уже разговаривали сегодня» и приглашение умирало.
 *
 * Признак — реплики собеседника в расшифровке («Клиент: …»). ОЦЕНКА: расшифровку пишет
 * поставщик голоса, и у молчаливого собеседника она может быть пустой — такой звонок
 * частоту не тратит (лучше лишний звонок завтра, чем потерянное приглашение).
 */
export function robotSessionCountsAsConversation(
  session: { startedAt: Date; endedAt: Date | null; endedReason: string | null; transcript: string | null },
  now: Date
): boolean {
  if (!session.endedAt) return now.getTime() - session.startedAt.getTime() < LIVE_SESSION_COUNTS_MS;
  if (endedAsNotReached(session.endedReason)) return false;
  const lines = clientLinesOf((session.transcript ?? "").split("\n"));
  if (lines.length === 0 || looksLikeVoicemail(lines)) return false;
  if (isRobotCallOurFailure(session.endedReason, session.transcript)) return lines.length >= SUBSTANTIAL_CLIENT_LINES;
  return true;
}

/**
 * Поднятые звонки робота на этот номер (исходящие) с момента `since`: все сессии — для
 * предохранителя наборов — и из них состоявшиеся разговоры — для частоты.
 */
async function outboundSessionsSince(phoneKey: string, since: Date, now: Date): Promise<{ all: Date[]; conversations: Date[] }> {
  const rows = await prisma.liveVoiceSession.findMany({
    where: { direction: "outbound", callerNumber: phoneKey, startedAt: { gte: since } },
    select: { startedAt: true, endedAt: true, endedReason: true, transcript: true },
    orderBy: { startedAt: "asc" },
    take: 50,
  });
  return {
    all: rows.map((r) => r.startedAt),
    conversations: rows.filter((r) => robotSessionCountsAsConversation(r, now)).map((r) => r.startedAt),
  };
}

/**
 * Частота на номер: считаются только состоявшиеся разговоры
 * (robotSessionCountsAsConversation). Недозвон частоту не тратит. Отдельно — предохранитель
 * ROBOT_CALL_DAILY_SESSIONS_FUSE: поднятых звонков с любым итогом (автоответчик, наш сбой)
 * на номер за сутки не больше стольких, и для приглашения кандидата тоже (П5, 11.11.2026).
 */
async function frequencyRefusal(
  phoneKey: string,
  settings: PolicySettings,
  now: Date,
  purpose: RobotCallTarget["purpose"]
): Promise<Extract<RobotCallDecision, { allowed: false }> | null> {
  const today = dushanbeDayRange(now);
  const weekStart = new Date(today.start.getTime() - (WEEK_DAYS - 1) * DAY_MS);
  const { all, conversations: sessions } = await outboundSessionsSince(phoneKey, weekStart, now);
  if (all.filter((at) => at.getTime() >= today.start.getTime()).length >= ROBOT_CALL_DAILY_SESSIONS_FUSE) {
    return refuse("daily_sessions_fuse", nextRobotCallWindowStart(today.end, settings.calendar));
  }
  const todayCount = sessions.filter((at) => at.getTime() >= today.start.getTime()).length;
  if (purpose !== "interview_invite" && todayCount >= settings.dailyMax) {
    return refuse("daily_limit", nextRobotCallWindowStart(today.end, settings.calendar));
  }
  if (sessions.length >= settings.weeklyMax) {
    // Окно освободится, когда самый старый разговор выпадет из семи суток.
    const oldest = dushanbeDayRange(sessions[0]).start;
    return refuse("weekly_limit", nextRobotCallWindowStart(new Date(oldest.getTime() + WEEK_DAYS * DAY_MS), settings.calendar), settings);
  }
  return null;
}

/**
 * Потолок минут робота (lib/liveVoiceSpend.ts): дошли — «перенести» до начала окна звонков
 * после конца суток или месяца. Чтение заодно обновляет удержание входящих и ставит
 * тревоги директору. Сбой базы бросает — дверь отвечает «попробуйте позже».
 */
async function spendCapRefusal(now: Date, calendar: RobotCallCalendar): Promise<Extract<RobotCallDecision, { allowed: false }> | null> {
  const reading = await refreshLiveVoiceSpend(now);
  if (!reading.held || !reading.retryAt) return null;
  return refuse(reading.held === "month" ? "minutes_cap_month" : "minutes_cap_day", nextRobotCallWindowStart(reading.retryAt, calendar));
}

/**
 * ЕДИНСТВЕННАЯ ДВЕРЬ: можно ли роботу набрать этот номер прямо сейчас.
 * Не бросает: сбой проверки — отказ «попробуйте позже».
 */
export async function robotCallAllowed(target: RobotCallTarget): Promise<RobotCallDecision> {
  const now = target.now ?? new Date();
  if (!isDialableTajikNumber(target.phone)) return refuse("invalid_number");
  const key = robotCallPhoneKey(target.phone);
  try {
    const settings = await loadPolicySettings();
    if (target.kind !== "test") {
      const window = robotCallWindowRefusal(now, settings.calendar);
      if (window) return refuse(window, nextRobotCallWindowStart(now, settings.calendar));
      // П5: потолок минут робота за сутки/месяц — общий на все номера, поэтому до проверок номера.
      const spend = await spendCapRefusal(now, settings.calendar);
      if (spend) return spend;
    }
    const stored = await storedStopReason(target);
    if (stored) return refuse(stored);
    // Частота — до станции: отказ «перенести» повторяется сценарием раз в несколько
    // минут, и каждый повтор не должен ждать AMI до трёх секунд.
    if (target.kind !== "test") {
      const frequency = await frequencyRefusal(key, settings, now, target.purpose);
      if (frequency) return frequency;
    }
    if (await isOnStationBlacklist(target.phone)) return refuse("blacklisted");
    return { allowed: true };
  } catch (err) {
    void logSystemError("telephony", `Звонок роботом: не удалось проверить, можно ли звонить: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "robot-call-policy-failed",
    });
    return refuse("policy_unavailable");
  }
}

/**
 * Отказ двери в форме ответа функций набора моста (LiveVoiceTestCallResult):
 * `notDialed` — звонка точно не было; `busy` — перенести, попытку не тратить.
 * `null` — звонить можно.
 */
export async function robotCallRefusal(
  target: RobotCallTarget
): Promise<{ ok: false; notDialed: true; busy?: true; error: string; policyCode: RobotCallRefusalCode; retryAt?: Date } | null> {
  const decision = await robotCallAllowed(target);
  if (decision.allowed) return null;
  return {
    ok: false,
    notDialed: true,
    ...(decision.defer ? { busy: true as const } : {}),
    error: decision.message,
    policyCode: decision.code,
    ...(decision.retryAt ? { retryAt: decision.retryAt } : {}),
  };
}

/**
 * Поставить отметку «Не звонить роботом». Повторная постановка возвращает уже
 * действующую отметку и новой строки не заводит (одна активная на номер — частичный
 * уникальный индекс RobotCallStop_one_active_per_phone ловит и гонку двух нажатий).
 */
export async function setRobotCallStop(input: {
  phone: string;
  clientId?: string | null;
  source: RobotCallStopSource;
  setByAgentId?: string | null;
  note?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const phone = robotCallPhoneKey(input.phone);
  // По номеру, а не по карточке: уникальна именно активная отметка номера, и у карточки,
  // сменившей номер, новый номер должен получить свою отметку.
  const activeForPhone = () =>
    prisma.robotCallStop.findFirst({ where: { clearedAt: null, phone }, select: { id: true } });
  const existing = await activeForPhone();
  if (existing) return { id: existing.id, created: false };
  try {
    const row = await prisma.robotCallStop.create({
      data: {
        phone,
        clientId: input.clientId ?? null,
        source: input.source,
        setByAgentId: input.setByAgentId ?? null,
        note: input.note ?? null,
      },
      select: { id: true },
    });
    return { id: row.id, created: true };
  } catch (err) {
    const again = await activeForPhone();
    if (again) return { id: again.id, created: false };
    throw err;
  }
}

/** Снять отметку (все действующие по номеру и карточке). Строки остаются с clearedAt. */
export async function clearRobotCallStop(input: { phone: string; clientId?: string | null; clearedByAgentId: string | null; now?: Date }): Promise<number> {
  const phone = robotCallPhoneKey(input.phone);
  const or: Array<Record<string, unknown>> = [{ phone }];
  if (input.clientId) or.push({ clientId: input.clientId });
  const result = await prisma.robotCallStop.updateMany({
    where: { clearedAt: null, OR: or },
    data: { clearedAt: input.now ?? new Date(), clearedByAgentId: input.clearedByAgentId },
  });
  return result.count;
}
