import type { Server } from "node:http";
import { UPLOAD_PART_MAX_BYTES } from "@royal-home/shared";

/**
 * ТАЙМАУТЫ HTTP-СЕРВЕРА API — заданы явно (25.11.2026, волна B загрузки частями).
 *
 * Раньше не задавались, и действовали умолчания Node: `requestTimeout` 300 с на ВЕСЬ запрос
 * (вместе с телом) и `keepAliveTimeout` 5 с. Часть загрузки 8 МБ на канале 300 Кбит/с идёт
 * ~224 с — впритык к 300 с, а с паузами связи — дольше: Node рвал запрос, телефон получал
 * обрыв и слал часть заново.
 *
 *  - requestTimeout — не меньше 15 минут: самая крупная часть (UPLOAD_PART_MAX_BYTES) на самом медленном
 *    канале, который мы обещаем (MIN_UPLINK_BITS_PER_SEC), с тройным запасом. Быстрые запросы
 *    это не задевает: потолок, а не ожидание.
 *  - headersTimeout — 60 с, как было по умолчанию: заголовки приходят сразу, медленное тело —
 *    забота requestTimeout; защита от «медленных заголовков» остаётся прежней.
 *  - keepAliveTimeout — 65 с: дольше, чем держит простаивающее соединение прокси перед API
 *    (nginx/Caddy, 60 с), иначе Node закрывает соединение в тот момент, когда прокси шлёт по
 *    нему следующий запрос, — и человек получает 502 на ровном месте.
 */
export const MIN_UPLINK_BITS_PER_SEC = 300_000;
export const REQUEST_TIMEOUT_MS = Math.max(15 * 60_000, Math.ceil(((UPLOAD_PART_MAX_BYTES * 8) / MIN_UPLINK_BITS_PER_SEC) * 3) * 1000);
export const HEADERS_TIMEOUT_MS = 60_000;
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

export function applyHttpServerTimeouts(server: Pick<Server, "requestTimeout" | "headersTimeout" | "keepAliveTimeout">): void {
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
}
