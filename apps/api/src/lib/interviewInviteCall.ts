import { prisma } from "../db.js";
import {
  buildInterviewInviteCallPrompt,
  INTERVIEW_INVITE_CALL_TOOLS,
  INTERVIEW_INVITE_GREETING_TRIGGER,
  interviewTimeRu,
} from "../ai/interviewInviteCallPersona.js";
import { parseInterviewInviteCall } from "../ai/interviewInviteCallParse.js";
import { isDialableTajikNumber } from "@royal-home/shared";
import { logSystemAudit } from "./audit.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { sendPushToAgents } from "../push.js";
import { alignToCallHours, isWithinPostShowingCallHours } from "./postShowingCall.js";
import { loadCompanyDaysOff } from "./daysOffCalendar.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { NO_STATION_AUDIO_MS, originateLiveVoiceScenarioCall } from "./telephony/liveVoiceBridge.js";
import { NO_STATION_AUDIO_REASON } from "./telephony/liveVoiceAudioPath.js";
import type { LiveVoiceScenarioResult } from "./telephony/liveVoiceBridge.js";

/**
 * РОБОТ ПРИГЛАШАЕТ КАНДИДАТА НА СОБЕСЕДОВАНИЕ (владелец 25.09.2026).
 *
 * HR на экране вакансий жмёт «Позвать на собеседование», выбирает день и время
 * и оставляет галочку «Робот позвонит и пригласит» — PATCH /vacancies/:id зовёт
 * enqueueInterviewInviteCall. Тик раз в пять минут (liveVoiceScenarioTicks.ts) набирает номер в
 * рабочие часы звонков (09–19 по Душанбе, общие с опросом после показа), и
 * итог разговора ложится строкой в карточку кандидата. Если кандидат просит
 * другое время, отказывается или до него не дозвониться — HR получает
 * уведомление: решать дальше человеку, а не роботу.
 *
 * ЯЗЫК И ГОЛОС — ИЗ ПЕРЕПИСКИ. Досье считает язык чата по большинству
 * сообщений (ContactProfile.language). Писал по-таджикски — звонок по-таджикски
 * таджикским голосом (Настройки → Бот → «Голос для таджикского»), иначе
 * по-русски основным голосом. Замка на русский нет (владелец 28.09.2026):
 * заговорил кандидат по-таджикски — робот переходит вслед за ним.
 */

/**
 * Звонок ОДИН (владелец 01.10.2026: «одного раза звонка достаточно»). Не взял
 * трубку, автоответчик, «перезвоните позже», трубку взял не он — повторного
 * набора нет: HR получает уведомление со словами, ЧТО случилось, и решает сам.
 * До 01.10 была вторая попытка через час.
 *
 * Набора не было — попытка не тратится (02.10.2026, разбор дыр): линия живого
 * голоса занята, станция не приняла набор, у этой анкеты ещё идёт прежний
 * звонок. Строка ждёт и пробует снова, пока до собеседования не меньше часа
 * (TOO_LATE_MS); не успели — HR узнаёт честную причину, а не «не дозвонились».
 */
export const INTERVIEW_INVITE_MAX_ATTEMPTS = 1;
/** Ближе этого к собеседованию уже не звоним: звать поздно, лучше HR сам. */
const TOO_LATE_MS = 60 * 60 * 1000;
/**
 * Зависший CALLING без итога. Потолок разговора в мосте —
 * LIVE_VOICE_MAX_SESSION_MS, 15 минут, плюс до минуты на гудки
 * (MANUAL_TEST_CHANNEL_TTL_MS): раньше 10 минут здесь записывали «не
 * дозвонились» посреди настоящего долгого разговора.
 */
const STUCK_MS = 20 * 60 * 1000;
const BATCH = 10;
/** Линия живого голоса занята / идёт прежний звонок анкеты — когда пробовать снова. */
const BUSY_RETRY_MS = 3 * 60 * 1000;
/** Станция не приняла набор (ARI недоступен и т. п.) — когда пробовать снова. */
const DIAL_FAILED_RETRY_MS = 5 * 60 * 1000;
/** Звонок сорвался по НАШЕЙ вине — когда пробовать ещё раз (один раз на строку). */
const OUR_FAILURE_RETRY_MS = 30 * 60 * 1000;
/** Возвратов после нашего сбоя на одну строку. */
const OUR_FAILURE_MAX_RETRIES = 1;

/**
 * ЗВОНОК СОРВАЛСЯ ПО НАШЕЙ ВИНЕ, А НЕ КАНДИДАТ НЕ ОТВЕТИЛ (проверка робота
 * 02.10.2026). Обрыв связи с моделью, выкат CRM посреди разговора, нет звука со
 * станции — всё это раньше записывалось «не дозвонились» и сжигало единственный
 * звонок. Теперь строка возвращается в очередь ОДИН раз (OUR_FAILURE_MAX_RETRIES):
 * пока звук мёртв, повторять раз в час значило бы звонить кандидату снова и снова.
 * Второй сбой подряд — HR получает «у робота был сбой связи, позвоните сами».
 *
 * no_caller_speech — собеседник за весь звонок не издал ни звука: почти всегда
 * это звук в одну сторону (см. NO_CALLER_SPEECH_REASON в мосту), а не молчун.
 */
