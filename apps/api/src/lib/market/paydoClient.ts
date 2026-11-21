/**
 * КЛИЕНТ api.paydo.tj — ТОЛЬКО ЧТЕНИЕ (поиск объявлений). Ничего не публикуем.
 *
 * Гостевой токен выдаёт сам API: `POST /api/v1/authorization/anonymous-session/`
 * с {device_id, device_name, device_type} возвращает {anonymous_id}. Мы получаем
 * его на старте и держим только в памяти процесса — ни в коде, ни в логах, ни в
 * базе его нет. Протух (401) — берём новый один раз и повторяем запрос.
 *
 * Приличия: строго последовательно, пауза между запросами, честный User-Agent,
 * таймаут, ретраи с растущей задержкой; на 429/403 останавливаемся совсем —
 * это просьба сайта отстать, долбить дальше нельзя.
 *
 * ПОВТОРЫ (17.11.2026). Сбор Paydo падал «страница не отдана» серией: 13.11 с 03:00 до 04:20 по Душанбе
 * (ночной обход и пять инкрементов подряд), 16.11 один раз. Прежние повторы шли через 2 и 4 секунды —
 * короткий сбой сайта они не переживали. Теперь паузы 5, 15 и 45 секунд (четыре попытки, около минуты),
 * а причина последнего сбоя (код ответа или вид сетевой ошибки, без тел и токенов) лежит в `lastFailure`
 * и попадает в журнал: «не отдана» без кода не отличает упавший сайт от блокировки с адреса сервера.
 */

import { randomUUID } from "node:crypto";
import { readCapped } from "../safeFetch.js";

const API = "https://api.paydo.tj";
const USER_AGENT = "Mozilla/5.0 (compatible; RoyalHomeBot/1.0; +https://royalhome.tj)";
export const PAYDO_DELAY_MS = 700;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;
/** Паузы перед повтором, мс (после 1-й, 2-й, 3-й неудачи). */
export const PAYDO_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;
/** Потолок ответа Paydo — как у Somon (lib/somonLeads/sourceClient.ts): страница
 *  выдачи весит десятки КБ, всё больше 4 МБ — не выдача, а чужие данные в память. */
export const PAYDO_MAX_BYTES = 4 * 1024 * 1024;

