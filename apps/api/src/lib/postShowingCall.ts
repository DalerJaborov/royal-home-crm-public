import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { recordInvestigationSignal } from "./investigationCases.js";
import { conductedShowingBaseWhere } from "./conductedShowing.js";
import { isWeekdayOff, confirmedClientIntents } from "@royal-home/shared";
import { loadTrafficLightSettings } from "./inactiveTrafficLight.js";
import { isAlarmDayOff } from "./alarmCalendar.js";
import { companyDaysOffSnapshot, loadCompanyDaysOff } from "./daysOffCalendar.js";
import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "./dushanbeTime.js";
import { logSystemAudit } from "./audit.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { scenarioCallBlockReason } from "./scenarioCallEligibility.js";
import { logSystemError } from "./systemError.js";
import { originateLiveVoiceScenarioCall } from "./telephony/liveVoiceBridge.js";
import { LIVE_VOICE_STATION_AUDIO_RETRY_MS, NO_STATION_AUDIO_REASON } from "./telephony/liveVoiceAudioPath.js";
import { scenarioVoice } from "./telephony/scenarioVoice.js";
import { clientLinesOf, looksLikeVoicemail } from "../ai/scenarioTranscript.js";
import type { LiveVoiceScenarioResult } from "./telephony/liveVoiceBridge.js";
import { parsePostShowingCall, POST_SHOWING_CALL_RED_OUTCOMES } from "../ai/postShowingCallParse.js";
import type { PostShowingCallOutcome } from "../generated/prisma/client.js";
import {
  buildPostShowingCallPrompt,
  POST_SHOWING_CALL_GREETING_TRIGGER,
  POST_SHOWING_CALL_TOOLS,
} from "../ai/postShowingCallPersona.js";
import {
  claimPostShowingCall,
  duePostShowingCalls,
  findPostShowingCallByChannel,
  hasRecentPostShowingCall,
  hasScenarioCallMark,
  withScenarioCallMark,
  markPostShowingCallNoAnswer,
  markPostShowingCallSkipped,
  markPostShowingCallStarted,
  releasePostShowingCallClaim,
  savePostShowingCallOutcome,
  schedulePostShowingCall,
  POST_SHOWING_CALL_MAX_ATTEMPTS,
} from "./postShowingCalls.js";

/**
 * РАСПИСАНИЕ РОБОЗВОНКА ПОКУПАТЕЛЮ ПОСЛЕ ПОКАЗА — все правила «звонить или нет»
 * собраны здесь (доступ к таблице — `lib/postShowingCalls.ts`, сам разговор —
 * `ai/postShowingCallPersona.ts`, звонок — `lib/telephony/liveVoiceBridge.ts`).
 *
 * КРОН, А НЕ ОЧЕРЕДЬ ЗАДАНИЙ, и причина решающая: показ ПЕРЕНОСЯТ. Задание
 * несёт `runAt`, снятый в момент постановки, а перепостановка с тем же ключом,
 * пока задание `PENDING`, — no-op: звонок ушёл бы по старому часу к
 * перенесённому показу. `jobs/dealReviewAsk.ts` стоит в очереди законно —
 * закрытая сделка не переезжает.
 *
 * ГЛАВНОЕ ОГРАНИЧЕНИЕ, ИЗ-ЗА КОТОРОГО ВСЁ ЭТО НЕ ПРЕВРАЩАЕТСЯ В ПОТОК
 * АВТОЗВОНКОВ: звоним не после каждого показа, а только туда, где после показа
 * САМ КЛИЕНТ в CRM ничего не сказал. Записи агента тишину не снимают — его
 * слова и есть то, что проверяется (см. docs/buyer-antifraud-funnel-13-09-2026.md).
 */

/** Через сколько после показа звонить. Два с половиной часа: раньше — человек
 *  ещё с агентом и ответит при нём, позже того же вечера — впечатление тускнеет. */
export const POST_SHOWING_CALL_AFTER_MS = 150 * 60 * 1000;

/**
 * ЧАСЫ, КОГДА ВООБЩЕ МОЖНО ЗВОНИТЬ (решение владельца 16.09.2026: «звонить
 * можно только до 19:00»).
 *
 * НАМЕРЕННО УЖЕ, ЧЕМ ОКНО СООБЩЕНИЙ (09:00–20:00, `meetingReminders.ts`) — и
 * поэтому константы свои, а не заимствованные: непрочитанное сообщение ждёт
 * утра молча, а звонок в девять вечера будит.
 */
export const POST_SHOWING_CALL_DAY_START_HOUR = 9;
export const POST_SHOWING_CALL_DAY_END_HOUR = 19;

/** Показ давнее трёх суток не опрашиваем: человек уже посмотрел ещё три
 *  квартиры, и его «не понравилось» относится неизвестно к какой. */
export const POST_SHOWING_CALL_STALE_MS = 3 * 24 * 60 * 60 * 1000;

/** Не чаще одного звонка на клиента в неделю. */
export const POST_SHOWING_CALL_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Вторая попытка — в другое время суток, а не через пять минут. */
export const POST_SHOWING_CALL_RETRY_MS = 5 * 60 * 60 * 1000;