export function isOurCallFailure(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (
    reason.startsWith("start_failed") ||
    reason === "gemini_error" ||
    reason === "gemini_closed" ||
    reason === "rtp_socket_error" ||
    reason === "listener_stopped" ||
    reason === "ari_error" ||
    reason === NO_STATION_AUDIO_REASON ||
    reason === "no_caller_speech"
  );
}

/**
 * Номер для сравнения «тот же или исправленный» — последние 9 цифр: +992 90…,
 * 992 90… и 90… — один и тот же номер.
 */
export function invitePhoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/**
 * Немые звонки (28.09–03.10.2026: канал звука до станции был мёртв, кандидат
 * слышал тишину). Такая строка помечается этой причиной разовым скриптом
 * (scripts/recall-silent-invite-calls.ts) и НЕ считается звонком: защита «один
 * звонок» её пропускает, и робот может позвонить снова.
 */
export const AUDIO_DEAD_REASON = "audio_dead";

/**
 * Почему робот не позвонил или разговор не состоялся (поле skipReason).
 * SKIPPED — набора не было; GIVEN_UP — набор был, разговора о собеседовании нет.
 * Причины, о которых HR должен узнать, — в NOTIFY_SKIP_REASONS.
 */
export type InterviewInviteSkipReason =
  | "status_changed"
  | "time_changed"
  | "too_late"
  | "no_phone"
  | "not_dialable"
  | "live_voice_off"
  | "dial_failed"
  | "wrong_number"
  | "audio_down";
export type InterviewInviteGiveUpReason = "no_answer" | "voicemail" | "wrong_person" | "call_back_later" | "robot_failed";

/** status_changed / time_changed — их сделал сам HR, тревожить нечем. */
const NOTIFY_SKIP_REASONS: ReadonlySet<string> = new Set([
  "too_late",
  "no_phone",
  "not_dialable",
  "live_voice_off",
  "dial_failed",
  "wrong_number",
  "audio_down",
]);

export type InterviewInviteLanguage = "ru" | "tg";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Поставить звонок. Прежние незавершённые звонки этой анкеты гаснут: HR
 * переназначил время — старое приглашение звучать не должно.
 */
export async function enqueueInterviewInviteCall(input: {
  jobApplicationId: string;
  interviewAt: Date;
  requestedById: string | null;
  now?: Date;
}): Promise<{ id: string }> {
  return prisma.$transaction((tx) => enqueueInterviewInviteCallTx(tx, input));
}

/** То же внутри чужой транзакции: PATCH /vacancies/:id пишет анкету и звонок разом. */
export async function enqueueInterviewInviteCallTx(
  tx: Tx,
  input: { jobApplicationId: string; interviewAt: Date; requestedById: string | null; now?: Date }
): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  const app = await tx.jobApplication.findUnique({
    where: { id: input.jobApplicationId },
    select: { contactProfile: { select: { language: true } } },
  });
  const language: InterviewInviteLanguage = app?.contactProfile?.language === "tg" ? "tg" : "ru";
  await tx.interviewInviteCall.updateMany({
    where: { jobApplicationId: input.jobApplicationId, status: { in: ["PENDING", "NO_ANSWER"] } },
    data: { status: "CANCELLED" },
  });
  return tx.interviewInviteCall.create({
    data: {
      jobApplicationId: input.jobApplicationId,
      interviewAt: input.interviewAt,
      language,
      scheduledFor: alignToCallHours(now, null),
      requestedById: input.requestedById,
    },
    select: { id: true },
  });
}

/**
 * Может ли робот вообще позвонить про это время — спрашивается ДО постановки
 * звонка (PATCH /vacancies/:id). null — может. Иначе причина и строка для HR:
 * собеседование сохраняется, звонок не ставится, и HR сразу видит, что звонить
 * ему самому (02.10.2026: раньше такие звонки молча гасли SKIPPED, а HR
 * получал «робот позвонит»).
 */
