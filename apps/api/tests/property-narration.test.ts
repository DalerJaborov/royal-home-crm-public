import { describe, expect, it, vi } from "vitest";
import { narrationConfigSchema, narrationDraftSchema } from "@royal-home/shared";
import { generateNarrationAudio, narrationFacts, narrationHash, narrationScriptError, publicationPreview, suggestedNarration } from "../src/lib/propertyNarration.js";

const facts = { type: "APARTMENT", rooms: 3, areaSqm: "90", floor: 4, totalFloors: 9, district: { name: "Центр" }, price: 900000, phone: "private", title: "Цена 900000" };
const config = { modelId: "configured-model", voices: [{ id: "owner_voice", name: "Голос владельца" }] };
describe("property narration boundaries", () => {
  it("builds a fact-only script without free text, price or personal contacts", () => {
    const snapshot = narrationFacts(facts);
    expect(snapshot).not.toHaveProperty("price"); expect(snapshot).not.toHaveProperty("phone");
    const text = suggestedNarration(snapshot);
    expect(text).toContain("90 квадратных метров"); expect(text).not.toContain("900000"); expect(text).not.toContain("private");
    expect(narrationScriptError(text)).toBeNull();
    expect(narrationHash(snapshot)).not.toBe(narrationHash(narrationFacts({ ...facts, rooms: 2 })));
    expect(narrationHash(snapshot)).toBe(narrationHash(narrationFacts({ ...facts, price: 1 })));
  });
  it.each(["Цена: 900000", "Всего пятьсот тысяч сомони", "$ 900", "Стоимость миллион", "90 000 USD"])("rejects spoken price %s", (text) => expect(narrationScriptError(text)).not.toBeNull());
  it("requires explicit voice configuration and accepts more than two choices", () => {
    expect(narrationConfigSchema.parse({}).voices).toEqual([]);
    expect(narrationConfigSchema.safeParse({ modelId: "m", voices: [1, 2, 3].map((n) => ({ id: `v${n}`, name: `Голос ${n}` })) }).success).toBe(true);
    expect(narrationConfigSchema.safeParse({ modelId: "m", voices: [config.voices[0], config.voices[0]] }).success).toBe(false);
    expect(narrationDraftSchema.safeParse({ expectedRevision: 0, requestKey: crypto.randomUUID(), script: "a".repeat(5001) }).success).toBe(false);
  });
  it("does not invoke the provider for an unknown voice", async () => {
    const fetcher = vi.fn();
    expect(await generateNarrationAudio({ script: "Площадь девяносто метров.", voiceId: "other", config, apiKey: "test" }, fetcher)).toMatchObject({ status: "FAILED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves the entire approved text above the old 2000-character limit", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg", "request-id": "receipt" } }));
    const script = "Описание объекта. ".repeat(160);
    const result = await generateNarrationAudio({ script, voiceId: "owner_voice", config, apiKey: "test" }, fetcher);
    expect(result.status).toBe("READY");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).text).toBe(script);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never retries an ambiguous paid request", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("connection lost"));
    expect(await generateNarrationAudio({ script: "Площадь девяносто метров.", voiceId: "owner_voice", config, apiKey: "test" }, fetcher)).toEqual({ status: "UNKNOWN", errorCode: "PROVIDER_OUTCOME_UNKNOWN" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not mistake HTML or a provider error for generated audio", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("html", { headers: { "content-type": "text/html" } }));
    expect(await generateNarrationAudio({ script: "Площадь девяносто метров.", voiceId: "owner_voice", config, apiKey: "test" }, fetcher)).toMatchObject({ status: "UNKNOWN" });
  });
  it("publication previews never claim an external update succeeded", () => {
    const rows = publicationPreview(["FACEBOOK", "INSTAGRAM", "TIKTOK", "FACEBOOK"]);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => ["PREVIEW", "MANUAL_REQUIRED"].includes(r.status))).toBe(true);
    expect(rows.filter((r) => r.channel === "INSTAGRAM").every((r) => r.status === "MANUAL_REQUIRED")).toBe(true);
  });
});
