import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedCustomerQualifierContext } from "../src/ai/customerPromptMemory.js";
import type { ContactProfileForPrompt } from "../src/ai/contactProfileBlock.js";
const db = vi.hoisted(() => ({
  settings: { findUnique: vi.fn(async () => null) }, $disconnect: vi.fn(),
  street: { findMany: vi.fn(async () => []) }, landmark: { findMany: vi.fn(async () => []) },
  district: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => ({ id: "synthetic-district" })) }, microdistrict: { findMany: vi.fn(async () => []) },
  livingArea: { findMany: vi.fn(async () => []) }, geoAlias: { findMany: vi.fn(async () => []) },
  styleExample: { findMany: vi.fn(async () => []) }, botLesson: { findMany: vi.fn(async () => []) }, guardHit: { upsert: vi.fn() },
  property: { findMany: vi.fn(async () => []) },
  jobApplication: { findUnique: vi.fn(async () => ({ age: 32, studyingNow: false, employedNow: false, phone: "SYNTHETIC_OLD_PHONE" })) },
}));
const fake = vi.hoisted(() => ({ callAi: vi.fn(), fetch: vi.fn(async () => { throw Error("External fetch forbidden"); }) }));
// Keep the module's exports while replacing every DB operation used here.
// loadEnv has no exports; its side effect stays disabled to avoid credentials.
vi.mock("../src/db.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/db.js")>(), prisma: db,
}));
vi.mock("../src/loadEnv.js", () => ({}));
vi.mock("../src/lib/recruitmentPositions.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/recruitmentPositions.js")>(),
  readCustomerOpenVacancies: async () => {
    const { recruitmentCatalogHash } = await import("../src/ai/customerAgentRecruitmentProtocol.js");
    const { recruitmentPositionTemplates } = await import("../src/lib/recruitmentPositionTemplates.js");
    const facts = { collecting: true, positions: recruitmentPositionTemplates().filter(row => row.key === "real-estate-agent")
      .map(row => ({ ...row, revision: 1, isOpen: true })) };
    return { kind: "open_vacancies", ...facts, sourceHash: recruitmentCatalogHash(facts) };
  },
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: fake.callAi }));
import { runQualifyTurn } from "../src/ai/leadQualifier.js";
const abilities = { showings: true, askOwner: true, vacancies: true, promptEconomy: true, callback: false, links: true, cautious: false };
const valid = { reply: ["Могу помочь с вашим вопросом."], ready: false, confident: true };
const profile: ContactProfileForPrompt = { category: "VENDOR", previousCategories: [], selfName: "PRIVATE_NAME", language: "ru",
  history: "PRIVATE_HISTORY", buyer: ["PRIVATE_BUYER"], seller: ["PRIVATE_SELLER"], job: ["PRIVATE_JOB"], crm: "PRIVATE_CRM" };