/** Сайт попросил остановиться (429/403) — обход нужно прекратить. */
export class PaydoBlockedError extends Error {
  constructor(public readonly status: number) {
    super(`Paydo ответил ${status}: обход остановлен`);
    this.name = "PaydoBlockedError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Последний сбой запроса: только код ответа или вид сетевой ошибки — ни тел, ни токенов. */
export interface PaydoFailure {
  status: number | null;
  /** "timeout" | "network" | "too_large" | "bad_json" | "http" */
  kind: string;
}

/** Причина словами для журнала: «HTTP 502», «таймаут» и т.п. */
export function paydoFailureText(f: PaydoFailure | null): string {
  if (!f) return "причина неизвестна";
  if (f.status != null) return `HTTP ${f.status}`;
  return { timeout: "таймаут", network: "сеть", too_large: "слишком большой ответ", bad_json: "ответ не JSON" }[f.kind] ?? f.kind;
}

function failureOf(err: unknown): PaydoFailure {
  const e = err as { name?: string; message?: string } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return { status: null, kind: "timeout" };
  if (e?.message?.includes("слишком большой ответ")) return { status: null, kind: "too_large" };
  if (e instanceof SyntaxError) return { status: null, kind: "bad_json" };
  return { status: null, kind: "network" };
}

export interface PaydoSearchPage {
  advertisements: unknown[];
  cursor: string | null;
  hasMore: boolean;
}

export class PaydoClient {
  private token: string | null = null;
  private lastRequestAt = 0;
  private readonly deviceId = randomUUID();
  /** Причина последнего неудачного запроса поиска (null — последний прошёл). */
  lastFailure: PaydoFailure | null = null;
  /** Для тестов: подмена ожидания между повторами. */
  constructor(private readonly pause: (ms: number) => Promise<void> = sleep) {}

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + PAYDO_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private async request(path: string, init: { body: unknown; token?: string }): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Country": "TJ",
      "User-Agent": USER_AGENT,
      "Accept-Language": "ru",
    };
    if (init.token) headers["anonymous-id"] = init.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(init.body),
        signal: controller.signal,
        // Хост постоянный; перенаправление на чужой адрес — не Paydo (аудит 17.11.2026, S3).
        redirect: "error",
      });
      // Тело читается здесь же, под тем же сроком и с потолком: раньше срок
      // снимался сразу после заголовков, а `res.json()` читал сколько угодно.
      const { body, truncated } = await readCapped(res, PAYDO_MAX_BYTES);
      if (truncated) throw new Error(`Paydo: слишком большой ответ (больше ${PAYDO_MAX_BYTES} байт)`);
      return new Response(body.byteLength ? new Uint8Array(body) : null, { status: res.status, headers: res.headers });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureToken(force = false): Promise<string> {
    if (this.token && !force) return this.token;
    await this.throttle();
    const res = await this.request("/api/v1/authorization/anonymous-session/", {
      body: { device_id: this.deviceId, device_name: "RoyalHomeBot", device_type: "WEB" },
    });
    if (res.status === 429 || res.status === 403) throw new PaydoBlockedError(res.status);
    if (!res.ok) throw new Error(`Paydo: гостевая сессия не выдана (${res.status})`);
    const data = (await res.json()) as { anonymous_id?: string };
    if (!data.anonymous_id) throw new Error("Paydo: в ответе нет anonymous_id");
    this.token = data.anonymous_id;
    return this.token;
  }

  /** Одна страница поиска (до 20 объявлений). null cursor — первая страница. */
  async search(
    subcategoryId: number,
    cursor: string | null,
    filters: Array<{ key: string; value: string[] }> = [{ key: "city", value: ["dushanbe"] }]
  ): Promise<PaydoSearchPage | null> {
    const qs = new URLSearchParams({ category_id: "2", subcategory_id: String(subcategoryId), limit: "20" });
    if (cursor) qs.set("cursor", cursor);
    let reauthed = false;
    const retryPause = async (attempt: number) => {
      if (attempt < MAX_RETRIES) await this.pause(PAYDO_RETRY_DELAYS_MS[Math.min(attempt, PAYDO_RETRY_DELAYS_MS.length) - 1]);
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const token = await this.ensureToken();
        await this.throttle();
        const res = await this.request(`/api/v1/search/?${qs}`, { body: { filters }, token });
        if (res.status === 429 || res.status === 403) throw new PaydoBlockedError(res.status);
        if (res.status === 401 && !reauthed) {
          reauthed = true;
          await this.ensureToken(true);
          attempt--; // обновление токена не считается неудачной попыткой
          continue;
        }
        if (res.status >= 500 || res.status === 408) {
          this.lastFailure = { status: res.status, kind: "http" };
          await retryPause(attempt);
          continue;
        }
        if (!res.ok) {
          // 4xx (кроме 401/403/408/429) повтором не лечится: запрос неверен для сайта — сразу отказ с кодом.
          this.lastFailure = { status: res.status, kind: "http" };
          return null;
        }
        const json = (await res.json()) as {
          advertisements?: { advertisements?: unknown[]; cursor?: string | null; has_more?: boolean };
        };
        const block = json.advertisements;
        this.lastFailure = null;
        return {
          advertisements: Array.isArray(block?.advertisements) ? block.advertisements : [],
          cursor: block?.cursor ?? null,
          hasMore: Boolean(block?.has_more),
        };
      } catch (err) {
        if (err instanceof PaydoBlockedError) throw err;
        this.lastFailure = failureOf(err);
        await retryPause(attempt);
      }
    }
    return null;
  }
}
