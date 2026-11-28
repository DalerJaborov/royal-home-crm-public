import { stat } from "node:fs/promises";
import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { sendMessage, sendVideoByFileId, sendVideoFromDisk } from "../../telegram/api.js";
import type { Lesson } from "./catalog.js";

/**
 * ОТПРАВКА ВИДЕОУРОКА В TELEGRAM — ОДНА ДВЕРЬ (28.11.2026).
 *
 * Первая отправка — файлом с диска, Telegram возвращает file_id; он хранится в LessonVideoCache вместе с
 * подписью файла (размер:время изменения), дальше урок уходит по file_id без загрузки. Файл заменили на
 * сервере — подпись другая, кэш не используется. В личке стоит protect_content (не переслать и не сохранить),
 * в группе — обычная отправка. Пределы: не чаще LESSON_SENDS_PER_MINUTE уроков в минуту на чат, тот же урок в
 * тот же чат — не чаще раза в минуту, «все уроки» — раз в час на чат. Счётчики в памяти процесса: после
 * перезапуска начинаются заново (цель — защита от двойного нажатия и зацикленной модели, не учёт).
 */
export const LESSON_SENDS_PER_MINUTE = 6;
export const LESSON_DUPLICATE_MS = 60_000;
export const LESSON_BROADCAST_INTERVAL_MS = 60 * 60_000;

const sendsByChat = new Map<string, number[]>();
const lastSendByKey = new Map<string, number>();
const lastBroadcastByChat = new Map<string, number>();

/** Для тестов. */
export function resetLessonSendLimits(): void {
  sendsByChat.clear();
  lastSendByKey.clear();
  lastBroadcastByChat.clear();
}

export type LessonLimit = { ok: true } | { ok: false; error: string };

/** Проверяет и ЗАНИМАЕТ место в пределах отправки одного урока. */
export function takeLessonSendSlot(chatId: string, lesson: Pick<Lesson, "number" | "lang">, now = Date.now()): LessonLimit {
  const key = `${chatId}:${lesson.lang}:${lesson.number}`;
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
  lastSendByKey.set(key, now);
  return { ok: true };
}

/** Проверяет и занимает «все уроки» (раз в час на чат). */
export function takeLessonBroadcastSlot(chatId: string, now = Date.now()): LessonLimit {
  const prev = lastBroadcastByChat.get(chatId);
  if (prev !== undefined && now - prev < LESSON_BROADCAST_INTERVAL_MS) {
    const minutes = Math.ceil((LESSON_BROADCAST_INTERVAL_MS - (now - prev)) / 60_000);
    return { ok: false, error: `Все уроки в этот чат уже отправлялись. Повторить можно через ${minutes} мин` };
  }
  lastBroadcastByChat.set(chatId, now);
  return { ok: true };
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

export type LessonSendResult = { ok: true; via: "file_id" | "disk" } | { ok: false; error: string };

/** Отправляет один урок в чат. Пределы проверяет вызывающий (takeLessonSendSlot). */
export async function sendLessonVideo(chatId: string, lesson: Lesson, opts: { protect: boolean }): Promise<LessonSendResult> {
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
      // file_id мог устареть (другой бот, сброс): шлём файлом и обновим запись ниже.
      void logSystemError("api", `Видеоурок ${lesson.number} (${lesson.lang}): по file_id не ушёл, шлю файлом: ${describeError(err)}`);
    }
  }
  try {
    const cover = await usableCover(lesson.coverPath);
    const sent = await sendVideoFromDisk(chatId, lesson.filePath, caption, undefined, undefined, {
      width: 1080,
      height: 1920,
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

/** «Все уроки»: оглавление, уроки по порядку с паузой, «Это все». Возвращает число отправленных. */
export async function broadcastLessons(chatId: string, lessons: Lesson[], opts: { protect: boolean }): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  await sendMessage(chatId, lessonContentsLine(lessons));
  for (const lesson of lessons) {
    await pause(lessonBroadcastPauseMs());
    // В рассылке лимит «в минуту» не нужен (между уроками пауза), но отметка о дубле ставится.
    lastSendByKey.set(`${chatId}:${lesson.lang}:${lesson.number}`, Date.now());
    const result = await sendLessonVideo(chatId, lesson, opts);
    if (result.ok) sent += 1;
    else failed += 1;
  }
  await pause(lessonBroadcastPauseMs());
  await sendMessage(chatId, failed > 0 ? `Это все, кроме уроков, которые не отправились (${failed}). Попросите их отдельно` : "Это все");
  return { sent, failed };
}
