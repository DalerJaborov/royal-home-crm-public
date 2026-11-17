import type { SocialVideoChannel, SocialVideoDestination, SocialVideoItem } from "@royal-home/shared";
import { useAuthStore } from "../store/auth";
import { getOrCreateDeviceId } from "./deviceId";
import { ApiError } from "./apiError";
import { httpStatusMessage } from "./httpStatusMessage";
import { refreshAccessToken } from "./api";

/**
 * Загрузка свободного ролика в соцсети С ПРОГРЕССОМ (12.10.2026).
 *
 * Тот же приём, что `uploadConversationMedia` (lib/mediaUpload.ts): `fetch` не
 * отдаёт прогресс ОТПРАВКИ тела, поэтому XMLHttpRequest. Отличия от образца:
 *  - ролик весит сотни мегабайт и едет минутами, поэтому сторож по тишине
 *    (нет движения байт 60 с — обрыв), а не общий потолок по времени;
 *  - СТОРОЖ ТИШИНЫ ДЕЙСТВУЕТ ТОЛЬКО ДО 100 %. Когда все байты ушли, сервер перепаковывает файл
 *    (до 5 минут) и лишь потом отвечает; тишина в канале в этот момент — работа, а не обрыв.
 *    Обрыв по 60-секундной тишине именно тут порождал дубль-черновик (сервер ролик всё равно
 *    создавал). Ответ ждём до `RESPONSE_WAIT_MS` — 10 минут;
 *  - при 401 один раз обновляем токен и шлём заново: загрузка длинная, а токен
 *    мог истечь, пока человек выбирал и подписывал ролик.
 */

/** Столько тишины в канале считаем обрывом — тот же порог, что у очередей загрузки. */
export const STALL_MS = 60_000;

/** Сколько ждать ответ сервера после того, как все байты ушли (перепаковка до 5 минут + запас). */
export const RESPONSE_WAIT_MS = 10 * 60_000;

export interface SocialVideoUploadInput {
  /** Ролик. Не задан — значит фото-пост из `photos` (16.11.2026). */
  file?: File;
  /** Фото-пост: 1–10 снимков, уходят на POST /social-videos/photos. */
  photos?: File[];
  title: string;
  caption: string;
  brief: string;
  channels: SocialVideoChannel[];
  /** Адреса «канал + аккаунт»; на сервере главнее `channels`. */
  destinations?: SocialVideoDestination[];
  onProgress: (percent: number) => void;
  /** Все байты ушли: дальше сервер обрабатывает файл — экран пишет «Обрабатываем ролик на сервере…». */
  onUploaded?: () => void;
}

function sendOnce(input: SocialVideoUploadInput, token: string | null): Promise<SocialVideoItem> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // Текстовые поля — ДО файла: multer на сервере видит их к моменту разбора файла.
    form.append("title", input.title);
    form.append("caption", input.caption);
    if (input.brief) form.append("brief", input.brief);
    form.append("channels", JSON.stringify(input.channels));
    if (input.destinations) form.append("destinations", JSON.stringify(input.destinations));
    const isPhoto = !input.file && (input.photos?.length ?? 0) > 0;
    if (input.file) form.append("video", input.file, input.file.name);
    for (const p of input.photos ?? []) form.append("photos", p, p.name);

    const xhr = new XMLHttpRequest();
    let settled = false;
    let uploaded = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
    };
    const arm = (ms: number) => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        // abort() поднимет onabort, он и отклонит обещание.
        xhr.abort();
      }, ms);
    };
    /** Движение байт: пока тело едет, тишина дольше STALL_MS — обрыв. */
    const beat = () => {
      if (uploaded) return;
      arm(STALL_MS);
    };

    xhr.open("POST", isPhoto ? "/api/v1/social-videos/photos" : "/api/v1/social-videos");
    xhr.withCredentials = true;
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("X-Device-Id", getOrCreateDeviceId());

    xhr.upload.onprogress = (e) => {
      beat();
      if (e.lengthComputable) input.onProgress(Math.round((e.loaded / e.total) * 100));
    };
    // Тело ушло целиком — дальше сервер разбирает и перепаковывает файл. Тишины тут не бойтесь:
    // сторожа по движению байт снимаем, ставим один длинный предел ожидания ответа.
    xhr.upload.onload = () => {
      uploaded = true;
      input.onProgress(100);
      input.onUploaded?.();
      arm(RESPONSE_WAIT_MS);
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
        resolve(data as SocialVideoItem);
        return;
      }
      const message = (data as { error?: string } | undefined)?.error || httpStatusMessage(xhr.status);
      reject(new ApiError(message, xhr.status, data));
    };
    xhr.onerror = () => {
      done();
      reject(new Error("Сеть недоступна — ролик не загружен"));
    };
    xhr.onabort = () => {
      done();
      reject(
        new Error(
          uploaded
            ? "Сервер слишком долго обрабатывает ролик. Проверьте список роликов — черновик мог создаться, тогда откройте его, а не загружайте файл заново."
            : "Связь пропала — ролик не загружен"
        )
      );
    };

    beat();
    xhr.send(form);
  });
}

