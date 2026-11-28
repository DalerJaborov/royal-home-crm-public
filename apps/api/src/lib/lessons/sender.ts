import { stat } from "node:fs/promises";
import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { sendMessage, sendVideoByFileId, sendVideoFromDisk, TelegramApiError } from "../../telegram/api.js";
import { isShuttingDown } from "../shutdownState.js";
import { realPathInsideLessonsDir, type Lesson } from "./catalog.js";

/**
 * ОТПРАВКА ВИДЕОУРОКА В TELEGRAM — ОДНА ДВЕРЬ (28.11.2026).
 *
 * Первая отправка — файлом с диска, Telegram возвращает file_id; он хранится в LessonVideoCache вместе с
 * подписью файла (размер:время изменения), дальше урок уходит по file_id без загрузки. Файл заменили на
 * сервере — подпись другая, кэш не используется. В личке стоит protect_content (не переслать и не сохранить),
 * в группе — обычная отправка. Пределы: не чаще LESSON_SENDS_PER_MINUTE уроков в минуту на чат, тот же урок в
 * тот же чат — не чаще раза в минуту, «все уроки» — раз в час на чат. Метка «уже отправлен» ставится только
 * после успеха; пока урок уходит, держится замок «отправляется». Счётчики в памяти процесса: после
 * перезапуска начинаются заново (цель — защита от двойного нажатия и зацикленной модели, не учёт).
 * Отказ Telegram 400/403 (бот заблокирован, чат не найден, нет права слать видео) — состояние чата, а не
 * поломка: человеку понятная фраза, в журнал не пишем, с диска повторно не грузим, «все уроки» останавливаем.
 */
export const LESSON_SENDS_PER_MINUTE = 6;
export const LESSON_DUPLICATE_MS = 60_000;
export const LESSON_BROADCAST_INTERVAL_MS = 60 * 60_000;
/** Облачный Bot API принимает файл до 50 МБ; свой сервер (TELEGRAM_API_BASE_URL) — до 2 ГБ. */
export const CLOUD_BOT_API_FILE_LIMIT = 50 * 1024 * 1024;

const sendsByChat = new Map<string, number[]>();
/** Когда урок УСПЕШНО ушёл в чат (метка «уже отправлен» ставится только после успеха). */
const lastSendByKey = new Map<string, number>();
/** Уроки, которые прямо сейчас отправляются (замок «в процессе»). */
const inFlightByKey = new Set<string>();
const lastBroadcastByChat = new Map<string, number>();
const broadcastInFlight = new Set<string>();

/** Для тестов. */
export function resetLessonSendLimits(): void {
  sendsByChat.clear();
  lastSendByKey.clear();
  inFlightByKey.clear();
  lastBroadcastByChat.clear();
  broadcastInFlight.clear();
}

/**
 * Занятое место: вызывающий ОБЯЗАН позвать done(true) после успешной отправки или done(false) при любом
 * неуспехе (ошибка Telegram, aborted, файла нет) — тогда замок снимается, метка «отправлен» не ставится,
 * место в минутном пределе возвращается.
 */
export type LessonLimit = { ok: true; done: (success: boolean) => void } | { ok: false; error: string };

/** Проверяет и ЗАНИМАЕТ место в пределах отправки одного урока. */
export function takeLessonSendSlot(chatId: string, lesson: Pick<Lesson, "number" | "lang">, now = Date.now()): LessonLimit {
  const key = `${chatId}:${lesson.lang}:${lesson.number}`;
  if (inFlightByKey.has(key)) {
    return { ok: false, error: `Урок ${lesson.number} сейчас отправляется. Подождите, он скоро придёт` };
  }
  const prev = lastSendByKey.get(key);
  if (prev !== undefined && now - prev < LESSON_DUPLICATE_MS) {
    return { ok: false, error: `Урок ${lesson.number} уже отправлен в этот чат меньше минуты назад. Он выше в переписке` };
  }
  const recent = (sendsByChat.get(chatId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= LESSON_SENDS_PER_MINUTE) {
    return { ok: false, error: "Слишком много уроков за минуту. Подождите минуту и попросите ещё раз" };
  }
  recent.push(now);
  sendsByChat.set(chatId, recent);
  inFlightByKey.add(key);
  let finished = false;
  return {
    ok: true,
    done(success: boolean) {
      if (finished) return;
      finished = true;
      inFlightByKey.delete(key);
      if (success) {
        lastSendByKey.set(key, Date.now());
        return;
      }
      const list = sendsByChat.get(chatId);
      const at = list ? list.lastIndexOf(now) : -1;
      if (list && at >= 0) list.splice(at, 1);
    },
  };
}

/** Проверяет и занимает «все уроки» (раз в час на чат). Час отсчитывается с первого дошедшего сообщения. */
export function takeLessonBroadcastSlot(chatId: string, now = Date.now()): LessonLimit {
  if (broadcastInFlight.has(chatId)) {
    return { ok: false, error: "Все уроки в этот чат уже отправляются. Они придут по очереди" };
  }
  const prev = lastBroadcastByChat.get(chatId);
  if (prev !== undefined && now - prev < LESSON_BROADCAST_INTERVAL_MS) {
    const minutes = Math.ceil((LESSON_BROADCAST_INTERVAL_MS - (now - prev)) / 60_000);
    return { ok: false, error: `Все уроки в этот чат уже отправлялись. Повторить можно через ${minutes} мин` };
  }
  broadcastInFlight.add(chatId);
  let finished = false;
  return {
    ok: true,
    done(success: boolean) {
      if (finished) return;
      finished = true;
      broadcastInFlight.delete(chatId);
      // success — хотя бы первое сообщение дошло; иначе час не блокируем.
      if (success) lastBroadcastByChat.set(chatId, Date.now());
    },
  };
}

export function lessonCaption(lesson: Pick<Lesson, "number" | "title">): string {
  return `Урок ${lesson.number}. ${lesson.title}`;
}

async function fileSignature(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? `${s.size}:${Math.round(s.mtimeMs)}` : null;
  } catch {
    return null;
  }
}

