import { describe, expect, it, vi } from "vitest";
import { customerAgentDecisionSchema, type CustomerAgentDecision } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerAgentAnswerVerdict } from "../src/ai/customerAgentRenderer.js";
import { validateCustomerAgentAnswer, CUSTOMER_AGENT_ANSWER_EXAMPLES, CUSTOMER_AGENT_ANSWER_GUIDANCE, ANSWER_ENABLED_LANGUAGES,
  type CustomerAgentAnswerInput } from "../src/ai/customerAgentAnswer.js";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { CUSTOMER_AGENT_SYSTEM } from "../src/ai/customerAgentPrompt.js";
import { CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2 } from "../src/lib/customerAgentQualityContinuityUpgrade.js";
import { createHash } from "node:crypto";

/**
 * One brain, step 1 (16.11.2026): the model writes the whole reply, the server verifies it against its own template and the
 * tool evidence of the turn; all or nothing. The «bad» cases are the live replies of the audit 16.11.2026
 * (reports/bot-audit-16-11/tone.md, facts.md, language.md): each must fall back to the template, never reach the customer.
 */
const hash = "a".repeat(64);
const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "123456.78", currency: "TJS" as const,
  availability: "AVAILABLE" as const, publicAddress: "Synthetic district, Душанбе", addressPolicy: "district_city_only" as const,
  builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: hash };
const priceEvidence = [{ ref: "e0", value: { kind: "facts", facts, kinds: ["price"] } }] as never;
const base = { requestedFacts: ["price"] as never, knownPhoneSource: "none" as const, maxOutputChars: 2000, surface: "dm" as const };
type Lang = "ru" | "tg";
const decision = (d: Record<string, unknown>) => ({ kind: "reply", refs: [], social: "none", question: "none", ...d }) as CustomerAgentDecision;
/** The verdict exactly as the renderer reaches it: the template of the same decision and evidence is the reference. */
function verdict(answer: string, opts: { language?: Lang; inputText?: string; d?: Record<string, unknown>; evidence?: unknown; prior?: string[] } = {}) {
  const language = opts.language ?? "ru";
  return customerAgentAnswerVerdict({ ...base, language, inputText: opts.inputText ?? (language === "ru" ? "Цена объекта 123?" : "Нархи объекти 123 чанд?"),
    decision: { ...decision(opts.d ?? { refs: ["e0"] }), answer } as CustomerAgentDecision, evidence: (opts.evidence ?? priceEvidence) as never,
    ...(opts.prior ? { verifiedContext: { surface: "dm", revisionId: hash, publicState: { topic: "unknown" } as never,
      turns: opts.prior.map(text => ({ role: "assistant" as const, text })) } as never } : {}) });
}
const reasonOf = (...args: Parameters<typeof verdict>) => { const v = verdict(...args); return v?.ok ? "ok" : v?.reason; };
const clarify = (question: string, social = "acknowledge") => ({ kind: "clarify", refs: [], social, question });

