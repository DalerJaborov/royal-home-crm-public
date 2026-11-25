import { OUTGOING_MEDIA_SOURCE_MAX_BYTES } from "./outgoingMediaLimits.js";

/**
 * ЕДИНЫЙ ПРЕДЕЛ ВИДЕО ПРИ ЗАГРУЗКЕ (решение владельца 07.10.2026: «лимит на
 * загрузку видео увеличить до максимума, чтобы таких проблем не было»).
 *
 * Живой случай: агент выбрал IMG_9854.MOV (746,6 МБ), подсказка мастера обещала
 * «сжатие принимает до 300 МБ», а сервер отказал «больше лимита 700 МБ» ещё до
 * первого байта — число было набрано руками в пяти местах и в каждом своё.
 * Теперь число одно, и его читают обе стороны: сервер (мастер и карточка
 * объекта) и экраны выбора файла, которые проверяют размер ДО постановки в
 * очередь.
 *
 * 2 ГБ — «максимум» = прежний потолок сессий загрузки по частям
 * (routes/properties/videos.ts) и одиночного приёма готового ролика
 * (upload.ts::videoHandoffUpload). Видео едет частями по 8 МБ на диск, а не
 * целиком в память, поэтому выше этого предела упирается уже не в код, а в
 * ёмкость диска и терпение мобильного интернета.
 *
 * РОВНО 2 ГиБ − 1 БАЙТ, а не 2 ГиБ: `sizeBytes` у VideoUploadSession,
 * PropertyDraftMedia и PropertyVideo — колонки `Int` (int32, максимум
 * 2 147 483 647). Файл ровно в 2 ГиБ проходил проверку предела и падал 500-й
 * на записи сессии (поймано тестом «ровно предел проходит», 07.10.2026). Для
 * человека это всё те же «2 ГБ» (formatUploadLimit).
 */
export const UPLOAD_VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1;

/** Машинный код отказа «ролик больше предела» в теле ответа 400. */
export const VIDEO_TOO_LARGE_CODE = "VIDEO_TOO_LARGE";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Человеческая подпись предела: «2 ГБ», «700 МБ». Дробь только если она есть («1,5 ГБ»). */
export function formatUploadLimit(bytes: number = UPLOAD_VIDEO_MAX_BYTES): string {
  const trim = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");
  if (bytes >= GB) return `${trim(bytes / GB)} ГБ`;
  return `${trim(bytes / MB)} МБ`;
}

/**
 * Текст отказа для ролика больше предела — один на сервер и клиент. `sizeLabel`
 * (уже отформатированный вес, «746,6 МБ») необязателен: клиент его знает и
 * называет, серверу достаточно предела.
 */
export function videoTooLargeMessage(filename: string, sizeLabel?: string): string {
  const weight = sizeLabel ? `весит ${sizeLabel} — больше` : "больше";
  return `Ролик «${filename}» ${weight} предела ${formatUploadLimit()}. Снимите короче или в меньшем разрешении (на iPhone: Настройки → Камера → Форматы → «Эффективный») и добавьте снова.`;
}

/**
 * Делит выбранные файлы на годные и слишком тяжёлые — ПО ВСЕМ, а не по первому.
 * Ровно предел проходит; предел + 1 байт — нет (так же сверяет сервер: `>`).
 */
export function partitionVideosByLimit<T extends { size: number }>(
  files: readonly T[],
  maxBytes: number = UPLOAD_VIDEO_MAX_BYTES
): { accepted: T[]; rejected: T[] } {
  const accepted: T[] = [];
  const rejected: T[] = [];
  for (const file of files) (file.size > maxBytes ? rejected : accepted).push(file);
  return { accepted, rejected };
}

/**
 * ПОТОЛОК ОДНОГО ЗАПРОСА ЧЕРЕЗ ПРОКСИ (17.11.2026, класс «большой файл одним запросом → 413»).
 *
 * Между браузером и API стоят Cloudflare (тело больше 100 МБ — 413 `Server: cloudflare`,
 * замер 17.11: 95 МБ проходит, 105 МБ нет), прокси на хосте и nginx контейнера web
 * (`client_max_body_size 150m`, тело буферизуется в tmpfs 128 МБ). Живой случай: ролик 87 МБ
 * в «Роликах в соцсети» получил 413 ещё до API. 90 МБ — с запасом ниже самого узкого звена.
 *
 * Правило одно: файл, который может быть тяжелее этого числа, едет ЧАСТЯМИ
 * (`UPLOAD_PART_BYTES` за запрос, сессии загрузки), а одиночный маршрут обещает не больше
 * этого числа на весь запрос. Сторож — `scripts/audit-limits.mjs` (шаг precheck и CI).
 */
export const PROXY_SINGLE_REQUEST_MAX_BYTES = 90 * MB;

/**
 * Размер одной части при загрузке частями — ОДНО число на все три вида загрузки частями
 * (общие сессии, видео объекта, ролик черновика мастера; раньше было три копии «8 МБ»).
 *
 * 4 МБ, а не 8 (25.11.2026): на канале 300 Кбит/с часть 8 МБ идёт 224 с — впритык к пределам
 * прокси и Node, и каждый обрыв стоил повтора восьми мегабайт. Все клиенты берут размер части
 * из ПЛАНА, который сервер присылает на старте (web: uploadQueue.ts, chunkedUpload.ts,
 * draftUploads.ts; бот: assistantPropertyDraft.ts), поэтому смена числа касается только новых
 * сессий — открытые доезжают со своим размером из плана.
 */
