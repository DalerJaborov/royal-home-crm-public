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
  file: File;
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
    form.append("video", input.file, input.file.name);

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

    xhr.open("POST", "/api/v1/social-videos");
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

/** Создаёт черновик ролика: POST /social-videos (multipart). */
export async function uploadSocialVideo(input: SocialVideoUploadInput): Promise<SocialVideoItem> {
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