export async function interviewInviteRefusal(input: {
  jobApplicationId: string;
  interviewAt: Date;
  phone: string | null;
  now?: Date;
}): Promise<{ reason: string; note: string } | null> {
  const now = input.now ?? new Date();
  const saved = "Собеседование сохранено.";
  if (!input.phone) {
    return { reason: "no_phone", note: `${saved} У кандидата нет номера — робот не позвонит, сообщите кандидату сами.` };
  }
  if (!isDialableTajikNumber(input.phone)) {
    return {
      reason: "not_dialable",
      note: `${saved} Номер кандидата не похож на таджикский — робот не сможет позвонить, свяжитесь с кандидатом сами.`,
    };
  }
  // В прошлый раз на этот номер ответил не кандидат — робот на него больше не
  // звонит ни про какое время (проверка робота 02.10.2026: перенос времени
  // ставил новый звонок на тот же чужой номер). Исправленный номер — пускаем.
  const phoneKey = invitePhoneKey(input.phone);
  if (phoneKey && (await wrongPersonOnPhone(input.jobApplicationId, phoneKey))) {
    return {
      reason: "wrong_number",
      note: `${saved} В прошлый раз на этот номер ответил не кандидат — робот на него больше не звонит. Проверьте номер или свяжитесь с кандидатом сами.`,
    };
  }
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceEnabled: true } });
  if (!settings?.liveVoiceEnabled) {
    return { reason: "live_voice_off", note: `${saved} Звонки робота выключены в настройках — позвоните кандидату сами.` };
  }
  if (alignToCallHours(now, null).getTime() + TOO_LATE_MS > input.interviewAt.getTime()) {
    return {
      reason: "too_late",
      note: `${saved} До собеседования слишком мало времени — робот не успеет позвонить, позвоните кандидату сами.`,
    };
  }
  // Один звонок на одно приглашение (владелец 01.10.2026). Форма «Перенести»
  // подставляет текущее время с галочкой робота — повторное сохранение того же
  // времени звонило кандидату второй раз. Не считаются звонком: немой звонок
  // (audio_dead), сбой робота (robot_failed) и «не тот человек» на ДРУГОМ
  // номере — HR исправил номер, и робот звонит уже кандидату.
  const earlier = await prisma.interviewInviteCall.findMany({
    where: {
      jobApplicationId: input.jobApplicationId,
      interviewAt: input.interviewAt,
      status: { in: ["CALLING", "DONE", "GIVEN_UP"] },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { status: true, skipReason: true, phone: true },
  });
  const same = earlier.find((row) => countsAsCall(row, phoneKey));
  if (same?.status === "CALLING") {
    return { reason: "already_calling", note: `${saved} Робот как раз сейчас звонит кандидату про это время.` };
  }
  if (same) {
    return {
      reason: "already_called",
      note: `${saved} Робот уже звонил кандидату про это время — второй раз он не звонит. Итог звонка — в анкете.`,
    };
  }
  return null;
}

/**
 * Считается ли строка звонком кандидату для правила «один звонок». Нет: немой
 * звонок (audio_dead), сбой робота (robot_failed) и «трубку взял не кандидат» на
 * ДРУГОМ номере — HR исправил номер, и робот звонит уже кандидату. Старые строки
 * без номера считаются звонком, как раньше. Сравнение в коде, а не в запросе:
 * NOT с пустыми полями в SQL молча выкидывает строки целиком.
 */
export function countsAsCall(
  row: { status: string; skipReason: string | null; phone: string | null },
  currentPhoneKey: string | null
): boolean {
  if (row.skipReason === AUDIO_DEAD_REASON || row.skipReason === "robot_failed") return false;
  if (row.status === "GIVEN_UP" && row.skipReason === "wrong_person" && row.phone && row.phone !== currentPhoneKey) return false;
  return true;
}

