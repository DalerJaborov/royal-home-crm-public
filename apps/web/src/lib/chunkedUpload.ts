import type { ChunkedUploadPurpose } from "@royal-home/shared";
import { useAuthStore } from "../store/auth";
import { getOrCreateDeviceId } from "./deviceId";
import { ApiError } from "./apiError";
import { httpStatusMessage } from "./httpStatusMessage";
import { refreshAccessToken } from "./api";
import { reportUploadIssue } from "./errorReporter";
import type { UploadIssueInfo } from "./uploadFormat";
import { planServerRetry, MAX_RETRY_ATTEMPTS } from "./uploadRetry";
import { registerWork } from "./workGuard";
import { holdScreenAwake } from "./upload/wakeLock";
import { isOffline, retryAfterFromXhr, sleepAbortable, waitForOnline, WaitAbortedError } from "./upload/network";
import { classifyReadError, readBlobEnds, readFailureMessage } from "./upload/readProbe";
import { giveUpMessage, OFFLINE_TEXT, zeroCauseLabel, zeroCauseMessage, type UploadLive, type ZeroCause } from "./upload/progressText";

/**
 * ОБЩИЙ ПОМОЩНИК ЗАГРУЗКИ ЧАСТЯМИ (17.11.2026, класс «большой файл одним запросом → 413»).
 *
 * Одним запросом файл тяжелее ~90 МБ не доходит до сервера: Cloudflare и прокси режут тело
 * (PROXY_SINGLE_REQUEST_MAX_BYTES в packages/shared). Поэтому файл режется на части (размер
 * задаёт сервер в плане сессии — клиент его не придумывает), каждая идёт своим запросом и при
 * сбое повторяется, а сервер склеивает их и делает своё дело на шаге сборки.
 *
 * Кто зовёт: свободный ролик в соцсети (lib/socialVideoUpload.ts), ролик карточки объекта
 * (lib/uploadQueue.ts, PropertyClipVideoCard), фото/видео в переписку (lib/mediaUpload.ts).
 * Сессии роликов объектов с докачкой между вкладками — своя очередь (uploadVideoChunked в
 * lib/uploadQueue.ts), у неё план и принятые части хранит база.
 *
 * ПОВТОРЫ — ПО ОБЩЕМУ РАСПИСАНИЮ (25.11.2026, находка 6). Было: 4 попытки части с паузами
 * 1/2/4 с — около семи секунд, и вся загрузка падала; лифт или метро длятся минуты. Стало:
 * паузы и потолок те же, что у очередей объекта (lib/uploadRetry.ts: 5 с … 5 мин, 10 отказов
 * ПОДРЯД без продвижения — принятая часть начинает счёт заново), без сети — ждём `online`,
 * не тратя попыток, на 429 — пауза не короче Retry-After сервера. Сессия переживает
 * перезагрузку вкладки: её номер лежит в localStorage по отпечатку файла.
 *
 * XMLHttpRequest, а не fetch: только он сообщает прогресс ОТПРАВКИ тела.
 */

/** Столько тишины в канале считаем обрывом — тот же порог, что у очередей загрузки. */
export const STALL_MS = 60_000;
/**
 * Потолок отказов ОДНОЙ части подряд без продвижения. Тот же, что у очередей
 * (lib/uploadRetry.ts) — прежние 4 попытки за ~7 с переписаны на общее расписание.
 */
export const PART_ATTEMPTS = MAX_RETRY_ATTEMPTS;
const START_WAIT_MS = 60_000;

export interface XhrSendOptions {
  method: string;
  url: string;
  body: Blob | string;
  token: string | null;
  headers?: Record<string, string>;
  /** Прогресс отправки тела: байт ушло. */
  onSent?: (loaded: number) => void;
  /** Сколько ждать ответ после того, как тело ушло. */
  waitMs: number;
  /** Текст, если ответ не пришёл за waitMs после отправки тела. */
  waitMessage?: string;
  /** Отмена человеком: запрос обрывается, обещание отклоняется UploadCancelledError. */
  signal?: AbortSignal;
}

