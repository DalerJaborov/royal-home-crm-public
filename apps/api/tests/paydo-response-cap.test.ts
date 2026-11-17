import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PAYDO_MAX_BYTES, PaydoClient } from "../src/lib/market/paydoClient.js";

/**
 * ОТВЕТ PAYDO — С ПОТОЛКОМ И БЕЗ ПЕРЕХОДОВ (аудит безопасности 17.11.2026, S3).
 *
 * Было: `fetch` без `redirect: "error"` и `res.json()` целиком — чужой ответ
 * клал в память сервера сколько хотел, и срок запроса снимался сразу после
 * заголовков, до чтения тела.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());
afterAll(() => vi.unstubAllGlobals());

type Requester = { request(path: string, init: { body: unknown }): Promise<Response> };

function streamOf(totalBytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
}

describe("PaydoClient.request", () => {
  it("ответ больше потолка (10 МБ) — ошибка, а не чтение в память целиком", async () => {
    fetchMock.mockResolvedValue(new Response(streamOf(10 * 1024 * 1024), { status: 200 }));
    const client = new PaydoClient() as unknown as Requester;
    await expect(client.request("/api/v1/search/", { body: {} })).rejects.toThrow(/слишком большой ответ/);
    expect(PAYDO_MAX_BYTES).toBeLessThan(10 * 1024 * 1024);
  });

  it("перенаправления запрещены, обычный ответ читается как раньше", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ anonymous_id: "x" }), { status: 200 }));
    const client = new PaydoClient() as unknown as Requester;
    const res = await client.request("/api/v1/authorization/anonymous-session/", { body: {} });
    expect(await res.json()).toEqual({ anonymous_id: "x" });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });
});
