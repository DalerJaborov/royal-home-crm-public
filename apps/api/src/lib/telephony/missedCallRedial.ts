import { isForeignPhone, stationDialRefusal } from "@royal-home/shared";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { closeAutoTasks } from "../autoTasks.js";
import { describeError } from "../describeError.js";
import { dushanbeNextOccurrence, isWithinDushanbeWindow } from "../dushanbeTime.js";
import { findStaffPhone } from "../staffPhoneGuard.js";
import { logSystemError } from "../systemError.js";
import { logTimeline } from "../timeline.js";
import { beginOrigination, endOrigination, hasLiveCall } from "./callTracker.js";
import { dialOperatorThenClient, loadDutyOperator } from "./callbackConnect.js";
import { isCompanyPhone } from "./missedCallFollowup.js";
import { phoneTail } from "../clientPhones.js";

/**
 * АВТОПЕРЕЗВОН ПРОПУЩЕННЫМ (28.11.2026, решения владельца: попытки через 5/30/120 минут в
 * рабочие часы, дежурный = Settings.callbackOperatorAgentId).
 *
 * Пропущенный входящий ставит номер в очередь. Тик раз в минуту (в процессе api, рядом с картой
 * живых звонков: callMemoryTicks.ts) звонит дежурному оператору, станция соединяет его с клиентом:
 * тот же путь, что у «Позвонить сейчас» (dialOperatorThenClient). Ночные попытки сдвигаются на
 * утро. Дежурный занят: попытка переносится на 2 минуты, а не сгорает.
 *
 * НЕ СОЗДАЁТ CallbackRequest (он попал бы в баннер агентам и задвоил). Руководству ничего не
 * шлёт (решение 20.09: напоминаний и эскалаций по пропущенным нет). СМС клиенту после неудач НЕ
 * шлём вовсе: владелец отказался 28.11.2026. После последней неудачи: статус gave_up и строка
 * в хронологии карточки (карточку и её статусы не трогаем).
 *
 * Рубильник Settings.missedCallRedialEnabled, по умолчанию ВЫКЛ: выключено, и ничего не ставится
 * в очередь и никому не звонится.
 */

export const REDIAL_DEFAULT_DELAYS_MIN = [5, 30, 120] as const;
export const REDIAL_MAX_ATTEMPTS = 5;
/** Дежурный занят: не жжём попытку, возвращаемся через это время. */
export const REDIAL_BUSY_RETRY_MS = 2 * 60 * 1000;
/** Дежурного нет: смотрим снова через это время. */
export const REDIAL_NO_OPERATOR_RETRY_MS = 30 * 60 * 1000;
/** Сколько ждём итог набранного звонка, прежде чем считать попытку неудачной без итога. */
export const REDIAL_OUTCOME_WAIT_MS = 15 * 60 * 1000;
/** Без карточки итог не виден: даём станции столько времени и считаем попытку неудачной без итога. */
export const REDIAL_NO_CARD_SETTLE_MS = 3 * 60 * 1000;
/** Тишина после последней неудачи, после которой чистка закрывает автозадачу (рубильник «чистка»). */
export const REDIAL_JUNK_QUIET_MS = 7 * 24 * 60 * 60 * 1000;
/** После закрытой серии новую для того же номера не начинаем так долго. */
export const REDIAL_RESERIES_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** Дежурный не снял трубку: попытка клиента не тратится, пробуем снова через это время... */
export const REDIAL_OPERATOR_NO_PICKUP_RETRY_MS = 2 * 60 * 1000;
/** ...но не больше стольких раз подряд быстро, дальше пауза подлиннее... */
export const REDIAL_OPERATOR_NO_PICKUP_QUICK_TRIES = 3;
export const REDIAL_OPERATOR_NO_PICKUP_LONG_RETRY_MS = 30 * 60 * 1000;
/** ...и после стольких молчаний дежурного серию закрываем: звонить некому. */
export const REDIAL_OPERATOR_NO_PICKUP_GIVE_UP = 8;

const MINUTE_MS = 60 * 1000;

