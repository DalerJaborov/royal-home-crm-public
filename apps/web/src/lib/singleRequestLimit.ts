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
 * `api()` проверяет каждую FormData сам (lib/api.ts); прямые отправки зовут
 * `assertFitsSingleRequest(form)` перед `send` — сторож scripts/audit-limits.mjs следит за
 * каждой отправкой.
 */

/**
 * Разметка multipart: граница и заголовки каждой части плюс запас. Без запаса форма «ровно
 * 90 МБ файлов» проходила проверку экрана и упиралась в дверь сервера, которая считает
 * весь Content-Length.
 */
export const FORM_OVERHEAD_BYTES = 64 * 1024;
const PER_ENTRY_OVERHEAD_BYTES = 512;

/** Вес файлов в форме (текстовые поля — байты-копейки, их не считаем). */
export function formDataFileBytes(form: FormData): number {
  let total = 0;
  form.forEach((value) => {
    if (typeof value !== "string") total += value.size;
  });
  return total;
}

function measure(body: FormData | Blob | readonly Blob[] | number): { size: number; wire: number; files: number } {
  if (typeof body === "number") return { size: body, wire: body, files: 1 };
  if (body instanceof FormData) {
    let entries = 0;
    let files = 0;
    let text = 0;
    body.forEach((value) => {
      entries++;
      if (typeof value === "string") text += value.length * 3;
      else files++;
    });
    const size = formDataFileBytes(body);
    return { size, wire: size + text + FORM_OVERHEAD_BYTES + entries * PER_ENTRY_OVERHEAD_BYTES, files };
  }
  if (Array.isArray(body)) {
    const size = body.reduce((sum: number, b: Blob) => sum + b.size, 0);
    return { size, wire: size + FORM_OVERHEAD_BYTES, files: body.length };
  }
  const size = (body as Blob).size;
  return { size, wire: size, files: 1 };
}

/** Бросает ApiError 413 с понятным текстом, если запрос тяжелее потолка одного запроса. */
export function assertFitsSingleRequest(body: FormData | Blob | readonly Blob[] | number): void {
  const { size, wire, files } = measure(body);
  if (wire > PROXY_SINGLE_REQUEST_MAX_BYTES) {
    throw new ApiError(singleRequestTooLargeMessage(size, files), 413, { code: REQUEST_TOO_LARGE_CODE });
  }
}
