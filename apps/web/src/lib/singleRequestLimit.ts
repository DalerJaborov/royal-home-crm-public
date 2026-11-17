import {
  PROXY_SINGLE_REQUEST_MAX_BYTES,
  REQUEST_TOO_LARGE_CODE,
  singleRequestTooLargeMessage,
} from "@royal-home/shared";
import { ApiError } from "./apiError";

/**
 * ПРОВЕРКА ВЕСА ДО ОТПРАВКИ ОДНИМ ЗАПРОСОМ (17.11.2026, класс «большой файл одним запросом → 413»).
 *
 * Тело тяжелее PROXY_SINGLE_REQUEST_MAX_BYTES (90 МБ) не доходит до сервера: его режет
 * Cloudflare или прокси, и человек видел безликое «Файл слишком большой» после минут
 * ожидания. Здесь отказ случается сразу и тем же текстом, что отвечает сервер. Тяжёлые
 * файлы, которые бывают больше потолка по делу (ролики), едут частями — lib/chunkedUpload.ts.
 *
 * `api()` проверяет каждую FormData сам (lib/api.ts); прямые XMLHttpRequest зовут
 * `assertFitsSingleRequest` — сторож scripts/audit-limits.mjs следит, чтобы не забывали.
 */

/** Вес файлов в форме (текстовые поля — байты-копейки, их не считаем). */
export function formDataFileBytes(form: FormData): number {
  let total = 0;
  form.forEach((value) => {
    if (typeof value !== "string") total += value.size;
  });
  return total;
}

/** Бросает ApiError 413 с понятным текстом, если запрос тяжелее потолка одного запроса. */
export function assertFitsSingleRequest(body: FormData | Blob | readonly Blob[] | number): void {
  const size =
    typeof body === "number"
      ? body
      : body instanceof FormData
        ? formDataFileBytes(body)
        : Array.isArray(body)
          ? body.reduce((sum: number, b: Blob) => sum + b.size, 0)
          : (body as Blob).size;
  if (size > PROXY_SINGLE_REQUEST_MAX_BYTES) {
    throw new ApiError(singleRequestTooLargeMessage(size), 413, { code: REQUEST_TOO_LARGE_CODE });
  }
}