/**
 * Номера, по которым набор УЖЕ ушёл, но запись об этом в базу не легла (сбой базы после набора). Живёт в памяти
 * процесса: пока запись не обновлена, этот номер тик второй раз не набирает ни при каких условиях.
 */
const dialGuard = new Map<string, number>();

/** «5,30,120» → [5, 30, 120]. Мусор отбрасывается; пусто или всё мусор: значения по умолчанию. */
export function parseRedialDelays(raw: string | null | undefined): number[] {
  const parsed = String(raw ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 24 * 60)
    .slice(0, REDIAL_MAX_ATTEMPTS);
  return parsed.length > 0 ? parsed : [...REDIAL_DEFAULT_DELAYS_MIN];
}

/**
 * КОГДА СЛЕДУЮЩАЯ ПОПЫТКА (чистая функция). `from` + пауза; если выпало вне рабочего окна по
 * Душанбе (UTC+5), то на ближайшее начало окна. Окно «HH:MM» как в Settings.workHoursStart/End.
 */
export function computeNextAttemptAt(from: Date, delayMinutes: number, workStart: string, workEnd: string): Date {
  const candidate = new Date(from.getTime() + delayMinutes * MINUTE_MS);
  if (isWithinDushanbeWindow(workStart, workEnd, candidate)) return candidate;
  return dushanbeNextOccurrence(workStart, candidate);
}

/** Итог набранной попытки. null: итога ещё нет, ждём. */
export type RedialAttemptResult = "answered" | "no_answer" | "operator_no_pickup" | "unknown" | null;

/**
 * Чистое решение по итогу попытки: `callAttempt` из записи звонка (callTracker) и её возраст.
 * Дозвонились (TALKED): успех. Клиент не ответил или отмена: неудача. Дежурный не снял: не попытка клиента. Итога нет: с карточкой ждём
 * конца разговора до REDIAL_OUTCOME_WAIT_MS, без карточки итога не будет вообще, ждём недолго.
 */
export function judgeAttempt(callAttempt: string | null | undefined, hasInteraction: boolean, attemptAgeMs: number): RedialAttemptResult {
  if (callAttempt === "TALKED") return "answered";
  // Дежурный не снял трубку: до клиента вызов не дошёл, это не неудача клиента.
  if (callAttempt === "AGENT_NO_PICKUP") return "operator_no_pickup";
  if (callAttempt === "NO_ANSWER" || callAttempt === "CANCELLED") return "no_answer";
  const wait = hasInteraction ? REDIAL_OUTCOME_WAIT_MS : REDIAL_NO_CARD_SETTLE_MS;
  return attemptAgeMs >= wait ? "unknown" : null;
}

interface RedialSettings {
  enabled: boolean;
  junkEnabled: boolean;
  delays: number[];
  workStart: string;
  workEnd: string;
  forwardPhone: string | null;
}

async function loadSettings(): Promise<RedialSettings> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      missedCallRedialEnabled: true,
      missedCallRedialJunkEnabled: true,
      missedCallRedialDelays: true,
      workHoursStart: true,
      workHoursEnd: true,
      incomingForwardPhone: true,
    },
  });
  return {
    enabled: s?.missedCallRedialEnabled === true,
    junkEnabled: s?.missedCallRedialJunkEnabled === true,
    delays: parseRedialDelays(s?.missedCallRedialDelays),
    workStart: s?.workHoursStart ?? "09:30",
    workEnd: s?.workHoursEnd ?? "18:00",
    forwardPhone: s?.incomingForwardPhone ?? null,
  };
}

export type RedialScheduleStatus =
  | "scheduled"
  | "already_queued"
  | "disabled"
  | "no_phone"
  | "not_dialable"
  | "company_number"
  | "staff"
  | "irrelevant"
  | "recent_series"
  | "error";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/**
 * Поставить пропущенный в очередь автоперезвона. Не бросает: звонок и его итог важнее.
 * Вызывается из finishIncomingCall в ветке «не отвечен», рядом с sendMissedCallSms.
 * Один номер = одна живая строка очереди (частичный уникальный индекс): повторный звонок только
 * обновляет ссылку на звонок и карточку, расписание и счётчик попыток не сбрасывает.
 */