describe("whole reply in the model's words: warm, verified replies go out", () => {
  it("Russian price answer keeps the verified price, currency and object number", () => {
    expect(verdict("Понимаю, вам важна цена. Объект №123 стоит 123 456.78 сомони.")).toEqual({ ok: true,
      text: "Понимаю, вам важна цена. Объект №123 стоит 123 456.78 сомони." });
  });
  it("Tajik is on: a warm Tajik answer with the greeting the template also gives", () => {
    expect(reasonOf("Ваалайкум ассалом! Нархи объекти №123 ҳоло 123 456.78 сомонӣ аст.",
      { language: "tg", inputText: "Ассалому алейкум, нархи объекти 123 чанд?", d: { refs: ["e0"], social: "greet" } })).toBe("ok");
  });
  it("asks the same question the server chose, in own words", () => {
    expect(reasonOf("Понял, ищете квартиру в Сино. Сколько комнат вам нужно?", { inputText: "Ищу квартиру в Сино", d: clarify("rooms"), evidence: [] })).toBe("ok");
    expect(reasonOf("Фаҳмидам, шумо дар Сино хона мехаред. Бемалол бигӯед, чӣ қадар маблағ дар назар доред?",
      { language: "tg", inputText: "Хона мехарам дар Сино", d: clarify("budget"), evidence: [] })).toBe("ok");
  });
  it("every example shown to the model passes the verifier (guidance never teaches a dropped reply)", () => {
    expect(reasonOf(CUSTOMER_AGENT_ANSWER_EXAMPLES.ru[0], { inputText: "Ищу квартиру для семьи", d: clarify("location"), evidence: [] })).toBe("ok");
    expect(reasonOf(CUSTOMER_AGENT_ANSWER_EXAMPLES.ru[1], { inputText: "Хочу купить квартиру", d: clarify("budget"), evidence: [] })).toBe("ok");
    expect(reasonOf(CUSTOMER_AGENT_ANSWER_EXAMPLES.tg[0], { language: "tg", inputText: "Ассалому алейкум, хона мехарам", d: clarify("location", "greet"), evidence: [] })).toBe("ok");
    expect(reasonOf(CUSTOMER_AGENT_ANSWER_EXAMPLES.tg[1], { language: "tg", inputText: "Хона мехарам", d: clarify("budget"), evidence: [] })).toBe("ok");
  });
  it("both languages are enabled and the guidance names the owner's banned words", () => {
    expect([...ANSWER_ENABLED_LANGUAGES].sort()).toEqual(["ru", "tg"]);
    for (const word of ["писал выше", "дар боло навиштам", "лутфан", "мутахассис", "шумо"]) expect(CUSTOMER_AGENT_ANSWER_GUIDANCE).toContain(word);
  });
  it("is deterministic and the renderer returns the verified text (the delivery seal prints the same)", () => {
    const answer = "Понимаю, вам важна цена. Объект №123 стоит 123 456.78 сомони.";
    expect(verdict(answer)).toEqual(verdict(answer));
    const d = { ...decision({ refs: ["e0"] }), answer } as CustomerAgentDecision;
    expect(renderCustomerAgentDecision({ ...base, language: "ru", inputText: "Цена объекта 123?", decision: d, evidence: priceEvidence })).toBe(answer);
    expect(customerAgentDecisionSchema.parse(d)).toMatchObject({ answer });
  });
});

