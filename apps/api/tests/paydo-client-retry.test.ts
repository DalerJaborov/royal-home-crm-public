import { afterEach, describe, expect, it, vi } from "vitest";
import { PAYDO_RETRY_DELAYS_MS, PaydoBlockedError, PaydoClient, paydoFailureText } from "../src/lib/market/paydoClient.js";

/**
 * Повторы Paydo (17.11.2026): сбой сайта «страница не отдана» серией (13.11, 03:00–04:20 по Душанбе) прежние
 * повторы через 2 и 4 секунды не переживали. Теперь паузы 5/15/45 с, а причина последнего сбоя — код ответа
 * или вид ошибки — остаётся в lastFailure для журнала. 403/429 — стоп без повторов.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const page = { advertisements: { advertisements: [], cursor: null, has_more: false } };

function stubFetch(searchReplies: Array<() => Response>) {
  let i = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("anonymous-session")) return json({ anonymous_id: "test-anon" });
    const reply = searchReplies[Math.min(i++, searchReplies.length - 1)];
    return reply();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("PaydoClient: повторы и причина сбоя", () => {
  it("502, 502, потом 200: две паузы 5 и 15 секунд, страница отдана, сбоя нет", async () => {
    stubFetch([() => json({}, 502), () => json({}, 502), () => json(page)]);
    const pauses: number[] = [];
    const client = new PaydoClient(async (ms) => void pauses.push(ms));
    const res = await client.search(201, null);
    expect(res).not.toBeNull();
    expect(pauses).toEqual([PAYDO_RETRY_DELAYS_MS[0], PAYDO_RETRY_DELAYS_MS[1]]);
    expect(client.lastFailure).toBeNull();
  }, 20_000);

  it("сайт лежит: четыре попытки, паузы 5/15/45 с, итог null и код ответа для журнала", async () => {
    stubFetch([() => json({}, 503)]);
    const pauses: number[] = [];
    const client = new PaydoClient(async (ms) => void pauses.push(ms));
    expect(await client.search(201, null)).toBeNull();
    expect(pauses).toEqual([...PAYDO_RETRY_DELAYS_MS]);
    expect(paydoFailureText(client.lastFailure)).toBe("HTTP 503");
  }, 20_000);

  it("4xx (кроме 401/403/408/429) повтором не лечится: сразу null с кодом; 403 — остановка без повторов", async () => {
    stubFetch([() => json({}, 400)]);
    const pauses: number[] = [];
    const client = new PaydoClient(async (ms) => void pauses.push(ms));
    expect(await client.search(201, null)).toBeNull();
    expect(pauses).toEqual([]);
    expect(paydoFailureText(client.lastFailure)).toBe("HTTP 400");
    stubFetch([() => json({}, 403)]);
    await expect(new PaydoClient(async () => {}).search(201, null)).rejects.toBeInstanceOf(PaydoBlockedError);
  }, 20_000);

  it("сетевой сбой и таймаут называются словами, без тел и адресов", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("anonymous-session")) return json({ anonymous_id: "test-anon" });
      throw Object.assign(new Error("boom"), { name: "AbortError" });
    }));
    const client = new PaydoClient(async () => {});
    expect(await client.search(201, null)).toBeNull();
    expect(paydoFailureText(client.lastFailure)).toBe("таймаут");
    expect(paydoFailureText(null)).toBe("причина неизвестна");
  }, 20_000);
});
