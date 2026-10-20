import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callGraph } from "../src/messengers/meta.js";

/**
 * "Upload failed" (error_subcode 2018007) НЕ подпадает под общее правило
 * fetchWithRetry «4xx/5xx от Meta не повторяем» (25.08.2026, найдено по
 * утреннему отчёту об ошибках: этот код ловился и на фото, и на PDF-файл
 * вперемешку с успешными отправками того же файла минутами раньше/позже —
 * то есть не постоянный отказ конкретного URL, а разовый сбой скачивания
 * на стороне Meta).
 */

function uploadFailedResponse(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Upload failed", type: "IGApiException", code: 100, error_subcode: 2018007 } }),
    { status: 400 }
  );
}

function otherErrorResponse(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Invalid parameter", type: "IGApiException", code: 100 } }),
    { status: 400 }
  );
}

describe("callGraph — повтор на error_subcode 2018007", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("первая попытка 'Upload failed', вторая — успех: результат доходит, а не теряется", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? uploadFailedResponse() : new Response(JSON.stringify({ message_id: "mid-1" }), { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await callGraph<{ message_id: string }>("https://graph.facebook.com/v23.0/me/messages", "token", { foo: "bar" });

    expect(result).toEqual({ message_id: "mid-1" });
    expect(calls).toBe(2);
  }, 10_000);

  it("другая ошибка Graph API (без error_subcode 2018007) не повторяется — падает сразу", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls += 1;
      return Promise.resolve(otherErrorResponse());
    }) as unknown as typeof fetch;

    await expect(
      callGraph("https://graph.facebook.com/v23.0/me/messages", "token", { foo: "bar" })
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });

  it("'Upload failed' на каждой попытке — в итоге падает, а не повторяет бесконечно", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls += 1;
      return Promise.resolve(uploadFailedResponse());
    }) as unknown as typeof fetch;

    await expect(
      callGraph("https://graph.facebook.com/v23.0/me/messages", "token", { foo: "bar" })
    ).rejects.toThrow(/2018007/);
    // Одна первая попытка + столько повторов, сколько задержек предусмотрено — не более.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(3);
  }, 10_000);
});
