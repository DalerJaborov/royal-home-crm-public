/**
 * ЕДИНЫЙ ФОРМАТ ОТКАЗА ПРИ ЗАГРУЗКЕ ФАЙЛА ЧАСТЯМИ (25.11.2026, волна B «загрузка не теряет
 * данные и всегда отвечает понятно»).
 *
 * До этого три реализации приёма частей (общее ядро, видео объекта, черновик мастера) отвечали
 * кто во что горазд: `{error}`, `{error, code}`, `{error, retryable}`, `{error, inProgress}`;
 * сбой диска — 502 (клиент принимал за обрыв прокси), «слишком большой» — 413 в одном месте и
 * 400 в другом. Экран не мог отличить «повторите» от «бесполезно повторять».
 *
 * Теперь у каждого отказа есть:
 *   - `code`      — машинный код из списка ниже (по нему экран решает, что делать);
 *   - `message`   — человеческий текст по-русски (его можно показать как есть);
 *   - `retryable` — есть ли смысл повторять тот же запрос;
 *   - `retryAfterMs` — через сколько повторить (если сервер знает).
 * Поле `error` сохранено и равно `message` — старые вкладки читают именно его.
 */

export const UPLOAD_ERROR_CODES = [
  /** На диске сервера не хватает места — повтор не поможет, нужен администратор. */
  "DISK_FULL",
  /** Сбой записи/чтения на диске сервера (не нехватка места) — можно повторить. */
  "STORAGE_FAILED",
  /** Не все части дошли (или часть на диске оказалась битой) — дослать `uploadedPartNumbers`-недостающие. */
  "PARTS_MISSING",
  /** Файл уже собирается другим запросом — подождать и спросить состояние. */
  "ASSEMBLING",
  /** Часть пришла не того размера, что в плане. */
  "PART_SIZE_MISMATCH",
  /** Номер части вне плана. */
  "PART_OUT_OF_RANGE",
  /** Пустая часть. */
  "EMPTY_PART",
  /** Тело части оборвалось посередине (связь) — повторить ту же часть. */
  "PART_INCOMPLETE",
  /** Загрузки нет (истекла, отменена, чужая). */
  "SESSION_NOT_FOUND",
  /** Файл уже собран — новые части в эту сессию не принимаются. */
  "ALREADY_ASSEMBLED",
  /** Слишком много одновременных загрузок у сотрудника. */
  "TOO_MANY_UPLOADS",
  /** Файл больше предела назначения. */
  "FILE_TOO_LARGE",
  /** Неверный размер части, запрошенный на старте. */
  "PART_SIZE_INVALID",
  /** Собранный файл — не видео (ffprobe не нашёл видеопоток). */
  "NOT_VIDEO",
  /** Ролик длиннее предела назначения. */
  "TOO_LONG",
  /** Частота запросов выше предела — повторить позже. */
  "RATE_LIMITED",
] as const;

export type UploadErrorCode = (typeof UPLOAD_ERROR_CODES)[number];

