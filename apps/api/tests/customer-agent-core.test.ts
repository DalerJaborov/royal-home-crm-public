import { afterEach, describe, expect, it, vi } from "vitest";
import { customerAgentDecisionSchema, customerAgentToolCallSchema } from "@royal-home/shared";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { PUBLIC_AGENCY_CONTACT } from "../src/lib/publicAgencyContact.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash, customerAgentPublicListingSignature, customerAgentSearchFit } from "../src/ai/customerAgentPublicProtocol.js";

const hash = "a".repeat(64);
const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "123456.78", currency: "TJS" as const,
  availability: "AVAILABLE" as const, publicAddress: "Synthetic district, Душанбе", addressPolicy: "district_city_only" as const,
  builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: hash };
const final = (change = {}): CustomerAgentModelTurn => ({ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", ...change }), calls: [], modelParts: [] });
const toolTurn = (calls: CustomerAgentModelTurn["calls"]): CustomerAgentModelTurn => ({ text: "", calls,
  modelParts: calls.map(call => ({ functionCall: call })) });
function fixture(overrides: Partial<CustomerCoreFrame> = {}) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "Цена объекта 123?", knownPhoneSource: "none", requestedFacts: ["price"],
    revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
      providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
      limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
    startedAt: Date.now(), operation, tools: [{ name: "get_property_facts", description: "Read public facts" }], ...overrides };
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async () => final());
  const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "observed", observation: { kind: "facts", facts, kinds: ["price"] } }));
  const assertCurrent = vi.fn<CustomerCorePorts["assertCurrent"]>(async () => true);
  const requestStop = vi.fn<CustomerCorePorts["requestStop"]>(reason => controller.abort(reason));
  const observeLateToolResult = vi.fn<CustomerCorePorts["observeLateToolResult"]>();
  return { frame, controller, operation, modelTurn, executeAllowedTool, assertCurrent,
    requestStop, observeLateToolResult, ports: { modelTurn, executeAllowedTool, assertCurrent, requestStop, observeLateToolResult } satisfies CustomerCorePorts };
}
afterEach(() => vi.useRealTimers());
it("preloads verified availability through the declared read before one model decision", async () => {
  const f = fixture({ inputText: "Салом хона Холо хам хаст", language: "tg", requestedFacts: ["availability"] });
  f.executeAllowedTool.mockResolvedValue({ status: "observed", observation: { kind: "facts", facts, kinds: ["availability"] } });
  expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "ready", text: "Бале, объекти №123 ҳоло дастрас аст.", rounds: 1, toolCalls: 1 });
  expect(f.executeAllowedTool).toHaveBeenCalledWith({ name: "get_property_facts", args: { kinds: ["availability"] } }, expect.anything());
  expect(f.modelTurn).toHaveBeenCalledTimes(1);
});
it("reuses a prefetched vacancy ref when the model reads the same current catalog again", async () => {
  const value = { collecting: true, positions: [] };
  const f = fixture({ inputText: "Есть вакансии?", requestedFacts: [], tools: [{ name: "get_open_vacancies", description: "Current jobs" }] });
  f.executeAllowedTool.mockResolvedValue({ status: "observed", observation: { kind: "open_vacancies", ...value, sourceHash: recruitmentCatalogHash(value) } });
  f.modelTurn.mockResolvedValueOnce({ text: "", calls: [{ name: "get_open_vacancies", args: {}, id: "model-read" }],
    modelParts: [{ functionCall: { name: "get_open_vacancies", args: {}, id: "model-read" } }] }).mockResolvedValueOnce(final({ refs: ["e0"] }));
  const result = await runCustomerAgentTurn(f.frame, f.ports);
  expect(result).toMatchObject({ status: "ready", text: "Сейчас открытых вакансий нет." });
  expect(result.evidence).toHaveLength(1);
  expect(f.executeAllowedTool).toHaveBeenCalledTimes(2);
});
it.each(['безеб','Ика бардакай','Кимат','Беҳтарин хона бдай 👏👏'])('handles a standalone public reaction without paid model/tool calls: %s',async inputText=>{
 const f=fixture({surface:'public_comment',inputText,requestedFacts:[],language:'tg'});
 const result=await runCustomerAgentTurn(f.frame,f.ports);
 expect(result).toMatchObject({status:'ready',rounds:0,toolCalls:0});
 if(result.status!=='ready')throw Error('Expected a public reaction');
 expect(result.text).not.toMatch(/123|992|сохтмон|телефон/u);
 expect(f.modelTurn).not.toHaveBeenCalled();expect(f.executeAllowedTool).not.toHaveBeenCalled();
});

