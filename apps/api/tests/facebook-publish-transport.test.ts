import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFacebookPublish } from "../src/lib/facebookPublishTransport.js";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn() } }));

const url = "https://graph.facebook.com/test-page/videos";
const init = { method: "POST", body: '{"description":"test"}' };
const failure = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Facebook publishing transport", () => {
  it.each(["UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN", "ENOTFOUND"])("replays the same request after %s", async (code) => {
    const response = new Response("{}", { status: 200 });
    const fetchMock = vi.fn().mockRejectedValueOnce(failure(code)).mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const result = fetchFacebookPublish(url, init);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(response);
    expect(fetchMock.mock.calls).toEqual([[url, { ...init, redirect: "error" }], [url, { ...init, redirect: "error" }]]);
  });

  it("stops after three connection failures and preserves the final error", async () => {
    const error = failure("UND_ERR_CONNECT_TIMEOUT");
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);
    const result = fetchFacebookPublish(url, init).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["ECONNRESET", "EPIPE", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])("never replays an ambiguous %s failure", async (code) => {
    const error = failure(code);
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFacebookPublish(url, init)).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 429, 500, 503])("never replays HTTP %s", async (status) => {
    const response = new Response("{}", { status });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchFacebookPublish(url, init)).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("UND_ERR_CONNECT_TIMEOUT"), new DOMException("Timeout", "TimeoutError"), new DOMException("Abort", "AbortError")])("does not infer replay safety from a message or a request timeout", async (error) => {
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFacebookPublish(url, init)).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("retries aggregated addresses only if every error is before connection (allSafe=%s)", async (allSafe) => {
    const error = new TypeError("fetch failed", { cause: new AggregateError([failure("EAI_AGAIN"), failure(allSafe ? "UND_ERR_CONNECT_TIMEOUT" : "ECONNRESET")]) });
    const response = new Response("{}");
    const fetchMock = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const result = fetchFacebookPublish(url, init).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(allSafe ? response : error);
    expect(fetchMock).toHaveBeenCalledTimes(allSafe ? 2 : 1);
  });

  it("does not replay after cancellation during backoff", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockRejectedValue(failure("UND_ERR_CONNECT_TIMEOUT"));
    vi.stubGlobal("fetch", fetchMock);
    const result = fetchFacebookPublish(url, { ...init, signal: controller.signal }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(controller.signal.reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