export async function scheduleMissedCallRedial(input: {
  phone: string | null | undefined;
  incomingCallId?: string | null;
  clientId?: string | null;
  callSource?: string | null;
  now?: Date;
}): Promise<RedialScheduleStatus> {
  try {
    const settings = await loadSettings();
    if (!settings.enabled) return "disabled";

    const phone = (input.phone ?? "").trim();
    // Звонок из WhatsApp без настоящего номера (только идентификатор) набрать нельзя.
    if (phone.replace(/\D/g, "").length < 9) return "no_phone";
    if (isForeignPhone(phone) || stationDialRefusal(phone)) return "not_dialable";
    if (isCompanyPhone(phone, settings.forwardPhone)) return "company_number";
    if (await findStaffPhone([phone])) return "staff";
    // Хоть раз «не по делу» (курьер, реклама): не перезваниваем.
    if ((await prisma.incomingCall.count({ where: { phone, irrelevant: true } })) >= 1) return "irrelevant";

    const now = input.now ?? new Date();
    const existing = await prisma.missedCallRedial.findFirst({ where: { phone, status: "pending" }, select: { id: true } });
    if (existing) {
      await prisma.missedCallRedial.update({
        where: { id: existing.id },
        data: {
          ...(input.incomingCallId ? { incomingCallId: input.incomingCallId } : {}),
          ...(input.clientId ? { clientId: input.clientId } : {}),
        },
      });
      return "already_queued";
    }
    const recent = await prisma.missedCallRedial.findFirst({
      where: { phone, status: { not: "pending" }, createdAt: { gte: new Date(now.getTime() - REDIAL_RESERIES_COOLDOWN_MS) } },
      select: { id: true },
    });
    if (recent) return "recent_series";

    try {
      await prisma.missedCallRedial.create({
        data: {
          phone,
          incomingCallId: input.incomingCallId ?? null,
          clientId: input.clientId ?? null,
          source: input.callSource === "whatsapp" ? "whatsapp" : "phone",
          nextAttemptAt: computeNextAttemptAt(now, settings.delays[0], settings.workStart, settings.workEnd),
        },
      });
    } catch (err) {
      // Параллельный второй звонок успел раньше: очередь уже есть.
      if (isUniqueViolation(err)) return "already_queued";
      throw err;
    }
    return "scheduled";
  } catch (err) {
    void logSystemError("telephony", `Автоперезвон пропущенному: не поставлен в очередь: ${describeError(err)}`, { dedupKey: "missed-call-redial-schedule" });
    return "error";
  }
}

export type RedialTickStatus = "disabled" | "idle" | "off_hours" | "no_operator" | "operator_busy" | "dialed" | "closed" | "failed";

type Row = Prisma.MissedCallRedialGetPayload<object>;

async function closeRow(
  id: string,
  status: "done" | "skipped" | "gave_up" | "junk",
  reason: string,
  extra: Prisma.MissedCallRedialUpdateInput = {}
): Promise<void> {
  await prisma.missedCallRedial.update({ where: { id }, data: { status, closedReason: reason, ...extra } });
}

function attemptsWord(n: number): string {
  return n === 1 ? "попытку" : n < 5 ? "попытки" : "попыток";
}

