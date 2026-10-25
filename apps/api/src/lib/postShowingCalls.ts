import { prisma } from "../db.js";
import type { PostShowingCallOutcome } from "../generated/prisma/client.js";

/**
 * ХРАНИЛИЩЕ РОБОЗВОНКОВ ПОСЛЕ ПОКАЗА — только доступ к таблице, без решений.
 *
 * Здесь НЕТ ни одного правила «звонить или не звонить»: ни часов, ни лимитов,
 * ни разбора исхода. Всё это живёт в `lib/postShowingCall.ts` (расписание) и
 * `ai/postShowingCallParse.ts` (разбор разговора). Разделение не ради красоты:
 * правила менялись при владельце трижды за два дня (окно до 21:00 → до 19:00,
 * сообщение → звонок), а форма хранения не менялась ни разу, и смешивать их в
 * одном файле значит переписывать запросы каждый раз, когда поменялось решение.
 *
 * Зачем таблица вообще и почему агент её не видит — в докстринге модели
 * `PostShowingCall` (prisma/schema.prisma) и в
 * `docs/buyer-antifraud-funnel-13-09-2026.md`.
 */

/** Две попытки, и ни одной больше (владелец: «не дозвонились — не долбить»).
 *  Вторая — в другое время суток, это решает расписание, не хранилище. */
export const POST_SHOWING_CALL_MAX_ATTEMPTS = 2;

export interface ScheduleInput {
  showingId: string;
  clientId: string;
  agentId: string;
  propertyId: string | null;
  scheduledFor: Date;
  previewOnly?: boolean;
}

/**
 * Что сделала постановка: завели новую, передвинули уже стоящую (показ
 * перенесли) или оставили как есть. Возвращается ради тестов и журнала — по
 * одному булеву «ок» нельзя отличить «звонок уехал вместе с показом» от
 * «звонок остался на старом часе», а это ровно та ошибка, ради которой
 * расписание держится на кроне, а не на очереди заданий.
 */
export type ScheduleResult = "created" | "moved" | "kept";

export async function schedulePostShowingCall(input: ScheduleInput): Promise<ScheduleResult> {
  const existing = await prisma.postShowingCall.findUnique({
    where: { showingId: input.showingId },
    select: { id: true, status: true, scheduledFor: true },
  });

  if (!existing) {
    try {
      await prisma.postShowingCall.create({
        data: {
          showingId: input.showingId,
          clientId: input.clientId,
          agentId: input.agentId,
          propertyId: input.propertyId,
          scheduledFor: input.scheduledFor,
          previewOnly: input.previewOnly ?? true,
        },
      });
      return "created";
    } catch {
      // Гонка двух тиков на одном показе: @unique по showingId не даст завести
      // вторую запись, и это не ошибка — вторая попытка просто опоздала.
      return "kept";
    }
  }

  // Показ перенесли — звонок обязан уехать вместе с ним, но только пока он ещё
  // не начался: набранный или состоявшийся звонок задним числом не двигают.
  if (existing.status === "PENDING" && existing.scheduledFor.getTime() !== input.scheduledFor.getTime()) {
    await prisma.postShowingCall.update({
      where: { id: existing.id },
      data: { scheduledFor: input.scheduledFor },
    });
    return "moved";
  }

  return "kept";
}

export interface DueCall {
  id: string;
  showingId: string;
  clientId: string;
  agentId: string;
  propertyId: string | null;
  attempts: number;
  scheduledFor: Date;
}

/**
 * Кого пора набирать. Предел выборки обязателен: на каждую запись идёт реальный
 * звонок через станцию, и проход без потолка занял бы тик целиком.
 *
 * NO_ANSWER здесь наравне с PENDING — это не «кончилось», а «ждёт второй
 * попытки»; израсходовавшие обе лежат в GIVEN_UP и сюда не попадают.
 */