interface UploadErrorSpec {
  status: number;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** Код → HTTP-статус и текст по умолчанию. Одно место на сервер и экран. */
export const UPLOAD_ERROR_SPECS: Record<UploadErrorCode, UploadErrorSpec> = {
  DISK_FULL: {
    status: 507,
    message: "На сервере закончилось место для файлов — загрузка остановлена. Мы уже получили сигнал, попробуйте позже.",
    retryable: false,
  },
  STORAGE_FAILED: {
    status: 500,
    message: "Сервер не смог сохранить файл — попробуем ещё раз",
    retryable: true,
    retryAfterMs: 5_000,
  },
  PARTS_MISSING: { status: 409, message: "Не все части файла дошли — дошлём недостающие", retryable: true },
  ASSEMBLING: { status: 409, message: "Файл уже собирается — подождите", retryable: true, retryAfterMs: 3_000 },
  PART_SIZE_MISMATCH: { status: 400, message: "Размер части не совпадает с планом загрузки", retryable: false },
  PART_OUT_OF_RANGE: { status: 400, message: "Неверный номер части", retryable: false },
  EMPTY_PART: { status: 400, message: "Пустая часть", retryable: false },
  PART_INCOMPLETE: { status: 400, message: "Часть оборвалась по дороге — отправим её ещё раз", retryable: true, retryAfterMs: 2_000 },
  SESSION_NOT_FOUND: { status: 404, message: "Загрузка не найдена — выберите файл ещё раз", retryable: false },
  ALREADY_ASSEMBLED: { status: 409, message: "Файл уже собран", retryable: false },
  TOO_MANY_UPLOADS: {
    status: 429,
    message: "Сейчас идёт слишком много ваших загрузок — дождитесь, пока закончится одна из них",
    retryable: true,
    retryAfterMs: 30_000,
  },
  FILE_TOO_LARGE: { status: 413, message: "Файл больше допустимого предела", retryable: false },
  PART_SIZE_INVALID: { status: 400, message: "Неверный размер части", retryable: false },
  NOT_VIDEO: { status: 422, message: "Файл не читается как видео — выберите другой ролик", retryable: false },
  TOO_LONG: { status: 422, message: "Ролик длиннее допустимого", retryable: false },
  RATE_LIMITED: { status: 429, message: "Слишком много запросов, подождите немного", retryable: true, retryAfterMs: 10_000 },
};

export interface UploadErrorBody {
  /** = message. Старые вкладки читают это поле. */
  error: string;
  message: string;
  code: UploadErrorCode | string;
  retryable: boolean;
  retryAfterMs?: number;
  [extra: string]: unknown;
}

/** Тело отказа: свой текст и дополнительные поля (например `uploadedPartNumbers`) поверх умолчаний кода. */
export function uploadErrorBody(
  code: UploadErrorCode,
  options: { message?: string; retryAfterMs?: number; extra?: Record<string, unknown> } = {}
): UploadErrorBody {
  const spec = UPLOAD_ERROR_SPECS[code];
  const message = options.message ?? spec.message;
  const retryAfterMs = options.retryAfterMs ?? spec.retryAfterMs;
  return {
    ...(options.extra ?? {}),
    error: message,
    message,
    code,
    retryable: spec.retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/**
 * АСИНХРОННАЯ СБОРКА. Заголовок `X-Upload-Async: 1` на запросе «собрать файл» (complete)
 * просит ответить 202 сразу и собирать в фоне; состояние — GET сессии (поле `state`).
 * Без заголовка — прежний синхронный ответ 200/201 (старые открытые вкладки).
 */
export const UPLOAD_ASYNC_HEADER = "X-Upload-Async";

/** Состояние сессии загрузки: принимает части → собирает → обрабатывает → готово / ошибка. */
export const UPLOAD_SESSION_STATES = ["receiving", "assembling", "processing", "done", "failed"] as const;
export type UploadSessionState = (typeof UPLOAD_SESSION_STATES)[number];

/** Ответ GET состояния сессии — один вид у всех трёх видов загрузки частями. */
export interface UploadSessionStatusView {
  sessionId: string;
  state: UploadSessionState;
  partSize: number;
  totalParts: number;
  sizeBytes: number;
  uploadedPartNumbers: number[];
  /** Сколько байт уже лежит на сервере (сумма принятых частей). */
  receivedBytes: number;
  /** Итог сборки при `done`: тот же код и тело, что вернул бы синхронный ответ. */
  result?: { status: number; body: unknown };
  /** Отказ при `failed`. */
  error?: UploadErrorBody;
  updatedAt: string;
}

/** Сколько сервер помнит итог сборки после завершения (повтор «собрать» отдаёт его же). */
export const UPLOAD_RESULT_KEEP_MS = 24 * 60 * 60 * 1000;

/** Сессия без новой части дольше этого считается брошенной (одно число на все три вида). */
export const UPLOAD_SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