/** Человек отменил загрузку — не ошибка сети: повторять не нужно, показывать нечего. */
export class UploadCancelledError extends Error {
  constructor() {
    super("Отправка отменена");
    this.name = "UploadCancelledError";
  }
}

/** Отчего запрос со статусом 0 кончился — лежит в `ApiError.data.cause`. */
export function zeroCauseOf(err: unknown): ZeroCause | undefined {
  if (!(err instanceof ApiError) || err.status !== 0) return undefined;
  return (err.data as { cause?: ZeroCause } | undefined)?.cause;
}

export function xhrSend<T>(o: XhrSendOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let uploaded = false;
    /** Сами оборвали по тишине/пределу — чтобы в журнале было «тишина», а не «обрыв браузером». */
    let firedBy: ZeroCause | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (ms: number, cause: ZeroCause) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!settled) {
          firedBy = cause;
          xhr.abort();
        }
      }, ms);
    };
    const done = () => {
      settled = true;
      if (timer) clearTimeout(timer);
    };
    xhr.open(o.method, o.url);
    xhr.withCredentials = true;
    if (o.token) xhr.setRequestHeader("Authorization", `Bearer ${o.token}`);
    xhr.setRequestHeader("X-Device-Id", getOrCreateDeviceId());
    xhr.setRequestHeader("Content-Type", typeof o.body === "string" ? "application/json" : "application/octet-stream");
    for (const [name, value] of Object.entries(o.headers ?? {})) xhr.setRequestHeader(name, value);
    // Пока тело едет — сторож тишины; когда ушло — один длинный предел ожидания ответа.
    xhr.upload.onprogress = (e) => {
      if (!uploaded) arm(STALL_MS, "stall");
      o.onSent?.(e.loaded);
    };
    xhr.upload.onload = () => {
      uploaded = true;
      arm(o.waitMs, "deadline");
    };
    xhr.onload = () => {
      done();
      let data: unknown;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      const message = (data as { error?: string } | undefined)?.error || httpStatusMessage(xhr.status);
      reject(new ApiError(message, xhr.status, data, retryAfterFromXhr(xhr) ?? undefined));
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError("Сеть недоступна — файл не загружен", 0, { cause: isOffline() ? "offline" : "network" }));
    };
    xhr.onabort = () => {
      done();
      if (o.signal?.aborted) {
        reject(new UploadCancelledError());
        return;
      }
      const cause: ZeroCause = firedBy ?? "abort";
      reject(
        new ApiError(uploaded && o.waitMessage && cause === "deadline" ? o.waitMessage : "Связь пропала — файл не загружен", 0, { cause })
      );
    };
    if (o.signal?.aborted) {
      done();
      reject(new UploadCancelledError());
      return;
    }
    o.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    if (typeof o.body === "string") arm(o.waitMs + STALL_MS, "deadline");
    else arm(STALL_MS, "stall");
    xhr.send(o.method === "GET" ? null : o.body);
  });
}

/** Один раз обновить токен на 401 — загрузка длинная, токен мог истечь по дороге. */
export async function withAuth<T>(fn: (token: string | null) => Promise<T>): Promise<T> {
  try {
    return await fn(useAuthStore.getState().accessToken);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && useAuthStore.getState().hasSession) {
      const token = await refreshAccessToken();
      if (token) return fn(token);
    }
    throw err;
  }
}

/** Часть стоит повторить при сбое сети, таймауте, перегрузке и 5xx; отказ по смыслу (4xx) — нет. */
function retryablePartError(err: unknown): boolean {
  if (err instanceof UploadCancelledError) return false;
  if (!(err instanceof ApiError)) return true;
  return err.status === 0 || err.status >= 500 || err.status === 408 || err.status === 429;
}

/**
 * Сессия между попытками (ревью #254). Помощник записывает сюда id сессии сразу после
 * старта, а вызывающий держит объект, пока задание живо: «Повторить» после сбоя не грузит
 * файл заново, а докачивает недостающие части в ту же сессию или сразу зовёт сборку.
 */
