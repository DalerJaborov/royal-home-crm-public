import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), extract: vi.fn(), settings: vi.fn(), runtime: vi.fn(), money: vi.fn(), attempt: vi.fn(), reserve: vi.fn() }));
vi.mock("../src/telegram/api.js", () => ({ resolveTelegramFile: mocks.resolve }));
vi.mock("../src/ai/assistant/mediaUnderstanding.js", () => ({ understandAssistantMedia: mocks.extract }));
vi.mock("../src/ai/assistant/runtime.js", () => ({ loadAssistantSettings: mocks.settings, loadAssistantGeminiRuntime: mocks.runtime }));
vi.mock("../src/ai/assistant/moneyBudget.js", () => ({ createAssistantMoneyGuard: () => mocks.money }));
vi.mock("../src/ai/assistant/attemptLimit.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/assistant/attemptLimit.js")>(), createAssistantAttemptLimit: () => mocks.attempt }));
vi.mock("../src/ai/assistant/attemptBudget.js", () => ({ reserveAssistantGeminiAttempt: mocks.reserve }));
import { downloadAssistantMedia, handleAssistantMedia } from "../src/telegram/assistantMedia.js";
const msg = () => ({ chat: { id: 1, type: "private" }, document: { file_id: "file", mime_type: "application/pdf" } });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({ enabled: true });
  mocks.runtime.mockResolvedValue({ keys: ["test"], model: "cheap", fallbackModels: ["cheap"] });
  mocks.resolve.mockResolvedValue({ kind: "url", url: "https://telegram.invalid/test" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("%PDF-1.7")));
  mocks.extract.mockResolvedValue({ extraction: { transcript: "", readableText: "120000", visualDescription: "", incomplete: false, language: "ru" } });
});
describe("employee Telegram file adapter", () => {
  it("rejects group by default before any download", async () => {
    const result = await handleAssistantMedia({ ...msg(), chat: { id: 1, type: "group" } }, "employee");
    expect(result.error).toBe("media_scope"); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("checks the off switch before fetching or extracting", async () => {
    mocks.settings.mockResolvedValue({ enabled: false });
    expect((await handleAssistantMedia(msg(), "employee")).error).toBe("assistant_disabled");
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.extract).not.toHaveBeenCalled();
  });
  it("returns standalone extraction and forwards full attempt metadata to both budgets", async () => {
    const result = await handleAssistantMedia(msg(), "employee");
    expect(result.extraction?.readableText).toBe("120000");
    expect(mocks.resolve).toHaveBeenCalledWith("file", 4_000_000, 10_000);
    const request = mocks.extract.mock.calls[0][0];
    expect(request.runtime.model).toBe("gemini-3.1-pro-preview"); expect(request.runtime.fallbackModels).toEqual([]);
    const metadata = { model: "pro", body: {}, apiKey: "test", kind: "generate" };
    await request.beforeAttempt(metadata);
    expect(mocks.attempt).toHaveBeenCalledOnce(); expect(mocks.money).toHaveBeenCalledWith(metadata);
  });
  it("rejects declared oversize before download", async () => {
    expect((await handleAssistantMedia({ ...msg(), document: { ...msg().document, file_size: 4_000_001 } }, "employee")).error).toBe("media_failed");
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("stops a streaming download beyond the real byte limit", async () => {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(11)); }, cancel })));
    await expect(downloadAssistantMedia("file", 10)).rejects.toThrow("media_size_rejected");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("redacts provider and download errors", async () => {
    mocks.resolve.mockRejectedValue(new Error("https://secret-token/private"));
    const result = await handleAssistantMedia(msg(), "employee");
    expect(result.error).toBe("media_failed"); expect(result.text).not.toContain("secret-token");
  });
});
