import { describe, expect, it, vi } from "vitest";
import { submitReplySchema, SUBMIT_REPLY_ROLES, SUBMIT_REPLY_TOPICS, type SubmitReplyCapabilities } from "@royal-home/shared";
import { WHO_IS_THIS } from "../src/ai/botContract.js";
import { TOPIC_CODES } from "../src/ai/topicLock.js";

const { callAi, logError } = vi.hoisted(() => ({ callAi: vi.fn(), logError: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: callAi,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: logError,
}));
const { runQualifyTurn, qualifySchema } = await import("../src/ai/leadQualifier.js");
const { pickNeutralReply, NEUTRAL_REPLIES } = await import("../src/messengers/replyChain.js");
const caps: SubmitReplyCapabilities = {
  showings: true, askOwner: true, vacancies: true, promptEconomy: true,
  canSendPhotos: true, canSendGuide: true, topicLock: false,
};
const valid = { reply: ["Здравствуйте!"], ready: false, confident: false };

describe("submit_reply boundary", () => {
  it("provider-declared fields and role/topic codes stay aligned with runtime validation", () => {
    const provider = qualifySchema(true, true, { ...caps, callback: false, links: true, cautious: false }, true);
    expect(Object.keys(provider.properties).sort()).toEqual(Object.keys(submitReplySchema({ ...caps, topicLock: true }).shape).sort());
    expect(SUBMIT_REPLY_ROLES).toEqual(WHO_IS_THIS);
    expect(SUBMIT_REPLY_TOPICS).toEqual(TOPIC_CODES);
  });
  it.each([null, [], "text", 12])("rejects non-object %j", (raw) => {
    expect(submitReplySchema(caps).safeParse(raw).success).toBe(false);
  });
  it.each([
    { ready: "false" }, { confident: "true" }, { sendGuide: "false" },
    { reply: [] }, { reply: [""] }, { reply: "   " }, { reply: ["ok", 42] },
    { lead: { budgetMax: "500000" } }, { lead: { budgetMax: -1 } },
    { lead: { budgetMax: Infinity } }, { lead: { budgetMax: NaN } },
    { lead: { budgetMax: 1e100 } }, { lead: { rooms: 2_147_483_648 } },
    { lead: { budgetMin: 200, budgetMax: 100 } },
    { lead: { type: "VILLA" } }, { lead: { rooms: 1.5 } },
    { intent: "delete" }, { whoIsThis: "ADMIN" },
    { showing: { action: "cancel", clientId: "another-client" } },
    { showing: { action: "book", propertyCode: "12" } },
    { showing: { action: "book", day: "2026-02-30" } },
    { showing: { action: "book", time: "25:90" } },
    { jobApplication: { phone: 992000000000 } }, { jobApplication: { hasCar: "false" } },
    { topicAnswer: { clientAnsweredOpenQuestion: true } },
  ])("rejects malformed nested data %j", (patch) => {
    expect(submitReplySchema(caps).safeParse({ ...valid, ...patch }).success).toBe(false);
  });
  it("preserves partial data, cancellation and string-reply compatibility", () => {
    expect(submitReplySchema(caps).parse({ ...valid, reply: "Хуб", showing: { action: "cancel" }, jobApplication: { hasCar: false } }))
      .toMatchObject({ reply: ["Хуб"], lead: null, showing: { action: "cancel" }, jobApplication: { hasCar: false } });
  });
  it.each(["showing", "askOwner", "jobApplication", "whoIsThis", "showPropertyNumber", "sendGuide"])("rejects disabled capability %s", (field) => {
    const disabled = Object.fromEntries(Object.keys(caps).map((k) => [k, false])) as unknown as SubmitReplyCapabilities;
    const values = { showing: { action: "cancel" }, askOwner: "question", jobApplication: {}, whoIsThis: "BUYER", showPropertyNumber: 12, sendGuide: true };
    expect(submitReplySchema(disabled).safeParse({ ...valid, [field]: values[field as keyof typeof values] }).success).toBe(false);
  });
  it("requires topic fields only with topic lock, and callback is independent of callback routing", () => {
    expect(submitReplySchema(caps).parse({ ...valid, callbackRequest: "Call tomorrow" }).callbackRequest).toBe("Call tomorrow");
    expect(submitReplySchema(caps).safeParse({ ...valid, topic: "price", openQuestion: "", clientAnsweredOpenQuestion: false }).success).toBe(false);
    expect(submitReplySchema({ ...caps, topicLock: true }).safeParse(valid).success).toBe(false);
    expect(submitReplySchema({ ...caps, topicLock: true }).safeParse({ ...valid, topic: "price", openQuestion: "", clientAnsweredOpenQuestion: false }).success).toBe(true);
  });
  it("runQualifyTurn rejects the whole object before guards/consumers, without leaking values to logs", async () => {
    callAi.mockResolvedValue({ ...valid, ready: "false", lead: { notes: "PRIVATE-NOTE" }, showing: { action: "cancel" } });
    logError.mockClear();
    const out = await runQualifyTurn([{ role: "user", content: "Здравствуйте" }], {}, {
      abilities: { ...caps, callback: false, links: true, cautious: false },
    });
    expect(out).toBeNull();
    expect(logError.mock.calls.flat().join(" ")).toContain("ready:invalid_type");
    expect(logError.mock.calls.flat().join(" ")).not.toContain("PRIVATE-NOTE");
  });
});

describe("honest fallback in the established language", () => {
  // Language/recovery obligations from the frozen golden200, not a full replay
  // of the business answer (which also requires facts/tools in later stages).
  it.each([
    { id: "Д005", text: "35-40кв. Типо кредит", language: "ru" as const },
    { id: "Д111", text: "5 мох", language: "tg" as const },
    { id: "Д146", text: "бисер 2 фоиз", language: "tg" as const },
  ])("golden $id: recovery preserves language and does not invent a receipt", async ({ text, language }) => {
    const reply = await pickNeutralReply({ language, clientTurnText: text, botSaidBefore: [], fallbackLanguageWords: [] });
    expect(Object.values(NEUTRAL_REPLIES).map((v) => v[language])).toContain(reply);
    expect(reply).not.toMatch(/записал|қайд кардам|позвон|рақам/i);
  });
  it.each(["ru", "tg"] as const)("keeps %s for punctuation/number/emoji and contradictory history", async (language) => {
    for (const clientTurnText of [".", "700", "👍"]) {
      const text = await pickNeutralReply({ language, clientTurnText, botSaidBefore: [], fallbackLanguageWords: [language === "ru" ? "Нархаш чанд?" : "Сколько стоит?"] });
      expect(Object.values(NEUTRAL_REPLIES).map((v) => v[language])).toContain(text);
      expect(text).not.toMatch(/записал|қайд кардам|позвон|рақам/i);
    }
  });
  it("unknown language still uses client history", async () => {
    expect(await pickNeutralReply({ language: "unknown", clientTurnText: ".", botSaidBefore: [], fallbackLanguageWords: ["Здравствуйте, сколько стоит?"] }))
      .toBe(NEUTRAL_REPLIES.presence.ru);
  });
});
