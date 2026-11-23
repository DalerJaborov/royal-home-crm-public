import { CONVERSATION_MEDIA_MAX_BYTES } from "@royal-home/shared";
import { uploadToPurpose, type ChunkedSessionHolder } from "./chunkedUpload";

/**
 * Пределы ИСХОДЯЩЕГО ФОТО по каналу (18.08.2026) — зеркало OUTGOING_MEDIA_LIMITS
 * (поле image) в apps/api/src/lib/conversationDelivery.ts. Проверка здесь только
 * ради мгновенной подсказки до загрузки: последнее слово всё равно за сервером.
 *
 * ВИДЕО сюда больше не входит (гибридный режим, 18.08.2026 вечер): ролик больше
 * канального лимита не отклоняется — он уходит в R2 и клиенту ссылкой вместо
 * файла (см. deliverMediaToConversation). На фронте у видео остаётся только общий
 * предохранитель MAX_MEDIA_PICK_MB — случайно огромный файл, а не лимит Meta.
 *
 * Общий модуль (22.09.2026): раньше эти два числа и проверка жили только в
 * Messages.tsx (десктоп) — тот самый класс бага «desktop и mobile ship
 * together» из CLAUDE.md, копия логики моглa бы разойтись между экранами.
 */
export const OUTGOING_IMAGE_LIMIT_MB: Record<string, number> = {
  WHATSAPP: 5,
  INSTAGRAM: 25,
  FACEBOOK: 25,
};

/** Верхний предохранитель выбора файла — НЕ лимит Meta (тот выбирает файл/ссылку на
 *  бэкенде). До 17.11.2026 здесь стоял 1 ГБ, а сервер принимал 300 МБ: экран пропускал
 *  файл, который сервер всё равно отклонял. Теперь число одно — CONVERSATION_MEDIA_MAX_BYTES
 *  в packages/shared, им же сервер проверяет старт загрузки. */
export const MAX_MEDIA_PICK_MB = Math.round(CONVERSATION_MEDIA_MAX_BYTES / (1024 * 1024));

/** Проверяет выбранный файл фото/видео ДО загрузки — тот же расчёт, что раньше
 *  жил только в Messages.tsx (см. комментарий у OUTGOING_IMAGE_LIMIT_MB выше).
 *  Возвращает текст ошибки или null, если файл годится. */
export function validateOutgoingMediaPick(file: File, channel: string | undefined): string | null {
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  if (!isImage && !isVideo) {
    return "Допустимы только изображения или видео";
  }
  if (file.size > MAX_MEDIA_PICK_MB * 1024 * 1024) {
    return `Файл слишком большой: предел ${MAX_MEDIA_PICK_MB} МБ`;
  }
  if (isImage && channel) {
    const limitMb = OUTGOING_IMAGE_LIMIT_MB[channel];
    if (limitMb && file.size > limitMb * 1024 * 1024) {
      return `Файл слишком большой: для фото в этом канале предел ${limitMb} МБ`;
    }
  }
  return null;
}

/**
 * Выбор НЕСКОЛЬКИХ фото/видео за раз (23.11.2026, «отправить фото клиенту — в одно
 * касание»): один файл идёт прежним путём (превью + подпись), несколько — сразу
 * в отправку, без промежуточных шагов. Любой неподходящий файл останавливает весь
 * выбор с понятной причиной: половину пачки молча не отправляем.
 */
export function planOutgoingMediaPick(
  files: ArrayLike<File> | null | undefined,
  channel: string | undefined,
): { error: string | null; single: File | null; batch: File[] } {
  const list = Array.from(files ?? []);
  for (const file of list) {
    const error = validateOutgoingMediaPick(file, channel);
    if (error) return { error: list.length > 1 ? `${file.name}: ${error}` : error, single: null, batch: [] };
  }
  if (list.length === 1) return { error: null, single: list[0], batch: [] };
  return { error: null, single: null, batch: list };
}

/**
 * Загрузка фото/видео в переписку С ПРОГРЕССОМ (18.08.2026), ЧАСТЯМИ с 17.11.2026.
 *
 * Одним запросом ролик объекта 100-300 МБ не доходил до сервера: Cloudflare и прокси режут
 * тело больше ~100 МБ (413 «Файл слишком большой» ещё до API). Теперь файл едет частями по
 * 8 МБ (общий помощник lib/chunkedUpload.ts, назначение `conversation-media`), каждая часть
 * при сбое повторяется, а сервер на сборке доставляет файл клиенту тем же путём, что и
 * прежний одиночный маршрут (routes/conversations.ts, deliverReplyMedia).
 *
 * Ключ повтора уходит на шаге сборки: «Повторить» после обрыва не шлёт клиенту файл второй
 * раз — сервер отдаёт ответ первой сборки (lib/idempotency.ts).
 */
export const MEDIA_DELIVERY_WAIT_MS = 120_000;

/**
 * Состояние отправки между попытками и отмена (ревью #254). По `localId` пузыря: сессия
 * частей (повтор докачивает её, а не грузит файл заново) и рычаг отмены — «Отменить»
 * обрывает идущую часть, не шлёт оставшиеся и не зовёт сборку, то есть файл клиенту не уйдёт.
 * Модульная таблица, а не состояние компонента: пузырь живёт в общем сторе и переживает
 * переключение диалогов, а с ним и загрузка.
 */
const inFlight = new Map<string, { session: ChunkedSessionHolder; controller: AbortController }>();

/** Отменить отправку пузыря. Сессию забываем: следующий раз — с чистого листа. */
export function cancelConversationMediaUpload(localId: string): void {
  const entry = inFlight.get(localId);
  entry?.controller.abort();
  inFlight.delete(localId);
}

/** Успех — забыть состояние пузыря. */
function forget(localId: string) {
  inFlight.delete(localId);
}

export function uploadConversationMedia(
  conversationId: string,
  file: File,
  caption: string | undefined,
  onProgress: (percent: number) => void,
  /** Ключ повтора (17.11.2026, аудит F2-4): «Повторить» после обрыва не шлёт клиенту файл второй раз. */
  idempotencyKey?: string,
  /** id пузыря: по нему повтор находит прошлую сессию, а «Отменить» — эту отправку. */
  localId?: string
): Promise<{ ok: boolean; pausedUntil: string }> {
  const previous = localId ? inFlight.get(localId) : undefined;
  const entry = { session: previous?.session ?? {}, controller: new AbortController() };
  if (localId) inFlight.set(localId, entry);
  return uploadToPurpose<{ ok: boolean; pausedUntil: string }>("conversation-media", file, {
    // id сессии — в теле: ключ повтора привязан к адресу, а повтор открывает новую сессию.
    completeUrl: () => `/api/v1/conversations/${conversationId}/reply-media/upload-sessions/complete`,
    completeBody: (sessionId) => (caption ? { sessionId, caption } : { sessionId }),
    completeHeaders: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    completeWaitMs: MEDIA_DELIVERY_WAIT_MS,
    completeWaitMessage: "Сервер долго отправляет файл. Проверьте переписку: файл мог уйти — тогда повторять не нужно.",
    onProgress,
    signal: entry.controller.signal,
    session: entry.session,
  }).then((result) => {
    if (localId) forget(localId);
    return result;
  });
}
