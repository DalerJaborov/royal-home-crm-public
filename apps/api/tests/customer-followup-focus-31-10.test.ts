import { describe, expect, it, vi } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerPropertyFactKind } from "@royal-home/shared";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";
import { propertyNumberSelectors } from "../src/lib/customerPropertyReferenceText.js";
import { customerRoleSignals, customerTextRole } from "../src/ai/customerAgentRole.js";
import { renderCustomerAgentDecision, type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerSearchContinuation, customerSearchIntent, customerSearchPreRead } from "../src/ai/customerAgentSearchIntent.js";
import { judgeTurn } from "./attack/judge.js";
import { scenarioSchema, type JudgeFacts, type TurnOutcome } from "./attack/types.js";

/** 31.10.2026, live multi-turn probes (P9): a short follow-up about the object just shown, a Tajik seller, the vacancy list. */
describe("a short word about the shown object is a fact question", () => {
  it.each<[string, CustomerPropertyFactKind[]]>([
    ["район", ["address"]], ["а район?", ["address"]], ["в каком районе?", ["address"]], ["ноҳия?", ["address"]], ["ноҳияаш кадом?", ["address"]],
    ["сколько стоит ОБ-000088", ["price"]], ["ОБ-88 этаж?", ["characteristics"]], ["цена ob-000012", ["price"]],
  ])("%s", (text, expected) => { expect(classifyCustomerPropertyFactIntent(text)).toEqual(expected); });
  it("keeps real search wording out of the fact path", () => {
    expect(classifyCustomerPropertyFactIntent("двушку в районе Сино")).toBeNull();
    expect(classifyCustomerPropertyFactIntent("в Фирдавси")).toBeNull();
  });
  it("reads the CRM object code as the public number", () => {
    expect(propertyNumberSelectors("сколько стоит ОБ-000088?")).toEqual(["88"]);
    expect(propertyNumberSelectors("об этом 5 этаже")).toEqual([]);
  });
});

describe("a Tajik seller without ӯ is a seller", () => {
  it.each(["хонаи фуруши дорам", "фурушӣ дорам", "фуруши дорам", "хона мефурушам", "хона фурухтан мехоҳам", "барои фурӯш хона дорам", "хонаро мефурӯшам"])(
    "%s", text => { expect(customerRoleSignals(text).sell).toBe(true); expect(customerTextRole(text, false)).toBe("seller"); });
  it.each(["хона харидан мехоҳам", "хонаи фурӯшӣ ҳаст?", "фуруши хонаҳо чанд аст?"])("a buyer's question stays a buyer's: %s", text => {
    expect(customerTextRole(text, false)).not.toBe("seller");
  });
});

const hash = "a".repeat(64);
const knowledge = readCustomerAgentCompanyKnowledge(), sourceHash = customerAgentCompanyKnowledgeHash(knowledge);
async function runCore(inputText: string, language: "ru" | "tg", change: object) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language, inputText, knownPhoneSource: "none", requestedFacts: [],
    revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: sourceHash,
      providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
      limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
    startedAt: Date.now(), operation, tools: [{ name: "get_company_policy", description: "Read approved public company policy" }] };
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>();
  const turn: CustomerAgentModelTurn = { text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", ...change }), calls: [], modelParts: [] };
  modelTurn.mockResolvedValueOnce(turn);
  const ports: CustomerCorePorts = { modelTurn, executeAllowedTool: async () => ({ status: "denied", reason: "unused" }),
    assertCurrent: async () => true, requestStop: reason => controller.abort(reason), observeLateToolResult: () => {} };
  return runCustomerAgentTurn(frame, ports);
}
describe("a model that asks a seller what to explain gets the seller intake", () => {
  it.each(["clarify_previous", "topic"])("tg seller, model question %s", async question => {
    const result = await runCore("хонаи фуруши дорам", "tg", { kind: "clarify", question });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.decision).toMatchObject({ kind: "clarify", question: "seller_details", refs: [] });
    expect(result.text).not.toContain("Чиро муфассалтар");
  });
});

const context = (turns: Array<{ role: "user" | "assistant"; text: string }>) => customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: hash, turns,
  publicState: { language: "ru", topic: "buyer", openQuestion: "none" } });