describe("real bad replies of the audit 16.11.2026 fall back to the template", () => {
  it.each([
    ["«писал выше»", "ru", "Я уже писал выше: объект №123 стоит 123 456.78 сомони."],
    ["«повторю»", "ru", "Повторю ещё раз: объект №123 стоит 123 456.78 сомони."],
    ["«бори дигар такрор мекунам» (#79)", "tg", "Бори дигар такрор мекунам: нархи объекти №123 123 456.78 сомонӣ аст."],
    ["«дар боло навишта будам» (#7)", "tg", "Ман инро дар боло навишта будам. Нархи объекти №123 123 456.78 сомонӣ аст."],
    ["«агар саволи ман дар боло номафҳум буд» (#97)", "tg", "Агар саволи ман дар боло номафҳум буд, бубахшед. Нархи объекти №123 123 456.78 сомонӣ аст."],
    ["service receipt (Khodzhaeva_S)", "ru", "Заявка на связь с сотрудником сохранена. Объект №123 стоит 123 456.78 сомони."],
    ["«мутахассиси мо»", "tg", "Мутахассиси мо мегӯяд, ки нархи объекти №123 123 456.78 сомонӣ аст."],
    ["«лутфан»", "tg", "Лутфан, бидонед: нархи объекти №123 123 456.78 сомонӣ аст."],
    ["«амвол»", "tg", "Нархи амволи №123 123 456.78 сомонӣ аст."],
    ["a dash inside the phrase", "ru", "Объект №123 — 123 456.78 сомони."],
  ] as const)("%s → wooden", (_name, language, answer) => {
    expect(reasonOf(answer, { language, inputText: language === "ru" ? "Цена объекта 123?" : "Нархи объекти 123 чанд?" })).toBe("wooden");
  });
  it("«ты» / «ту» → rude", () => {
    expect(reasonOf("Слушай, объект №123 стоит 123 456.78 сомони, тебе подходит?", { d: { refs: ["e0"], question: "none" } })).toBe("rude");
    expect(reasonOf("Ту бидон, нархи объекти №123 123 456.78 сомонӣ аст.", { language: "tg" })).toBe("rude");
  });
  it("an invented price (YouTube «135 520 сомонӣ» at 1 250 000 TJS) → number", () => {
    expect(reasonOf("Объект №123 стоит 135 520 сомони.")).toBe("number");
  });
  it("the right figure in another currency → currency", () => {
    expect(reasonOf("Объект №123 стоит 123 456.78 долларов.")).toBe("currency");
  });
  it("spelled-out figures are unverifiable → number", () => {
    expect(reasonOf("Объект №123 стоит сто двадцать три тысячи сомони, точнее 123 456.78 сомони.")).toBe("number");
  });
  it("an invented address, «с ремонтом», rent, zone and legal claims → claim (or promise)", () => {
    expect(reasonOf("Объект №123 на проспекте Рудаки, цена 123 456.78 сомони.")).toBe("claim");
    expect(reasonOf("Объект №123 с хорошим ремонтом, цена 123 456.78 сомони.")).toBe("claim");
    expect(reasonOf("Фаҳмидам. Ҳоло бо иҷора кор намекунем. Чӣ қадар маблағ дар назар доред?", { language: "tg", inputText: "Тобеи марказ намешавад", d: clarify("budget"), evidence: [] })).toBe("claim");
    expect(reasonOf("Понял. В других городах не работаем. Сколько комнат вам нужно?", { inputText: "Ищу квартиру", d: clarify("rooms"), evidence: [] })).toBe("claim");
    expect(["claim", "promise"]).toContain(reasonOf("Не могу гарантировать юридическую чистоту объекта. Сколько комнат вам нужно?", { inputText: "Ищу квартиру", d: clarify("rooms"), evidence: [] }));
  });
  it("a call or time promise without a receipt → promise", () => {
    expect(reasonOf("Агент свяжется с вами сегодня до конца вечера. Сколько комнат вам нужно?", { inputText: "Ищу квартиру", d: clarify("rooms"), evidence: [] })).toBe("promise");
    expect(reasonOf("Я проверю и подберу варианты. Сколько комнат вам нужно?", { inputText: "Ищу квартиру", d: clarify("rooms"), evidence: [] })).toBe("promise");
  });
  it("losing the verified price → missing_fact (never cut the answer)", () => {
    expect(reasonOf("Понимаю, вас интересует этот объект.")).toBe("missing_fact");
  });
  it("two questions, no question where the server asks one, or another topic → question", () => {
    expect(reasonOf("Какой район вам нужен? И сколько комнат?", { inputText: "Ищу квартиру", d: clarify("rooms"), evidence: [] })).toBe("question");
    expect(reasonOf("Понял, ищете квартиру.", { inputText: "Ищу квартиру", d: clarify("rooms"), evidence: [] })).toBe("question");
    expect(reasonOf("Понял. Как вас зовут?", { inputText: "Ищу квартиру", d: clarify("rooms"), evidence: [] })).toBe("question");
  });
  it("asking for the phone when the server does not → phone_ask", () => {
    expect(reasonOf("Оставьте ваш номер телефона. Сколько комнат вам нужно?", { inputText: "Ищу квартиру", d: clarify("rooms"), evidence: [] })).toBe("phone_ask");
  });
  it("Russian to a Tajik customer (14 chats) → language", () => {
    expect(reasonOf("Объект №123 стоит 123 456.78 сомони.", { language: "tg" })).toBe("language");
  });
  it("the same reply as before → repeat; a second greeting → double_greet; «я бот» → meta", () => {
    const answer = "Понимаю, вам важна цена. Объект №123 стоит 123 456.78 сомони.";
    expect(reasonOf(answer, { prior: [answer] })).toBe("repeat");
    expect(reasonOf("Здравствуйте! Объект №123 стоит 123 456.78 сомони.")).toBe("double_greet");
    expect(reasonOf("Я бот, но знаю: объект №123 стоит 123 456.78 сомони.")).toBe("meta");
  });
  it("a template with a link stays the template (the model never sees links)", () => {
    expect(validateCustomerAgentAnswer({ answer: "Вот этот объект.", template: "Объект №123: https://royalhome.tj/p/123", language: "ru", surface: "dm",
      evidence: [], maxOutputChars: 2000 } satisfies CustomerAgentAnswerInput)).toEqual({ ok: false, reason: "template_payload" });
  });
  it("public comments never carry a model reply", () => {
    expect(customerAgentAnswerVerdict({ ...base, surface: "public_comment", language: "ru", inputText: "Цена?",
      decision: { ...decision({ refs: ["e0"] }), answer: "Объект №123 стоит 123 456.78 сомони." } as CustomerAgentDecision, evidence: priceEvidence })).toEqual({ ok: false, reason: "surface_disabled" });
  });
  it("a rejected answer renders the template unchanged", () => {
    const d = { ...decision({ refs: ["e0"] }), answer: "Я уже писал выше." } as CustomerAgentDecision;
    expect(renderCustomerAgentDecision({ ...base, language: "ru", inputText: "Цена объекта 123?", decision: d, evidence: priceEvidence })).toBe("Цена объекта №123: 123 456.78 сомони.");
  });
});

