import { CONVERSATION_MEDIA_MAX_BYTES, formatUploadLimit } from "@royal-home/shared";
import { api } from "./api";
import { uploadToPurpose, type ChunkedSessionHolder } from "./chunkedUpload";
import type { UploadLive } from "./upload/progressText";

/**
 * Пределы фото по каналу экран больше НЕ проверяет (25.11.2026, владелец: «пусть наш сервер
 * быстренько сожмёт и отправит, как WhatsApp»): сервер сам сжимает фото и видео под предел
 * канала (apps/api/src/lib/outgoingMediaPrepare.ts, числа — packages/shared/src/outgoingMediaLimits.ts).
 * Здесь остался только предел исходника — его делят экран и сервер (CONVERSATION_MEDIA_MAX_BYTES).
 */
export const MAX_MEDIA_PICK_MB = Math.round(CONVERSATION_MEDIA_MAX_BYTES / (1024 * 1024));

const EXT_MIME: Record<string, string> = {
  heic: "image/heic", heif: "image/heif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", mov: "video/quicktime", mp4: "video/mp4", m4v: "video/mp4", "3gp": "video/3gpp", webm: "video/webm",
  mkv: "video/x-matroska",
};

/** Тип файла: Chrome на Windows отдаёт HEIC с iPhone и часть MOV с ПУСТЫМ типом — берём по расширению. */
export function outgoingMediaType(file: Pick<File, "type" | "name">): string {
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) return file.type;
  const ext = ((file.name ?? "").split(".").pop() ?? "").toLowerCase();
  return EXT_MIME[ext] ?? file.type;
}

/** Тот же файл, но с понятным типом: данные не копируются (File поверх тех же байтов). */
function withOutgoingType(file: File): File {
  const type = outgoingMediaType(file);
  return type === file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
}