/** Был ли у анкеты звонок на ЭТОТ номер, где трубку взял не кандидат. */
async function wrongPersonOnPhone(jobApplicationId: string, phoneKey: string, exceptId?: string): Promise<boolean> {
  const hit = await prisma.interviewInviteCall.findFirst({
    where: {
      jobApplicationId,
      status: "GIVEN_UP",
      skipReason: "wrong_person",
      phone: phoneKey,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  return !!hit;
}

/**
 * ПОКА НА ЛИНИИ РОБОТА НЕТ ЗВУКА — КАНДИДАТАМ НЕ ЗВОНИМ (03.10.2026).
 *
 * С 28.09 звук со станции до CRM не доходил (тоннель), и кандидаты брали
 * трубку в тишину. Мост сам ставит робота на паузу (liveVoiceAudioPathDown), но
 * пауза в памяти: она кончается по таймеру ради пробы и пропадает при выкате —
 * и пробой становился живой кандидат, ещё один немой звонок ему. Поэтому судим
 * по журналу сессий: последняя сессия, по которой видно состояние звука, кончилась
 * «нет звука со станции» — звук мёртв, кандидаты ждут. Проверяют звук другие
 * звонки робота (входящие, кнопка «Проверить» в Настройках): сессия, прожившая
 * дольше сторожа NO_STATION_AUDIO_MS, звук получала — иначе сторож бы её закрыл.
 * Короче сторожа и не по нему — о звуке ничего не говорит, смотрим дальше.
 * Не успели до собеседования — HR узнаёт настоящую причину (audio_down).
 */
export async function stationAudioDown(now: Date): Promise<boolean> {
  const recent = await prisma.liveVoiceSession.findMany({
    where: { endedAt: { not: null, lte: now } },
    orderBy: { endedAt: "desc" },
    take: 20,
    select: { startedAt: true, endedAt: true, endedReason: true },
  });
  for (const s of recent) {
    if (s.endedReason === NO_STATION_AUDIO_REASON) return true;
    if (s.endedAt && s.endedAt.getTime() - s.startedAt.getTime() >= NO_STATION_AUDIO_MS) return false;
  }
  return false;
}

/**
 * Один проход. Зависшие звонки и опоздавшие строки разбираются всегда, даже
 * с выключенным живым голосом: иначе выключенный рубильник оставлял HR без
 * единого слова. Набор — не больше ОДНОГО звонка за проход: линия живого
 * голоса одна (один порт RTP), и второй кандидат, взявший трубку, пока звонит
 * первый, слышал бы тишину и обрыв на «алло». Защиту между разными сценариями
 * (опрос после показа, проверка продавца) держит мост — liveVoiceLineBusy.
 */
export async function runInterviewInviteCallTick(now: Date = new Date()): Promise<number> {
  // Снимок общих выходных для часов звонков (postShowingCall.ts, 11.10.2026).
  await loadCompanyDaysOff();
  await releaseStuckCalls(now);

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceEnabled: true } });
  const enabled = !!settings?.liveVoiceEnabled;
  const audioDown = enabled && (await stationAudioDown(now));
  await expireTooLate(now, enabled, audioDown);
  if (!enabled) return 0;
  if (!isWithinPostShowingCallHours(now)) return 0;
  if (audioDown) return 0;

  const due = await prisma.interviewInviteCall.findMany({
    where: {
      status: { in: ["PENDING", "NO_ANSWER"] },
      attempts: { lt: INTERVIEW_INVITE_MAX_ATTEMPTS },
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: "asc" },
    take: BATCH,
    select: { id: true },
  });
  for (const row of due) {
    const outcome = await dialInterviewInviteCall(row.id, now);
    if (outcome === "started") return 1;
    // Линия занята — она занята для всех строк, ждём следующего прохода.
    if (outcome === "busy") return 0;
  }
  return 0;
}

/** Зависший CALLING (итог от моста не пришёл) и старые NO_ANSWER с уже
 *  потраченной попыткой (до 01.10 их набирали второй раз) — к HR.
 *
 *  Итог не пришёл чаще всего из-за выката: мост сначала заливает запись в R2,
 *  и только потом зовёт обработчик — перезапуск CRM между ними терял итог, а
 *  сторож записывал «не дозвонились» (проверка робота 02.10.2026). Теперь
 *  сторож сначала смотрит, что о разговоре записал сам мост (LiveVoiceSession):
 *  разговор закончился — итог разбирается как обычно; оборвался или записи
 *  нет — это наш сбой, звонок возвращается в очередь один раз. */
async function releaseStuckCalls(now: Date): Promise<void> {
  const rows = await prisma.interviewInviteCall.findMany({
    where: {
      OR: [
        { status: "CALLING", lastAttemptAt: { lt: new Date(now.getTime() - STUCK_MS) } },
        { status: "NO_ANSWER", attempts: { gte: INTERVIEW_INVITE_MAX_ATTEMPTS } },
      ],
    },
    take: BATCH,
    select: { id: true, status: true, channelId: true },
  });
  for (const row of rows) {
    if (row.status === "CALLING" && row.channelId) {
      await recoverLostResult(row.channelId, now);
      continue;
    }
    // CALLING без канала — набор так и не ушёл на станцию (процесс упал между
    // захватом строки и ответом станции): это не «не дозвонились».
    const noDial = row.status === "CALLING" && !row.channelId;
    const updated = await prisma.interviewInviteCall.updateMany({
      where: { id: row.id, status: row.status },
      data: noDial ? { status: "SKIPPED", skipReason: "dial_failed" } : { status: "GIVEN_UP", skipReason: "no_answer" },
    });
    if (updated.count === 1) await notifyHr(row.id, null, now);
  }
}

/** Итог звонка, потерянный по дороге: собрать его из записи моста и разобрать. */
async function recoverLostResult(channelId: string, now: Date): Promise<void> {
  const session = await prisma.liveVoiceSession.findFirst({
    where: { channelId },
    orderBy: { startedAt: "desc" },
    select: { endedAt: true, endedReason: true, transcript: true, recordingUrl: true, startedAt: true },
  });
  const transcript = session?.transcript ? session.transcript.split("\n").filter((line) => line.trim()) : [];
  await finishInterviewInviteCall(
    {
      channelId,
      transcript,
      // Мост не успел записать конец — значит, CRM упала посреди разговора.
      reason: session?.endedAt && session.endedReason ? session.endedReason : "listener_stopped",
      clientSpoke: transcript.some((line) => line.startsWith("Клиент:")),
      recordingKey: session?.recordingUrl ?? null,
      startedAt: session?.startedAt,
      endedAt: session?.endedAt ?? undefined,
    },
    now
  );
}