export const UPLOAD_PART_BYTES = 4 * MB;
/** Наименьшая часть, которую клиент может попросить на старте (`partSize`). */
export const UPLOAD_PART_MIN_BYTES = 1 * MB;
/**
 * Наибольшая часть: и потолок `partSize` на старте, и предел тела запроса части на сервере.
 * 8 МБ — прежний размер части: сессии, открытые до 25.11.2026, досылают части по 8 МБ.
 */
export const UPLOAD_PART_MAX_BYTES = 8 * MB;
/** Потолок числа частей одной сессии (тот же, что был у R2 multipart). */
export const UPLOAD_MAX_PARTS = 10_000;

/**
 * План частей — одна функция на все виды загрузки. `requestedPartSize` (необязательно) —
 * размер, который попросил клиент; вне [MIN, MAX] — null (отказ PART_SIZE_INVALID).
 * Если при таком размере частей больше UPLOAD_MAX_PARTS, часть увеличивается (до файлов
 * в десятки гигабайт дело не доходит: предел видео 2 ГБ).
 */
export function computeUploadPartPlan(
  sizeBytes: number,
  requestedPartSize?: number | null
): { partSize: number; totalParts: number } | null {
  let partSize = requestedPartSize ?? UPLOAD_PART_BYTES;
  if (!Number.isSafeInteger(partSize) || partSize < UPLOAD_PART_MIN_BYTES || partSize > UPLOAD_PART_MAX_BYTES) return null;
  let totalParts = Math.max(1, Math.ceil(sizeBytes / partSize));
  if (totalParts > UPLOAD_MAX_PARTS) {
    partSize = Math.ceil(sizeBytes / UPLOAD_MAX_PARTS);
    totalParts = Math.ceil(sizeBytes / partSize);
  }
  return { partSize, totalParts };
}

/** Ожидаемый размер части `partNumber` по плану (последняя — хвост файла). */
export function expectedUploadPartBytes(plan: { partSize: number; totalParts: number; sizeBytes: number }, partNumber: number): number {
  return partNumber === plan.totalParts ? plan.sizeBytes - plan.partSize * (plan.totalParts - 1) : plan.partSize;
}

/** Машинный код отказа «запрос тяжелее потолка одного запроса» в теле ответа 413. */
export const REQUEST_TOO_LARGE_CODE = "REQUEST_TOO_LARGE";

/**
 * Текст отказа для одиночной отправки тяжелее потолка — один на сервер и экран.
 * `fileCount` > 1 — пачка: человеку важен общий вес («файлы весят вместе …»), а не один файл.
 */
export function singleRequestTooLargeMessage(sizeBytes?: number, fileCount = 1): string {
  const limit = formatUploadLimit(PROXY_SINGLE_REQUEST_MAX_BYTES);
  if (fileCount > 1) {
    const weight = sizeBytes ? ` весят вместе ${formatUploadLimit(sizeBytes)} —` : "";
    return `Файлы${weight} больше ${limit} за одну отправку. Отправьте их в несколько приёмов или уберите часть.`;
  }
  const weight = sizeBytes ? `весит ${formatUploadLimit(sizeBytes)} — это ` : "";
  return `Файл ${weight}больше ${limit} за одну отправку. Сожмите файл или разделите на несколько и отправьте снова.`;
}

/**
 * Пределы файлов, которые идут ЧАСТЯМИ через общие сессии загрузки
 * (apps/api/src/lib/chunkedUploadSessions.ts, POST /api/v1/upload-sessions). Ключ — назначение:
 * сервер по нему выбирает предел и допустимый тип, а сборку делает маршрут этого назначения.
 *
 * - `clip-video` — короткий ролик карточки объекта: 300 МБ до сжатия (обход квартиры телефоном).
 * - `conversation-media` — фото/видео сотрудника клиенту в переписку: 1 ГБ с 25.11.2026
 *   (владелец: «любые видео отправлять, без ограничений»; сервер сам сжимает под канал,
 *   см. outgoingMediaLimits.ts). Было 300 МБ (18.08.2026: «ролик объекта 100-300 МБ»).
 */
export const CHUNKED_UPLOAD_PURPOSES = {
  "clip-video": { maxBytes: 300 * MB, accepts: "video" },
  "conversation-media": { maxBytes: OUTGOING_MEDIA_SOURCE_MAX_BYTES, accepts: "image-or-video" },
} as const satisfies Record<string, { maxBytes: number; accepts: "video" | "image-or-video" }>;

export type ChunkedUploadPurpose = keyof typeof CHUNKED_UPLOAD_PURPOSES;

/** Предел файла фото/видео в переписку — экран проверяет до отправки, сервер — на старте сессии. */
export const CONVERSATION_MEDIA_MAX_BYTES = CHUNKED_UPLOAD_PURPOSES["conversation-media"].maxBytes;