/** Сколько ждём итога начатого звонка, прежде чем считать его потерянным.
 *
 *  Потолок сессии в мосте — 15 минут (`LIVE_VOICE_MAX_SESSION_MS` в
 *  liveVoiceBridge.ts) плюс до минуты гудков. Прежние 10 минут срабатывали
 *  посреди живого разговора: строка уходила в «не дозвонились», а у проверки
 *  продавца — ещё и в аларм директору (аудит 02.10.2026, №14). 20 минут — как у
 *  приглашения кандидата; общая для опроса и проверки продавца. */
export const POST_SHOWING_CALL_STUCK_MS = 20 * 60 * 1000;

/**
 * СБОЙ НА НАШЕЙ СТОРОНЕ — НЕ «НЕ ДОЗВОНИЛИСЬ» (02.10.2026, аудит сценарных звонков №3).
 *
 * Причины конца сессии, в которых человек снял трубку, а разговора не вышло по
 * нашей вине: мост не поднялся (`start_failed: …`), модель упала или закрылась
 * (`gemini_*`), сокет звука (`rtp_socket_error`), выкат (`listener_stopped`),
 * станция (`ari_error`) и немая линия (`no_station_audio`). Записать это как
 * молчание человека значило бы испортить статистику тишины по агенту, а у
 * проверки продавца — объявить живой номер мёртвым.
 */
export function isOurSideCallFailure(reason: string): boolean {
  return (
    reason === NO_STATION_AUDIO_REASON ||
    reason.startsWith("start_failed") ||
    reason.startsWith("gemini_") ||
    reason === "rtp_socket_error" ||
    reason === "listener_stopped" ||
    reason === "ari_error"
  );
}

/** Что `end_call` модели сказал о том, кто взял трубку. Причина приходит
 *  строкой «model_ended_call: …»; русские слова — запасной путь, если модель
 *  написала причину своими словами (аудит №20). */
export function scenarioEndKind(reason: string): "voicemail" | "call_back_later" | "wrong_person" | null {
  const text = reason.toLowerCase().replace(/^model_ended_call:?\s*/, "");
  // Сравнение по СЛОВАМ, а не по вхождению (третий аудит 02.10.2026, низкая): «не тот
  // момент, перезвоните» свободным текстом раньше попадало в «не тот человек».
  const tokens = text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  if (tokens.includes("voicemail") || tokens.some((t) => t.startsWith("автоответчик"))) return "voicemail";
  if (tokens.includes("wrong_person")) return "wrong_person";
  if (tokens.includes("call_back_later")) return "call_back_later";
  // Русские слова — запасной путь, если модель написала причину своими словами.
  const notThatMoment = /не\s+тот\s+(момент|раз|час|день|время)/u.test(text);
  if (!notThatMoment && /не\s+тот/u.test(text)) return "wrong_person";
  if (tokens.some((t) => t.startsWith("перезвон"))) return "call_back_later";
  return null;
}

/**
 * Состоялся ли разговор, несмотря на сбой в конце (третий аудит 02.10.2026, С2):
 * `gemini_closed` или выкат приходят и после четырёхминутной, по сути законченной
 * беседы. Если человек сказал хотя бы две реплики и не меньше ~60 знаков, его слова
 * разбираются как обычный разговор, а не выбрасываются вместе с попыткой.
 */
export function hasSubstantialClientSpeech(transcript: readonly string[]): boolean {
  const lines = transcript.filter((line) => line.startsWith("Клиент:"));
  const chars = lines.reduce((n, line) => n + line.slice("Клиент:".length).trim().length, 0);
  return lines.length >= 2 && chars >= 60;
}

/** Сколько показов разбирает один тик. Предел обязателен: на каждый due-звонок
 *  идёт обращение к станции. */
const BATCH = 20;

/**
 * Разброс внутри получаса, одинаковый для одной и той же записи.
 *
 * Без него все звонки, перенесённые с ночи, ушли бы ровно в 09:00 одной
 * пачкой — станция и модель получили бы залп, а человек в трубке слышал бы
 * паузу, пока очередь до него дойдёт. Детерминированный (от id), чтобы
 * повторный расчёт в следующем тике не двигал час туда-сюда.
 */
export function postShowingCallSpreadMs(seed: string): number {
  const hash = createHash("sha1").update(seed).digest();
  return (hash.readUInt16BE(0) % 30) * 60 * 1000;
}

/**
 * Когда звонить по показу, случившемуся в `showingAt`.
 *
 * Обычный случай — через 2,5 часа. Но если этот момент приходится на ночь или
 * на время после 19:00, звонок НЕ сгорает, а переносится на ближайшее утро:
 * несделанный звонок — это дыра в покрытии опроса, а на покрытии держится вся
 * статистика порога 4.
 *
 * Считается через «настенные» часы Душанбе (`dushanbeWallClock`), а не
 * `setHours`: контейнер живёт в UTC, и локальные часы процесса тут ни при чём.
 */
export function postShowingCallDueAt(showingAt: Date, seed: string): Date {
  return alignToCallHours(new Date(showingAt.getTime() + POST_SHOWING_CALL_AFTER_MS), seed);
}