const user = (text: string) => ({ role: "user" as const, text });
const bot = (text: string) => ({ role: "assistant" as const, text });
const facts = (kinds: CustomerPropertyFactKind[]): CustomerAgentEvidence => ({ ref: "e0", value: { kind: "facts", kinds, facts: {
  propertyId: "00000000-0000-4000-8000-000000000069", shortId: 69, publicLink: null, publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only",
  price: "500000", currency: "TJS", availability: "AVAILABLE", builder: null, updatedAt: "2026-10-31T00:00:00.000Z", signature: "s".repeat(64),
  characteristics: { type: "APARTMENT", rooms: 2, areaSqm: "65", landAreaSotka: null, floor: 5, totalFloors: 9, condition: "GOOD", marketType: null, stage: null } } } as never });
function render(decision: object, inputText: string, turns: Array<{ role: "user" | "assistant"; text: string }>, evidence: CustomerAgentEvidence[] = [],
  requestedFacts: CustomerPropertyFactKind[] = []) {
  return renderCustomerAgentDecision({ decision: { social: "none", refs: evidence.map(e => e.ref), ...decision } as never, evidence, language: "ru", requestedFacts,
    knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText, verifiedContext: context(turns) });
}

describe("the repeat guard never swallows an answer to a fact question", () => {
  const object = "Цена объекта №69: 500 000 сомони.\nРасположение: Сино, Душанбе.\nЭтаж: 5 из 9.";
  it("answers 'этаж' again with the floor line, not with an 'I already wrote' notice", () => {
    const text = render({ kind: "reply", question: "none" }, "этаж", [user("цена"), bot(`Повторю ещё раз:\n${object}`)],
      [facts(["characteristics"])], ["characteristics"])!;
    expect(text).toContain("Этаж: 5 из 9");
    expect(text).not.toMatch(/уже писал|своими словами|одним сообщением/u);
  });
  it("answers 'район' with the address line", () => {
    const text = render({ kind: "reply", question: "none" }, "район", [bot(object)], [facts(["address"])], ["address"])!;
    expect(text).toContain("Сино, Душанбе");
    expect(text).not.toMatch(/уже писал|своими словами|одним сообщением/u);
  });
  it("a fact question is answered even when the whole answer was said in the previous turn", () => {
    const first = render({ kind: "reply", question: "none" }, "район", [bot("Расположение: Сино, Душанбе.")], [facts(["address"])], ["address"])!;
    expect(first).toContain("Сино, Душанбе");
  });
  it("without a fact question the old behaviour stays: a notice instead of a third copy", () => {
    const all = [facts(["price", "address", "characteristics"])];
    const first = render({ kind: "reply", question: "none" }, "расскажите", [user("расскажите")], all)!;
    const second = render({ kind: "reply", question: "none" }, "расскажите", [user("расскажите"), bot(first)], all)!;
    expect(second).toMatch(/^Повторю ещё раз:/u);
    const third = render({ kind: "reply", question: "none" }, "расскажите", [user("расскажите"), bot(first), user("расскажите"), bot(second)], all)!;
    expect(third).toMatch(/уже писал|своими словами|одним сообщением/u);
  });
  it("asks which object once more with the 'I asked' wording, not with a notice", () => {
    const unresolved: CustomerAgentEvidence = { ref: "e0", value: { kind: "property_unresolved", status: "missing", reason: "no_reference" } };
    const first = render({ kind: "clarify", question: "property" }, "цена", [user("цена")], [unresolved], ["price"])!;
    expect(first).toContain("Какой объект");
    const again = render({ kind: "clarify", question: "property" }, "цена", [user("цена"), bot(first)], [unresolved], ["price"])!;
    expect(again).toContain("Я уточнял, о каком объекте речь");
    expect(again).not.toMatch(/уже писал/u);
  });
});

describe("a fact question with several shown objects asks which of them", () => {
  const shown = "Нашёл варианты:\n1. Объект №69\nЦена: 500 000\n2. Объект №70\nЦена: 900 000";
  const unresolved: CustomerAgentEvidence = { ref: "e0", value: { kind: "property_unresolved", status: "missing", reason: "no_reference" } };
  it("lists the numbers of the shown objects", () => {
    const text = render({ kind: "clarify", question: "property" }, "этаж", [user("двушки"), bot(shown)], [unresolved], ["characteristics"])!;
    expect(text).toContain("№69");
    expect(text).toContain("№70");
    expect(text).toMatch(/Какой из/u);
  });
  it("keeps the plain question when nothing or one object was shown", () => {
    expect(render({ kind: "clarify", question: "property" }, "этаж", [user("этаж")], [unresolved], ["characteristics"])).toContain("Какой объект вы имеете в виду");
    expect(render({ kind: "clarify", question: "property" }, "этаж", [bot("Нашёл:\n1. Объект №69")], [unresolved], ["characteristics"]))
      .toContain("Какой объект вы имеете в виду");
  });
});

