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
 */

import { randomUUID } from "node:crypto";

const API = "https://api.paydo.tj";
const USER_AGENT = "Mozilla/5.0 (compatible; RoyalHomeBot/1.0; +https://royalhome.tj)";
export const PAYDO_DELAY_MS = 700;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

/** Сайт попросил остановиться (429/403) — обход нужно прекратить. */
export class PaydoBlockedError extends Error {
  constructor(public readonly status: number) {
    super(`Paydo ответил ${status}: обход остановлен`);
    this.name = "PaydoBlockedError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PaydoSearchPage {
  advertisements: unknown[];
  cursor: string | null;
  hasMore: boolean;
}

export class PaydoClient {
  private token: string | null = null;
  private lastRequestAt = 0;
  private readonly deviceId = randomUUID();

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
      return await fetch(`${API}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(init.body),
        signal: controller.signal,
      });
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
        if (res.status >= 500) {
          await sleep(PAYDO_DELAY_MS * attempt * 3);
          continue;
        }
        if (!res.ok) return null;
        const json = (await res.json()) as {
          advertisements?: { advertisements?: unknown[]; cursor?: string | null; has_more?: boolean };
        };
        const block = json.advertisements;
        return {
          advertisements: Array.isArray(block?.advertisements) ? block.advertisements : [],
          cursor: block?.cursor ?? null,
          hasMore: Boolean(block?.has_more),
        };
      } catch (err) {
        if (err instanceof PaydoBlockedError) throw err;
        await sleep(PAYDO_DELAY_MS * attempt * 3);
      }
    }
    return null;
  }
}