/** Разобрать итог набранной попытки. true — строка продвинулась. */
async function settleAttempt(row: Row, settings: RedialSettings, now: Date): Promise<boolean> {
  const lastAt = row.lastAttemptAt;
  if (!lastAt) return false;
  let callAttempt: string | null = null;
  if (row.lastInteractionId) {
    const i = await prisma.interaction.findUnique({ where: { id: row.lastInteractionId }, select: { callAttempt: true } });
    callAttempt = i?.callAttempt ?? null;
  }
  const verdict = judgeAttempt(callAttempt, !!row.lastInteractionId, now.getTime() - lastAt.getTime());
  if (verdict === null) return false;
  if (verdict === "answered") {
    await closeRow(row.id, "done", "answered", { lastOutcome: "answered" });
    return true;
  }
  if (!row.lastInteractionId) {
    // Карточки не было: что вышло из звонка, не видно, повторять вслепую нельзя.
    await closeRow(row.id, "gave_up", "outcome_unseen", { lastOutcome: verdict });
    return true;
  }
  if (verdict === "operator_no_pickup") {
    // Попытка клиента не потрачена: снимаем её и переносим, как при занятом дежурном.
    const misses = row.operatorNoPickups + 1;
    if (misses >= REDIAL_OPERATOR_NO_PICKUP_GIVE_UP) {
      await closeRow(row.id, "gave_up", "operator_unreachable", { attempts: Math.max(0, row.attempts - 1), operatorNoPickups: misses, lastOutcome: verdict });
      return true;
    }
    const wait = misses <= REDIAL_OPERATOR_NO_PICKUP_QUICK_TRIES ? REDIAL_OPERATOR_NO_PICKUP_RETRY_MS : REDIAL_OPERATOR_NO_PICKUP_LONG_RETRY_MS;
    await prisma.missedCallRedial.update({
      where: { id: row.id },
      data: { attempts: Math.max(0, row.attempts - 1), operatorNoPickups: misses, lastOutcome: verdict, nextAttemptAt: new Date(now.getTime() + wait) },
    });
    return true;
  }
  if (row.attempts >= settings.delays.length) {
    await closeRow(row.id, "gave_up", "attempts_exhausted", { lastOutcome: verdict });
    if (row.clientId) {
      try {
        await logTimeline({
          clientId: row.clientId,
          actor: { kind: "system", source: "missed-call-redial" },
          type: "SYSTEM",
          notes: `Автоперезвон пропущенному: не дозвонились, ${row.attempts} ${attemptsWord(row.attempts)}`,
        });
      } catch (err) {
        void logSystemError("telephony", `Автоперезвон: итог «не дозвонились» не записан в хронологию: ${describeError(err)}`);
      }
    }
    return true;
  }
  await prisma.missedCallRedial.update({
    where: { id: row.id },
    data: {
      lastOutcome: verdict,
      nextAttemptAt: computeNextAttemptAt(lastAt, settings.delays[row.attempts], settings.workStart, settings.workEnd),
    },
  });
  return true;
}

/** Чистка (рубильник): после неудач и недели тишины закрыть открытую автозадачу «перезвонить». Карточку не трогаем. */
async function sweepJunk(now: Date): Promise<void> {
  const rows = await prisma.missedCallRedial.findMany({
    where: { status: "gave_up", closedReason: "attempts_exhausted", lastAttemptAt: { lt: new Date(now.getTime() - REDIAL_JUNK_QUIET_MS) } },
    take: 20,
    orderBy: { lastAttemptAt: "asc" },
  });
  for (const row of rows) {
    const later = await prisma.incomingCall.count({ where: { phone: row.phone, startedAt: { gt: row.lastAttemptAt ?? now } } });
    if (later > 0) {
      await prisma.missedCallRedial.update({ where: { id: row.id }, data: { closedReason: "active_after_giveup" } });
      continue;
    }
    if (row.clientId) await closeAutoTasks(row.clientId, ["inbound_missed_callback"], now);
    await closeRow(row.id, "junk", "quiet_after_giveup");
  }
}