export interface ChunkedSessionHolder {
  sessionId?: string;
}

export interface UploadInPartsOptions {
  file: Blob;
  /** Старт сессии: адрес и тело (имя, вес, тип — что просит сервер этого назначения). */
  startUrl: string;
  startBody: Record<string, unknown>;
  /** Адрес части N. */
  partUrl: (sessionId: string, partNumber: number) => string;
  /** Сборка: адрес, тело, сколько ждать ответ и что сказать, если не дождались. */
  completeUrl: (sessionId: string) => string;
  completeBody?: Record<string, unknown> | ((sessionId: string) => Record<string, unknown>);
  completeHeaders?: Record<string, string>;
  completeWaitMs: number;
  completeWaitMessage?: string;
  onProgress?: (percent: number) => void;
  /** Подробное состояние для строки прогресса (components/UploadProgressLine.tsx):
   *  байты, «ждём связь», «повтор через N с», «сервер обрабатывает». */
  onLive?: (live: UploadLive) => void;
  /** Все байты ушли: дальше сервер обрабатывает файл. */
  onUploaded?: () => void;
  /** Отмена человеком: оставшиеся части не уходят, сборка не зовётся. */
  signal?: AbortSignal;
  /** Сессия прошлой попытки — докачать в неё, а не начинать заново. */
  session?: ChunkedSessionHolder;
  /** Что это за загрузка — для журнала ошибок и подписи «идёт работа» (workGuard). */
  report?: { kind: UploadIssueInfo["kind"]; label: string };
}

type SessionPlan = { sessionId: string; partSize: number; totalParts: number; uploadedPartNumbers?: number[] };
const statusUrl = (sessionId: string) => `/api/v1/upload-sessions/${sessionId}`;

function isGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

function partsMissing(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && (err.data as { code?: string } | undefined)?.code === "PARTS_MISSING";
}

// ─────────────────────── сессия переживает перезагрузку вкладки ───────────────────────

/** Сколько помним сессию по отпечатку файла: сервер всё равно убирает брошенные сессии. */
const SESSION_MEMORY_MS = 24 * 60 * 60_000;
const SESSION_KEY_PREFIX = "rh-upload-session:";

/**
 * Отпечаток файла: кто грузит, куда (адрес старта и назначение), имя, вес и время изменения.
 * Тот же файл, выбранный заново после перезагрузки, докачивается в прежнюю сессию.
 * Blob без имени (не File) отпечатка не имеет — для него сессия живёт только в памяти.
 */