/**
 * РОЛИК ЧАСТЯМИ (17.11.2026). Одним запросом файл 87 МБ получал 413 «Файл слишком большой»
 * ещё до сервера: Cloudflare перед CRM не пропускает тело больше 100 МБ, прокси на сервере —
 * и меньше. Поэтому ролик режется на части (размер задаёт сервер, 8 МБ), каждая часть идёт
 * своим запросом и при сбое повторяется, а сервер склеивает их и делает черновик
 * (apps/api/src/lib/socialVideoUploadSessions.ts). Фото-пост лёгкий и идёт одним запросом.
 */
export const PART_ATTEMPTS = 4;
const START_WAIT_MS = 60_000;

interface XhrSendOptions {
  method: string;
  url: string;
  body: Blob | string;
  token: string | null;
  /** Прогресс отправки тела: байт ушло. */
  onSent?: (loaded: number) => void;
  /** Сколько ждать ответ после того, как тело ушло. */
  waitMs: number;
  /** Текст, если ответ не пришёл за waitMs после отправки тела. */
  waitMessage?: string;
}

function xhrSend<T>(o: XhrSendOptions): Promise<T> {
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
      reject(new Error("Сеть недоступна — ролик не загружен"));
    };
    xhr.onabort = () => {
      done();
      reject(new Error(uploaded && o.waitMessage ? o.waitMessage : "Связь пропала — ролик не загружен"));
    };
    arm(typeof o.body === "string" ? o.waitMs + STALL_MS : STALL_MS);
    xhr.send(o.body);
  });
}

/** Один раз обновить токен на 401 — загрузка длинная, токен мог истечь по дороге. */
async function withAuth<T>(fn: (token: string | null) => Promise<T>): Promise<T> {
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
  if (!(err instanceof ApiError)) return true;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function uploadVideoInParts(input: SocialVideoUploadInput, file: File): Promise<SocialVideoItem> {
  const base = "/api/v1/social-videos/upload-sessions";
  const session = await withAuth((token) =>
    xhrSend<{ sessionId: string; partSize: number; totalParts: number }>({
      method: "POST",
      url: base,
      body: JSON.stringify({ filename: file.name, sizeBytes: file.size }),
      token,
      waitMs: START_WAIT_MS,
    })
  );

  const total = Math.max(1, file.size);
  let sentBefore = 0;
  for (let n = 1; n <= session.totalParts; n++) {
    const part = file.slice((n - 1) * session.partSize, Math.min(n * session.partSize, file.size));
    for (let attempt = 1; ; attempt++) {
      try {
        await withAuth((token) =>
          xhrSend({
            method: "PUT",
            url: `${base}/${session.sessionId}/parts/${n}`,
            body: part,
            token,
            waitMs: STALL_MS,
            onSent: (loaded) => input.onProgress(Math.min(99, Math.round(((sentBefore + loaded) / total) * 100))),
          })
        );
        break;
      } catch (err) {
        if (attempt >= PART_ATTEMPTS || !retryablePartError(err)) throw err;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    sentBefore += part.size;
  }

  input.onProgress(100);
  input.onUploaded?.();
  const fields: Record<string, string> = {
    title: input.title,
    caption: input.caption,
    channels: JSON.stringify(input.channels),
  };
  if (input.brief) fields.brief = input.brief;
  if (input.destinations) fields.destinations = JSON.stringify(input.destinations);
  // Сборку сами НЕ повторяем: сервер мог успеть сделать черновик, повтор дал бы дубль.
  return withAuth((token) =>
    xhrSend<SocialVideoItem>({
      method: "POST",
      url: `${base}/${session.sessionId}/complete`,
      body: JSON.stringify(fields),
      token,
      waitMs: RESPONSE_WAIT_MS,
      waitMessage:
        "Сервер слишком долго обрабатывает ролик. Проверьте список роликов — черновик мог создаться, тогда откройте его, а не загружайте файл заново.",
    })
  );
}

/** Создаёт черновик: ролик — частями (см. выше), фото-пост — POST /social-videos/photos. */
export async function uploadSocialVideo(input: SocialVideoUploadInput): Promise<SocialVideoItem> {
  if (input.file) return uploadVideoInParts(input, input.file);
  try {
    return await sendOnce(input, useAuthStore.getState().accessToken);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && useAuthStore.getState().hasSession) {
      const token = await refreshAccessToken();
      if (token) {
        input.onProgress(0);
        return sendOnce(input, token);
      }
    }
    throw err;
  }
}