describe("core: the answer is lifted before the strict parse, shadow by default, live behind CUSTOMER_AGENT_SAY_MODE", () => {
  const GOOD = "Понимаю, вам важна цена. Объект №123 стоит 123 456.78 сомони.";
  const TEMPLATE = "Цена объекта №123: 123 456.78 сомони.";
  const final = (change = {}): CustomerAgentModelTurn => ({ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "none", question: "none", ...change }), calls: [], modelParts: [] });
  function fixture(overrides: Partial<CustomerCoreFrame> = {}) {
    const controller = new AbortController();
    const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
      accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
    const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "Цена объекта 123?", knownPhoneSource: "none", requestedFacts: ["price"],
      revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
        providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
        limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 40_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
      startedAt: Date.now(), operation, tools: [{ name: "get_property_facts", description: "Read public facts" }], ...overrides };
    const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async () => final());
    const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "observed", observation: { kind: "facts", facts, kinds: ["price"] } }));
    const ports = { modelTurn, executeAllowedTool, assertCurrent: vi.fn(async () => true), requestStop: vi.fn((reason: "deadline" | "cancelled") => controller.abort(reason)),
      observeLateToolResult: vi.fn() } satisfies CustomerCorePorts;
    return { frame, modelTurn, ports };
  }
  const run = async (answer: unknown, frame: Partial<CustomerCoreFrame> = {}) => {
    const f = fixture(frame);
    f.modelTurn.mockResolvedValue(final({ answer }));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    if (result.status !== "ready") throw Error(`Expected ready, got ${result.status}`);
    return { f, result };
  };
  it("shadow (prod default): a verified answer is only counted, the template goes out", async () => {
    const { result } = await run(GOOD);
    expect(result.text).toBe(TEMPLATE);
    expect(result.answer).toEqual({ status: "dropped", reason: "shadow" });
    expect(result.decision).not.toHaveProperty("answer");
  });
  it("live: the model's own words go out and the stored decision re-renders to the same print", async () => {
    const { result, f } = await run(GOOD, { sayMode: "live" });
    expect(result.text).toBe(GOOD);
    expect(result.answer).toEqual({ status: "used" });
    expect(result.decision).toMatchObject({ answer: GOOD });
    expect(renderCustomerAgentDecision({ decision: result.decision, evidence: result.evidence, language: "ru", requestedFacts: f.frame.requestedFacts,
      knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", inputText: f.frame.inputText })).toBe(GOOD);
  });
  it("live Tajik works too", async () => {
    const answer = "Нархи объекти №123 ҳоло 123 456.78 сомонӣ аст.";
    const { result } = await run(answer, { sayMode: "live", language: "tg", inputText: "Нархи объекти 123 чанд?" });
    expect(result.answer).toEqual({ status: "used" });
    expect(result.text).toBe(answer);
  });
  it.each([["wooden", "Я уже писал выше: объект №123 стоит 123 456.78 сомони."], ["number", "Объект №123 стоит 135 520 сомони."], ["length", 42]] as const)(
    "live: a bad answer (%s) costs nothing: template, one round, the reason in the counters", async (reason, answer) => {
      const { result, f } = await run(answer, { sayMode: "live" });
      expect(result.text).toBe(TEMPLATE);
      expect(result.answer).toEqual({ status: "dropped", reason });
      expect(result.decision).not.toHaveProperty("answer");
      expect(f.modelTurn).toHaveBeenCalledTimes(1);
    });
  it("asks for the whole answer in private messages for Russian AND Tajik, never in comments, never in the pinned prompt", async () => {
    const text = (f: ReturnType<typeof fixture>) => f.modelTurn.mock.calls[0][0].contents.flatMap(c => c.parts.map(p => (p as { text?: string }).text ?? "")).join("\n");
    const dmContext = { surface: "dm", revisionId: hash, turns: [], publicState: { topic: "unknown" } as never } as const;
    for (const language of ["ru", "tg"] as const) {
      const f = fixture({ language, verifiedContext: dmContext });
      await runCustomerAgentTurn(f.frame, f.ports);
      expect(text(f)).toContain("answerGuidance");
    }
    const pub = fixture({ surface: "public_comment", verifiedContext: { ...dmContext, surface: "public_comment" } });
    await runCustomerAgentTurn(pub.frame, pub.ports);
    expect(text(pub)).not.toContain("answerGuidance");
    expect(CUSTOMER_AGENT_SYSTEM).not.toContain("answerGuidance");
  });
  it("the pinned system prompt is unchanged, so the release rides the routine refresh (no new upgrade pair)", () => {
    expect(createHash("sha256").update(CUSTOMER_AGENT_SYSTEM).digest("hex")).toBe(CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2.toPrompt);
  });
});
