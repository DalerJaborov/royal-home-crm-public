import { describe, expect, it, vi } from "vitest";
import { runCustomerAgentTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { customerAffirmationFollowUp, customerBareAffirmation, customerCheaperRequested, customerCheaperSearchCall } from "../src/ai/customerAgentFollowUp.js";
import { customerAgentPublicListingSignature, customerAgentSearchFit } from "../src/ai/customerAgentPublicProtocol.js";

const hash = "a".repeat(64);
const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "820000", currency: "TJS" as const,
  availability: "AVAILABLE" as const, publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only" as const, builder: null,
  characteristics: { type: "APARTMENT" as const, rooms: 3, areaSqm: null, landAreaSotka: null, floor: null, totalFloors: null, condition: null, marketType: null, stage: null },
  publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: hash };

describe("cheaper-than-focus intent", () => {
  it.each(["Ин хело гарон аст барои нархи арзонтар лозим", "дорого, есть дешевле?", "Дороговато", "а подешевле нет?", "бюджет меньше", "Қимат аст", "нархаш баланд"])
    ("recognises: %s", text => expect(customerCheaperRequested(text)).toBe(true));
  it.each(["сколько стоит", "недорого ли это", "не дорого, беру", "Цена объекта?", "", "дорогу покажите"])
    ("ignores: %s", text => expect(customerCheaperRequested(text)).toBe(false));
  it("builds a bounded cheapest-first search below the focus price in its currency", () => {
    expect(customerCheaperSearchCall(facts)).toEqual({ name: "search_public_properties",
      args: { type: "APARTMENT", districtName: "Сино", budget: { max: "819999", currency: "TJS" }, sort: "cheap" } });
    expect(customerCheaperSearchCall({ ...facts, price: "820000.50", currency: "USD" })?.args.budget).toEqual({ max: "820000", currency: "USD" });
  });
  it("makes no search without a price, a sold object or any place/type", () => {
    expect(customerCheaperSearchCall({ ...facts, price: null })).toBeNull();
    expect(customerCheaperSearchCall({ ...facts, availability: "SOLD" })).toBeNull();
    expect(customerCheaperSearchCall({ ...facts, price: "1" })).toBeNull();
    expect(customerCheaperSearchCall({ ...facts, publicAddress: null, characteristics: undefined })).toBeNull();
    expect(customerCheaperSearchCall(null)).toBeNull();
  });
});

describe("bare affirmation after the bot's own question", () => {
  it.each(["Да", "да!", "Ҳа", "хуб", "ok 👍", "да, да", "Бале"])("is a bare yes: %s", text => expect(customerBareAffirmation(text)).toBe(true));
  it.each(["да, покажите цену", "нет", "Да 500", "ҳа бале мехоҳам ба ман занг занед", ""])("is not: %s", text => expect(customerBareAffirmation(text)).toBe(false));
  it("re-asks a free-worded 'which object' question with the standard object question", () => {
    expect(customerAffirmationFollowUp("О какой квартире вы хотите узнать подробнее?", false)).toBe("property");
    expect(customerAffirmationFollowUp("Дар бораи кадом хона маълумот мехоҳед?", false)).toBe("property");
    expect(customerAffirmationFollowUp("О какой квартире вы хотите узнать подробнее?", true)).toBeNull();
  });
  it("re-asks a fixed question in its repair wording, never a repair again and never a consent question", () => {
    expect(customerAffirmationFollowUp("Какой бюджет вы рассматриваете?", false)).toBe("clarify_previous");
    expect(customerAffirmationFollowUp("Я уточнял сумму для покупки. Какой у вас бюджет?", false)).toBeNull();
    expect(customerAffirmationFollowUp("Вы хотите, чтобы сотрудник вам позвонил?", false)).toBeNull();
    expect(customerAffirmationFollowUp("Подтверждаете?", false)).toBeNull();
    expect(customerAffirmationFollowUp("Хотите посмотреть фото?", false)).toBeNull();
    expect(customerAffirmationFollowUp(undefined, false)).toBeNull();
  });
});

function fixture(overrides: Partial<CustomerCoreFrame> = {}) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "Да", knownPhoneSource: "none", requestedFacts: [],
    revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
      providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
      limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
    startedAt: Date.now(), operation, tools: [{ name: "search_public_properties", description: "search" }], ...overrides };
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async () => ({ text: JSON.stringify({ kind: "reply", refs: [], social: "thank", question: "none" }), calls: [], modelParts: [] }));
  const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "denied", reason: "none" }));
  const ports: CustomerCorePorts = { modelTurn, executeAllowedTool, assertCurrent: async () => true,
    requestStop: reason => controller.abort(reason), observeLateToolResult: () => {} };
  return { frame, modelTurn, executeAllowedTool, ports };
}
const context = (assistant: string, topic = "buyer") => ({ surface: "dm" as const, revisionId: hash,
  turns: [{ role: "user" as const, text: "Здравствуйте" }, { role: "assistant" as const, text: assistant }],
  publicState: { language: "ru", topic, openQuestion: "none" } as never });