export async function duePostShowingCalls(now: Date, limit = 20): Promise<DueCall[]> {
  return prisma.postShowingCall.findMany({
    where: { previewOnly: false, status: { in: ["PENDING", "NO_ANSWER"] }, scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: limit,
    select: {
      id: true,
      showingId: true,
      clientId: true,
      agentId: true,
      propertyId: true,
      attempts: true,
      scheduledFor: true,
    },
  });
}

/**
 * Не позвонили и не будем — с причиной.
 *
 * Причина обязательна и в этом весь смысл записи: без неё нельзя посчитать
 * покрытие опроса, а на покрытии держится статистика порога 4 («какая доля
 * показов кончилась тишиной»). Молча пропущенный звонок в этой статистике
 * неотличим от показа, по которому клиент промолчал, — то есть портит ровно ту
 * цифру, ради которой всё и затевалось.
 */
export async function markPostShowingCallSkipped(id: string, reason: string): Promise<void> {
  await prisma.postShowingCall.update({
    where: { id },
    data: { status: "SKIPPED", skipReason: reason },
  });
}

/** Станция приняла набор: попытка потрачена, канал запомнен. Счётчик растёт
 *  ЗДЕСЬ, а не при ответе человека, — иначе недозвон не считался бы попыткой
 *  вовсе и бот звонил бы бесконечно. */
/**
 * ЗАНЯТЬ ЗВОНОК ДО НАБОРА (№172 ночной проверки 24.09). Раньше «звоним»
 * ставилось после того, как станция приняла набор: рестарт процесса в этот миг
 * (каждый выкат) оставлял запись ждущей, и следующий тик набирал того же
 * человека второй раз. Теперь запись переходит в CALLING условно — только из
 * ждущих статусов, — и кто перевёл, тот и звонит. Прежние статус и время
 * попытки возвращаются вызывающему: отказ станции откатывает занятие ими.
 * Зависшее занятие (процесс умер посреди набора) снимет releaseStuckCalls.
 */
export async function claimPostShowingCall(
  id: string,
  now: Date
): Promise<{ status: "PENDING" | "NO_ANSWER"; lastAttemptAt: Date | null } | null> {
  const before = await prisma.postShowingCall.findUnique({ where: { id }, select: { status: true, lastAttemptAt: true } });
  if (!before || (before.status !== "PENDING" && before.status !== "NO_ANSWER")) return null;
  const claimed = await prisma.postShowingCall.updateMany({
    where: { id, status: before.status, previewOnly: false },
    data: { status: "CALLING", channelId: null, lastAttemptAt: now },
  });
  return claimed.count === 1 ? { status: before.status, lastAttemptAt: before.lastAttemptAt } : null;
}

/** Станция приняла набор: запись уже занята (claimPostShowingCall) — дописать канал и попытку. */
export async function markPostShowingCallStarted(id: string, channelId: string, now: Date): Promise<void> {
  await prisma.postShowingCall.update({
    where: { id },
    data: { status: "CALLING", channelId, lastAttemptAt: now, attempts: { increment: 1 } },
  });
}

/**
 * Станция не приняла набор — снять занятие и вернуть прежнее время попытки:
 * лента опросов считает «звонили» по lastAttemptAt, а набора не было.
 */
export async function releasePostShowingCallClaim(
  id: string,
  prev: { status: "PENDING" | "NO_ANSWER"; lastAttemptAt: Date | null },
  nextAttemptAt: Date
): Promise<void> {
  // Прежний статус, а не всегда NO_ANSWER (третий аудит 02.10.2026, низкая): строка с
  // нулём попыток, ставшая «не дозвонились», попадала в статистику тишины по агенту
  // как «опрошенный показ», хотя ей так и не позвонили.
  await prisma.postShowingCall.updateMany({
    where: { id, status: "CALLING", channelId: null },
    data: { status: prev.status, scheduledFor: nextAttemptAt, lastAttemptAt: prev.lastAttemptAt },
  });
}

/**
 * Трубку не взяли. `nextAttemptAt` = null означает, что попытки кончились:
 * запись уходит в GIVEN_UP и больше не поднимается. Молчание уликой не
 * считается — человек не обязан отвечать роботу; в порог 4 оно идёт одним
 * эпизодом, а не обвинением.
 */
export async function markPostShowingCallNoAnswer(id: string, nextAttemptAt: Date | null, mark?: ScenarioCallMark): Promise<void> {
  const markData = mark ? { skipReason: withScenarioCallMark(await currentMarks(id), mark) } : {};
  await prisma.postShowingCall.update({
    where: { id },
    data: nextAttemptAt
      ? { status: "NO_ANSWER", scheduledFor: nextAttemptAt, ...markData }
      : { status: "GIVEN_UP", ...markData },
  });
}

async function currentMarks(id: string): Promise<string | null> {
  const row = await prisma.postShowingCall.findUnique({ where: { id }, select: { skipReason: true } });
  return row?.skipReason ?? null;
}

/**
 * ПОМЕТКИ НА ЖИВОЙ ЗАПИСИ ЗВОНКА (02.10.2026, аудит сценарных звонков №4, №6, №12).
 *
 * `skipReason` у записи в SKIPPED — причина «не позвонили». У записи, которая
 * ещё живёт (PENDING / NO_ANSWER / GIVEN_UP / DONE), то же поле несёт пометки
 * через запятую — без миграции, тем же приёмом, что `dial_failed` у
 * приглашения кандидата:
 * - `attempt_returned` — попытку уже возвращали один раз (немой звонок или сбой
 *   на нашей стороне). Второй раз не возвращаем: живой человек не должен каждый
 *   час служить проверкой мёртвой линии;
 * - `line_alive` — в какой-то попытке трубку сняли (автоответчик, «перезвоните»,
 *   не тот человек): номер живой, «мёртвым» его не считать;
 * - `wrong_person` — трубку взял не тот, о ком речь.
 * Общий словарь для опроса после показа и проверки продавца.
 */
export type ScenarioCallMark = "attempt_returned" | "line_alive" | "wrong_person";

export function hasScenarioCallMark(skipReason: string | null | undefined, mark: ScenarioCallMark): boolean {
  return (skipReason ?? "").split(",").includes(mark);
}

export function withScenarioCallMark(skipReason: string | null | undefined, ...marks: ScenarioCallMark[]): string {
  const all = new Set((skipReason ?? "").split(",").filter(Boolean));
  for (const m of marks) all.add(m);
  return [...all].join(",");
}

export interface OutcomeInput {
  outcome: PostShowingCallOutcome;
  confidence: number | null;
  quote: string | null;
  redFlags: string[];
  summary: string | null;
  talkedAt: Date;
}

/** Поговорили и разобрали. Разбор делает ИИ, решение «кого разбудить» —
 *  расписание; хранилищу остаётся положить как есть. */
export async function savePostShowingCallOutcome(id: string, input: OutcomeInput): Promise<void> {
  await prisma.postShowingCall.update({
    where: { id },
    data: {
      status: "DONE",
      talkedAt: input.talkedAt,
      outcome: input.outcome,
      outcomeConfidence: input.confidence,
      quote: input.quote,
      redFlags: input.redFlags,
      summary: input.summary,
    },
  });
}

/** Разговор закончился — найти, к какому звонку он относится. Канал ARI живёт
 *  ровно одну сессию, поэтому по нему запись единственна. */
export async function findPostShowingCallByChannel(
  channelId: string
): Promise<(DueCall & { skipReason: string | null; status: string }) | null> {
  return prisma.postShowingCall.findFirst({
    where: { channelId },
    orderBy: { lastAttemptAt: "desc" },
    select: {
      id: true,
      status: true,
      skipReason: true,
      showingId: true,
      clientId: true,
      agentId: true,
      propertyId: true,
      attempts: true,
      scheduledFor: true,
    },
  });
}

/**
 * Звонили ли этому клиенту с указанного момента — для недельного лимита.
 *
 * Считаются ПОПЫТКИ НАБОРА (`lastAttemptAt`), а не заведённые записи: запись,
 * которую пропустили по нерабочему часу или отсутствию телефона, человека не
 * побеспокоила и права на тишину не расходует. Покупатель, посмотревший за
 * неделю три объекта, получает один звонок, а не три (решение владельца:
 * автозвонки не должны превратиться в поток).
 *
 * `excludeId` — запись, которую сейчас собираются набрать. Её собственная
 * прошлая попытка в лимит не идёт: после немого звонка (`no_station_audio`) или
 * сбоя на нашей стороне попытка возвращается (`attempts` снова 0), а
 * `lastAttemptAt` остаётся час назад — и без исключения повтор молча гас бы
 * как `weekly_limit` собственной же записью (аудит 02.10.2026, №5).
 */
export async function hasRecentPostShowingCall(clientId: string, since: Date, excludeId?: string): Promise<boolean> {
  const recent = await prisma.postShowingCall.findFirst({
    where: { clientId, lastAttemptAt: { gte: since }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  return recent !== null;
}