/** Строки, до собеседования которых меньше часа, — звать поздно: гаснут, и HR
 *  узнаёт почему (робот не смог / выключен / не успел). */
async function expireTooLate(now: Date, enabled: boolean, audioDown: boolean): Promise<void> {
  const rows = await prisma.interviewInviteCall.findMany({
    where: { status: { in: ["PENDING", "NO_ANSWER"] }, interviewAt: { lt: new Date(now.getTime() + TOO_LATE_MS) } },
    take: BATCH,
    select: {
      id: true,
      interviewAt: true,
      skipReason: true,
      jobApplication: { select: { status: true, interviewAt: true } },
    },
  });
  for (const row of rows) {
    const app = row.jobApplication;
    const reason: InterviewInviteSkipReason =
      app.status !== "INTERVIEW"
        ? "status_changed"
        : app.interviewAt?.getTime() !== row.interviewAt.getTime()
          ? "time_changed"
          : row.skipReason === "dial_failed"
            ? "dial_failed"
            : !enabled
              ? "live_voice_off"
              : audioDown
                ? "audio_down"
                : "too_late";
    const updated = await prisma.interviewInviteCall.updateMany({
      where: { id: row.id, status: { in: ["PENDING", "NO_ANSWER"] } },
      data: { status: "SKIPPED", skipReason: reason },
    });
    // Собеседование уже прошло — HR это и так знает.
    if (updated.count === 1 && NOTIFY_SKIP_REASONS.has(reason) && row.interviewAt.getTime() > now.getTime()) {
      await notifyHr(row.id, null, now);
    }
  }
}

/** Захваченную строку (CALLING) — в SKIPPED; HR узнаёт, если это его дело. */
async function skipClaimed(id: string, reason: InterviewInviteSkipReason, now: Date): Promise<"skipped"> {
  const updated = await prisma.interviewInviteCall.updateMany({
    where: { id, status: "CALLING" },
    data: { status: "SKIPPED", skipReason: reason, channelId: null },
  });
  if (updated.count === 1 && NOTIFY_SKIP_REASONS.has(reason)) await notifyHr(id, null, now);
  return "skipped";
}

/**
 * Набора не было — попытка не тратится, строка возвращается в очередь на
 * `delayMs` позже (в часы звонков). Следующая попытка уже не успевает до
 * собеседования — честный итог сразу.
 */
async function putBack(
  claimed: { id: string; interviewAt: Date; lastAttemptAt: Date | null; skipReason: string | null },
  now: Date,
  delayMs: number,
  giveUpReason: InterviewInviteSkipReason,
  marker: string | null
): Promise<void> {
  const next = alignToCallHours(new Date(now.getTime() + delayMs), null);
  if (claimed.interviewAt.getTime() - next.getTime() < TOO_LATE_MS) {
    await skipClaimed(claimed.id, giveUpReason, now);
    return;
  }
  await prisma.interviewInviteCall.updateMany({
    where: { id: claimed.id, status: "CALLING" },
    // channelId — прочь: иначе упавший на следующей попытке процесс оставит строку
    // с прежним каналом, и сторож сочтёт, что набор был (проверка робота 02.10.2026).
    data: {
      status: "PENDING",
      scheduledFor: next,
      lastAttemptAt: claimed.lastAttemptAt,
      skipReason: marker ?? claimed.skipReason,
      channelId: null,
    },
  });
}

export type InterviewInviteDialOutcome = "started" | "busy" | "waiting" | "skipped";