/**
 * Ближайший разрешённый момент для звонка, не раньше `at`.
 *
 * `seed` — ключ разброса (см. postShowingCallSpreadMs). `null` означает «без
 * разброса, ровно в этот момент»: разброс нужен там, где записи идут пачкой и
 * разом упёрлись бы в 09:00 (опрос покупателей), и вреден там, где звонок
 * штучный — лишние полчаса ожидания на ровном месте (проверка продавца).
 *
 * ВЫХОДНЫЕ — ИЗ НАСТРОЕК (владелец 11.10.2026; с 02.10 до 11.10 здесь было зашито
 * воскресенье, аудит звонков робота А4): звонок, попавший на общий выходной компании
 * (Settings.companyDaysOff), переносится на утро ближайшего рабочего дня. Пусто —
 * выходных нет, робот звонит каждый день. Список берётся снимком
 * (daysOffCalendar.ts::companyDaysOffSnapshot): функцию зовут все три сценария (опрос,
 * проверка продавца, приглашение кандидата) из десятка мест, а их тики первой строкой
 * обновляют снимок. Календаря государственных праздников в CRM нет ни в какой таблице.
 */
export function alignToCallHours(at: Date, seed: string | null, companyDaysOff: readonly number[] = companyDaysOffSnapshot()): Date {
  const cal = { companyDaysOff };
  const spread = seed === null ? 0 : postShowingCallSpreadMs(seed);
  const ideal = new Date(at.getTime() + spread);
  const wall = dushanbeWallClock(ideal);
  const hour = wall.getUTCHours();

  if (hour >= POST_SHOWING_CALL_DAY_START_HOUR && hour < POST_SHOWING_CALL_DAY_END_HOUR && !isAlarmDayOff(ideal, cal)) {
    return ideal;
  }

  // Слишком рано (показ был ночью — редкость, но бывает у записанных задним
  // числом) — ждём того же утра. Слишком поздно — следующего. Утро и вечер
  // выходного одинаково ведут на следующий рабочий день.
  let dayOffset = hour >= POST_SHOWING_CALL_DAY_END_HOUR ? 1 : 0;
  const dayStart = (offset: number) =>
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + offset, POST_SHOWING_CALL_DAY_START_HOUR, 0, 0);
  // Сдвиг на сутки не меняет дня недели по Душанбе: «настенные» часы здесь — UTC-поля.
  // Предохранитель: семь выходных схема не пропускает, но цикл не должен зависеть от этого.
  for (let guard = 0; guard < 7 && isWeekdayOff(new Date(dayStart(dayOffset)).getUTCDay(), cal); guard++) dayOffset++;
  return new Date(dayStart(dayOffset) - DUSHANBE_OFFSET_MS + spread);
}

export function isWithinPostShowingCallHours(now: Date, companyDaysOff: readonly number[] = companyDaysOffSnapshot()): boolean {
  if (isAlarmDayOff(now, { companyDaysOff })) return false;
  const hour = dushanbeWallClock(now).getUTCHours();
  return hour >= POST_SHOWING_CALL_DAY_START_HOUR && hour < POST_SHOWING_CALL_DAY_END_HOUR;
}

/** Когда показ фактически был. Плановый час вернее отметки «выполнено» (её
 *  ставят вечером за весь день); полночь по Душанбе часом показа быть не может
 *  — так ложится дата без времени (см. hasExactTime в meetingReminders.ts). */
export function showingMomentOf(showing: {
  nextActionDate: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  showingEvidenceVersion?: number;
}): Date {
  const planned = showing.nextActionDate;
  if (planned) {
    if ((showing.showingEvidenceVersion ?? 0) >= 1) return planned;
    const wall = dushanbeWallClock(planned);
    const isMidnight = wall.getUTCHours() === 0 && wall.getUTCMinutes() === 0;
    if (!isMidnight) return planned;
  }
  return showing.completedAt ?? showing.createdAt;
}

/** «сегодня днём», «вчера вечером» — чтобы бот не зачитывал дату вслух. */
export function showingWhenLabel(showingAt: Date, now: Date): string {
  const wallShowing = dushanbeWallClock(showingAt);
  const wallNow = dushanbeWallClock(now);
  const days = Math.round(
    (Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate()) -
      Date.UTC(wallShowing.getUTCFullYear(), wallShowing.getUTCMonth(), wallShowing.getUTCDate())) /
      86_400_000
  );
  const hour = wallShowing.getUTCHours();
  const partOfDay = hour < 12 ? "утром" : hour < 17 ? "днём" : "вечером";
  if (days <= 0) return `сегодня ${partOfDay}`;
  if (days === 1) return `вчера ${partOfDay}`;
  return `${days} дня назад, ${partOfDay}`;
}

/**
 * Ставит звонки по показам, которые уже состоялись.
 *
 * Ставит ВСЕМ подходящим показам, даже тем, по которым звонить в итоге не
 * придётся: решение «не звонить» принимается в момент набора и записывается
 * причиной в ту же запись. Иначе покрытие опроса нельзя посчитать — пропущенный
 * звонок был бы неотличим от показа, которого система не заметила вовсе.
 */