describe("Perceived media stays in the common customer brain", () => {
  const visual = { language: "ru" as const, transcript: "", subject: "home_interior" as const, visible: ["kitchen" as const], readableText: "", speech: "none" as const };
  it("uses real perceived content rather than the metadata-only clarification", async () => {
    const f = fixture({ inputText: "", requestedFacts: [], attachmentInput: { kinds: ["image"] }, mediaPerception: visual });
    f.modelTurn.mockResolvedValue(final({ question: "role" }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", rounds: 1 });
    if (result.status !== "ready") throw Error("Expected media response");
    expect(result.text).toContain("кухня"); expect(result.text).not.toContain("недоступно");
    expect(JSON.stringify(f.modelTurn.mock.calls[0][0].contents)).toContain("untrustedCustomerMedia");
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it.each(["ru", "tg"] as const)("asks for a new recording only after actual %s speech was unintelligible", async language => {
    const f = fixture({ inputText: "", language, requestedFacts: [], mediaPerception: { ...visual, language, subject: "not_visible", visible: [], speech: "unintelligible" } });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", rounds: 0 });
    if (result.status !== "ready") throw Error("Expected honest media repair");
    expect(result.text).toContain(language === "ru" ? "голосовое ещё раз" : "овозиро бори дигар");
    expect(result.text).not.toMatch(/текстом|сотрудник|передал|992/iu);
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("does not broaden an unqualified public surface", async () => {
    const f = fixture({ surface: "public_comment", inputText: "", requestedFacts: [], mediaPerception: visual });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "media_surface_unqualified" });
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("retains the original human/ownership fence after perception", async () => {
    const f = fixture({ inputText: "", requestedFacts: [], mediaPerception: visual }); f.assertCurrent.mockResolvedValue(false);
    expect((await runCustomerAgentTurn(f.frame, f.ports)).status).toBe("held"); expect(f.modelTurn).not.toHaveBeenCalled();
  });
});

describe("Customer attachment-only turns", () => {
  it.each(["image", "audio", "video", "document", "share", "unknown"] as const)("answers a genuine %s without inventing its contents or a handover", async kind => {
    const f = fixture({ inputText: "", requestedFacts: [] });
    const result = await runCustomerAgentTurn({ ...f.frame, attachmentInput: { kinds: [kind] } }, f.ports);
    expect(result).toMatchObject({ status: "ready", question: "clarify_previous", rounds: 0, toolCalls: 0 });
    if (result.status !== "ready") throw Error("Attachment should get a normal clarification");
    expect(result.text).toContain("?");
    expect(result.text).not.toMatch(/992|сотрудник|передал|записал|увидел|вижу|прослушал|ссылка не открылась/iu);
    expect(f.modelTurn).not.toHaveBeenCalled(); expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("uses actual property facts for an attachment reference and still checks freshness", async () => {
    const f = fixture({ inputText: "", requestedFacts: ["price"] });
    const result = await runCustomerAgentTurn({ ...f.frame, attachmentInput: { kinds: ["share"] } }, f.ports);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw Error("Expected referenced property facts");
    expect(result.text).toContain("123 456.78"); expect(result.text).not.toContain("Какой объект");
    expect(f.modelTurn).not.toHaveBeenCalled(); expect(f.executeAllowedTool).toHaveBeenCalledTimes(1);
    const stale = fixture({ inputText: "", requestedFacts: [] }); stale.assertCurrent.mockResolvedValue(false);
    expect(await runCustomerAgentTurn({ ...stale.frame, attachmentInput: { kinds: ["image"] } }, stale.ports)).toMatchObject({ status: "held" });
  });
  it("does not turn a bare empty or public turn into an attachment claim", async () => {
    const empty = fixture({ inputText: "", requestedFacts: [] });
    expect(await runCustomerAgentTurn(empty.frame, empty.ports)).toMatchObject({ status: "held", reason: "input_limit" });
    const publicTurn = fixture({ surface: "public_comment", inputText: "", requestedFacts: [] });
    expect(await runCustomerAgentTurn({ ...publicTurn.frame, attachmentInput: { kinds: ["image"] } }, publicTurn.ports)).toMatchObject({ status: "held" });
  });
  it("keeps the actual caption as current input, exposing only finite metadata rather than pretending to see a file", async () => {
    const f = fixture({ inputText: "Сколько стоит эта квартира?", requestedFacts: [] });
    f.modelTurn.mockResolvedValue(final({ question: "property" }));
    const result = await runCustomerAgentTurn({ ...f.frame, attachmentInput: { kinds: ["image"] } }, f.ports);
    expect(result.status).toBe("ready");
    const parts = f.modelTurn.mock.calls[0][0].contents.at(-1)!.parts;
    expect(parts[0]).toEqual({ text: "Сколько стоит эта квартира?" });
    expect(parts[1]).toEqual({ text: JSON.stringify({ incomingAttachmentMetadata: { kinds: ["image"] }, contentAvailable: false }) });
    expect(JSON.stringify(parts)).not.toContain("inlineData");
  });
});

describe("Bounded correction of model tool arguments", () => {
  const invalid = { name: "get_property_facts", args: { kinds: ["price"], propertyId: facts.propertyId }, id: "invalid-1" };
  it("lets the same model correct a rejected public read before producing a verified answer", async () => {
    const f = fixture({ requestedFacts: [], inputText: "Что можно узнать об этом варианте?" });
    f.modelTurn.mockResolvedValueOnce(toolTurn([invalid]))
      .mockResolvedValueOnce(toolTurn([{ name: "get_property_facts", args: { kinds: ["price"] }, id: "valid-2" }]))
      .mockResolvedValueOnce(final({ refs: ["e0"] }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", rounds: 3, toolCalls: 2 });
    if (result.status !== "ready") throw Error("Expected corrected public read");
    expect(result.text).toContain("123 456.78");
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1);
    expect(f.modelTurn.mock.calls[1][0].contents.at(-1)).toEqual({ role: "user", parts: [
      { functionResponse: { name: invalid.name, id: invalid.id, response: { result: { status: "invalid_arguments" } } } },
    ] });
  });
  it("does not execute any part of an invalid batch, including an otherwise valid write", async () => {
    const f = fixture({ requestedFacts: [], tools: [{ name: "request_callback", description: "Callback" }, ...fixture().frame.tools] });
    f.modelTurn.mockResolvedValueOnce(toolTurn([{ name: "request_callback", args: { topic: "Позвоните" }, id: "write-1" }, invalid]))
      .mockResolvedValueOnce(final({ kind: "clarify", question: "property" }));
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "ready", rounds: 2, toolCalls: 2 });
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
    expect(JSON.stringify(f.modelTurn.mock.calls[1][0].contents.at(-1))).toContain("batch_not_executed");
  });
  it("counts rejected calls and terminates repeated invalid arguments at the original round bound", async () => {
    const f = fixture({ requestedFacts: [] });
    f.modelTurn.mockResolvedValue(toolTurn([invalid]));
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "round_limit", rounds: 3, toolCalls: 3 });
    expect(f.modelTurn).toHaveBeenCalledTimes(3); expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("does not repair unknown or disallowed tool names", async () => {
    const f = fixture({ requestedFacts: [] });
    f.modelTurn.mockResolvedValueOnce(toolTurn([{ name: "delete_client", args: {}, id: "unknown-1" }]))
      .mockResolvedValueOnce(final({ kind: "clarify", question: "property" }));
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "unavailable_tool", rounds: 1, toolCalls: 0 });
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
  });
  it("does not offer a registered tool missing from this turn's allowed declarations", async () => {
    const f = fixture({ requestedFacts: [] });
    f.modelTurn.mockResolvedValue(toolTurn([{ name: "get_agency_contact", args: {}, id: "unavailable-1" }]));
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "unavailable_tool" });
    expect(f.modelTurn).toHaveBeenCalledTimes(1); expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("does not let corrected calls escape the original call budget", async () => {
    const f = fixture({ requestedFacts: [] });
    f.frame = { ...f.frame, revision: { ...f.frame.revision, limits: { ...f.frame.revision.limits, maxToolCalls: 1 } } };
    f.modelTurn.mockResolvedValueOnce(toolTurn([invalid]))
      .mockResolvedValueOnce(toolTurn([{ name: "get_property_facts", args: { kinds: ["price"] }, id: "valid-2" }]));
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "tool_limit", toolCalls: 1 });
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("does not allow a rejected call ID to be reused with different arguments", async () => {
    const f = fixture({ requestedFacts: [] });
    f.modelTurn.mockResolvedValueOnce(toolTurn([invalid]))
      .mockResolvedValueOnce(toolTurn([{ ...invalid, args: { kinds: ["price"] } }]));
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "call_id_reused" });
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("stops before executing a corrected call if original ownership changes", async () => {
    const f = fixture({ requestedFacts: [] });
    f.assertCurrent.mockImplementation(async () => f.modelTurn.mock.calls.length < 2);
    f.modelTurn.mockResolvedValueOnce(toolTurn([invalid]))
      .mockResolvedValueOnce(toolTurn([{ name: "get_property_facts", args: { kinds: ["price"] }, id: "valid-2" }]));
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held" });
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
});

describe("Customer comments: appreciation is not a request for a phone", () => {
  it.each(["👍👍👍👍👍👍👍🔥🔥🔥🔥🔥🔥🔥", "🔥🔥👏", "Спасибо!", "Очень красиво 🤍", "Раҳмат ❤️", "Бисёр зебо!", "Офарин 👏"])("thanks for %s without a model/tool call", async inputText => {
    const f = fixture({ surface: "public_comment", inputText, requestedFacts: [] });
    // Reproduce both observed failures: an irrelevant contact CTA and a skip.
    f.modelTurn.mockResolvedValue({ text: '{"kind":"skip","reason":"no_reply_needed"}', calls: [], modelParts: [] });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", decision: { kind: "reply", social: "thank", question: "none", refs: [] } });
    if (result.status !== "ready") throw Error("Expected a thank-you");
    expect(result.text).toMatch(/Спасибо|Рады|Благодарим|Ташаккур|Раҳмат/u);
    expect(result.text).not.toMatch(/992|телефон|позвон|Понял|Фаҳмидам|рақам/iu);
    expect(f.modelTurn).not.toHaveBeenCalled(); expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it.each(["🔥 Какая цена?", "Спасибо, но мне не позвонили", "👍 номер телефона?", "🔥?", "😡", "🤮", "💩🔥", "🤡", "💔", "💰", "☎️", "https://spam.invalid 🔥", "красиво, но обман", "не спасибо"])("does not mistake %s for pure appreciation", async inputText => {
    const f = fixture({ surface: "public_comment", inputText, requestedFacts: [] });
    f.modelTurn.mockResolvedValue(final({ social: "acknowledge" }));
    await runCustomerAgentTurn(f.frame, f.ports);
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
  });
  it("retains the ownership/deadline fence for a free social reply", async () => {
    const f = fixture({ surface: "public_comment", inputText: "🔥🔥👏", requestedFacts: [] });
    f.assertCurrent.mockResolvedValue(false);
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held" });
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("does not short-circuit a private message or a requested fact", async () => {
    for (const override of [{ surface: "dm" as const, requestedFacts: [] }, { surface: "public_comment" as const, requestedFacts: ["price" as const] }]) {
      const f = fixture({ inputText: "🔥🔥👏", ...override });
      f.modelTurn.mockResolvedValue(final({ social: "thank" }));
      await runCustomerAgentTurn(f.frame, f.ports); expect(f.modelTurn).toHaveBeenCalledTimes(1);
    }
  });
});
describe("CustomerAgentCore private canonical public-read extension", () => {
  it.each(["ru", "tg"] as const)("malformed public final in %s preserves verified facts without another model call or staff transfer", async language => {
    const f = fixture({ surface: "public_comment", language });
    f.modelTurn.mockResolvedValue({ text: '{"wrong":"Цена 9 сомони, сотрудник уже позвонил"}', calls: [], modelParts: [] });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", fallbackReason: "invalid_model_decision", decision: { kind: "reply", refs: ["e0"] } });
    if(result.status !== "ready") throw Error("Expected verified public fallback");
    expect(result.text).toContain("123 456.78"); expect(result.text).not.toMatch(/9 сомони|сотрудник|позвонил|передал/iu);
    expect(f.modelTurn).toHaveBeenCalledTimes(1); expect(f.executeAllowedTool.mock.calls.map(([c])=>c.name)).toEqual(["get_property_facts"]);
  });
  it("malformed public final without useful evidence stays held and stale facts cannot be sent", async () => {
    const f=fixture({surface:"public_comment",requestedFacts:[]});
    f.modelTurn.mockResolvedValue({text:"Неверный ответ",calls:[],modelParts:[]});
    expect(await runCustomerAgentTurn(f.frame,f.ports)).toMatchObject({status:"held",reason:"invalid_model_decision"});
    const stale=fixture({surface:"public_comment"});
    stale.modelTurn.mockImplementation(async()=>{stale.assertCurrent.mockResolvedValue(false);return {text:"Неверный ответ",calls:[],modelParts:[]};});
    expect(await runCustomerAgentTurn(stale.frame,stale.ports)).toMatchObject({status:"held"});
  });
  it.each(["commission", "rental", "payment", "negotiation"] as const)("%s is a useful actual-source answer without mutation or a phone request", async topic => {
    const knowledge = readCustomerAgentCompanyKnowledge();
    const f = fixture({ requestedFacts: [], tools: [{ name: "get_company_policy", description: "Read approved public company policy" }] });
    const frame = { ...f.frame, revision: { ...f.frame.revision, knowledgeSourceHash: customerAgentCompanyKnowledgeHash(knowledge) } };
    f.modelTurn.mockResolvedValueOnce({ text: "", calls: [{ name: "get_company_policy", args: { topic }, id: "policy-1" }],
      modelParts: [{ functionCall: { name: "get_company_policy", args: { topic }, id: "policy-1" } }] })
      .mockResolvedValueOnce(final({ refs: ["e0"], question: topic === "commission" ? "role" : "none" }));
    f.executeAllowedTool.mockResolvedValue({ status: "observed", observation: { kind: "company_policy", topic, knowledge, sourceHash: frame.revision.knowledgeSourceHash } });
    const result = await runCustomerAgentTurn(frame, f.ports);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected useful approved company answer");
    expect(result.text.length).toBeGreaterThan(20);
    expect(f.executeAllowedTool.mock.calls.map(([call]) => call.name)).toEqual(["get_company_policy"]);
    expect(result.text).not.toMatch(/номер телефона|запрос создан|позвонят|собственник согласился/iu);
  });
  it("search returns public candidates, honest relaxed status and matching call IDs without granting focus/action", async () => {
    const f = fixture({ requestedFacts: [], tools: [{ name: "search_public_properties", description: "Read possible published offers" }] });
    const args = { type: "APARTMENT" as const, rooms: 2, budget: { max: "100000", currency: "TJS" as const } };
    const data = { type: "APARTMENT" as const, rooms: 3, districtName: "Synthetic district" };
    const listing = { ...data, signature: customerAgentPublicListingSignature(facts.signature, data) };
    const match = customerAgentSearchFit(args, listing, { cardTjs: 123456.78, minTjs: null, maxTjs: 100000 });
    f.executeAllowedTool.mockResolvedValue({ status: "observed", observation: { kind: "property_search", query: args,
      coverage: "bounded_ranked_pool", poolLimit: 500, policyHash: hash, cards: [{ facts, listing, match }] } });
    f.modelTurn.mockResolvedValueOnce({ text: "", calls: [{ name: "search_public_properties", args, id: "search-1" }],
      modelParts: [{ functionCall: { name: "search_public_properties", args, id: "search-1" } }] })
      .mockResolvedValueOnce(final({ refs: ["e0"] }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected useful search reply");
    expect(result.text).toContain("123 456.78 сомони"); expect(result.text).toContain("выше названного бюджета");
    expect(result.text).toContain("комнат больше"); expect(f.executeAllowedTool).toHaveBeenCalledTimes(1);
    const modelContext = JSON.stringify(f.modelTurn.mock.calls[1][0].contents);
    expect(modelContext).toContain('"id":"search-1"'); expect(modelContext).not.toContain(facts.propertyId);
    expect(modelContext).not.toContain(facts.signature); expect(modelContext).not.toContain('"policyHash"');
  });
  it.each(["topic", "role", "clarify_previous"] as const)("%s is one bounded useful question without a fake receipt", async question => {
    const f = fixture({ requestedFacts: [] }); f.modelTurn.mockResolvedValue(final({ question }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected useful clarification");
    expect(result.text.match(/[?？]/gu)).toHaveLength(1); expect(f.executeAllowedTool).not.toHaveBeenCalled();
    expect(result.text).not.toMatch(/создан|сохранён|согласился|позвонят/iu);
  });
});
describe("CustomerAgentCore draft positive obligations", () => {
  it.each(["dm", "voice"] as const)("%s actual loop reads before model and preserves useful exact decimal price", async surface => {
    const f = fixture({ surface });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected useful response");
    expect(result.text).toContain("123 456.78 сомони");
    expect(result.text).not.toContain("телефон");
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1);
    expect(f.executeAllowedTool.mock.invocationCallOrder[0]).toBeLessThan(f.modelTurn.mock.invocationCallOrder[0]);
    const request = JSON.stringify(f.modelTurn.mock.calls[0][0]);
    expect(request).not.toContain(facts.propertyId); expect(request).not.toContain('"signature"');
    expect(f.modelTurn.mock.calls[0][0].operation).toBe(f.operation);
  });
  it("TG structured facts survive and one useful question follows", async () => {
    const f = fixture({ language: "tg" });
    f.modelTurn.mockResolvedValue(final({ question: "rooms", social: "acknowledge" }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected TG response");
    expect(result.text).toContain("сомонӣ"); expect(result.text).toContain("чанд ҳуҷра");
    expect(result.text.match(/[?？]/gu)).toHaveLength(1);
  });
  it("preserves original model parts/signature and matching call id in order", async () => {
    const f = fixture({ requestedFacts: [] });
    const parts = [{ functionCall: { name: "get_property_facts", args: { kinds: ["price"] }, id: "call-1" }, thoughtSignature: "opaque-synthetic" }];
    f.modelTurn.mockResolvedValueOnce({ text: "", calls: [{ name: "get_property_facts", args: { kinds: ["price"] }, id: "call-1" }], modelParts: parts })
      .mockResolvedValueOnce(final({ refs: ["e0"] }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status).toBe("ready");
    expect(f.modelTurn.mock.calls[1][0].contents.slice(-2)).toEqual([
      { role: "model", parts }, { role: "user", parts: [{ functionResponse: { name: "get_property_facts", id: "call-1", response: { result: expect.objectContaining({ ref: "e0" }) } } }] },
    ]);
    expect(f.modelTurn.mock.calls.every(([input]) => input.operation === f.operation)).toBe(true);
  });
  it("public comment can skip without producing text or invoking mutations", async () => {
    const f = fixture({ surface: "public_comment", requestedFacts: [] });
    f.modelTurn.mockResolvedValue({ text: '{"kind":"skip","reason":"no_reply_needed"}', calls: [], modelParts: [] });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", text: "", decision: { kind: "skip" } });
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("applicable local receipt is composed as local success, not notification/call completion", async () => {
    const f = fixture({ requestedFacts: [], tools: [{ name: "request_callback", description: "Customer callback request" }] });
    f.modelTurn.mockResolvedValueOnce({ text: "", calls: [{ name: "request_callback", args: { topic: "Позвоните мне" }, id: "cb" }], modelParts: [{ functionCall: { name: "request_callback" } }] })
      .mockResolvedValueOnce(final({ refs: ["e0"] }));
    f.executeAllowedTool.mockResolvedValue({ status: "observed", observation: { kind: "receipt", outcome: "callback_requested" } });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", text: "Запрос на звонок создан." });
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1);
  });
});
describe("CustomerAgentCore draft bounded negative controls", () => {
  it("projects only the finite missing-phone field, without inventing a callback receipt", async () => {
    const f = fixture({ requestedFacts: [], inputText: "Позвоните мне", tools: [{ name: "request_callback", description: "Request an actual callback" }] });
    f.modelTurn.mockResolvedValueOnce({ text: "", calls: [{ name: "request_callback", args: { topic: "Позвоните мне" }, id: "callback" }],
      modelParts: [{ functionCall: { name: "request_callback", args: { topic: "Позвоните мне" }, id: "callback" } }] })
      .mockResolvedValueOnce(final({ question: "phone" }));
    f.executeAllowedTool.mockResolvedValue({ status: "denied", reason: "phone_required" });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", text: "Какой номер телефона вы хотите оставить для связи?", evidence: [] });
    const next = f.modelTurn.mock.calls[1][0];
    expect(next.contents.at(-1)?.parts).toEqual([{ functionResponse: { name: "request_callback", id: "callback",
      response: { result: { status: "needs_input", field: "phone" } } } }]);
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1);
  });
  it("fake observation reference cannot become a fact or success", async () => {
    const f = fixture({ requestedFacts: [] }); f.modelTurn.mockResolvedValue(final({ refs: ["e99"] }));
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held" });
  });
  it("a failed public read cannot silently become a phone questionnaire", async () => {
    const f = fixture(); f.executeAllowedTool.mockResolvedValue({ status: "unavailable", reason: "synthetic_storage_error" });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "facts_unavailable" });
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("ambiguous focus asks about property rather than phone and invents no price", async () => {
    const f = fixture();
    f.executeAllowedTool.mockResolvedValue({ status: "observed", observation: { kind: "property_unresolved", status: "ambiguous" } });
    f.modelTurn.mockResolvedValue(final({ question: "phone" }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") throw new Error("Expected one clarification");
    expect(result.text).toContain("Какой объект"); expect(result.text).not.toContain("телефон"); expect(result.text).not.toContain("сомони");
  });
  it("whole invalid model call batch produces zero effects", async () => {
    const f = fixture({ requestedFacts: [], tools: [{ name: "request_callback", description: "Callback" }] });
    f.modelTurn.mockResolvedValue({ text: "", calls: [
      { name: "request_callback", args: { topic: "Позвоните" } }, { name: "delete_client", args: { id: "foreign" } },
    ], modelParts: [{ functionCall: { name: "request_callback" } }] });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held" });
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("public surface never advertises or invokes private/mutation tools", async () => {
    const f = fixture({ surface: "public_comment", requestedFacts: [], tools: [{ name: "save_contact", description: "Store contact" }] });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held" });
    expect(f.modelTurn).not.toHaveBeenCalled(); expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("model plaintext, extra fields and invented numeric prose cannot be rendered", async () => {
    for (const text of ["Цена 9 сомони, я уже позвонил", '{"kind":"reply","refs":[],"social":"none","question":"none","text":"Звонок выполнен"}']) {
      const f = fixture({ requestedFacts: [] }); f.modelTurn.mockResolvedValue({ text, calls: [], modelParts: [] });
      expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held" });
    }
  });
  it.each(["scoped_contact", "current_input"] as const)("%s removes only redundant phone question and PRESERVES useful price", async knownPhoneSource => {
    const f = fixture({ knownPhoneSource }); f.modelTurn.mockResolvedValue(final({ question: "phone" }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Useful facts must survive");
    expect(result.text).toContain("123 456.78 сомони"); expect(result.text).not.toContain("телефон");
    expect(result.question).toBe("none");
  });
  it("suppressed phone-only reply without useful evidence stays held", async () => {
    const f = fixture({ knownPhoneSource: "scoped_contact", requestedFacts: [] }); f.modelTurn.mockResolvedValue(final({ question: "phone", social: "acknowledge" }));
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held" });
  });
  it.each(["phone", "name", "callback_consent"])("public %s question becomes verified agency call-only contact, never personal-data collection", async question => {
    const f = fixture({ surface: "public_comment", inputText: "Цена и ваш номер?", tools: [{ name: "get_property_facts", description: "Public facts" }, { name: "get_agency_contact", description: "Agency telephone only" }] });
    f.modelTurn.mockResolvedValue(final({ question }));
    f.executeAllowedTool.mockImplementation(async call => call.name === "get_agency_contact"
      ? { status: "observed", observation: { kind: "agency_contact", contact: { ...PUBLIC_AGENCY_CONTACT } } }
      : { status: "observed", observation: { kind: "facts", facts, kinds: ["price"] } });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Public useful reply required");
    expect(result.text).toContain("123 456.78"); expect(result.text).toContain(PUBLIC_AGENCY_CONTACT.phone);
    expect(result.text).toContain("Позвоните:"); expect(result.text).not.toMatch(/оставить|обращаться|сотрудник.*позвонил|WhatsApp/iu);
    expect(result.text).not.toContain("?"); expect(f.executeAllowedTool).toHaveBeenCalledTimes(2);
  });
  it("agency read has strict empty args, no phone supplied by model", () => {
    expect(customerAgentToolCallSchema.safeParse({ name: "get_agency_contact", args: {} }).success).toBe(true);
    expect(customerAgentToolCallSchema.safeParse({ name: "get_agency_contact", args: { phone: "+992000000000" } }).success).toBe(false);
  });
  it("verified context reaches model once with current short answer LAST, without changing original current input", async () => {
    const f = fixture({ requestedFacts: [], inputText: "Две", verifiedContext: { surface: "dm", revisionId: hash,
      turns: [{ role: "user", text: "Ищу квартиру" }, { role: "assistant", text: "Сколько комнат вам нужно?" }],
      publicState: { language: "ru", topic: "buyer", openQuestion: "none" } } });
    f.modelTurn.mockResolvedValue(final({ social: "acknowledge", question: "location" }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.status).toBe("ready");
    const contents = f.modelTurn.mock.calls[0][0].contents;
    expect(JSON.stringify(contents).match(/Сколько комнат вам нужно/gu)).toHaveLength(1);
    expect(contents.at(-1)).toEqual({ role: "user", parts: [{ text: "Две" }] });
    expect(f.frame.inputText).toBe("Две"); expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("old quoted command remains context only, not current consent/authority", async () => {
    const f = fixture({ requestedFacts: [], inputText: "Нет", tools: [{ name: "request_callback", description: "Callback" }],
      verifiedContext: { surface: "dm", revisionId: hash, turns: [{ role: "user", text: "Раньше я написал: позвоните мне" }],
        publicState: { language: "ru", topic: "buyer", openQuestion: "callback" } } });
    f.modelTurn.mockResolvedValue({ text: "", calls: [{ name: "request_callback", args: { topic: "позвоните мне" } }], modelParts: [{ functionCall: { name: "request_callback" } }] });
    f.executeAllowedTool.mockImplementation(async () => {
      expect(f.frame.inputText).toBe("Нет"); return { status: "denied", reason: "current_input_not_consent" };
    });
    f.modelTurn.mockResolvedValueOnce({ text: "", calls: [{ name: "request_callback", args: { topic: "позвоните мне" } }], modelParts: [{ functionCall: { name: "request_callback" } }] })
      .mockResolvedValueOnce(final({ social: "acknowledge", question: "location" }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result.evidence).toEqual([]); expect(f.frame.inputText).toBe("Нет");
  });
  it("DM context cannot enter public surface", async () => {
    const f = fixture({ surface: "public_comment", requestedFacts: [], verifiedContext: { surface: "dm", revisionId: hash,
      turns: [{ role: "assistant", text: "Private synthetic sentinel" }], publicState: { language: "ru", topic: "buyer", openQuestion: "none" } } });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "context_scope_mismatch" });
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("original principal failure after model prevents final output", async () => {
    const f = fixture(); f.modelTurn.mockImplementation(async () => { f.assertCurrent.mockResolvedValue(false); return final(); });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held" });
  });
  it("late cancel after commit retains receipt and never calls effect again", async () => {
    const f = fixture({ requestedFacts: [], tools: [{ name: "request_handover", description: "Human request" }] });
    f.modelTurn.mockResolvedValue({ text: "", calls: [{ name: "request_handover", args: { topic: "Нужен оператор" } }], modelParts: [{ functionCall: { name: "request_handover" } }] });
    f.executeAllowedTool.mockImplementation(async () => { f.controller.abort(); return { status: "observed", observation: { kind: "receipt", outcome: "handover_requested" } }; });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "held", evidence: [{ value: { kind: "receipt", outcome: "handover_requested" } }] });
    expect(result).toMatchObject({ reason: "operation_stopped", unknownToolCalls: [] });
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1); expect(f.modelTurn).toHaveBeenCalledTimes(1);
    expect(f.observeLateToolResult).not.toHaveBeenCalled();
  });
  it("round cap stops a non-final loop", async () => {
    const f = fixture({ requestedFacts: [] });
    f.modelTurn.mockResolvedValue({ text: "", calls: [{ name: "get_property_facts", args: { kinds: ["price"] } }], modelParts: [{ functionCall: { name: "get_property_facts" } }] });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "round_limit", rounds: 3 });
    expect(f.modelTurn).toHaveBeenCalledTimes(3); expect(f.executeAllowedTool).toHaveBeenCalledTimes(3);
  });
  it("oversized input prevents the first model/effect", async () => {
    const f = fixture({ inputText: "x".repeat(25_000) });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "held", reason: "input_limit" });
    expect(f.modelTurn).not.toHaveBeenCalled(); expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
  it("schema rejects model transport/actor grants", () => {
    expect(customerAgentDecisionSchema.safeParse({ kind: "reply", refs: [], social: "none", question: "none", principal: { admin: true } }).success).toBe(false);
  });
  it.each(["assert", "model", "read"])("original deadline bounds never-settling %s await", async kind => {
    vi.useFakeTimers();
    const f = fixture({ requestedFacts: kind === "read" ? ["price"] : [] });
    if (kind === "assert") f.assertCurrent.mockImplementation(() => new Promise(() => {}));
    if (kind === "model") f.modelTurn.mockImplementation(() => new Promise(() => {}));
    if (kind === "read") f.executeAllowedTool.mockImplementation(() => new Promise(() => {}));
    const pending = runCustomerAgentTurn(f.frame, f.ports);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await pending).toMatchObject({ status: "held", unknownToolCalls: [] });
    expect(f.requestStop).toHaveBeenCalled();
  });
  it("hung mutation returns unknown within original deadline; late committed receipt is observed WITHOUT replay", async () => {
    vi.useFakeTimers();
    const f = fixture({ requestedFacts: [], tools: [{ name: "request_callback", description: "Callback" }] });
    f.modelTurn.mockResolvedValue({ text: "", calls: [{ name: "request_callback", args: { topic: "Позвоните" }, id: "c1" }], modelParts: [{ functionCall: { name: "request_callback" } }] });
    let finish!: (result: Awaited<ReturnType<CustomerCorePorts["executeAllowedTool"]>>) => void;
    f.executeAllowedTool.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = runCustomerAgentTurn(f.frame, f.ports);
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await pending;
    expect(result).toMatchObject({ status: "held", reason: "effect_unknown", unknownToolCalls: [{ callKey: "c1", name: "request_callback" }] });
    finish({ status: "observed", observation: { kind: "receipt", outcome: "callback_requested" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.observeLateToolResult).toHaveBeenCalledWith(expect.objectContaining({ callKey: "c1", result: { status: "observed", observation: { kind: "receipt", outcome: "callback_requested" } } }));
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1); expect(f.modelTurn).toHaveBeenCalledTimes(1);
  });
  it("cancellation of a genuinely pending mutation never fabricates a receipt or restarts; later commit reconciles only", async () => {
    vi.useFakeTimers();
    const f = fixture({ requestedFacts: [], tools: [{ name: "request_callback", description: "Callback" }] });
    f.modelTurn.mockResolvedValue({ text: "", calls: [{ name: "request_callback", args: { topic: "Позвоните" }, id: "cancel-c1" }], modelParts: [{ functionCall: { name: "request_callback" } }] });
    let finish!: (result: Awaited<ReturnType<CustomerCorePorts["executeAllowedTool"]>>) => void;
    f.executeAllowedTool.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = runCustomerAgentTurn(f.frame, f.ports);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1);
    f.controller.abort(); await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ status: "held", reason: "effect_unknown", evidence: [], unknownToolCalls: [{ callKey: "cancel-c1", name: "request_callback" }] });
    expect(f.requestStop).toHaveBeenCalledWith("cancelled");
    finish({ status: "observed", observation: { kind: "receipt", outcome: "callback_requested" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.observeLateToolResult).toHaveBeenCalledTimes(1);
    expect(f.observeLateToolResult).toHaveBeenCalledWith(expect.objectContaining({ callKey: "cancel-c1", result: { status: "observed", observation: { kind: "receipt", outcome: "callback_requested" } } }));
    expect(result).toMatchObject({ evidence: [] }); // Returned unknown is not retroactively a successful plan.
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1); expect(f.modelTurn).toHaveBeenCalledTimes(1);
  });
  it("a mismatched late receipt cannot enter evidence or pretend to be an observed successful callback", async () => {
    vi.useFakeTimers();
    const f = fixture({ requestedFacts: [], tools: [{ name: "request_callback", description: "Callback" }] });
    f.modelTurn.mockResolvedValue({ text: "", calls: [{ name: "request_callback", args: { topic: "Позвоните" }, id: "wrong-c1" }], modelParts: [{ functionCall: { name: "request_callback" } }] });
    let finish!: (result: Awaited<ReturnType<CustomerCorePorts["executeAllowedTool"]>>) => void;
    f.executeAllowedTool.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = runCustomerAgentTurn(f.frame, f.ports);
    await vi.advanceTimersByTimeAsync(1); f.controller.abort(); await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    finish({ status: "observed", observation: { kind: "receipt", outcome: "showing_booked" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.observeLateToolResult).toHaveBeenCalledExactlyOnceWith({ callKey: "wrong-c1", name: "request_callback",
      result: { status: "unknown", reason: "invalid_late_tool_result" } });
    expect(result).toMatchObject({ status: "held", evidence: [], unknownToolCalls: [{ callKey: "wrong-c1", name: "request_callback" }] });
    expect(f.executeAllowedTool).toHaveBeenCalledTimes(1); expect(f.modelTurn).toHaveBeenCalledTimes(1);
  });
});