export async function dialInterviewInviteCall(id: string, now: Date): Promise<InterviewInviteDialOutcome> {
  const call = await prisma.interviewInviteCall.findUnique({
    where: { id },
    select: {
      id: true,
      jobApplicationId: true,
      interviewAt: true,
      language: true,
      lastAttemptAt: true,
      skipReason: true,
      failureRetries: true,
      jobApplication: { select: { name: true, contactName: true, phone: true, status: true, interviewAt: true } },
    },
  });
  if (!call) return "skipped";
  // Захват строки ОДНОЙ записью с условием: два прохода (или два процесса)
  // не наберут одного кандидата дважды. Дальше каждая запись — только из CALLING.
  const claimed = await prisma.interviewInviteCall.updateMany({
    where: { id, status: { in: ["PENDING", "NO_ANSWER"] }, attempts: { lt: INTERVIEW_INVITE_MAX_ATTEMPTS } },
    data: { status: "CALLING", lastAttemptAt: now },
  });
  if (claimed.count !== 1) return "skipped";

  const app = call.jobApplication;
  // Анкету успели перевести дальше или перенести время мимо этого звонка.
  if (app.status !== "INTERVIEW") return skipClaimed(id, "status_changed", now);
  if (!app.interviewAt || app.interviewAt.getTime() !== call.interviewAt.getTime()) return skipClaimed(id, "time_changed", now);
  if (call.interviewAt.getTime() - now.getTime() < TOO_LATE_MS) {
    return skipClaimed(id, call.skipReason === "dial_failed" ? "dial_failed" : "too_late", now);
  }
  if (!app.phone) return skipClaimed(id, "no_phone", now);
  if (!isDialableTajikNumber(app.phone)) return skipClaimed(id, "not_dialable", now);
  const phoneKey = invitePhoneKey(app.phone);
  // Пока звонок ждал очереди, прежний звонок на этот номер кончился «трубку
  // взял не кандидат» — второй раз чужого человека не тревожим.
  if (phoneKey && (await wrongPersonOnPhone(call.jobApplicationId, phoneKey, id))) {
    return skipClaimed(id, "wrong_number", now);
  }

  // У этой анкеты ещё идёт прежний звонок (HR перенёс время, пока робот
  // говорил о старом) — второй параллельно не набираем, ждём его конца.
  const inFlight = await prisma.interviewInviteCall.count({
    where: { jobApplicationId: call.jobApplicationId, id: { not: id }, status: "CALLING" },
  });
  if (inFlight > 0) {
    await putBack(call, now, BUSY_RETRY_MS, "too_late", null);
    return "waiting";
  }

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceVoiceName: true, liveVoiceVoiceNameTajik: true, interviewInviteAddress: true },
  });
  // Кандидат уже слышал от робота другое время — это перенос, а не первое
  // приглашение (владелец 28.09.2026). Берём только разговор, который
  // состоялся (DONE): до кого не дозвонились, тот прежнего времени не знает.
  const heard = await prisma.interviewInviteCall.findFirst({
    where: {
      jobApplicationId: call.jobApplicationId,
      id: { not: id },
      status: "DONE",
      interviewAt: { not: call.interviewAt },
      // Немой звонок (audio_dead) кандидат не слышал — прежнего времени не знает.
      OR: [{ skipReason: null }, { skipReason: { not: AUDIO_DEAD_REASON } }],
    },
    orderBy: { createdAt: "desc" },
    select: { interviewAt: true, outcome: true },
  });
  const language = call.language === "tg" ? "tg" : "ru";
  // Пусто — мост берёт свой голос по умолчанию; род речи задаёт мост по выбранному голосу.
  const voiceName =
    (language === "tg" ? settings?.liveVoiceVoiceNameTajik || settings?.liveVoiceVoiceName : settings?.liveVoiceVoiceName) ||
    undefined;

  const result = await originateLiveVoiceScenarioCall(
    app.phone,
    {
      systemInstruction: buildInterviewInviteCallPrompt({
        candidateName: firstName(app.name ?? app.contactName),
        interviewAt: call.interviewAt,
        address: settings?.interviewInviteAddress ?? null,
        language,
        previous: heard ? { interviewAt: heard.interviewAt, askedByCandidate: heard.outcome === "RESCHEDULE" } : null,
      }),
      greetingTrigger: INTERVIEW_INVITE_GREETING_TRIGGER,
      tools: INTERVIEW_INVITE_CALL_TOOLS,
      voiceName,
      // Без замка на русский и для русской переписки (владелец 28.09.2026):
      // кандидат писал по-русски, а ответил по-таджикски, и замок заставил
      // робота извиняться «говорю только по-русски». Начинает на языке
      // переписки, переходит вслед за кандидатом (см. languageRule в промпте).
      forceRussianOnly: false,
      // Язык переписки — для поставщика ElevenLabs (02.10.2026), Gemini берёт сам.
      language,
      onFinished: (r) => finishInterviewInviteCall(r),
    },
    { callerId: "Royal Home" }
  );

  if (result.busy) {
    // Линия занята другим разговором — попытку не тратим, пробуем через пару минут.
    await putBack(call, now, BUSY_RETRY_MS, "too_late", null);
    return "busy";
  }
  if (!result.ok || !result.channelId) {
    // Станция не приняла набор (недоступна, «на этот номер уже идёт звонок»…) —
    // звонка кандидату НЕ было. Попытка не тратится, пробуем позже; метка
    // dial_failed — чтобы, если так и не выйдет, HR узнал правду.
    void logSystemError(
      "telephony",
      `Приглашение на собеседование: станция не приняла набор (звонок ${id}): ${result.error ?? "без причины"}`,
      { dedupKey: "interview-invite-originate" }
    );
    await putBack(call, now, DIAL_FAILED_RETRY_MS, "dial_failed", "dial_failed");
    return "waiting";
  }

  await prisma.interviewInviteCall.updateMany({
    where: { id, status: "CALLING" },
    data: { channelId: result.channelId, attempts: { increment: 1 }, skipReason: null, phone: phoneKey },
  });
  return "started";
}