/** Условия, при которых звонить уже не нужно. Возвращает причину закрытия или null. */
async function closeReasonBeforeDial(row: Row): Promise<{ status: "done" | "skipped"; reason: string } | null> {
  const calls = await prisma.incomingCall.findMany({
    where: { phone: row.phone, startedAt: { gte: row.createdAt } },
    select: { answered: true, irrelevant: true, voicemailFile: true },
  });
  if (calls.some((c) => c.irrelevant)) return { status: "skipped", reason: "irrelevant" };
  if (calls.some((c) => c.answered)) return { status: "done", reason: "self_answered" };
  // Наговорил на автоответчик: это разбирает человек, перезвон не нужен.
  const first = row.incomingCallId
    ? await prisma.incomingCall.findUnique({ where: { id: row.incomingCallId }, select: { voicemailFile: true } })
    : null;
  if (first?.voicemailFile || calls.some((c) => c.voicemailFile)) return { status: "skipped", reason: "voicemail" };
  // Замок голосовой почты встаёт раньше, чем имя файла попадает в звонок: смотрим и его.
  const tail = phoneTail(row.phone);
  if ((await prisma.voicemailMessage.count({ where: { phone: { endsWith: tail }, recordedAt: { gte: row.createdAt } } })) > 0) {
    return { status: "skipped", reason: "voicemail" };
  }
  // Человек уже занимается: открыта просьба «перезвоните» или у агента висит его задача «перезвонить».
  const request = await prisma.callbackRequest.count({
    where: { doneAt: null, OR: [{ phone: { endsWith: tail } }, ...(row.clientId ? [{ clientId: row.clientId }] : [])] },
  });
  if (request > 0) return { status: "skipped", reason: "open_callback_request" };
  if (row.clientId) {
    const agentTask = await prisma.interaction.count({
      where: {
        clientId: row.clientId,
        autoTaskKind: "inbound_missed_callback",
        nextAction: { not: null },
        completedAt: null,
        taskCancelledAt: null,
        subjectAgentId: { not: null },
      },
    });
    if (agentTask > 0) return { status: "skipped", reason: "agent_task" };
  }
  if (row.clientId) {
    const talked = await prisma.interaction.count({
      where: { clientId: row.clientId, type: "CALL", callAttempt: "TALKED", createdAt: { gte: row.createdAt } },
    });
    if (talked > 0) return { status: "done", reason: "called_by_agent" };
  }
  return null;
}

/**
 * Один тик (раз в минуту): разобрать итоги набранных попыток, затем позвонить ОДНОМУ по очереди.
 * Один звонок за тик: оператор один, пачка originate дала бы ему стопку гудков.
 */