export async function schedulePostShowingCalls(now: Date = new Date()): Promise<number> {
  const automation = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { buyerSellerAutomationMode: true } });
  // Снимок общих выходных для alignToCallHours (Настройки, 11.10.2026).
  await loadCompanyDaysOff();
  // Apply the occurrence window before LIMIT. An appointment created weeks ago
  // can have happened today; future bookings must not crowd it out of the batch.
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s.id FROM "Interaction" s JOIN "Client" c ON c.id=s."clientId"
    CROSS JOIN LATERAL (SELECT CASE
      WHEN s."nextActionDate" IS NOT NULL
        AND (s."showingEvidenceVersion" >= 1 OR to_char(s."nextActionDate" + interval '5 hours', 'HH24:MI') <> '00:00')
      THEN s."nextActionDate" ELSE COALESCE(s."completedAt", s."createdAt") END AS at) occurrence
    WHERE s.type='SHOWING' AND s."declinedAt" IS NULL AND s."taskCancelledAt" IS NULL
      AND s."nextActionDate" IS NOT NULL
      AND (s."showingEvidenceVersion" >= 1 OR to_char(s."nextActionDate" + interval '5 hours', 'HH24:MI') <> '00:00')
      AND COALESCE(s."subjectAgentId",s."agentId") IS NOT NULL
      AND c."deletedAt" IS NULL
      AND (s."buyerIntentAtCreation"=true OR (s."buyerIntentAtCreation" IS NULL AND
        (c.kind='BUYER' OR (c.kind='SELLER' AND c."dualIntent"=true AND c."dualIntentConfirmedAt" IS NOT NULL))))
      AND occurrence.at >= ${new Date(now.getTime() - POST_SHOWING_CALL_STALE_MS)} AND occurrence.at <= ${now}
      AND NOT EXISTS (SELECT 1 FROM "PostShowingCall" p WHERE p."showingId"=s.id)
    ORDER BY occurrence.at DESC, s.id LIMIT 100`;
  const showings = await prisma.interaction.findMany({
    where: {
      ...conductedShowingBaseWhere(now),
      id: { in: candidates.map(row => row.id) },
      postShowingCall: { is: null },
      client: { deletedAt: null },
      AND: [{ OR: [{ buyerIntentAtCreation: true }, { buyerIntentAtCreation: null,
        client: { OR: [{ kind: "BUYER" }, { kind: "SELLER", dualIntent: true, dualIntentConfirmedAt: { not: null } }] } }] }],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      clientId: true,
      agentId: true,
      subjectAgentId: true,
      propertyId: true,
      nextActionDate: true,
      completedAt: true,
      createdAt: true,
      showingEvidenceVersion: true,
    },
  });

  let scheduled = 0;
  for (const showing of showings) {
    // Показ без агента (SYSTEM/AI-запись без subjectAgentId) — робозвонок
    // спрашивать некого, пропускаем (П-10, 17.09.2026).
    const agentId = showing.subjectAgentId ?? showing.agentId;
    if (!agentId) continue;
    const showingAt = showingMomentOf(showing);
    if (showingAt.getTime() > now.getTime()) continue;
    if (now.getTime() - showingAt.getTime() > POST_SHOWING_CALL_STALE_MS) continue;

    const result = await schedulePostShowingCall({
      showingId: showing.id,
      clientId: showing.clientId,
      agentId,
      propertyId: showing.propertyId,
      scheduledFor: postShowingCallDueAt(showingAt, showing.id),
      previewOnly: automation?.buyerSellerAutomationMode !== "LIVE",
    });
    if (result === "created") scheduled++;
  }
  return scheduled;
}

/**
 * Сказал ли САМ КЛИЕНТ хоть что-то после показа.
 *
 * Два следа, и оба — слова клиента, а не агента: входящее сообщение в любом
 * канале (`Client.lastClientMessageAt`) и состоявшийся разговор через АТС
 * (он записывается и разбирается ИИ, то есть слепой зоны в нём нет).
 * `lastContactAt` и `lastAgentAttemptAt` сюда не годятся: их двигает сам агент.
 */
export async function clientSpokeAfterShowing(clientId: string, showingAt: Date): Promise<boolean> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { lastClientMessageAt: true },
  });
  if (client?.lastClientMessageAt && client.lastClientMessageAt > showingAt) return true;

  const settings = await loadTrafficLightSettings();
  const talked = await prisma.interaction.findFirst({
    where: { clientId, type: "CALL", callAttempt: "TALKED", recordingDurationSec: { gte: settings.leadCallMinSeconds }, createdAt: { gt: showingAt } },
    select: { id: true },
  });
  return talked !== null;
}

/** Зависшие звонки: набрали, а итога так и не было (трубку не взяли — сессия в
 *  мосте не поднималась вовсе, значит и обработчик завершения не звал никто). */
async function releaseStuckCalls(now: Date): Promise<void> {
  const stuck = await prisma.postShowingCall.findMany({
    where: { status: "CALLING", lastAttemptAt: { lt: new Date(now.getTime() - POST_SHOWING_CALL_STUCK_MS) } },
    take: BATCH,
    select: { id: true, attempts: true, skipReason: true, channelId: true },
  });
  // Недозвон мост теперь сообщает сам (reason "no_answer", сразу по истечении
  // гудков). Строка, провисевшая в CALLING дольше потолка сессии, — это итог,
  // потерянный НАМИ (выкат посреди звонка, упавший обработчик), а не молчание
  // человека: обрабатывается как сбой на нашей стороне.
  for (const call of stuck) {
    // ЗАНЯТА, НО НЕ НАБРАНА (третий аудит 02.10.2026, В3): процесс умер между
    // занятием записи и ответом станции — канала нет, `attempts` не увеличивался.
    // Звонка не было, возвращать нечего: прежний «возврат» вычитал попытку у строки,
    // которой никто не набирал, и покупателю доставалось на звонок больше обещанных
    // двух, а единственный `attempt_returned` сгорал впустую.
    if (!call.channelId) {
      await prisma.postShowingCall.updateMany({
        where: { id: call.id, status: "CALLING", channelId: null },
        data: {
          status: call.attempts > 0 ? "NO_ANSWER" : "PENDING",
          // Время «попытки» поставило занятие, а не набор: у нетронутой строки оно не должно
          // считаться за недельный лимит клиента.
          ...(call.attempts === 0 ? { lastAttemptAt: null } : {}),
          scheduledFor: alignToCallHours(new Date(now.getTime() + POST_SHOWING_CALL_BUSY_RETRY_MS), call.id),
        },
      });
      continue;
    }
    await handleOurSideFailure(call, now);
  }
}

/**
 * Сбой на нашей стороне (см. isOurSideCallFailure): попытка возвращается, но не
 * больше ОДНОГО раза на запись (аудит №4). Второй такой звонок — запись
 * закрывается как SKIPPED `station_down`: это не молчание покупателя, в
 * статистику тишины и в проверку продавца она не идёт.
 */
async function handleOurSideFailure(
  call: { id: string; attempts: number; skipReason: string | null },
  now: Date
): Promise<void> {
  if (hasScenarioCallMark(call.skipReason, "attempt_returned")) {
    await markPostShowingCallSkipped(call.id, "station_down");
    return;
  }
  const attemptsLeft = Math.max(0, call.attempts - 1);
  await prisma.postShowingCall.update({
    where: { id: call.id },
    data: {
      status: attemptsLeft > 0 ? "NO_ANSWER" : "PENDING",
      attempts: attemptsLeft,
      scheduledFor: alignToCallHours(new Date(now.getTime() + LIVE_VOICE_STATION_AUDIO_RETRY_MS), call.id),
      skipReason: withScenarioCallMark(call.skipReason, "attempt_returned"),
    },
  });
}

function nextAttemptAt(attempts: number, now: Date, seed: string): Date | null {
  if (attempts >= POST_SHOWING_CALL_MAX_ATTEMPTS) return null;
  return alignToCallHours(new Date(now.getTime() + POST_SHOWING_CALL_RETRY_MS), seed);
}

/**
 * Один проход: поставить новые звонки, освободить зависшие, набрать те, чей час
 * настал. Возвращает число реально начатых звонков.
 */
export async function runPostShowingCallTick(now: Date = new Date()): Promise<number> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { postShowingCallEnabled: true, liveVoiceEnabled: true },
  });
  // Рубильник проверяется ДО всего остального: выключенная функция не должна ни
  // заводить записей, ни ходить в базу за показами.
  if (!settings?.postShowingCallEnabled || !settings.liveVoiceEnabled) return 0;

  await schedulePostShowingCalls(now); // обновляет и снимок выходных
  await releaseStuckCalls(now);

  // Ночью и после 19:00 не набираем вовсе. Записи при этом остаются ждать: их
  // час уже перенесён на утро, но между тиками бывает и «час настал, а пока
  // дошли до набора, уже 19:01».
  if (!isWithinPostShowingCallHours(now)) return 0;

  const due = await duePostShowingCalls(now, BATCH);
  /**
   * НЕ БОЛЬШЕ ОДНОГО ЗВОНКА ЗА ТИК (02.10.2026, аудит фона №4). Порт RTP у моста
   * один — одна беседа. Пачка опросов, набранная разом, давала один разговор и
   * обрывы на «алло» у остальных, с уже списанной попыткой. Записи, закрытые
   * без звонка (клиент сам ответил, недельный предел), не в счёт — идём к
   * следующей; линия занята или станция отказала — до следующего тика.
   */
  for (const call of due) {
    const outcome = await dialOnePostShowingCall(call.id, now);
    if (outcome !== "skipped") return outcome === "started" ? 1 : 0;
  }
  return 0;
}

/** Линия живого голоса занята другим разговором — через сколько пробуем снова.
 *  Те же три минуты, что у приглашения на собеседование: разговор робота
 *  короткий, а пять часов ждать незачем — это не отказ клиента. */
export const POST_SHOWING_CALL_BUSY_RETRY_MS = 3 * 60 * 1000;

/** Станция не приняла набор (не настроена, Asterisk не ответил, 5xx) — через сколько
 *  пробуем снова. Минуты, а не часы (аудит 02.10.2026, В16): это не отказ клиента, а
 *  сбой на нашей стороне, и пять часов ожидания сдвигали ВСЕ остальные звонки, а
 *  каждый отказ слал руководству отдельный пуш. Те же пять минут, что у приглашения
 *  кандидата (DIAL_FAILED_RETRY_MS); попытка при этом не тратится. */
export const POST_SHOWING_CALL_STATION_RETRY_MS = 5 * 60 * 1000;

/** Чем кончилась попытка набора: начат звонок, линия занята, станция отказала, запись закрыта без звонка. */
type DialOutcome = "started" | "busy" | "station_failed" | "skipped";

async function dialOnePostShowingCall(callId: string, now: Date): Promise<DialOutcome> {
  const call = await prisma.postShowingCall.findUnique({
    where: { id: callId },
    select: {
      id: true,
      clientId: true,
      attempts: true,
      previewOnly: true,
      showing: { select: { nextActionDate: true, completedAt: true, createdAt: true, buyerIntentAtCreation: true,
        showingEvidenceVersion: true, declinedAt: true, taskCancelledAt: true } },
      client: { select: { fullName: true, phone: true, deletedAt: true, kind: true, dualIntent: true, dualIntentConfirmedAt: true } },
      agent: { select: { fullName: true } },
      property: { select: { title: true } },
    },
  });
  if (!call || call.previewOnly) return "skipped";
  if (call.showing.declinedAt || call.showing.taskCancelledAt || !call.showing.nextActionDate
    || call.showing.nextActionDate > now || (call.showing.showingEvidenceVersion === 0
      && dushanbeWallClock(call.showing.nextActionDate).getUTCHours() === 0 && dushanbeWallClock(call.showing.nextActionDate).getUTCMinutes() === 0)) {
    await markPostShowingCallSkipped(call.id, "showing_time_unconfirmed_or_cancelled");
    return "skipped";
  }

  if (call.client.deletedAt || !(call.showing.buyerIntentAtCreation ?? confirmedClientIntents(call.client).buys)) {
    await markPostShowingCallSkipped(call.id, "client_gone");
    return "skipped";
  }

  const showingAt = showingMomentOf(call.showing);
  if (now.getTime() - showingAt.getTime() > POST_SHOWING_CALL_STALE_MS) {
    await markPostShowingCallSkipped(call.id, "stale");
    return "skipped";
  }

  // Клиент уже сам всё сказал — звонить не за чем, и это самый частый отказ:
  // именно он не даёт опросу превратиться в поток автозвонков.
  if (await clientSpokeAfterShowing(call.clientId, showingAt)) {
    await markPostShowingCallSkipped(call.id, "client_answered");
    return "skipped";
  }

  // Первая попытка расходует недельный лимит, вторая — уже нет: это тот же
  // звонок, а не второй повод побеспокоить.
  // Своя запись в лимит не идёт (excludeId): после возвращённой попытки её
  // собственный lastAttemptAt гасил повтор как weekly_limit (аудит №5).
  if (
    call.attempts === 0 &&
    (await hasRecentPostShowingCall(call.clientId, new Date(now.getTime() - POST_SHOWING_CALL_WEEK_MS), call.id))
  ) {
    await markPostShowingCallSkipped(call.id, "weekly_limit");
    return "skipped";
  }

  if (!call.client.phone) {
    await markPostShowingCallSkipped(call.id, "no_phone");
    return "skipped";
  }

  // «Не беспокойте» и чёрный список станции (аудит 02.10.2026, А4): тот, кто
  // попросил оставить его в покое, роботом не набирается — ни с первой попытки,
  // ни со второй (отметка могла появиться между ними).
  const block = await scenarioCallBlockReason({ phone: call.client.phone, clientId: call.clientId });
  if (block) {
    await markPostShowingCallSkipped(call.id, block);
    return "skipped";
  }

  // Голос — до промта: имя и «сотрудница/сотрудник» в нём от пола голоса (02.10.2026).
  const voice = await scenarioVoice();
  const prompt = buildPostShowingCallPrompt({
    clientName: firstName(call.client.fullName),
    propertyTitle: call.property?.title ?? null,
    agentName: firstName(call.agent.fullName),
    whenLabel: showingWhenLabel(showingAt, now),
    voiceGender: voice.gender,
  }, voice.forceRussianOnly);

  // Занять запись ДО набора (№172): кто занял — тот звонит; второй проход или
  // перезапущенный посреди набора процесс её уже не возьмёт.
  const claim = await claimPostShowingCall(call.id, now);
  if (!claim) return "skipped";
  const retryAt = alignToCallHours(new Date(now.getTime() + POST_SHOWING_CALL_RETRY_MS), call.id);

  let result: Awaited<ReturnType<typeof originateLiveVoiceScenarioCall>>;
  try {
    result = await originateLiveVoiceScenarioCall(
      call.client.phone,
      {
        investigationOnly: true,
        systemInstruction: prompt,
        voiceName: voice.voiceName,
        forceRussianOnly: voice.forceRussianOnly,
        greetingTrigger: POST_SHOWING_CALL_GREETING_TRIGGER,
        tools: POST_SHOWING_CALL_TOOLS,
        clientId: call.clientId,
        onFinished: (callResult) => finishPostShowingCall(callResult),
      },
      { callerId: "Royal Home" }
    );
  } catch (err) {
    await releasePostShowingCallClaim(call.id, claim, retryAt);
    throw err;
  }

  if (result.busy) {
    // Линия живого голоса занята другим разговором (аудит фона 02.10.2026, №4) —
    // это не отказ станции и не молчание клиента. Раньше «занято» шло веткой
    // ниже: в журнал как «станция не приняла набор» и опрос на пять часов
    // позже. Теперь — как у приглашения и проверки продавца: попытку не тратим,
    // статус не трогаем, пробуем через пару минут.
    await prisma.postShowingCall.updateMany({
      where: { id: call.id, status: "CALLING", channelId: null },
      data: {
        status: claim.status,
        lastAttemptAt: claim.lastAttemptAt,
        scheduledFor: new Date(now.getTime() + POST_SHOWING_CALL_BUSY_RETRY_MS),
      },
    });
    return "busy";
  }
  if (!result.ok || !result.channelId) {
    // Станция не приняла набор — это не отказ клиента и не его молчание.
    // Попытку не тратим; повтор через минуты, как у приглашения (В16). В журнал
    // ошибок — ОДНА запись на все отказы подряд (общий dedupKey, а не id звонка в
    // тексте): раньше каждый отказ имел свой текст и каждый будил руководство
    // пушем «новая ошибка».
    void logSystemError(
      "investigation",
      `Опрос после показа: станция не приняла набор (звонок ${call.id}): ${result.error ?? "без причины"}`,
      { dedupKey: "post-showing-originate" }
    );
    await releasePostShowingCallClaim(call.id, claim, alignToCallHours(new Date(now.getTime() + POST_SHOWING_CALL_STATION_RETRY_MS), null));
    return "station_failed";
  }

  await markPostShowingCallStarted(call.id, result.channelId, now);
  return "started";
}

/**
 * Разговор кончился.
 *
 * Пока здесь только исход ДОЗВОНА — что именно человек сказал, разбирает
 * отдельный проход по расшифровке (шаг 4). Разделение осознанное: дозвон — факт
 * станции, он известен сразу и точно, а исход разговора — суждение модели,
 * которое обязано иметь порог уверенности и цитату.
 */
export async function finishPostShowingCall(result: LiveVoiceScenarioResult, now: Date = new Date()): Promise<void> {
  const call = await findPostShowingCallByChannel(result.channelId);
  if (!call) return;
  // Итог принимается только у звонка, который ещё идёт (третий аудит 02.10.2026, С6):
  // задержанный `no_answer` после ручного сброса или повторный итог по тому же каналу
  // перезаписывал уже разобранную или возвращённую запись.
  if (call.status !== "CALLING") return;

  // Человек снял трубку, но разговора не вышло по НАШЕЙ вине: немая линия
  // (сторож NO_STATION_AUDIO_MS в мосте), упавшая модель, выкат. Его молчание —
  // не ответ: попытка возвращается, но не больше одного раза (аудит №3, №4).
  // Исключение — сбой ПОСЛЕ состоявшегося разговора (С2): слова человека не выбрасываем.
  if (isOurSideCallFailure(result.reason) && !hasSubstantialClientSpeech(result.transcript)) {
    await handleOurSideFailure(call, now);
    return;
  }

  // Автоответчик оператора модель не всегда называет сама (end_call(voicemail)): его
  // выдают реплики «клиента» вроде «абонент недоступен, оставьте сообщение».
  const kind = scenarioEndKind(result.reason) ?? (looksLikeVoicemail(clientLinesOf(result.transcript)) ? "voicemail" : null);

  // Трубку взял не тот (жена, брат): опрос с ним не проводим и записью «поговорили»
  // не считаем — вторая попытка, как при «перезвоните» (аудит №12). Пометка
  // остаётся на записи, событие — в аудите.
  if (kind === "wrong_person") {
    logSystemAudit("post_showing_call_wrong_person", "PostShowingCall", call.id, { attempts: call.attempts });
    const retryAt = nextAttemptAt(call.attempts, now, call.id);
    if (!retryAt) {
      // Попытки кончились, а покупателя так и не слышали: запись закрывается БЕЗ звонка, как
      // `station_down`, а не GIVEN_UP (третий аудит 02.10.2026, В4). GIVEN_UP — это «молчание
      // покупателя»: он шёл в долю тишины по агенту и делал строку кандидатом на звонок
      // собственнику, хотя трубку брала жена или номер оказался чужим.
      await markPostShowingCallSkipped(call.id, "wrong_person");
      return;
    }
    await markPostShowingCallNoAnswer(call.id, retryAt, "wrong_person");
    return;
  }

  if (kind === "voicemail" || kind === "call_back_later" || !result.clientSpoke) {
    await markPostShowingCallNoAnswer(call.id, nextAttemptAt(call.attempts, now, call.id));
    return;
  }

  // Человек говорил — разбираем, что именно он сказал. Отказ модели оставляет
  // звонок неразобранным (UNCLEAR), а не «всё понравилось»: тишина поставщика
  // не должна тихо улучшать статистику агента.
  const parsed = await parsePostShowingCall(result.transcript);
  await savePostShowingCallOutcome(call.id, {
    outcome: parsed?.outcome ?? "UNCLEAR",
    confidence: parsed?.confidence ?? null,
    quote: parsed?.quote ?? null,
    redFlags: parsed?.redFlags ?? [],
    summary: parsed?.summary ?? null,
    talkedAt: now,
  });

  await routePostShowingCallOutcome(call.id, parsed?.unconfirmedOutcome ?? null);
}

/**
 * КУДА УХОДИТ ИСХОД РАЗГОВОРА — И ПОЧЕМУ НЕ В ХРОНОЛОГИЮ КАРТОЧКИ.
 *
 * Хронология открыта агенту. Строка «Опрос после показа: жалоба на агента» в
 * ней сожгла бы механизм один раз и навсегда: дальше жалоб через него не будет
 * никогда — их просто перестанут до нас доносить. Поэтому исход идёт двумя
 * путями, и ни один из них агенту не виден: запись в аудит (её читают по праву
 * `auditLog.view`) и, для красных исходов, аларм руководителю.
 *
 * `excludeAgentId` обязателен: агент, попавший в алармы по праву своей роли, не
 * должен получить пуш про самого себя.
 *
 * Постановка аларма ЖДЁТСЯ, а не бросается вдогонку (`void`): очередь сама
 * глотает свои ошибки, а незавершённое обещание в конце разговора означает, что
 * сигнал может не успеть записаться вовсе — и тогда единственное подтверждённое
 * показание клиента просто исчезнет.
 */
async function routePostShowingCallOutcome(
  callId: string,
  unconfirmedOutcome: PostShowingCallOutcome | null = null
): Promise<void> {
  const call = await prisma.postShowingCall.findUnique({
    where: { id: callId },
    select: {
      id: true,
      clientId: true, propertyId: true, showingId: true, createdAt: true, talkedAt: true, channelId: true,
      agentId: true,
      outcome: true,
      quote: true,
      redFlags: true,
      summary: true,
      client: { select: { fullName: true, shortId: true } },
      agent: { select: { fullName: true } },
      property: { select: { title: true } },
    },
  });
  if (!call) return;

  if (unconfirmedOutcome || (call.outcome && POST_SHOWING_CALL_RED_OUTCOMES.includes(call.outcome))) {
    await recordInvestigationSignal({ clientId: call.clientId, propertyId: call.propertyId, showingId: call.showingId,
      subjectAgentId: call.agentId, assignmentAt: call.createdAt, sourceType: "post-showing-call", sourceId: call.id,
      independenceKey: `call:${call.channelId ?? call.id}`, kind: "outcome", occurredAt: call.talkedAt ?? call.createdAt,
      summary: unconfirmedOutcome ? "Вывод модели не подтверждён цитатой. Требуется проверка записи; это не доказательство нарушения."
        : `${call.summary ?? call.outcome}${call.quote ? ` Цитата: ${call.quote}` : ""}`,
      payload: { outcome: call.outcome, unconfirmedOutcome, channelId: call.channelId },
    });
  }

  logSystemAudit("post_showing_call_outcome", "PostShowingCall", call.id, {
    outcome: call.outcome,
    redFlags: call.redFlags,
    agentId: call.agentId,
    summary: call.summary,
  });

  // Красный исход назван уверенно, а цитата по расшифровке не подтвердилась (третий аудит
  // 02.10.2026, В1): обвинения нет, но и молчать нельзя — руководителю уходит дело
  // «проверьте звонок». Цитата модели здесь НЕ приводится: она не подтверждена.
  if (unconfirmedOutcome && (!call.outcome || !POST_SHOWING_CALL_RED_OUTCOMES.includes(call.outcome))) {
    await enqueueDirectorAlert({
      title: "Опрос после показа: проверьте звонок",
      body:
        `${call.client.fullName}: по разговору возможна проблема (${unconfirmedOutcomeLabel(unconfirmedOutcome)}), ` +
        `но слов клиента для подтверждения в расшифровке не нашлось. Это не вывод, а просьба послушать запись. ` +
        `Показ вёл ${call.agent.fullName}${call.property?.title ? `, объект «${call.property.title}»` : ""}.`,
      url: `/clients/${call.client.shortId}`,
      tag: `post-showing-call-review-${call.id}`,
      recipientRoles: ["ADMIN", "DIRECTOR"],
      excludeAgentId: call.agentId,
    });
    return;
  }

  if (!call.outcome || !POST_SHOWING_CALL_RED_OUTCOMES.includes(call.outcome)) return;

  const what =
    call.outcome === "NO_MEETING"
      ? "клиент говорит, что показа не было"
      : call.outcome === "BYPASS"
        ? "похоже на сделку мимо агентства"
        : "жалоба на сотрудника";

  await enqueueDirectorAlert({
    title: "🚩 Опрос после показа",
    body:
      `${call.client.fullName}: ${what}. Показ вёл ${call.agent.fullName}` +
      `${call.property?.title ? `, объект «${call.property.title}»` : ""}.` +
      `${call.quote ? ` Дословно: «${call.quote}»` : ""}`,
    url: `/clients/${call.client.shortId}`,
    tag: `post-showing-call-${call.id}`,
    recipientRoles: ["ADMIN", "DIRECTOR"],
    excludeAgentId: call.agentId,
  });
}

function unconfirmedOutcomeLabel(outcome: PostShowingCallOutcome): string {
  return outcome === "NO_MEETING"
    ? "клиент мог сказать, что показа не было"
    : outcome === "BYPASS"
      ? "возможна сделка мимо агентства"
      : "возможна жалоба на сотрудника";
}

/** Обращаться по имени, а не по всей строке карточки («Далер Джабборов (Инста)»). */
function firstName(fullName: string | null): string | null {
  if (!fullName) return null;
  const first = fullName.trim().split(/\s+/)[0];
  return first && first.length > 1 ? first : null;
}