/** Разговор кончился — записать исход и, если нужно, позвать HR. */
export async function finishInterviewInviteCall(result: LiveVoiceScenarioResult, now: Date = new Date()): Promise<void> {
  const call = await prisma.interviewInviteCall.findFirst({
    where: { channelId: result.channelId, status: "CALLING" },
    orderBy: { lastAttemptAt: "desc" },
    select: { id: true, interviewAt: true, failureRetries: true },
  });
  if (!call) return;
  const recordingKey = result.recordingKey ?? null;

  // Сорвалось по нашей вине — кандидат тут ни при чём (см. isOurCallFailure).
  if (isOurCallFailure(result.reason)) {
    const next = alignToCallHours(new Date(now.getTime() + OUR_FAILURE_RETRY_MS), null);
    const canRetry =
      call.failureRetries < OUR_FAILURE_MAX_RETRIES && call.interviewAt.getTime() - next.getTime() >= TOO_LATE_MS;
    if (canRetry) {
      await prisma.interviewInviteCall.updateMany({
        where: { id: call.id, status: "CALLING" },
        data: {
          status: "PENDING",
          scheduledFor: next,
          attempts: { decrement: 1 },
          failureRetries: { increment: 1 },
          channelId: null,
          recordingKey,
        },
      });
      return;
    }
    const updated = await prisma.interviewInviteCall.updateMany({
      where: { id: call.id, status: "CALLING" },
      data: { status: "GIVEN_UP", skipReason: "robot_failed", recordingKey },
    });
    if (updated.count === 1) await notifyHr(call.id, null, now);
    return;
  }

  // Разговора о собеседовании не было. Робот больше не звонит (один звонок на
  // приглашение), поэтому HR получает, ЧТО случилось: «трубку взял не он» и
  // «просил перезвонить» — не то же самое, что «не дозвонились».
  const giveUp: InterviewInviteGiveUpReason | null = result.reason.includes("wrong_person")
    ? "wrong_person"
    : result.reason.includes("call_back_later")
      ? "call_back_later"
      : result.reason.includes("voicemail")
        ? "voicemail"
        : !result.clientSpoke
          ? "no_answer"
          : null;
  if (giveUp) {
    // «Наберите после шести», «он на работе до пяти» — HR должен это прочитать,
    // а не узнать из «просил перезвонить» (проверка робота 02.10.2026). Исход
    // разбора здесь не нужен — только слова человека.
    const said =
      result.clientSpoke && (giveUp === "wrong_person" || giveUp === "call_back_later")
        ? await parseInterviewInviteCall(result.transcript)
        : null;
    const updated = await prisma.interviewInviteCall.updateMany({
      where: { id: call.id, status: "CALLING" },
      data: {
        status: "GIVEN_UP",
        skipReason: giveUp,
        recordingKey,
        quote: said?.quote ?? null,
        summary: said?.summary ?? null,
      },
    });
    if (updated.count === 1) await notifyHr(call.id, null, now);
    return;
  }

  const parsed = await parseInterviewInviteCall(result.transcript);
  const outcome = parsed?.outcome ?? "UNCLEAR";
  const updated = await prisma.interviewInviteCall.updateMany({
    where: { id: call.id, status: "CALLING" },
    data: {
      status: "DONE",
      talkedAt: now,
      outcome,
      proposedTime: parsed?.proposedTime ?? null,
      quote: parsed?.quote ?? null,
      summary: parsed?.summary ?? null,
      recordingKey,
    },
  });
  if (updated.count !== 1) return;
  logSystemAudit("interview_invite_call_outcome", "InterviewInviteCall", call.id, { outcome });
  if (outcome !== "CONFIRMED") {
    await notifyHr(call.id, null, now);
    return;
  }
  // Адреса в Настройках нет — робот сказал «адрес пришлём сообщением», а
  // сам его не пришлёт никто, кроме HR.
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { interviewInviteAddress: true } });
  if (!settings?.interviewInviteAddress?.trim()) {
    await notifyHr(call.id, "кандидат придёт — отправьте ему адрес", now, {
      body: "Робот пообещал кандидату прислать адрес сообщением — отправьте его. Чтобы робот называл адрес сам, впишите его в настройках.",
    });
  }
}