describe("core: follow-up and pre-reads", () => {
  it("answers a bare yes after a free 'which apartment?' question with the object question, no model round", async () => {
    const f = fixture({ followUp: "property", verifiedContext: context("О какой квартире вы хотите узнать подробнее?", "unknown") });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", rounds: 0, question: "property" });
    if (result.status === "ready") expect(result.text).toContain("Пришлите номер объекта или ссылку");
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("re-asks a fixed budget question in the separate 'я уточнял' wording, which the repeat guard lets through", async () => {
    const f = fixture({ followUp: "clarify_previous", verifiedContext: context("Какой бюджет вы рассматриваете?") });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", rounds: 0 });
    if (result.status === "ready") expect(result.text).toBe("Я уточнял сумму для покупки. Какой у вас бюджет?");
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("ignores the follow-up hint for a job inquiry", async () => {
    const f = fixture({ followUp: "property", verifiedContext: context("О какой квартире вы хотите узнать подробнее?", "job") });
    await runCustomerAgentTurn(f.frame, f.ports);
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
  });
  const args = { type: "APARTMENT" as const, districtName: "Сино", budget: { max: "819999", currency: "TJS" as const }, sort: "cheap" as const };
  const call = { name: "search_public_properties" as const, args };
  const search = (cards: unknown[]) => ({ status: "observed" as const, observation: { kind: "property_search" as const, query: args,
    coverage: "bounded_ranked_pool" as const, poolLimit: 500, policyHash: hash, cards: cards as never } });
  it("reads the cheaper entries before the model and puts them in its context", async () => {
    const cheaper = { ...facts, shortId: 124, price: "700000" };
    const data = { type: "APARTMENT" as const, rooms: 3, districtName: "Сино" };
    const listing = { ...data, signature: customerAgentPublicListingSignature(cheaper.signature, data) };
    const match = customerAgentSearchFit(args, listing, { cardTjs: 700000, minTjs: null, maxTjs: 819999 });
    const f = fixture({ inputText: "Дорого, есть дешевле?", preReads: [call], verifiedContext: context("Объект №123, 820 000 сомони.") });
    f.executeAllowedTool.mockResolvedValue(search([{ facts: cheaper, listing, match }]));
    f.modelTurn.mockResolvedValue({ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "none", question: "none" }), calls: [], modelParts: [] });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(f.executeAllowedTool).toHaveBeenCalledWith(call, expect.anything());
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.modelTurn.mock.calls[0][0].contents)).toContain("serverObservation");
    expect(result).toMatchObject({ status: "ready" });
    if (result.status === "ready") expect(result.text).toContain("700 000");
  });
  it("says honestly nothing cheaper exists and asks the single budget question, without a model round", async () => {
    const f = fixture({ inputText: "Дорого, есть дешевле?", preReads: [call], verifiedContext: context("Объект №123, 820 000 сомони.") });
    f.executeAllowedTool.mockResolvedValue(search([]));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", rounds: 0, question: "budget" });
    if (result.status === "ready") expect(result.text).toBe("Вариантов дешевле сейчас не нашлось.\nКакой бюджет вы рассматриваете?");
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("never presents the dearer tolerance fillers of a cheaper search as cheaper: only over-budget cards means nothing cheaper", async () => {
    const dearer = { ...facts, propertyId: "00000000-0000-4000-8000-000000000002", shortId: 125, price: "830000" };
    const data = { type: "APARTMENT" as const, rooms: 3, districtName: "Сино" };
    const listing = { ...data, signature: customerAgentPublicListingSignature(dearer.signature, data) };
    const match = customerAgentSearchFit(args, listing, { cardTjs: 830000, minTjs: null, maxTjs: 819999 });
    expect(match.notes).toContain("over_budget");
    const f = fixture({ inputText: "Дорого", preReads: [call], verifiedContext: context("Объект №123.") });
    f.executeAllowedTool.mockResolvedValue(search([{ facts: dearer, listing, match }]));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(f.modelTurn).not.toHaveBeenCalled();
    if (result.status !== "ready") throw new Error("expected a ready reply " + JSON.stringify(result).slice(0, 400));
    expect(result.text).toBe("Вариантов дешевле сейчас не нашлось.\nКакой бюджет вы рассматриваете?");
    expect(result.text).not.toContain("830");
  });
  it("shows only the genuinely cheaper cards when the pool mixes them with over-budget fillers", async () => {
    const cheaper = { ...facts, shortId: 124, price: "700000" }, dearer = { ...facts, propertyId: "00000000-0000-4000-8000-000000000002", shortId: 125, price: "830000" };
    const data = { type: "APARTMENT" as const, rooms: 3, districtName: "Сино" };
    const card = (value: typeof facts, price: number) => { const listing = { ...data, signature: customerAgentPublicListingSignature(value.signature, data) };
      return { facts: value, listing, match: customerAgentSearchFit(args, listing, { cardTjs: price, minTjs: null, maxTjs: 819999 }) }; };
    const f = fixture({ inputText: "Дорого", preReads: [call], verifiedContext: context("Объект №123.") });
    f.executeAllowedTool.mockResolvedValue(search([card(cheaper, 700000), card(dearer, 830000)]));
    f.modelTurn.mockResolvedValue({ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "none", question: "none" }), calls: [], modelParts: [] });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    if (result.status !== "ready") throw new Error("expected a ready reply " + JSON.stringify(result).slice(0, 400));
    expect(result.text).toContain("700 000"); expect(result.text).not.toContain("830 000");
  });
  it("falls through to the model when the read is refused", async () => {
    const f = fixture({ inputText: "Дорого", preReads: [call], verifiedContext: context("Объект №123.") });
    await runCustomerAgentTurn(f.frame, f.ports);
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
  });
});