export function uploadFingerprint(
  file: Blob,
  startUrl: string,
  startBody: Record<string, unknown>,
  agentId: string | null | undefined,
  /** Куда собирается файл (адрес сборки без номера сессии): тот же ролик в ДРУГОЙ чат — другая сессия. */
  destination = ""
): string | null {
  if (typeof File === "undefined" || !(file instanceof File) || !file.name) return null;
  const purpose = typeof startBody.purpose === "string" ? startBody.purpose : "";
  return `${SESSION_KEY_PREFIX}${agentId ?? "-"}|${startUrl}|${purpose}|${destination}|${file.name}|${file.size}|${file.lastModified}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function recallSession(fp: string | null, now = Date.now()): string | undefined {
  if (!fp) return undefined;
  try {
    const raw = storage()?.getItem(fp);
    if (!raw) return undefined;
    const rec = JSON.parse(raw) as { sessionId?: string; at?: number };
    if (!rec.sessionId || typeof rec.at !== "number" || now - rec.at > SESSION_MEMORY_MS) {
      storage()?.removeItem(fp);
      return undefined;
    }
    return rec.sessionId;
  } catch {
    return undefined;
  }
}

export function rememberSession(fp: string | null, sessionId: string | undefined, now = Date.now()): void {
  if (!fp) return;
  try {
    if (sessionId) storage()?.setItem(fp, JSON.stringify({ sessionId, at: now }));
    else storage()?.removeItem(fp);
  } catch {
    /* приватный режим/квота — сессия живёт только в памяти, как раньше */
  }
}

// ─────────────────────────── повтор по общему расписанию ───────────────────────────

interface RetryContext {
  signal?: AbortSignal;
  /** Что показать во время паузы. */
  onWait: (live: { phase: "waiting-online" | "waiting-retry"; error: string; nextAttemptAt: number | null }) => void;
  /**
   * Экран держим, только пока идёт отправка (ревью 26.11.2026): ожидание сети и паузы повтора
   * (5 с … 5 мин) тянутся долго, и держать на них экран включённым — значит сажать батарею
   * на простое. `off` снимает блокировку на паузе, `on` берёт заново перед следующей попыткой.
   */
  awake?: { off(): void; on(): void };
}

/**
 * Пауза перед следующей попыткой после повторяемого отказа. Без сети — ждём связь (попытка не
 * тратится). Иначе — пауза по расписанию, не короче Retry-After. `null` — попытки кончились.
 */
async function pauseBeforeRetry(err: unknown, fails: number, ctx: RetryContext): Promise<number | null> {
  if (isOffline() || zeroCauseOf(err) === "offline") {
    ctx.onWait({ phase: "waiting-online", error: OFFLINE_TEXT, nextAttemptAt: null });
    ctx.awake?.off();
    try {
      await waitForOnline(ctx.signal);
    } finally {
      ctx.awake?.on();
    }
    return fails; // обрыв без сети попытку не тратит
  }
  const plan = planServerRetry(fails, false);
  if (plan.delayMs === null) return null;
  const retryAfter = err instanceof ApiError ? err.retryAfterMs ?? 0 : 0;
  const delay = Math.max(plan.delayMs, retryAfter);
  const reason = err instanceof ApiError && err.status === 0 ? zeroCauseMessage(zeroCauseOf(err)) : err instanceof ApiError ? err.message : "Связь прервалась";
  ctx.onWait({ phase: "waiting-retry", error: reason, nextAttemptAt: Date.now() + delay });
  ctx.awake?.off();
  try {
    await sleepAbortable(delay, ctx.signal);
  } finally {
    ctx.awake?.on();
  }
  return plan.attempts;
}

/** Отмена во время паузы — та же отмена, что и посреди части. */
function asCancel(err: unknown): unknown {
  return err instanceof WaitAbortedError ? new UploadCancelledError() : err;
}

/**
 * Старт → части (каждая с повтором) → сборка. Сборку сами НЕ повторяем: сервер мог успеть.
 *
 * Повтор с `session` из прошлой попытки (ревью #254):
 *  1. сразу сборка со старой сессией — если прошлый раз упал на ней, файл заново не грузим
 *     (а с ключом повтора сервер отдаст ответ первой сборки, если она всё же прошла);
 *  2. «не все части» — спрашиваем, какие есть, и докачиваем только недостающие;
 *  3. сессии больше нет (404) — начинаем заново.
 */
export async function uploadInParts<T>(o: UploadInPartsOptions): Promise<T> {
  const holder = o.session ?? {};
  const fp = uploadFingerprint(o.file, o.startUrl, o.startBody, useAuthStore.getState().agent?.id, o.completeUrl(""));
  if (!holder.sessionId) holder.sessionId = recallSession(fp);
  const total = Math.max(1, o.file.size);
  const live = (l: UploadLive) => o.onLive?.(l);
  let sentTotal = 0;

  // Экран не гаснет, вкладку тихо не закрыть, автообновление ждёт (находки 8 и 9).
  let releaseAwake: (() => void) | null = holdScreenAwake();
  const awake = {
    off: () => {
      releaseAwake?.();
      releaseAwake = null;
    },
    on: () => {
      releaseAwake ??= holdScreenAwake();
    },
  };
  const unregister = registerWork({
    id: `chunked:${o.startUrl}:${fp ?? Math.random().toString(36).slice(2)}`,
    label: o.report?.label ?? "Загрузка файла",
    blocksUnload: true,
  });
  const startedAt = Date.now();
  /** Отказ уже записан в журнал — внешний catch второй раз не пишет. */
  let reported = false;

  const report = (err: unknown, extra: Partial<UploadIssueInfo>) => {
    if (!o.report || reported) return;
    reported = true;
    const name = o.file instanceof File ? o.file.name : "файл";
    reportUploadIssue({
      kind: o.report.kind,
      name,
      sizeBytes: o.file.size,
      propertyLabel: o.report.label,
      attempts: extra.attempts ?? 1,
      maxAttempts: PART_ATTEMPTS,
      status: err instanceof ApiError ? err.status : 0,
      error: err instanceof Error ? err.message : null,
      online: typeof navigator !== "undefined" ? navigator.onLine !== false : true,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "",
      fileType: o.file.type,
      avgSpeedBps: sentTotal > 0 ? sentTotal / Math.max(1, (Date.now() - startedAt) / 1000) : undefined,
      cause: err instanceof ApiError && err.status === 0 ? zeroCauseLabel(zeroCauseOf(err)) : undefined,
      final: true,
      ...extra,
    });
  };

  const complete = (sessionId: string) => {
    if (o.signal?.aborted) throw new UploadCancelledError();
    o.onProgress?.(100);
    o.onUploaded?.();
    live({ phase: "processing", loaded: o.file.size, total: o.file.size });
    return withAuth((token) =>
      xhrSend<T>({
        method: "POST",
        url: o.completeUrl(sessionId),
        body: JSON.stringify((typeof o.completeBody === "function" ? o.completeBody(sessionId) : o.completeBody) ?? {}),
        token,
        headers: o.completeHeaders,
        waitMs: o.completeWaitMs,
        waitMessage: o.completeWaitMessage,
        signal: o.signal,
      })
    );
  };

  /** Запрос без тела (старт, состояние сессии) — повторяется по тому же расписанию. */
  const withRetry = async <R>(fn: () => Promise<R>): Promise<R> => {
    let fails = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!retryablePartError(err)) throw err;
        const next = await pauseBeforeRetry(err, fails, ctx).catch((e: unknown) => {
          throw asCancel(e);
        });
        if (next === null) {
          report(err, { attempts: fails + 1, stage: "session" });
          throw new ApiError(giveUpMessage(err instanceof ApiError ? err.status : 0, fails + 1, zeroCauseOf(err)), err instanceof ApiError ? err.status : 0, err instanceof ApiError ? err.data : undefined);
        }
        fails = next;
      }
    }
  };
  const ctx: RetryContext = {
    signal: o.signal,
    awake,
    onWait: (w) => live({ phase: w.phase, loaded: sentTotal, total: o.file.size, error: w.error, nextAttemptAt: w.nextAttemptAt }),
  };

  try {
    let plan: SessionPlan | null = null;
    const previous = holder.sessionId;
    if (previous) {
      try {
        const result = await complete(previous);
        rememberSession(fp, undefined);
        return result;
      } catch (err) {
        if (partsMissing(err)) {
          plan = await withRetry(() =>
            withAuth((token) =>
              xhrSend<SessionPlan>({ method: "GET", url: statusUrl(previous), body: "", token, waitMs: START_WAIT_MS, signal: o.signal })
            )
          ).catch((e: unknown) => {
            if (isGone(e)) return null;
            throw e;
          });
        } else if (!isGone(err)) {
          throw err;
        }
      }
    }
    if (!plan) {
      holder.sessionId = undefined;
      rememberSession(fp, undefined);
      live({ phase: "uploading", loaded: 0, total: o.file.size });
      plan = await withRetry(() =>
        withAuth((token) =>
          xhrSend<SessionPlan>({
            method: "POST",
            url: o.startUrl,
            body: JSON.stringify(o.startBody),
            token,
            waitMs: START_WAIT_MS,
            signal: o.signal,
          })
        )
      );
      holder.sessionId = plan.sessionId;
      rememberSession(fp, plan.sessionId);
    }

    // Размер части — из плана сервера, не из клиента (находка 5): сервер может его менять.
    const session = plan;
    const have = new Set(session.uploadedPartNumbers ?? []);
    let sentBefore = 0;
    for (let n = 1; n <= session.totalParts; n++) {
      const part = o.file.slice((n - 1) * session.partSize, Math.min(n * session.partSize, o.file.size));
      if (have.has(n)) {
        sentBefore += part.size;
        continue;
      }
      // Отказы ЭТОЙ части подряд; принятая часть начинает счёт заново (как у очередей).
      let fails = 0;
      for (;;) {
        if (o.signal?.aborted) throw new UploadCancelledError();
        let partSent = 0;
        try {
          live({ phase: "uploading", loaded: sentBefore, total: o.file.size });
          await withAuth((token) =>
            xhrSend({
              method: "PUT",
              url: o.partUrl(session.sessionId, n),
              body: part,
              token,
              waitMs: STALL_MS,
              signal: o.signal,
              onSent: (loaded) => {
                partSent = loaded;
                sentTotal = sentBefore + loaded;
                o.onProgress?.(Math.min(99, Math.round(((sentBefore + loaded) / total) * 100)));
                live({ phase: "uploading", loaded: Math.min(sentBefore + loaded, o.file.size), total: o.file.size });
              },
            })
          );
          break;
        } catch (err) {
          if (!retryablePartError(err)) throw err;
          // Ни байта части и статус 0 — так же выглядит файл, который телефон не отдаёт.
          // Проверяем чтением, а не догадкой: не читается — повторять бессмысленно.
          if (err instanceof ApiError && err.status === 0 && partSent === 0) {
            try {
              await readBlobEnds(part);
            } catch (readErr) {
              const r = classifyReadError(readErr);
              report(err, { attempts: fails + 1, stage: "parts", partNumber: n, partSentBytes: 0, partBytes: part.size, errorName: r.name, cause: "файл не читается" });
              throw new ApiError(readFailureMessage(r.reason), 422, { code: "FILE_UNREADABLE", reason: r.reason });
            }
          }
          const next = await pauseBeforeRetry(err, fails, ctx).catch((e: unknown) => {
            throw asCancel(e);
          });
          if (next === null) {
            report(err, { attempts: fails + 1, stage: "parts", partNumber: n, partSentBytes: partSent, partBytes: part.size, partsDone: n - 1, partsTotal: session.totalParts });
            throw new ApiError(giveUpMessage(err instanceof ApiError ? err.status : 0, fails + 1, zeroCauseOf(err)), err instanceof ApiError ? err.status : 0, err instanceof ApiError ? err.data : undefined);
          }
          fails = next;
        }
      }
      sentBefore += part.size;
      sentTotal = sentBefore;
    }

    const result = await complete(session.sessionId);
    rememberSession(fp, undefined);
    return result;
  } catch (err) {
    // Отмена человеком — сессию забываем: следующий раз с чистого листа.
    if (err instanceof UploadCancelledError) rememberSession(fp, undefined);
    else if (isGone(err)) rememberSession(fp, undefined);
    // Отказ по существу (4xx) или обрыв сборки — тоже в журнал, если ещё не записан выше.
    else report(err, { attempts: 1 });
    throw err;
  } finally {
    awake.off();
    unregister();
  }
}

/** Общие сессии сервера (routes/uploadSessions.ts): назначение решает предел и тип файла. */
export function uploadToPurpose<T>(
  purpose: ChunkedUploadPurpose,
  file: File,
  o: Omit<UploadInPartsOptions, "file" | "startUrl" | "startBody" | "partUrl">
): Promise<T> {
  return uploadInParts<T>({
    ...o,
    file,
    startUrl: "/api/v1/upload-sessions",
    startBody: { purpose, filename: file.name || "file", sizeBytes: file.size, contentType: file.type },
    partUrl: (sessionId, n) => `/api/v1/upload-sessions/${sessionId}/parts/${n}`,
  });
}
