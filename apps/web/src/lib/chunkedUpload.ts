import type { ChunkedUploadPurpose } from "@royal-home/shared";
import { useAuthStore } from "../store/auth";
import { getOrCreateDeviceId } from "./deviceId";
import { ApiError } from "./apiError";
import { httpStatusMessage } from "./httpStatusMessage";
import { refreshAccessToken } from "./api";

/**
 * ОБЩИЙ ПОМОЩНИК ЗАГРУЗКИ ЧАСТЯМИ (17.11.2026, класс «большой файл одним запросом → 413»).
 *
 * Одним запросом файл тяжелее ~90 МБ не доходит до сервера: Cloudflare и прокси режут тело
 * (PROXY_SINGLE_REQUEST_MAX_BYTES в packages/shared). Поэтому файл режется на части (размер
 * задаёт сервер, 8 МБ), каждая идёт своим запросом и при сбое повторяется, а сервер
 * склеивает их и делает своё дело на шаге сборки.
 *
 * Кто зовёт: свободный ролик в соцсети (lib/socialVideoUpload.ts), ролик карточки объекта
 * (lib/uploadQueue.ts, PropertyClipVideoCard), фото/видео в переписку (lib/mediaUpload.ts).
 * Сессии роликов объектов с докачкой между вкладками — своя очередь (uploadVideoChunked в
 * lib/uploadQueue.ts), у неё план и принятые части хранит база.
 *
 * XMLHttpRequest, а не fetch: только он сообщает прогресс ОТПРАВКИ тела.
 */

/** Столько тишины в канале считаем обрывом — тот же порог, что у очередей загрузки. */
export const STALL_MS = 60_000;
/** Столько раз пробуем одну часть, прежде чем сдаться. */
export const PART_ATTEMPTS = 4;
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

export function xhrSend<T>(o: XhrSendOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let uploaded = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!settled) xhr.abort();
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
      if (!uploaded) arm(STALL_MS);
      o.onSent?.(e.loaded);
    };
    xhr.upload.onload = () => {
      uploaded = true;
      arm(o.waitMs);
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
      reject(new ApiError(message, xhr.status, data));
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError("Сеть недоступна — файл не загружен", 0, undefined));
    };
    xhr.onabort = () => {
      done();
      if (o.signal?.aborted) {
        reject(new UploadCancelledError());
        return;
      }
      reject(new ApiError(uploaded && o.waitMessage ? o.waitMessage : "Связь пропала — файл не загружен", 0, undefined));
    };
    if (o.signal?.aborted) {
      done();
      reject(new UploadCancelledError());
      return;
    }
    o.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    arm(typeof o.body === "string" ? o.waitMs + STALL_MS : STALL_MS);
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadCancelledError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new UploadCancelledError());
      },
      { once: true }
    );
  });
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
  /** Все байты ушли: дальше сервер обрабатывает файл. */
  onUploaded?: () => void;
  /** Отмена человеком: оставшиеся части не уходят, сборка не зовётся. */
  signal?: AbortSignal;
  /** Сессия прошлой попытки — докачать в неё, а не начинать заново. */
  session?: ChunkedSessionHolder;
}

type SessionPlan = { sessionId: string; partSize: number; totalParts: number; uploadedPartNumbers?: number[] };
const statusUrl = (sessionId: string) => `/api/v1/upload-sessions/${sessionId}`;

function isGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

function partsMissing(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && (err.data as { code?: string } | undefined)?.code === "PARTS_MISSING";
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
  const complete = (sessionId: string) => {
    if (o.signal?.aborted) throw new UploadCancelledError();
    o.onProgress?.(100);
    o.onUploaded?.();
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

  let plan: SessionPlan | null = null;
  const previous = holder.sessionId;
  if (previous) {
    try {
      return await complete(previous);
    } catch (err) {
      if (partsMissing(err)) {
        plan = await withAuth((token) =>
          xhrSend<SessionPlan>({ method: "GET", url: statusUrl(previous), body: "", token, waitMs: START_WAIT_MS, signal: o.signal })
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
    plan = await withAuth((token) =>
      xhrSend<SessionPlan>({
        method: "POST",
        url: o.startUrl,
        body: JSON.stringify(o.startBody),
        token,
        waitMs: START_WAIT_MS,
        signal: o.signal,
      })
    );
    holder.sessionId = plan.sessionId;
  }

  const session = plan;
  const have = new Set(session.uploadedPartNumbers ?? []);
  const total = Math.max(1, o.file.size);
  let sentBefore = 0;
  for (let n = 1; n <= session.totalParts; n++) {
    const part = o.file.slice((n - 1) * session.partSize, Math.min(n * session.partSize, o.file.size));
    if (have.has(n)) {
      sentBefore += part.size;
      continue;
    }
    for (let attempt = 1; ; attempt++) {
      if (o.signal?.aborted) throw new UploadCancelledError();
      try {
        await withAuth((token) =>
          xhrSend({
            method: "PUT",
            url: o.partUrl(session.sessionId, n),
            body: part,
            token,
            waitMs: STALL_MS,
            signal: o.signal,
            onSent: (loaded) => o.onProgress?.(Math.min(99, Math.round(((sentBefore + loaded) / total) * 100))),
          })
        );
        break;
      } catch (err) {
        if (attempt >= PART_ATTEMPTS || !retryablePartError(err)) throw err;
        await sleep(1000 * 2 ** (attempt - 1), o.signal);
      }
    }
    sentBefore += part.size;
  }

  return complete(session.sessionId);
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