describe("judge: a vacancy list is an answer to 'are there vacancies?'", () => {
  const judgeFacts: JudgeFacts = { numbers: [], allowedPhoneDigits: [], allowedHandles: [] };
  const outcome = (text: string): TurnOutcome => ({ status: "replied", replies: [text], decision: null, observationsJson: "[]", modelCalls: 1 });
  const scenario = (input: string) => scenarioSchema.parse({ id: "judge-vacancy-1", category: "multi-turn", surface: "dm", channel: "INSTAGRAM", turns: [{ in: input }] });
  const failedRules = (input: string, reply: string) => judgeTurn({ scenario: scenario(input), turnIndex: 0, outcomes: [outcome(reply)], facts: judgeFacts, mode: "live",
    extraRules: new Set(["answers-the-question"]) }).verdicts.filter(v => !v.pass).map(v => v.rule);
  it("accepts the list that ends with a question", () => {
    expect(failedRules("есть вакансии?", "Сейчас открыты вакансии:\nАгент по недвижимости\nSMM-специалист\nВидеограф\nКакая должность вас интересует?")).toEqual([]);
    expect(failedRules("кор доред?", "Ҳоло ҷойҳои холӣ:\nАгент оид ба амвол\nМутахассиси SMM\nКадом вазифа шуморо ҷалб мекунад?")).toEqual([]);
  });
  it("still rejects a bare counter-question", () => {
    expect(failedRules("сколько стоит?", "Какой объект вас интересует?")).toContain("answers-the-question");
  });
});

describe("an answer to the bot's district / rooms / budget question continues the search", () => {
  const turns = (...items: Array<["user" | "assistant", string]>) => items.map(([role, text]) => ({ role, text }));
  it("'в Фирдавси' after 'двушка' + the district question searches a two-room apartment there", () => {
    const intent = customerSearchContinuation("в Фирдавси", turns(["user", "двушка"], ["assistant", "Какой район вам подходит?"]));
    expect(intent).toMatchObject({ type: "APARTMENT", rooms: 2, districtName: "Фирдавси" });
    expect(customerSearchPreRead(intent)?.args).toMatchObject({ type: "APARTMENT", rooms: 2, districtName: "Фирдавси" });
  });
  it("works in Tajik and after the 'I asked' repair wording", () => {
    expect(customerSearchContinuation("дар Сино", turns(["user", "ду хона мехоҳам"], ["assistant", "Кадом ноҳия ба шумо мувофиқ аст?"])))
      .toMatchObject({ rooms: 2, districtName: "Сино" });
    expect(customerSearchContinuation("Сино", turns(["user", "трёшку"], ["assistant", "Я уточнял район для поиска. Какой район вам подходит?"])))
      .toMatchObject({ rooms: 3, districtName: "Сино" });
  });
  it("is silent when the bot asked something else or the answer names no condition", () => {
    expect(customerSearchContinuation("в Фирдавси", turns(["user", "двушка"], ["assistant", "Спасибо, учту."]))).toBeNull();
    expect(customerSearchContinuation("не знаю", turns(["user", "двушка"], ["assistant", "Какой район вам подходит?"]))).toBeNull();
    expect(customerSearchContinuation("в Фирдавси", turns(["assistant", "Какой район вам подходит?"]).slice(0, 0))).toBeNull();
  });
  it("never turns a seller's or a job seeker's answer into a search", () => {
    expect(customerSearchContinuation("в Фирдавси", turns(["user", "у меня дом на продажу"], ["assistant", "Какой район вам подходит?"]))).toBeNull();
    expect(customerSearchContinuation("в Сино", turns(["user", "ищу работу smm, вакансия"], ["assistant", "Какой район вам подходит?"]))).toBeNull();
  });
});

describe("a Tajik seller's details are not a catalogue search", () => {
  it.each(["мефурушам, ду хонагӣ дар Сино", "мефурӯшам хонаи ду ҳуҷрагӣ дар Сино", "хонаро мефурушам, ду хона"])("%s", text => {
    expect(customerSearchIntent(text)).toBeNull();
  });
});