/** Проверяет выбранный файл фото/видео ДО загрузки. Возвращает текст ошибки или null. */
export function validateOutgoingMediaPick(file: File, _channel?: string | undefined): string | null {
  const type = outgoingMediaType(file);
  if (!type.startsWith("image/") && !type.startsWith("video/")) {
    return "Допустимы только изображения или видео";
  }
  if (file.size > CONVERSATION_MEDIA_MAX_BYTES) {
    return `Файл слишком большой: предел ${formatUploadLimit(CONVERSATION_MEDIA_MAX_BYTES)}`;
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
  const typed = list.map(withOutgoingType);
  if (typed.length === 1) return { error: null, single: typed[0], batch: [] };
  return { error: null, single: null, batch: typed };
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

/** Ответ сборки: сразу отправлено (рубильник сжатия выключен) или принято в очередь сервера. */
export type ConversationMediaUploadResult = { ok: boolean; pausedUntil?: string; queued?: boolean; jobId?: string };

export function uploadConversationMedia(
  conversationId: string,
  file: File,
  caption: string | undefined,
  onProgress: (percent: number) => void,
  /** Ключ повтора (17.11.2026, аудит F2-4): «Повторить» после обрыва не шлёт клиенту файл второй раз. */
  idempotencyKey?: string,
  /** id пузыря: по нему повтор находит прошлую сессию, а «Отменить» — эту отправку. */
  localId?: string,
  /** МБ из МБ, «ждём связь», «повтор через N с» — для строки под пузырём (25.11.2026). */
  onLive?: (live: UploadLive) => void,
  /** Срок паузы бота, выбранный при отправке (ISO): сервер ставит его при приёме файла. Пусто — умолчание сервера. */
  pausedUntil?: string
): Promise<ConversationMediaUploadResult> {
  const previous = localId ? inFlight.get(localId) : undefined;
  const entry = { session: previous?.session ?? {}, controller: new AbortController() };
  if (localId) inFlight.set(localId, entry);
  return uploadToPurpose<ConversationMediaUploadResult>("conversation-media", file, {
    // id сессии — в теле: ключ повтора привязан к адресу, а повтор открывает новую сессию.
    completeUrl: () => `/api/v1/conversations/${conversationId}/reply-media/upload-sessions/complete`,
    completeBody: (sessionId) => ({ sessionId, ...(caption ? { caption } : {}), ...(pausedUntil ? { pausedUntil } : {}) }),
    completeHeaders: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    completeWaitMs: MEDIA_DELIVERY_WAIT_MS,
    completeWaitMessage: "Сервер долго отправляет файл. Проверьте переписку: файл мог уйти — тогда повторять не нужно.",
    onProgress,
    onLive,
    signal: entry.controller.signal,
    session: entry.session,
    report: { kind: "chat", label: "переписка" },
  }).then((result) => {
    if (localId) forget(localId);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Очередь отправки на сервере (25.11.2026): файл уже загружен, сервер сжимает и шлёт
// ---------------------------------------------------------------------------

export type OutgoingMediaJobStatus = "QUEUED" | "PREPARING" | "SENDING" | "SENT" | "FAILED" | "CANCELLED";

export interface OutgoingMediaJobView {
  id: string;
  status: OutgoingMediaJobStatus;
  progress: number;
  error: string | null;
  note: string | null;
  /** false — исход неизвестен (файл мог дойти): «Повторить» не предлагаем. */
  retryable?: boolean;
  kind?: "image" | "video";
  caption?: string | null;
}

/** Незавершённые и упавшие за сутки отправки сотрудника в переписке — пузыри после перезагрузки вкладки. */
export function fetchOutgoingMediaJobs(conversationId: string): Promise<{ jobs: OutgoingMediaJobView[] }> {
  return api<{ jobs: OutgoingMediaJobView[] }>(`/conversations/${conversationId}/media-jobs`);
}

/** Номер пузыря, поднятого с сервера по заданию (а не созданного загрузкой в этой вкладке). */
export function serverJobLocalId(jobId: string): string {
  return `job-${jobId}`;
}

/**
 * СВЕРКА ПУЗЫРЕЙ С СЕРВЕРОМ при открытии переписки (ревью 26.11.2026).
 * `uploads` — пузыри в сторе, `followed` — задания, за которыми вкладка следит прямо сейчас.
 *  - задание есть на сервере, пузыря и слежки нет → завести пузырь (вкладку закрывали или обновляли);
 *  - пузырь с заданием есть, слежки нет, а сервер его уже не называет (список — только незавершённые и
 *    упавшие за сутки) → задание ушло (SENT) или отменено, пока вкладка не следила (опрос сдался через
 *    30 минут «проверьте позже»): пузырь убрать, иначе он висит вечно.
 */
export function reconcileJobBubbles(
  jobs: readonly OutgoingMediaJobView[],
  uploads: ReadonlyArray<{ localId: string; jobId?: string }>,
  followed: ReadonlySet<string>
): { add: OutgoingMediaJobView[]; removeLocalIds: string[] } {
  const present = new Set(uploads.map((u) => u.jobId).filter((id): id is string => !!id));
  const listed = new Set(jobs.map((j) => j.id));
  return {
    add: jobs.filter((j) => !present.has(j.id) && !followed.has(j.id)),
    removeLocalIds: uploads.filter((u) => u.jobId && !listed.has(u.jobId) && !followed.has(u.jobId)).map((u) => u.localId),
  };
}

/** Дольше этого не спрашиваем: сервер сам сдаётся раньше (12 минут сжатия), дальше — «проверьте позже». */
export const OUTGOING_MEDIA_WAIT_MAX_MS = 30 * 60_000;

export function fetchOutgoingMediaJob(conversationId: string, jobId: string): Promise<OutgoingMediaJobView> {
  return api<OutgoingMediaJobView>(`/conversations/${conversationId}/media-jobs/${jobId}`);
}

export function requestOutgoingMediaRetry(conversationId: string, jobId: string): Promise<{ jobId: string }> {
  return api<{ jobId: string }>(`/conversations/${conversationId}/media-jobs/${jobId}/retry`, { method: "POST" });
}

export function requestOutgoingMediaCancel(conversationId: string, jobId: string): Promise<unknown> {
  return api(`/conversations/${conversationId}/media-jobs/${jobId}`, { method: "DELETE" });
}

/** Через сколько спрашивать снова: первые полминуты — раз в 1,5 с (фото уходит за секунды), дальше реже. */
export function outgoingMediaPollDelayMs(elapsedMs: number): number {
  return elapsedMs < 30_000 ? 1_500 : elapsedMs < 3 * 60_000 ? 3_000 : 6_000;
}

/**
 * Ждать, пока сервер отправит файл. Сбой сети при опросе — не сбой отправки: спрашиваем
 * дальше. Возвращает последнее состояние (SENT, FAILED или CANCELLED).
 */
export async function waitOutgoingMediaJob(
  conversationId: string,
  jobId: string,
  onUpdate: (job: OutgoingMediaJobView) => void,
  signal?: AbortSignal,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<OutgoingMediaJobView> {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (Date.now() - started > OUTGOING_MEDIA_WAIT_MAX_MS) {
      return {
        id: jobId, status: "FAILED", progress: 0, retryable: false, note: null,
        error: "Сервер долго отправляет файл — проверьте переписку позже",
      };
    }
    try {
      const job = await fetchOutgoingMediaJob(conversationId, jobId);
      onUpdate(job);
      if (job.status === "SENT" || job.status === "FAILED" || job.status === "CANCELLED") return job;
    } catch (err) {
      // 404 — задания нет (убрано уборкой) — дальше спрашивать бессмысленно.
      if ((err as { status?: number }).status === 404) {
        return { id: jobId, status: "FAILED", progress: 0, error: "Отправка не найдена — обновите переписку", note: null };
      }
    }
    await sleep(outgoingMediaPollDelayMs(Date.now() - started));
  }
}