function context(knownPhoneSource: ScopedCustomerQualifierContext["knownPhoneSource"] = "none"): ScopedCustomerQualifierContext {
  return { mode: "scoped_customer", history: [{ role: "user", content: "Здравствуйте, нужна помощь" }], draft: { stage: "chatting" }, knownPhoneSource };
}
beforeEach(() => {
  vi.clearAllMocks(); fake.callAi.mockResolvedValue(valid); vi.stubGlobal("fetch", fake.fetch);
  db.property.findMany.mockResolvedValue([]); db.styleExample.findMany.mockResolvedValue([]); db.botLesson.findMany.mockResolvedValue([]);
});
afterEach(() => { expect(fake.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
function captured() {
  expect(fake.callAi).toHaveBeenCalledTimes(1);
  return fake.callAi.mock.calls[0][0] as { system: string; systemStable: string; messages: unknown; schema: { properties: Record<string, unknown> } };
}
describe("actual qualifier scoped customer invocation", () => {
  it("uses only scoped messages/draft and does not infer role or print any global profile fact", async () => {
    const result = await runQualifyTurn([{ role: "user", content: "PRIVATE_MESSAGE" }],
      { stage: "done", whoIsThis: "VENDOR", notes: "PRIVATE_DRAFT" },
      { abilities, contactProfile: profile, phoneKnown: true, customerContext: context() });
    expect(result?.reply).toEqual(valid.reply); const input = captured();
    expect(JSON.stringify(input)).not.toContain("PRIVATE_");
    expect(input.system).not.toContain("Телефон клиента У НАС УЖЕ ЕСТЬ");
    expect(input.schema.properties).toHaveProperty("showing");
    expect(JSON.stringify(input.messages)).toContain("Здравствуйте, нужна помощь");
    expect(db.jobApplication.findUnique).not.toHaveBeenCalled();
  });
  it.each(["current_input", "scoped_contact"] as const)("retains no-reask UX for %s without raw contact or a permission grant", async source => {
    expect((await runQualifyTurn([], { stage: "done" }, { abilities, customerContext: context(source) }))?.reply).toEqual(valid.reply);
    const input = captured(); expect(input.system).toContain("Телефон клиента У НАС УЖЕ ЕСТЬ");
    expect(JSON.stringify(input)).not.toContain("SYNTHETIC_OLD_PHONE");
  });
  it("does not import an old JobApplication into a scoped job turn", async () => {
    const input = context(); const result = await runQualifyTurn([], { stage: "done" }, {
      abilities, conversationId: "synthetic-conversation", customerContext: { ...input, draft: { stage: "chatting", intent: "job" } },
    });
    expect(result?.reply).toEqual(valid.reply); expect(db.jobApplication.findUnique).not.toHaveBeenCalled();
    expect(captured().system).toContain("возраст");
  });
  it("does not contradict a current scoped phone flag in the job missing-facts list", async () => {
    expect((await runQualifyTurn([], { stage: "done" }, {
      abilities, conversationId: "synthetic-conversation", customerContext: { ...context("current_input"),
        history: [{ role: "user", content: "Хочу стать агентом по недвижимости" }], draft: { stage: "chatting", intent: "job" } },
    }))?.reply).toEqual(valid.reply);
    expect(db.jobApplication.findUnique).not.toHaveBeenCalled();
    const missing = captured().system.match(/ЕЩЁ НЕ ВЫЯСНЕНО \(посчитано кодом\): ([^.]+)\./u)?.[1];
    expect(missing).toBe("возраст, учёба сейчас, работа сейчас");
  });
  it("preserves legacy profile role inference and printed memory when the new context is absent", async () => {
    expect((await runQualifyTurn([{ role: "user", content: "Здравствуйте" }], { stage: "chatting" }, { abilities, contactProfile: profile, phoneKnown: true }))?.reply).toEqual(valid.reply);
    const input = captured(); expect(input.system).toContain("PRIVATE_HISTORY");
    expect(input.system).toContain("Телефон клиента У НАС УЖЕ ЕСТЬ"); expect(input.schema.properties).not.toHaveProperty("showing");
  });
  it("preserves the legacy job lookup for existing callers", async () => {
    const result = await runQualifyTurn([{ role: "user", content: "Ищу работу" }], { stage: "chatting", intent: "job" }, { abilities, conversationId: "synthetic-conversation" });
    expect(result?.reply).toEqual(valid.reply); captured();
    expect(db.jobApplication.findUnique).toHaveBeenCalledWith({ where: { conversationId: "synthetic-conversation" }, select: { age: true, studyingNow: true, employedNow: true, phone: true } });
  });
  it("keeps current price/address IN and public catalog facts, without exact owner locations or global examples", async () => {
    const property = { id: "synthetic-property", shortId: 71, type: "APARTMENT", rooms: 2, floor: 3, totalFloors: 9,
      price: "410000", currency: "TJS", areaSqm: "54", district: { id: "synthetic-district", name: "Сино" },
      districtId: "synthetic-district", status: "AVAILABLE", deletedAt: null, offSite: false, publishedOnSite: true,
      siteListingId: null, instagramUrl: null, publishedChannels: [], address: "PRIVATE_OWNER_HOUSE_77_APT_9",
      landmark: "PRIVATE_OWNER_LANDMARK", title: "PRIVATE_OWNER_TITLE", ownerPhone: "PRIVATE_OWNER_PHONE", notes: "PRIVATE_OWNER_NOTES",
      details: {}, lat: null, lng: null, createdAt: new Date() };
    db.property.findMany.mockResolvedValue([property] as never);
    db.styleExample.findMany.mockResolvedValue([{ clientText: "PRIVATE_STYLE_NAME", agentText: "PRIVATE_STYLE_ADDRESS", source: "manual" }] as never);
    db.botLesson.findMany.mockResolvedValue([{ lesson: "PRIVATE_LEARNED_ADDRESS", channel: "INSTAGRAM" }] as never);
    const input = context();
    const result = await runQualifyTurn([{ role: "user", content: "PRIVATE_OLD_MESSAGE" }], { stage: "done" }, {
      abilities, channel: "WEBSITE", customerContext: { ...input, history: [{ role: "user", content: "Какая цена и где находится квартира в Сино? Я смотрю дом CURRENT_INPUT_HOUSE_17." }],
        draft: { stage: "chatting", intent: "buy", districtName: "Сино", type: "APARTMENT" } },
    });
    expect(result?.reply).toEqual(valid.reply); const prompt = captured();
    expect(JSON.stringify(prompt)).not.toContain("PRIVATE_");
    expect(prompt.system).toContain("Сино"); expect(prompt.system).toMatch(/410\s?000/u);
    expect(JSON.stringify(prompt.messages)).toContain("Какая цена и где находится квартира в Сино?");
    expect(JSON.stringify(prompt.messages)).toContain("CURRENT_INPUT_HOUSE_17");
    expect(db.property.findMany).toHaveBeenCalled();
    for (const [query] of db.property.findMany.mock.calls as unknown as [{ where: { status?: string } }][]) expect(query.where.status).toBe("AVAILABLE");
    expect(db.styleExample.findMany).not.toHaveBeenCalled(); expect(db.botLesson.findMany).not.toHaveBeenCalled();
    // The same synthetic card still renders as before for a legacy invocation.
    fake.callAi.mockClear(); db.property.findMany.mockClear();
    expect((await runQualifyTurn([{ role: "user", content: "Квартира в Сино" }],
      { stage: "chatting", intent: "buy", districtName: "Сино", type: "APARTMENT" }, { abilities, channel: "WEBSITE" }))?.reply).toEqual(valid.reply);
    const legacy = captured(); expect(legacy.system).toContain("PRIVATE_OWNER_HOUSE_77_APT_9");
    expect(legacy.system).toContain("PRIVATE_OWNER_LANDMARK"); expect(legacy.systemStable).toContain("PRIVATE_OWNER_HOUSE_77_APT_9");
    expect(db.styleExample.findMany).toHaveBeenCalled(); expect(db.botLesson.findMany).toHaveBeenCalled();
  });
});