export async function runMissedCallRedialTick(now: Date = new Date()): Promise<RedialTickStatus> {
  const settings = await loadSettings();
  if (!settings.enabled) return "disabled";

  // 1. Итоги уже набранных попыток (звонить не нужно, поэтому можно пачкой).
  const awaiting = await prisma.missedCallRedial.findMany({
    where: { status: "pending", lastAttemptAt: { not: null }, lastOutcome: null },
    orderBy: { lastAttemptAt: "asc" },
    take: 20,
  });
  for (const row of awaiting) {
    try {
      await settleAttempt(row, settings, now);
    } catch (err) {
      void logSystemError("telephony", `Автоперезвон: итог попытки не разобран: ${describeError(err)}`, { dedupKey: "missed-call-redial-settle" });
    }
  }

  if (settings.junkEnabled) {
    try {
      await sweepJunk(now);
    } catch (err) {
      void logSystemError("telephony", `Автоперезвон: чистка не прошла: ${describeError(err)}`, { dedupKey: "missed-call-redial-junk" });
    }
  }

  // 2. Позвонить одному: самый давний из подошедших (итог прошлой попытки уже известен).
  for (const [phone, until] of dialGuard) if (until <= now.getTime()) dialGuard.delete(phone);
  const row = await prisma.missedCallRedial.findFirst({
    where: {
      status: "pending",
      nextAttemptAt: { lte: now },
      OR: [{ lastAttemptAt: null }, { lastOutcome: { not: null } }],
      ...(dialGuard.size > 0 ? { phone: { notIn: [...dialGuard.keys()] } } : {}),
    },
    orderBy: { nextAttemptAt: "asc" },
  });
  if (!row) return "idle";

  const closedBy = await closeReasonBeforeDial(row);
  if (closedBy) {
    await closeRow(row.id, closedBy.status, closedBy.reason);
    return "closed";
  }

  if (!isWithinDushanbeWindow(settings.workStart, settings.workEnd, now)) {
    await prisma.missedCallRedial.update({ where: { id: row.id }, data: { nextAttemptAt: dushanbeNextOccurrence(settings.workStart, now) } });
    return "off_hours";
  }

  const operator = await loadDutyOperator();
  if (!operator) {
    await prisma.missedCallRedial.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(now.getTime() + REDIAL_NO_OPERATOR_RETRY_MS) } });
    return "no_operator";
  }
  if (hasLiveCall(operator.id) || !beginOrigination(operator.id)) {
    await prisma.missedCallRedial.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(now.getTime() + REDIAL_BUSY_RETRY_MS) } });
    return "operator_busy";
  }
  let dialPlaced = false;
  try {
    const cardId =
      row.clientId ??
      (row.incomingCallId ? (await prisma.incomingCall.findUnique({ where: { id: row.incomingCallId }, select: { clientId: true } }))?.clientId : null) ??
      null;
    const client = cardId
      ? await prisma.client.findFirst({ where: { id: cardId, deletedAt: null }, select: { id: true, shortId: true, fullName: true } })
      : null;
    if (cardId && !client) {
      await closeRow(row.id, "skipped", "client_deleted");
      return "closed";
    }

    // Замок на случай сбоя базы ПОСЛЕ набора: пока запись не обновлена, этот номер второй раз не набираем.
    dialGuard.set(row.phone, now.getTime() + REDIAL_OUTCOME_WAIT_MS);
    const dialed = await dialOperatorThenClient({
      operator,
      phone: row.phone,
      client,
      topic: "пропущенный звонок, перезваниваем",
      callerName: `Пропущенный: ${client?.fullName ?? row.phone}`,
      notePrefix: "Автоперезвон по пропущенному",
      redial: true,
    });
    if (dialed.outcome === "not_dialable") {
      await closeRow(row.id, "skipped", "not_dialable");
      dialGuard.delete(row.phone);
      return "closed";
    }
    const attempts = row.attempts + 1;
    const base = { attempts, lastAttemptAt: now, clientId: client?.id ?? row.clientId };
    if (dialed.outcome === "failed") {
      // Станция не набрала: считаем попыткой, иначе сбой станции крутил бы очередь бесконечно.
      if (attempts >= settings.delays.length) {
        await closeRow(row.id, "gave_up", "station_failed", { ...base, lastOutcome: "failed" });
      } else {
        await prisma.missedCallRedial.update({
          where: { id: row.id },
          data: {
            ...base,
            lastOutcome: "failed",
            nextAttemptAt: computeNextAttemptAt(now, settings.delays[attempts], settings.workStart, settings.workEnd),
          },
        });
      }
      dialGuard.delete(row.phone);
      return "failed";
    }
    dialPlaced = true;
    if (!client) {
      // Без карточки итог звонка не виден: повторно по этому номеру автоматически не звоним (одна попытка).
      await closeRow(row.id, "gave_up", "outcome_unseen", { ...base, lastOutcome: "unknown" });
    } else {
      await prisma.missedCallRedial.update({
        where: { id: row.id },
        data: { ...base, lastOutcome: null, lastInteractionId: dialed.interactionId },
      });
    }
    dialGuard.delete(row.phone);
    return "dialed";
  } catch (err) {
    void logSystemError("telephony", `Автоперезвон пропущенному: сбой попытки: ${describeError(err)}`, { dedupKey: "missed-call-redial-dial" });
    if (dialPlaced) {
      // Звонок уже ушёл, а запись не легла (сбой базы): второй попыткой сдвигаем срок, чтобы не набирать каждую минуту.
      // Не вышло и это: номер остаётся под замком в памяти (dialGuard) до конца ожидания итога.
      await prisma.missedCallRedial
        .update({
          where: { id: row.id },
          data: { attempts: { increment: 1 }, lastAttemptAt: now, nextAttemptAt: new Date(now.getTime() + REDIAL_OUTCOME_WAIT_MS) },
        })
        .then(() => dialGuard.delete(row.phone))
        .catch(() => {});
    } else {
      dialGuard.delete(row.phone);
    }
    return "failed";
  } finally {
    endOrigination(operator.id);
  }
}

/** Сколько попыток автоперезвона набрано за 7 дней: строка «включено, N» в реестре функций. */
export async function countMissedCallRedialDialed(days = 7, now: Date = new Date()): Promise<number> {
  return prisma.missedCallRedial.count({
    where: { lastAttemptAt: { gte: new Date(now.getTime() - days * 24 * 60 * 60 * 1000) } },
  });
}