async function usableCover(path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    const s = await stat(path);
    // Telegram принимает обложку до 200 КБ; больше — он её молча выбросит, шлём без неё.
    return s.isFile() && s.size <= 200 * 1024 ? path : null;
  } catch {
    return null;
  }
}

export type LessonSendResult = { ok: true; via: "file_id" | "disk" } | { ok: false; error: string; stop?: boolean };

/** Отказ Telegram по самому чату (400/403), а не сбой сервера или сети. */
function isChatRefusal(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError && (err.errorCode === 400 || err.errorCode === 403);
}

/** «Файл не тот» (протухший file_id) — единственный 400, после которого есть смысл грузить файл с диска. */
function isStaleFileId(err: TelegramApiError): boolean {
  return err.errorCode === 400 && /wrong (remote )?file|file (identifier|reference|id)|file_id/i.test(err.message);
}

export function chatRefusalText(err: TelegramApiError): string {
  if (err.errorCode === 403) {
    return "Telegram не даёт боту писать в этот чат (бот заблокирован или удалён из чата). Откройте чат с ботом и нажмите «Старт», либо верните бота в группу";
  }
  if (/not enough rights|have no rights|rights to send|CHAT_SEND_|not allowed/i.test(err.message)) {
    return "В этом чате у бота нет права отправлять видео. Выдайте боту это право в настройках группы";
  }
  if (/chat not found|PEER_ID_INVALID|user not found/i.test(err.message)) {
    return "Telegram не нашёл этот чат. Откройте чат с ботом и нажмите «Старт», либо проверьте, что бот в группе";
  }
  return "Telegram не принял видео в этот чат. Проверьте, что бот в чате и может отправлять видео";
}

function sizeLimitApplies(): boolean {
  return !process.env.TELEGRAM_API_BASE_URL?.trim();
}

/**
 * Отправляет один урок в чат. Пределы проверяет вызывающий (takeLessonSendSlot). Ошибка с `stop: true` — чат
 * отказал совсем (400/403): дальше слать в него бессмысленно.
 */