const SKIP_TEXT: Record<string, string> = {
  too_late: "Робот не успел позвонить до собеседования — позвоните кандидату сами",
  no_phone: "Робот не звонил: у кандидата нет номера — свяжитесь с ним сами",
  not_dialable: "Робот не звонил: номер не похож на таджикский — свяжитесь с кандидатом сами",
  live_voice_off: "Робот не звонил: звонки робота выключены в настройках — позвоните кандидату сами",
  dial_failed: "Робот не смог позвонить — позвоните кандидату сами",
  status_changed: "Робот не звонил: кандидата перевели на другой этап",
  time_changed: "Робот не звонил: время собеседования поменяли",
  wrong_number: "Робот не звонил: в прошлый раз на этот номер ответил не кандидат — проверьте номер",
  audio_down: "Робот не звонил: на линии робота нет звука — позвоните кандидату сами",
};

const GIVE_UP_TEXT: Record<string, string> = {
  wrong_person: "Трубку взял не кандидат — робот больше не звонит, позвоните сами",
  call_back_later: "Кандидат просил перезвонить — робот больше не звонит, позвоните сами",
  robot_failed: "У робота был сбой связи, разговора не было — позвоните кандидату сами",
};

/**
 * Слова для строки в карточке и для уведомления — одно место на оба экрана.
 * skipReason нужен, чтобы сказать ПОЧЕМУ робот не позвонил или не поговорил;
 * без него — общие слова, как раньше.
 */
export function interviewInviteStatusText(call: {
  status: string;
  outcome: string | null;
  proposedTime: string | null;
  skipReason?: string | null;
  /** Есть запись разговора — тогда «послушайте»; нет — слушать нечего. */
  recordingKey?: string | null;
}): string {
  if (call.status === "DONE") {
    if (call.outcome === "CONFIRMED") return "Робот позвонил: придёт";
    if (call.outcome === "RESCHEDULE")
      return `Робот позвонил: просит другое время${call.proposedTime ? ` — ${call.proposedTime}` : ""}`;
    if (call.outcome === "DECLINED") return "Робот позвонил: отказался";
    return call.recordingKey
      ? "Робот позвонил: ответ непонятен, послушайте разговор"
      : "Робот позвонил: ответ непонятен — позвоните кандидату";
  }
  if (call.status === "GIVEN_UP") {
    return (call.skipReason && GIVE_UP_TEXT[call.skipReason]) || "Робот не дозвонился — позвоните кандидату сами";
  }
  if (call.status === "CALLING") return "Робот звонит";
  if (call.status === "SKIPPED") return (call.skipReason && SKIP_TEXT[call.skipReason]) || "Робот не звонил";
  if (call.status === "CANCELLED") return "Звонок отменён";
  return "Робот позвонит в рабочие часы";
}

/** Короткая фраза для заголовка уведомления HR. */
function alertPhrase(call: {
  status: string;
  outcome: string | null;
  proposedTime: string | null;
  skipReason: string | null;
  recordingKey: string | null;
}): string {
  if (call.status === "GIVEN_UP" && !(call.skipReason && GIVE_UP_TEXT[call.skipReason])) {
    return "не дозвонились — позвоните кандидату сами";
  }
  const text = interviewInviteStatusText(call).replace(/^Робот позвонил: /, "");
  return text.charAt(0).toLowerCase() + text.slice(1);
}

async function notifyHr(id: string, override: string | null, now: Date, extra?: { body?: string }): Promise<void> {
  const call = await prisma.interviewInviteCall.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      outcome: true,
      proposedTime: true,
      skipReason: true,
      recordingKey: true,
      interviewAt: true,
      jobApplication: { select: { name: true, contactName: true, phone: true } },
    },
  });
  if (!call) return;
  const who = call.jobApplication.name ?? call.jobApplication.contactName ?? call.jobApplication.phone ?? "Кандидат";
  const what = override ?? alertPhrase(call);
  const alert = {
    title: `Собеседование: ${who} — ${what}`,
    body: `Приглашали ${interviewTimeRu(call.interviewAt)}. ${extra?.body ?? "Откройте анкету и решите, что дальше."}`,
    url: "/vacancies",
    tag: `interview-invite-${call.id}`,
  };
  // Очередь руководству доставляет только в часы алармов (по умолчанию
  // 09:50–14:45), а робот звонит до 19:00: ответ кандидата в 18:45 ждал бы
  // утра, хотя собеседование может быть уже утром (владелец 28.09.2026: «никаких
  // уведомлений о переносе не было»). Вне окна — сразу в ленту И пушем на
  // телефон: до 02.10 здесь была одна лента, и после 14:45 HR не узнавал об
  // ответе, пока сам не откроет CRM (проверка робота 02.10.2026). Ночью
  // телефон молчит сам — тихие часы держит push.ts.
  if (await isWithinAlarmHours(now)) {
    await enqueueDirectorAlert({ ...alert, recipientPermission: "vacancies.view" });
  } else {
    await sendPushToAgents(await findAgentsWithPermission("vacancies.view"), { ...alert, kind: "oversight" });
  }
}

function firstName(fullName: string | null): string | null {
  if (!fullName) return null;
  const first = fullName.trim().split(/\s+/)[0];
  return first && first.length > 1 ? first : null;
}
