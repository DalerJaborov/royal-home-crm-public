import { UPLOAD_ERROR_SPECS, uploadErrorBody, type UploadErrorBody, type UploadErrorCode } from "@royal-home/shared";

/**
 * Отказ загрузки частями с машинным кодом (packages/shared/src/uploadErrors.ts). Бросает слой
 * хранения (lib/localVideoStorage.ts) и ядро сессий; маршрут превращает его в ответ одной
 * функцией (sendUploadError, lib/uploadHttp.ts). Здесь нет ни базы, ни журнала — модуль
 * подключается из самого нижнего слоя.
 */
export class UploadError extends Error {
  readonly code: UploadErrorCode;
  readonly status: number;
  readonly retryAfterMs?: number;
  /** Поля тела ответа сверх стандартных (например `uploadedPartNumbers`). */
  readonly extra?: Record<string, unknown>;
  /** Подробность для журнала (пути, системный текст) — клиенту НЕ отдаётся. */
  readonly detail?: string;

  constructor(
    code: UploadErrorCode,
    options: {
      message?: string;
      status?: number;
      retryAfterMs?: number;
      extra?: Record<string, unknown>;
      detail?: string;
      cause?: unknown;
    } = {}
  ) {
    super(options.message ?? UPLOAD_ERROR_SPECS[code].message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.status = options.status ?? UPLOAD_ERROR_SPECS[code].status;
    this.retryAfterMs = options.retryAfterMs;
    this.extra = options.extra;
    this.detail = options.detail;
  }

  body(): UploadErrorBody {
    return uploadErrorBody(this.code, { message: this.message, retryAfterMs: this.retryAfterMs, extra: this.extra });
  }
}

/** Код ошибки файловой системы «нет места» (ENOSPC — диск, EDQUOT — квота). */
export function isDiskFullError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

/** Любой сбой диска → UploadError: нехватка места — DISK_FULL (507), остальное — STORAGE_FAILED (500). */
export function toStorageError(err: unknown, what: string): UploadError {
  if (err instanceof UploadError) return err;
  const detail = `${what}: ${err instanceof Error ? err.message : String(err)}`;
  return new UploadError(isDiskFullError(err) ? "DISK_FULL" : "STORAGE_FAILED", { cause: err, detail });
}
