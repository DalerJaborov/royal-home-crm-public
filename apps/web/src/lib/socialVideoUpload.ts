import type { SocialVideoChannel, SocialVideoDestination, SocialVideoItem } from "@royal-home/shared";
import { useAuthStore } from "../store/auth";
import { getOrCreateDeviceId } from "./deviceId";
import { ApiError } from "./apiError";
import { httpStatusMessage } from "./httpStatusMessage";
import { refreshAccessToken } from "./api";
import { PART_ATTEMPTS, STALL_MS, uploadInParts } from "./chunkedUpload";
import { assertFitsSingleRequest } from "./singleRequestLimit";
import { compressImage } from "./compressImage";
import { reportUploadIssue } from "./errorReporter";
import { registerWork } from "./workGuard";
import type { UploadLive } from "./upload/progressText";

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
export { STALL_MS };

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
  /** Подробное состояние для строки прогресса: МБ из МБ, «ждём связь», «повтор через N с». */
  onLive?: (live: UploadLive) => void;
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
    // Тяжелее потолка одного запроса тело не дойдёт до сервера — говорим сразу, а не после минут ожидания.
    try {
      assertFitsSingleRequest(form);
    } catch (err) {
      reject(err);
      return;
    }

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
      if (e.lengthComputable) {
        input.onProgress(Math.round((e.loaded / e.total) * 100));
        input.onLive?.({ phase: "uploading", loaded: e.loaded, total: e.total });
      }
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
 * и меньше. Механика — общий помощник lib/chunkedUpload.ts; здесь только адреса раздела
 * (сервер: apps/api/src/lib/socialVideoUploadSessions.ts). Фото-пост лёгкий и идёт одним
 * запросом — с проверкой веса до отправки.
 */
export { PART_ATTEMPTS };

const DRAFT_WAIT_MESSAGE =
  "Сервер слишком долго обрабатывает ролик. Проверьте список роликов — черновик мог создаться, тогда откройте его, а не загружайте файл заново.";

function uploadVideoInParts(input: SocialVideoUploadInput, file: File): Promise<SocialVideoItem> {
  const base = "/api/v1/social-videos/upload-sessions";
  const fields: Record<string, string> = {
    title: input.title,
    caption: input.caption,
    channels: JSON.stringify(input.channels),
  };
  if (input.brief) fields.brief = input.brief;
  if (input.destinations) fields.destinations = JSON.stringify(input.destinations);
  return uploadInParts<SocialVideoItem>({
    file,
    startUrl: base,
    startBody: { filename: file.name, sizeBytes: file.size },
    partUrl: (sessionId, n) => `${base}/${sessionId}/parts/${n}`,
    completeUrl: (sessionId) => `${base}/${sessionId}/complete`,
    completeBody: fields,
    completeWaitMs: RESPONSE_WAIT_MS,
    completeWaitMessage: DRAFT_WAIT_MESSAGE,
    onProgress: input.onProgress,
    onLive: input.onLive,
    onUploaded: input.onUploaded,
    report: { kind: "social", label: "ролики в соцсети" },
  });
}

/** Создаёт черновик: ролик — частями (см. выше), фото-пост — POST /social-videos/photos. */
export async function uploadSocialVideo(input: SocialVideoUploadInput): Promise<SocialVideoItem> {
  if (input.file) return uploadVideoInParts(input, input.file);
  // Фото-пост — одним запросом: десять снимков с камеры по 20 МБ (200 МБ) прокси не пропустит.
  // Сжимаем до 2560 px (compressImage, обычно 1-3 МБ на снимок; сервер всё равно перекладывает
  // их в JPEG под сети), а вес всей пачки проверяет sendOnce до отправки.
  if (input.photos?.length) input = { ...input, photos: await Promise.all(input.photos.map((p) => compressImage(p))) };
  // Пока фото уходят — вкладку тихо не закрыть и не обновить (находка 9, 25.11.2026).
  const unregister = registerWork({ id: "social-photo-post", label: "Загрузка фото в соцсети", blocksUnload: true });
  try {
    try {
      return await sendOnce(input, useAuthStore.getState().accessToken);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && useAuthStore.getState().hasSession) {
        const token = await refreshAccessToken();
        if (token) {
          input.onProgress(0);
          return await sendOnce(input, token);
        }
      }
      throw err;
    }
  } catch (err) {
    // Отказ фото-поста — в журнал, как у остальных загрузок (находка 7).
    const photos = input.photos ?? [];
    reportUploadIssue({
      kind: "social",
      name: photos.length === 1 ? photos[0].name : `${photos.length} фото`,
      sizeBytes: photos.reduce((s, p) => s + p.size, 0),
      propertyLabel: "фото-пост в соцсети",
      attempts: 1,
      maxAttempts: 1,
      status: err instanceof ApiError ? err.status : 0,
      error: err instanceof Error ? err.message : null,
      online: typeof navigator !== "undefined" ? navigator.onLine !== false : true,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "",
      final: true,
    });
    throw err;
  } finally {
    unregister();
  }
}