export async function sendLessonVideo(chatId: string, lesson: Lesson, opts: { protect: boolean }): Promise<LessonSendResult> {
  if (!(await realPathInsideLessonsDir(lesson.filePath))) {
    void logSystemError("api", `Видеоурок ${lesson.number} (${lesson.lang}): путь файла вне каталога уроков`, { dedupKey: `lesson-path-${lesson.lang}-${lesson.number}` });
    return { ok: false, error: `Файл урока ${lesson.number} сейчас недоступен` };
  }
  const sig = await fileSignature(lesson.filePath);
  if (!sig) {
    void logSystemError("api", `Видеоурок ${lesson.number} (${lesson.lang}): файл не найден на сервере`);
    return { ok: false, error: `Файл урока ${lesson.number} сейчас недоступен` };
  }
  const caption = lessonCaption(lesson);
  const cached = await prisma.lessonVideoCache.findUnique({ where: { lang_number: { lang: lesson.lang, number: lesson.number } } });
  if (cached && cached.fileSig === sig) {
    try {
      await sendVideoByFileId(chatId, cached.fileId, caption, { protectContent: opts.protect });
      return { ok: true, via: "file_id" };
    } catch (err) {
      if (isChatRefusal(err) && !isStaleFileId(err)) return { ok: false, error: chatRefusalText(err), stop: true };
      // file_id мог устареть (другой бот, сброс): шлём файлом и обновим запись ниже.
      void logSystemError("api", `Видеоурок ${lesson.number} (${lesson.lang}): по file_id не ушёл, шлю файлом: ${describeError(err)}`);
    }
  }
  const size = Number(sig.split(":")[0]);
  if (sizeLimitApplies() && size > CLOUD_BOT_API_FILE_LIMIT) {
    void logSystemError("api", `Видеоурок ${lesson.number} (${lesson.lang}) больше 50 МБ, а свой сервер Bot API не подключён (TELEGRAM_API_BASE_URL)`, { dedupKey: `lesson-too-big-${lesson.lang}-${lesson.number}` });
    return { ok: false, error: `Урок ${lesson.number} слишком большой для отправки в Telegram (больше 50 МБ). Сообщите руководителю` };
  }
  try {
    const cover = await usableCover(lesson.coverPath);
    const hasSize = lesson.width != null && lesson.height != null;
    const sent = await sendVideoFromDisk(chatId, lesson.filePath, caption, undefined, undefined, {
      ...(hasSize ? { width: lesson.width, height: lesson.height } : {}),
      durationSec: lesson.durationSec,
      thumbnailPath: cover,
      protectContent: opts.protect,
    });
    const fileId = sent.video?.file_id;
    if (fileId) {
      await prisma.lessonVideoCache
        .upsert({
          where: { lang_number: { lang: lesson.lang, number: lesson.number } },
          create: { lang: lesson.lang, number: lesson.number, fileSig: sig, fileId },
          update: { fileSig: sig, fileId },
        })
        .catch((err) => void logSystemError("api", `Видеоурок ${lesson.number}: file_id не сохранён: ${describeError(err)}`));
    }
    return { ok: true, via: "disk" };
  } catch (err) {
    if (isChatRefusal(err)) return { ok: false, error: chatRefusalText(err), stop: true };
    void logSystemError("api", `Видеоурок ${lesson.number} (${lesson.lang}) не отправлен: ${describeError(err)}`);
    return { ok: false, error: "Не получилось отправить урок. Попробуйте чуть позже" };
  }
}

export function lessonContentsLine(lessons: Pick<Lesson, "number" | "title">[]): string {
  return `Уроки по CRM:\n${lessons.map((l) => `${l.number}. ${l.title}`).join("\n")}`;
}

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function lessonBroadcastPauseMs(): number {
  const raw = Number(process.env.LESSONS_SEND_PAUSE_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30_000) : 2_000;
}

/**
 * «Все уроки»: оглавление, уроки по порядку с паузой, «Это все». Возвращает число отправленных.
 * `slot` — место из takeLessonBroadcastSlot: отмечается успешным после первого дошедшего сообщения (оглавления),
 * при провале на нём час не блокируется. Рассылка останавливается при остановке сервера и при отказе чата (400/403).
 */
export async function broadcastLessons(
  chatId: string,
  lessons: Lesson[],
  opts: { protect: boolean; slot?: Extract<LessonLimit, { ok: true }> },
): Promise<{ sent: number; failed: number; stopped?: "shutdown" | "chat-refused" }> {
  let sent = 0;
  let failed = 0;
  try {
    await sendMessage(chatId, lessonContentsLine(lessons));
  } catch (err) {
    opts.slot?.done(false);
    if (isChatRefusal(err)) return { sent, failed, stopped: "chat-refused" };
    throw err;
  }
  opts.slot?.done(true);
  let stopped: "shutdown" | "chat-refused" | undefined;
  for (const lesson of lessons) {
    await pause(lessonBroadcastPauseMs());
    if (isShuttingDown()) {
      stopped = "shutdown";
      break;
    }
    // В рассылке лимит «в минуту» не нужен (между уроками пауза), но замок «отправляется» и метка о дубле есть.
    const key = `${chatId}:${lesson.lang}:${lesson.number}`;
    if (inFlightByKey.has(key)) {
      failed += 1;
      continue;
    }
    inFlightByKey.add(key);
    let result: LessonSendResult;
    try {
      result = await sendLessonVideo(chatId, lesson, opts);
    } finally {
      inFlightByKey.delete(key);
    }
    if (result.ok) {
      lastSendByKey.set(key, Date.now());
      sent += 1;
    } else {
      failed += 1;
      if (result.stop) {
        stopped = "chat-refused";
        break;
      }
    }
  }
  if (stopped === "shutdown") {
    // logSystemError при остановке сам пропускает запись (пул базы закрывается), поэтому строка идёт и в консоль.
    console.warn(`[lessons] рассылка в чат ${chatId} прервана остановкой сервера: отправлено ${sent} из ${lessons.length}`);
    void logSystemError("api", `Рассылка всех уроков прервана остановкой сервера: отправлено ${sent} из ${lessons.length}`);
    return { sent, failed, stopped };
  }
  if (stopped === "chat-refused") return { sent, failed, stopped };
  await pause(lessonBroadcastPauseMs());
  try {
    await sendMessage(chatId, failed > 0 ? `Это все, кроме уроков, которые не отправились (${failed}). Попросите их отдельно` : "Это все");
  } catch (err) {
    if (!isChatRefusal(err)) throw err;
  }
  return { sent, failed };
}
