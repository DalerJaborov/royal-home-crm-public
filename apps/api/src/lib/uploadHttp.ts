import type { Request, Response } from "express";
import type { Readable } from "node:stream";
import { UPLOAD_PART_MAX_BYTES } from "@royal-home/shared";
import { UploadError } from "./uploadErrors.js";
import { logSystemError } from "./systemError.js";

/**
 * HTTP-СТОРОНА ЗАГРУЗКИ ЧАСТЯМИ — одна на три вида (общие сессии, видео объекта, ролик
 * черновика), 25.11.2026.
 *
 *  - partBodySource: тело части НЕ читается в память целиком (раньше express.raw держал до
 *    32 МБ на запрос в контейнере на 768 МБ): маршрут сначала проверяет права и сессию, а потом
 *    отдаёт поток запроса слою хранения (writeLocalUploadPart), который пишет его на диск со
 *    счётчиком байт. Заголовок Content-Length больше UPLOAD_PART_MAX_BYTES — отказ сразу.
 *  - sendUploadError: отказ с кодом → ответ единого вида (packages/shared/src/uploadErrors.ts);
 *    нехватка места и сбой диска — ещё и тревога в журнал (с дедупом, без потока строк).
 *  - logUploadPart: лёгкая строка в журнал контейнера о каждой НЕудачной части (сессия,
 *    номер, байты, время, адрес, UA, код) и счётчики для ежедневной сводки (uploadStats).
 */

/**
 * Адреса частей загрузки (PUT …/parts/N) всех трёх видов — у них свой потолок частоты
 * (app.ts::uploadPartLimiter), а общий потолок их не считает: ролик 2 ГБ — 512 частей.
 */
export const UPLOAD_PART_PATH_RE =
  /^\/api\/v1\/(?:upload-sessions\/[^/]+|social-videos\/upload-sessions\/[^/]+|properties\/[^/]+\/videos\/upload-sessions\/[^/]+|properties\/drafts\/current\/videos\/[^/]+)\/parts\/\d+$/;

export function isUploadPartRequest(req: Pick<Request, "method" | "originalUrl">): boolean {
  return req.method === "PUT" && UPLOAD_PART_PATH_RE.test(req.originalUrl.split("?")[0]);
}

/** Тело части: уже разобранный Buffer (если его разобрал кто-то раньше) или поток запроса. */
export function partBodySource(req: Request): Buffer | Readable {
  const parsed: unknown = req.body;
  if (Buffer.isBuffer(parsed)) return parsed;
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > UPLOAD_PART_MAX_BYTES) {
    throw new UploadError("PART_SIZE_MISMATCH", { status: 413, message: "Часть больше допустимого размера" });
  }
  return req;
}

const DISK_ALARM_KEY = "upload-disk-full";

/**
 * Ответ на отказ загрузки. true — ответ отправлен (это UploadError), false — ошибка чужая,
 * её обработает вызывающий (next(err) / throw). `what` — что делали, для журнала.
 */
export function sendUploadError(res: Response, err: unknown, what: string): boolean {
  if (!(err instanceof UploadError)) return false;
  reportUploadError(err, what);
  if (err.retryAfterMs !== undefined || err.status === 429 || err.status === 507) {
    const ms = err.retryAfterMs ?? err.body().retryAfterMs;
    if (typeof ms === "number") res.setHeader("Retry-After", String(Math.ceil(ms / 1000)));
  }
  if (!res.headersSent) res.status(err.status).json(err.body());
  return true;
}

/** Тревога в журнал по отказу загрузки: нехватка места и сбой диска. Остальное — дело клиента. */
export function reportUploadError(err: UploadError, what: string): void {
  if (err.code === "DISK_FULL") {
    void logSystemError("storage", `Загрузка файла: на диске сервера не хватает места (${what}). ${err.detail ?? ""}`.trim(), {
      dedupKey: DISK_ALARM_KEY,
    });
  } else if (err.code === "STORAGE_FAILED") {
    void logSystemError("storage", `Загрузка файла: сбой диска (${what}). ${err.detail ?? err.message}`, {
      dedupKey: `upload-storage:${what}`,
    });
  }
}

// ── журнал частей и ежедневная сводка ─────────────────────────────────────────

interface PartStats {
  ok: number;
  failed: number;
  byCode: Record<string, number>;
  since: number;
}

let stats: PartStats = { ok: 0, failed: 0, byCode: {}, since: Date.now() };

/** Счётчики частей с прошлой сводки (только чтение). */
export function uploadPartStats(): Readonly<PartStats> {
  return stats;
}

/**
 * Одна часть: успех — только в счётчик; отказ — строка в журнал контейнера (JSON) и счётчик.
 * Отказы «по делу» (часть не того размера у старого клиента) тоже считаются: доля нужна целиком.
 */
export function logUploadPart(
  req: Request,
  info: { kind: string; sessionId: string; partNumber: number; bytes?: number; startedAt: number; code?: string }
): void {
  if (!info.code) {
    stats.ok++;
    return;
  }
  stats.failed++;
  stats.byCode[info.code] = (stats.byCode[info.code] ?? 0) + 1;
  console.warn(
    `[upload-part] ${JSON.stringify({
      kind: info.kind,
      session: info.sessionId,
      part: info.partNumber,
      bytes: info.bytes ?? null,
      ms: Date.now() - info.startedAt,
      contentLength: req.headers["content-length"] ?? null,
      ip: req.ip ?? null,
      ua: String(req.headers["user-agent"] ?? "").slice(0, 160),
      code: info.code,
    })}`
  );
}

/** Доля отказов выше которой — тревога (за сутки, если частей было достаточно). */
const FAILURE_ALARM_SHARE = 0.05;
const FAILURE_ALARM_MIN_PARTS = 40;

/**
 * Ежедневная сводка (крон): доля неудачных частей > 5 % — запись в «Здоровье системы».
 * Счётчики обнуляются. Возвращает сводку для журнала крона.
 */
export function flushUploadPartStats(): { ok: number; failed: number; share: number; alarmed: boolean } {
  const snapshot = stats;
  stats = { ok: 0, failed: 0, byCode: {}, since: Date.now() };
  const total = snapshot.ok + snapshot.failed;
  const share = total > 0 ? snapshot.failed / total : 0;
  const alarmed = total >= FAILURE_ALARM_MIN_PARTS && share > FAILURE_ALARM_SHARE;
  if (alarmed) {
    const codes = Object.entries(snapshot.byCode)
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${code}×${n}`)
      .join(", ");
    void logSystemError(
      "storage",
      `Загрузка частями: за сутки не прошло ${snapshot.failed} из ${total} частей (${Math.round(share * 100)} %): ${codes}`,
      { dedupKey: "upload-part-failure-share" }
    );
  }
  return { ok: snapshot.ok, failed: snapshot.failed, share, alarmed };
}
