import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), extract: vi.fn(), settings: vi.fn(), runtime: vi.fn(), money: vi.fn(), attempt: vi.fn(), reserve: vi.fn(), scribe: vi.fn() }));
vi.mock("../src/telegram/api.js", () => ({ resolveTelegramFile: mocks.resolve }));
vi.mock("../src/ai/assistant/mediaUnderstanding.js", () => ({ understandAssistantMedia: mocks.extract }));
vi.mock("../src/ai/assistant/runtime.js", () => ({ loadAssistantSettings: mocks.settings, loadAssistantGeminiRuntime: mocks.runtime }));
vi.mock("../src/ai/assistant/moneyBudget.js", () => ({ createAssistantMoneyGuard: () => mocks.money }));
vi.mock("../src/ai/assistant/attemptLimit.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/assistant/attemptLimit.js")>(), createAssistantAttemptLimit: () => mocks.attempt }));
vi.mock("../src/ai/assistant/attemptBudget.js", () => ({ reserveAssistantGeminiAttempt: mocks.reserve }));
vi.mock("../src/telegram/assistantScribe.js", () => ({ recognizeShortAssistantVoice: mocks.scribe }));
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
  it("uses the fast recognition result without a second download or Gemini call", async () => {
    const transcript = "خیلی ممنونم. خیلی ممنون";
    mocks.scribe.mockResolvedValue({ transcript, language: "other" });
    const result = await handleAssistantMedia({ chat: { id: 1, type: "group" },
      voice: { file_id: "voice", duration: 4 } }, "employee", { allowGroup: true });
    expect(result.extraction).toMatchObject({ transcript, language: "other", incomplete: false });
    expect(mocks.scribe).toHaveBeenCalledOnce();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "forwarded", "long"])("uses Gemini for %s group voice", async mode => {
    mocks.scribe.mockResolvedValue(null);
    const msg = { chat: { id: 1, type: "group" }, voice: { file_id: "voice", duration: mode === "long" ? 45 : 4 },
      ...(mode === "forwarded" ? { forward_origin: { type: "user" } } : {}) };
    const result = await handleAssistantMedia(msg, "employee", { allowGroup: true });
    expect(result.extraction).toBeDefined();
    expect(mocks.scribe).toHaveBeenCalledTimes(mode === "unavailable" ? 1 : 0);
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.extract).toHaveBeenCalledOnce();
  });
  it.each(["missing Telegram file", "speech provider unavailable", "invalid recognition result"] as const)(
    "distinguishes a failed voice stage for %s", async failure => {
      const voice = { chat: { id: 1, type: "private" }, voice: { file_id: "file", duration: 5 } };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        if (failure === "missing Telegram file") mocks.resolve.mockRejectedValue(new Error("https://secret-token/private"));
        if (failure === "speech provider unavailable") mocks.extract.mockRejectedValue(new Error("provider detail with secret-token"));
        if (failure === "invalid recognition result") mocks.extract.mockRejectedValue(new Error("media_invalid_extraction"));
        const result = await handleAssistantMedia(voice, "employee");
        expect(result).toMatchObject(failure === "missing Telegram file" ? {
          error: "media_download_failed", text: "Не удалось скачать голосовое из Telegram. Отправь его ещё раз.",
        } : failure === "speech provider unavailable" ? {
          error: "media_recognition_unavailable", text: "Распознавание голоса сейчас недоступно. Напиши текстом или попробуй чуть позже.",
        } : {
          error: "media_speech_unclear", text: "Не удалось разобрать речь. Запиши ещё раз или напиши текстом.",
        });
        expect(warn).toHaveBeenCalledWith("[telegram:assistant:media] extraction failed", expect.objectContaining({
          kind: "voice", stage: failure === "missing Telegram file" ? "download" : "recognition",
        }));
        expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token");
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("redacts provider and download errors", async () => {
    mocks.resolve.mockRejectedValue(new Error("https://secret-token/private"));
    const result = await handleAssistantMedia(msg(), "employee");
    expect(result.error).toBe("media_failed"); expect(result.text).not.toContain("secret-token");
  });
});
