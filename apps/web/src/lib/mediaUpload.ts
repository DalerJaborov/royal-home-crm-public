import { useAuthStore } from "../store/auth";
import { getOrCreateDeviceId } from "./deviceId";
import { ApiError } from "./apiError";
import { httpStatusMessage } from "./httpStatusMessage";

/** Столько тишины в канале считаем обрывом — тот же порог, что у обеих
 *  очередей загрузки (`lib/uploadQueue.ts`). */
const STALL_MS = 60_000;

/**
 * Пределы ИСХОДЯЩЕГО ФОТО по каналу (18.08.2026) — зеркало OUTGOING_MEDIA_LIMITS
 * (поле image) в apps/api/src/lib/conversationDelivery.ts. Проверка здесь только
 * ради мгновенной подсказки до загрузки: последнее слово всё равно за сервером.
 *
 * ВИДЕО сюда больше не входит (гибридный режим, 18.08.2026 вечер): ролик больше
 * канального лимита не отклоняется — он уходит в R2 и клиенту ссылкой вместо
 * файла (см. deliverMediaToConversation). На фронте у видео остаётся только общий
 * предохранитель MAX_MEDIA_PICK_MB — случайно огромный файл, а не лимит Meta.
 *
 * Общий модуль (22.09.2026): раньше эти два числа и проверка жили только в
 * Messages.tsx (десктоп) — тот самый класс бага «desktop и mobile ship
 * together» из CLAUDE.md, копия логики моглa бы разойтись между экранами.
 */
export const OUTGOING_IMAGE_LIMIT_MB: Record<string, number> = {
  WHATSAPP: 5,
  INSTAGRAM: 25,
  FACEBOOK: 25,
};

/** Верхний предохранитель выбора файла на фронте — 1 ГБ, НЕ лимит Meta (тот
 *  выбирает файл/ссылку на бэкенде). Ловит только явно случайный выбор не того
 *  файла, отдельного смысла у числа больше нет. */
export const MAX_MEDIA_PICK_MB = 1024;

/** Проверяет выбранный файл фото/видео ДО загрузки — тот же расчёт, что раньше
 *  жил только в Messages.tsx (см. комментарий у OUTGOING_IMAGE_LIMIT_MB выше).
 *  Возвращает текст ошибки или null, если файл годится. */
export function validateOutgoingMediaPick(file: File, channel: string | undefined): string | null {
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  if (!isImage && !isVideo) {
    return "Допустимы только изображения или видео";
  }
  if (file.size > MAX_MEDIA_PICK_MB * 1024 * 1024) {
    return `Файл слишком большой: предел ${MAX_MEDIA_PICK_MB} МБ`;
  }
  if (isImage && channel) {
    const limitMb = OUTGOING_IMAGE_LIMIT_MB[channel];
    if (limitMb && file.size > limitMb * 1024 * 1024) {
      return `Файл слишком большой: для фото в этом канале предел ${limitMb} МБ`;
    }
  }
  return null;
}

/**
 * Загрузка фото/видео в переписку С ПРОГРЕССОМ (18.08.2026).
 *
 * Отдельно от lib/api.ts: `fetch` не отдаёт прогресс ОТПРАВКИ тела запроса ни в
 * одном стабильном кросс-браузерном API (ReadableStream-body есть только за
 * флагом в части браузеров) — только XMLHttpRequest умеет `upload.onprogress`
 * везде. Ради одного индикатора тащить сюда axios как зависимость не стали —
 * XHR тот же fetch по правам (Authorization, credentials), только с прогрессом.
 */
export function uploadConversationMedia(
  conversationId: string,
  file: File,
  caption: string | undefined,
  onProgress: (percent: number) => void
): Promise<{ ok: boolean; pausedUntil: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("media", file, file.name);
    if (caption) form.append("caption", caption);

    const xhr = new XMLHttpRequest();
    /**
     * СТОРОЖ ПО ТИШИНЕ (21.09.2026, тот же разбор, что и у двух очередей
     * загрузки — `lib/uploadQueue.ts` и `lib/draftUploads.ts`).
     *
     * `onabort` здесь был с самого начала, а вот потолка ожидания нет: без
     * явного `xhr.timeout` XHR ждёт ответа бесконечно. Молча заглохший запрос
     * (сервер принял байты и замолчал, туннель оборвался без события) оставлял
     * обещание висеть навсегда — в переписке это вечная полоса отправки, из
     * которой нельзя выйти иначе как перезагрузкой страницы.
     *
     * Потолок по ДВИЖЕНИЮ БАЙТ, а не по общему времени: видео из переписки на
     * мобильном канале едет минутами и честный долгий запрос убивать нельзя.
     */
    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
    };
    const beat = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        // abort() поднимет onabort, он и отклонит обещание.
        xhr.abort();
      }, STALL_MS);
    };
    xhr.open("POST", `/api/v1/conversations/${conversationId}/reply-media`);
    xhr.withCredentials = true;
    const token = useAuthStore.getState().accessToken;
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("X-Device-Id", getOrCreateDeviceId());

    xhr.upload.onprogress = (e) => {
      beat();
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    // Тело ушло целиком — дальше ждём сервер (sharp/ffmpeg по вложению), и это
    // тоже движение: сторож отсчитывает тишину заново.
    xhr.upload.onload = beat;

    xhr.onload = () => {
      done();
      let data: unknown;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as { ok: boolean; pausedUntil: string });
        return;
      }
      const message = (data as { error?: string } | undefined)?.error || httpStatusMessage(xhr.status);
      reject(new ApiError(message, xhr.status, data));
    };

    xhr.onerror = () => {
      done();
      reject(new Error("Сеть недоступна — файл не отправлен"));
    };
    xhr.onabort = () => {
      done();
      reject(new Error("Связь пропала — файл не отправлен"));
    };

    beat();
    xhr.send(form);
  });
}
