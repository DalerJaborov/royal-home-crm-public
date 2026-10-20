import { afterEach, describe, expect, it, vi } from "vitest";
import { botTurnTracePayloadSchema, type BotTurnTracePayload } from "@royal-home/shared";
import { withBotTurnTrace } from "../src/lib/botTurnTrace.js";
import { callGeminiTools } from "../src/ai/geminiClient.js";

vi.mock("../src/ai/geminiSettings.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({ keys: ["PRIVATE_SYNTHETIC_KEY"], model: "gemini-3.6-flash", fallbackModels: [],
    transcribeModels: [], imageModel: "unused", liteModel: "", explicitCaching: false }),
}));
vi.mock("../src/lib/systemError.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn(async () => {}),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("actual tools wire metadata trace with synthetic HTTP only, prepared source", () => {
  it("records assistant-tools per physical fetch and never its tool arguments, provider text or key", async () => {
    vi.stubEnv("GEMINI_PROXY_URL", "");
    const rows: BotTurnTracePayload[] = [], requests: unknown[] = [];
    const physical = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
      expect(init?.method).toBe("POST"); requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "save_contact",
        args: { phone: "+992931234567", name: "PRIVATE_NAME", internalId: "PRIVATE_RESOURCE_ID" } } }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, cachedContentTokenCount: 0 } }));
    }); vi.stubGlobal("fetch", physical);
    await withBotTurnTrace({ channel: "INSTAGRAM", account: "synthetic-scope", peer: "synthetic-peer", event: "synthetic-event",
      managed: { surface: "dm", phase: "planning" } }, async () => {
      const result = await callGeminiTools({ apiKey: "PRIVATE_SYNTHETIC_KEY", system: "PRIVATE_SYSTEM_PROMPT",
        contents: [{ role: "user", parts: [{ text: "PRIVATE_CUSTOMER_TEXT" }] }], tools: [{ name: "save_contact", description: "PRIVATE_TOOL_TEXT" }] });
      expect(result.calls[0].args).toMatchObject({ phone: "+992931234567" });
    }, { enabled: true, text: true, secret: "synthetic-core-trace-only-secret-0000000", write: row => { rows.push(row); } });
    expect(physical).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(1);
    expect(rows.at(-1)?.modelAttempts).toEqual([expect.objectContaining({ endpoint: "assistant-tools", model: "gemini-3.6-flash",
      outcome: "returned", cacheUsed: false })]);
    expect(rows.at(-1)?.modelAttempts[0].projection).toBeUndefined();
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|992931234567|save_contact/);
    expect(rows.every(row => botTurnTracePayloadSchema.safeParse(row).success)).toBe(true);
  });
});
