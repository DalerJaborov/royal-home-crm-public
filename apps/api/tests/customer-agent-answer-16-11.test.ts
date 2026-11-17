import { describe, expect, it, vi } from "vitest";
import { customerAgentDecisionSchema, type CustomerAgentDecision } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerAgentAnswerVerdict, customerAgentSentQuestion, customerSealedQuestionLast,
  customerAgentCallbackQuestionText } from "../src/ai/customerAgentRenderer.js";
import { CUSTOMER_AGENT_ANSWER_EXAMPLES, CUSTOMER_AGENT_ANSWER_GUIDANCE, ANSWER_ENABLED_LANGUAGES, customerAgentHumanLineSafe, customerAgentMemoryText,
  customerAgentAskKindOf, parseCustomerAgentAnswerParts } from "../src/ai/customerAgentAnswer.js";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { CUSTOMER_AGENT_SYSTEM } from "../src/ai/customerAgentPrompt.js";
import { CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2 } from "../src/lib/customerAgentQualityContinuityUpgrade.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerAgentAnswerMode } from "../src/lib/customerAgentFeaturePolicy.js";
import { summarizeCustomerAgentAnswerDay } from "../src/lib/customerAgentSayStats.js";
import { customerSearchContinuation } from "../src/ai/customerAgentSearchIntent.js";
import { createHash } from "node:crypto";

/**
 * One brain, step 1 after review #211 (16.11.2026): the model writes ONLY the human part (lead, ask, close); every fact line comes
 * verbatim from the template. The review's probe (D:/PublicWorktrees-20261021/review-211/apps/api/tmp-review/probe.ts) showed the word-level
 * check passing inverted facts with `ok:true`; every probe example is a test below and must now fall back to the template.
 */
const hash = "a".repeat(64);
const knowledge = readCustomerAgentCompanyKnowledge(), knowledgeSourceHash = customerAgentCompanyKnowledgeHash(knowledge);
const facts = (o: Record<string, unknown> = {}) => ({ propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "1250000", currency: "TJS" as const,
  availability: "AVAILABLE" as const, publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only" as const, builder: null, publicLink: null,
  updatedAt: "2026-10-15T00:00:00.000Z", signature: hash, ...o });
const price = [{ ref: "e0", value: { kind: "facts", facts: facts(), kinds: ["price"] } }];
const sold = [{ ref: "e0", value: { kind: "facts", facts: facts({ availability: "SOLD" }), kinds: ["price"] } }];
const two = [...price, { ref: "e1", value: { kind: "facts", facts: facts({ propertyId: "00000000-0000-4000-8000-000000000002", shortId: 124, price: "900000" }), kinds: ["price"] } }];
const pol = (topic: string) => [{ ref: "e0", value: { kind: "company_policy", topic, knowledge, sourceHash: knowledgeSourceHash } }];
const reply = (refs: string[], question = "none", social = "none") => ({ kind: "reply", refs, social, question });
const clarify = (question: string, social = "none") => ({ kind: "clarify", refs: [], social, question });
type Lang = "ru" | "tg";
interface Case { language?: Lang; inputText: string; d: Record<string, unknown>; evidence?: unknown[]; requestedFacts?: string[]; prior?: string[] }

const inputOf = (answer: unknown, c: Case) => ({ knownPhoneSource: "none" as const, maxOutputChars: 2000, surface: "dm" as const, knowledgeSourceHash,
  language: c.language ?? "ru", inputText: c.inputText, requestedFacts: (c.requestedFacts ?? []) as never, evidence: (c.evidence ?? []) as never,
  decision: { ...c.d, ...(answer === undefined ? {} : { answer }) } as CustomerAgentDecision,
  ...(c.prior ? { verifiedContext: { surface: "dm", revisionId: hash, publicState: { topic: "unknown" } as never,
    turns: c.prior.map(text => ({ role: "assistant" as const, text })) } as never } : {}) });
const verdict = (answer: unknown, c: Case) => customerAgentAnswerVerdict(inputOf(answer, c));
const reasonOf = (answer: unknown, c: Case) => { const v = verdict(answer, c); return v?.ok ? "ok" : v?.reason; };
const template = (c: Case) => renderCustomerAgentDecision(inputOf(undefined, c));
const rendered = (answer: unknown, c: Case) => renderCustomerAgentDecision(inputOf(answer, c));

const commissionRu: Case = { inputText: "Какая у вас комиссия?", d: reply(["e0"], "role"), evidence: pol("commission") };
const commissionTg: Case = { language: "tg", inputText: "Комиссияи шумо чанд аст?", d: reply(["e0"], "role"), evidence: pol("commission") };
const zoneRu: Case = { inputText: "Вы работаете в Худжанде?", d: reply(["e0"]), evidence: pol("service_scope") };
const zoneTg: Case = { language: "tg", inputText: "Дар Хуҷанд кор мекунед?", d: reply(["e0"]), evidence: pol("service_scope") };
const rentRu: Case = { inputText: "Вы сдаёте квартиры в аренду?", d: reply(["e0"]), evidence: pol("rental") };
const soldRu: Case = { inputText: "Цена объекта 123?", requestedFacts: ["price"], d: reply(["e0"]), evidence: sold };
const priceRu: Case = { inputText: "Цена объекта 123?", requestedFacts: ["price"], d: reply(["e0"]), evidence: price };
const twoRu: Case = { inputText: "Цена объекта 123?", requestedFacts: ["price"], d: reply(["e0", "e1"]), evidence: two };
const ask = (question: string, language: Lang = "ru", inputText = language === "ru" ? "Ищу квартиру" : "Хона мехарам"): Case =>
  ({ language, inputText, d: clarify(question) });

describe("review #211 probe: every inverted or invented fact falls back to the template (was ok:true)", () => {
  it.each([
    ["A1 commission swapped (ru)", commissionRu, { lead: "Комиссия для продавца 0%, для покупателя 2%.", ask: "Вы хотите купить или продать недвижимость?" }, "number"],
    ["A2 zone: «да, в Худжанде тоже»", zoneRu, { lead: "Да, в Худжанде мы тоже помогаем с покупкой и продажей недвижимости." }, "claim"],
    ["A2b zone: «по всей стране»", zoneRu, { lead: "Помогаем с покупкой и продажей недвижимости по всей стране." }, "claim"],
    ["A3 rent inverted", rentRu, { lead: "Да, арендой тоже занимаемся, сдаём квартиры." }, "claim"],
    ["A4 sold → free", soldRu, { lead: "Объект №123 свободен." }, "number"],
    ["A4b sold → on sale", soldRu, { lead: "Объект №123 ещё продаётся, можно посмотреть." }, "number"],
    ["A4c sold → on sale, no number", soldRu, { lead: "Этот объект ещё продаётся." }, "claim"],
    ["A9 price of the other card", twoRu, { lead: "Объект №123 стоит 900 000 сомони, а объект №124 стоит 1 250 000 сомони." }, "number"],
    ["A10 unknown currency", priceRu, { lead: "Для вас отдадим за восемьдесят пять тысяч у.е." }, "number"],
    ["A11 price k$", priceRu, { lead: "Это около 85k$." }, "number"],
    ["A12 «бесплатно» invented", ask("rooms"), { lead: "Для вас наши услуги бесплатны.", ask: "Сколько комнат вам нужно?" }, "claim"],
    ["A13 «обязательно найдём»", ask("rooms"), { lead: "Мы обязательно найдём вам хорошую квартиру.", ask: "Сколько комнат вам нужно?" }, "promise"],
    ["A14 new building, documents ready", priceRu, { lead: "Объект №123 в новостройке, документы готовы." }, "number"],
    ["A14b the same without a number", priceRu, { lead: "Это новостройка, документы готовы." }, "claim"],
    ["B1 years and minutes (were «verified» by updatedAt)", priceRu, { lead: "Дом сдан в 2026 году, до центра 15 минут." }, "number"],
    ["B1b the same in words", priceRu, { lead: "Дом уже сдан, до центра рукой подать." }, "claim"],
    ["B2 commission swapped (tg)", commissionTg, { lead: "Ҳаққи хизмат барои фурӯшанда 0%, барои харидор 2% аст.", ask: "Шумо хона мехаред ё мефурӯшед?" }, "number"],
    ["B3 zone (tg): «ҳа, дар Хуҷанд ҳам»", zoneTg, { lead: "Ҳа, дар Хуҷанд ҳам бо харид ва фурӯши хона ёрӣ мерасонем." }, "claim"],
  ] as const)("%s → %s", (_name, c, answer, reason) => {
    expect(reasonOf(answer, c)).toBe(reason);
    // The customer reads the server's own lines, unchanged.
    expect(rendered(answer, c)).toBe(template(c));
  });
  it("the old whole-reply string form is refused as a shape (the model may not write the facts at all)", () => {
    expect(reasonOf("Комиссия для продавца 0%, для покупателя 2%. Вы хотите купить или продать недвижимость?", commissionRu)).toBe("length");
    expect(reasonOf("Объект №123 свободен.", soldRu)).toBe("length");
    expect(parseCustomerAgentAnswerParts({ lead: "Понимаю.", price: "1" })).toBeNull();
    expect(parseCustomerAgentAnswerParts(["Понимаю."])).toBeNull();
  });
  it("A15/B4: Russian words inside a Tajik reply → language; and a Tajik word inside a Russian one", () => {
    expect(reasonOf({ lead: "Понимаю, фаҳмидам.", ask: "Чӣ қадар маблағ дар назар доред?" }, ask("budget", "tg"))).toBe("language");
    // Review #211 round 6: an agreement word is counted as its own reason first, so the shadow shows how often the model writes «Хорошо».
    expect(reasonOf({ lead: "Хорошо, фаҳмидам.", ask: "Чӣ қадар маблағ дар назар доред?" }, ask("budget", "tg"))).toBe("agree");
    expect(reasonOf({ lead: "Очень приятно, фаҳмидам." }, { language: "tg", inputText: "Нархи объекти 123 чанд?", requestedFacts: ["price"], d: reply(["e0"]), evidence: price })).toBe("language");
    expect(reasonOf({ lead: "Рахмат, понял вас.", ask: "Сколько комнат вам нужно?" }, ask("rooms"))).toBe("language");
  });
  it("A7/A7b/B5: Russian «ты» verbs and imperatives are not approved question wordings → template", () => {
    expect(reasonOf({ lead: "Понял вас.", ask: "Сколько комнат хочешь?" }, ask("rooms"))).toBe("question");
    expect(reasonOf({ lead: "Понял вас.", ask: "Подскажи, сколько комнат нужно?" }, ask("rooms"))).toBe("question");
    expect(reasonOf({ lead: "Понимаю вас.", ask: "На какую сумму рассчитываешь?" }, ask("budget"))).toBe("question");
  });
  it("A8/B6: Tajik «-ӣ» verbs and imperatives are not approved question wordings → template", () => {
    expect(reasonOf({ lead: "Фаҳмидам.", ask: "Бигӯ, чӣ қадар маблағ дорӣ?" }, ask("budget", "tg"))).toBe("question");
    expect(reasonOf({ lead: "Фаҳмидам.", ask: "Чанд пул дорӣ, бигӯ?" }, ask("budget", "tg"))).toBe("question");
  });
});

describe("the human part around verbatim facts: warm replies go out", () => {
  it("commission: the template line stays exactly as the server wrote it, the model words only frame it", () => {
    const tpl = template(commissionRu)!.split("\n");
    const v = verdict({ lead: "Понимаю вас.", ask: "Вы хотите купить или продать?" }, commissionRu);
    expect(v).toEqual({ ok: true, asked: "role", text: ["Понимаю вас.", ...tpl.slice(0, -1), "Вы хотите купить или продать?"].join("\n") });
    expect(tpl.slice(0, -1).join("\n")).toContain(`${knowledge.commission.sellerPercent}%`);
  });
  it("price: lead + verbatim price line; zone and rent keep the server's refusal or area line", () => {
    expect(rendered({ lead: "Вот что могу сказать." }, priceRu)).toBe(`Вот что могу сказать.\n${template(priceRu)}`);
    expect(rendered({ lead: "Спасибо, что написали!" }, zoneRu)).toBe(`Спасибо, что написали!\n${template(zoneRu)}`);
    expect(rendered({ lead: "Понимаю вас." }, rentRu)).toBe(`Понимаю вас.\n${template(rentRu)}`);
  });
  it("Tajik: a warm lead and the question in own words", () => {
    expect(verdict({ lead: "Раҳмат, ки навиштед!", ask: "Бемалол бигӯед, чӣ қадар маблағ дар назар доред?" }, ask("budget", "tg")))
      .toEqual({ ok: true, asked: "budget", text: "Раҳмат, ки навиштед!\nБемалол бигӯед, чӣ қадар маблағ дар назар доред?" });
  });
  it("every example shown to the model passes the verifier (guidance never teaches a dropped part)", () => {
    const cases: Record<Lang, Case[]> = {
      ru: [ask("location"), ask("budget"), priceRu],
      tg: [ask("budget", "tg"), ask("role", "tg")],
    };
    for (const language of ["ru", "tg"] as const) CUSTOMER_AGENT_ANSWER_EXAMPLES[language].forEach((example, index) =>
      expect(reasonOf(example, cases[language][index]), JSON.stringify(example)).toBe("ok"));
  });
  it("both languages, the guidance names the owner's banned words and never shows a fact", () => {
    expect([...ANSWER_ENABLED_LANGUAGES].sort()).toEqual(["ru", "tg"]);
    for (const word of ["писал выше", "дар боло навиштам", "лутфан", "мутахассис", "шумо", "lead", "ask", "close"]) expect(CUSTOMER_AGENT_ANSWER_GUIDANCE).toContain(word);
    expect(CUSTOMER_AGENT_ANSWER_GUIDANCE).not.toMatch(/\d{2,}/u);
  });
  it("greeting: the template greeting stays unless the lead greets; a lead may not greet where the template does not", () => {
    const greet: Case = { inputText: "Здравствуйте, ищу квартиру", d: clarify("rooms", "greet") };
    expect(rendered({ lead: "Рады вашему сообщению." }, greet)).toBe("Здравствуйте!\nРады вашему сообщению.\nСколько комнат вам нужно?");
    expect(rendered({ lead: "Здравствуйте! Рады вашему сообщению." }, greet)).toBe("Здравствуйте! Рады вашему сообщению.\nСколько комнат вам нужно?");
    expect(reasonOf({ lead: "Здравствуйте!" }, ask("rooms"))).toBe("double_greet");
  });
  it("close only when nothing is asked; an ask only where the server asks", () => {
    expect(rendered({ close: "Будем рады вашему сообщению." }, priceRu)).toBe(`${template(priceRu)}\nБудем рады вашему сообщению.`);
    // Next to a sold object: no close at all (no warmth after «уже продан»).
    expect(reasonOf({ close: "Будем рады вашему сообщению." }, { ...priceRu, evidence: [{ ref: "e0", value: { kind: "facts", facts: facts({ availability: "SOLD" }), kinds: ["price"] } }] })).toBe("vocabulary");
    expect(reasonOf({ close: "Всего доброго!" }, ask("rooms"))).toBe("question");
    expect(reasonOf({ ask: "Сколько комнат вам нужно?" }, priceRu)).toBe("question");
    expect(reasonOf({ ask: "Какой район вам нужен и сколько комнат?" }, ask("rooms"))).toBe("question");
    expect(reasonOf({ ask: "Как вас зовут?" }, ask("rooms"))).toBe("question");
    expect(reasonOf({ lead: "Подскажите, какой район вам удобен." }, ask("rooms"))).toBe("question");
  });
  it("contacts, Latin, places and «я бот» never ride the human words", () => {
    expect(reasonOf({ lead: "Оставьте ваш номер телефона." }, ask("rooms"))).toBe("phone_ask");
    expect(reasonOf({ lead: "Пишите в WhatsApp." }, ask("rooms"))).toBe("place");
    expect(reasonOf({ lead: "Понимаю, в Сино хорошо." }, ask("rooms"))).toBe("place");
    expect(reasonOf({ lead: "Я бот, но понимаю вас." }, ask("rooms"))).toBe("meta");
    expect(reasonOf({ lead: "Понимаю — это важно." }, ask("rooms"))).toBe("wooden");
  });
  it("public comments never carry model words; a file in the reply keeps the template", () => {
    expect(customerAgentAnswerVerdict({ ...inputOf({ lead: "Понимаю вас." }, priceRu), surface: "public_comment" })).toEqual({ ok: false, reason: "surface_disabled" });
    expect(reasonOf({ lead: "Понимаю вас." }, { ...priceRu, d: { ...reply(["e0"]), attachment: "buyer_guide" } })).toBe("template_payload");
  });
  it("is deterministic and the strict decision schema carries the parts (the delivery seal re-renders the same print)", () => {
    const parts = { lead: "Вот что могу сказать." };
    expect(verdict(parts, priceRu)).toEqual(verdict(parts, priceRu));
    expect(customerAgentDecisionSchema.parse({ ...reply(["e0"]), answer: parts })).toMatchObject({ answer: parts });
    expect(customerAgentDecisionSchema.safeParse({ ...reply(["e0"]), answer: "строка" }).success).toBe(false);
  });
  it("a bug in the verifier is the `error` verdict and the template still goes out (the turn never dies)", () => {
    const exploding = { get lead(): string { throw new Error("boom"); } };
    expect(verdict(exploding, priceRu)).toEqual({ ok: false, reason: "error" });
    expect(rendered(exploding, priceRu)).toBe(template(priceRu));
  });
});

describe("the question the bot asked is recorded structurally (review #211, п.4)", () => {
  const callback = ask("callback_consent");
  it("A5: the model's wording of the callback question is the callback question for the delivery seal", () => {
    // Round 5 (17.11): «Хорошо.» is no lead any more (it reads as «да»); the seal check is the same with «Понял вас.».
    const parts = { lead: "Понял вас.", ask: "Хотите, чтобы сотрудник вам позвонил?" };
    const v = verdict(parts, callback);
    expect(v).toEqual({ ok: true, asked: "callback_consent", text: "Понял вас.\nХотите, чтобы сотрудник вам позвонил?" });
    const input = inputOf(parts, callback), text = renderCustomerAgentDecision(input)!;
    expect(text.endsWith(customerAgentCallbackQuestionText("ru"))).toBe(false);
    expect(customerAgentSentQuestion(input, text)).toBe("callback_consent");
    // The stored-row check of customerAcceptedCallbackQuestion: the question is the last line.
    expect(customerSealedQuestionLast(text, customerAgentCallbackQuestionText("ru"))).toBe(true);
    expect(customerSealedQuestionLast("Хотите, чтобы сотрудник вам позвонил?\nБудем рады.", customerAgentCallbackQuestionText("ru"))).toBe(false);
  });
  it("A6: the name question in own words, and the template question as before", () => {
    const name = ask("name");
    const input = inputOf({ lead: "Спасибо!", ask: "Подскажите, как к вам обращаться?" }, name);
    expect(customerAgentSentQuestion(input, renderCustomerAgentDecision(input)!)).toBe("name");
    expect(reasonOf({ lead: "Отлично, поможем.", ask: "Подскажите, как к вам обращаться?" }, name)).toBe("promise");
    const plain = inputOf(undefined, callback);
    expect(customerAgentSentQuestion(plain, renderCustomerAgentDecision(plain)!)).toBe("callback_consent");
  });
  it("a consent question must ask, never announce the call", () => {
    expect(reasonOf({ ask: "Сотрудник вам позвонит, хорошо?" }, callback)).toBe("question");
    expect(reasonOf({ ask: "Мехоҳед корманд ба шумо занг занад?" }, ask("callback_consent", "tg"))).toBe("ok");
  });
  it("a text that does not end with the asked question records nothing", () => {
    const input = inputOf({ lead: "Понял вас." }, callback);
    expect(customerAgentSentQuestion(input, "Понял вас.")).toBe("none");
  });
});

describe("the model's sent words stay in the dialogue memory (review #211, п.5)", () => {
  it("fact-free human lines enter memory, fact lines only through the server's allow-list", () => {
    const sent = "Понимаю вас.\nЦена объекта №123: 1 250 000 сомони.\nВ каком районе вам было бы удобнее?";
    expect(customerAgentMemoryText(sent, new Set())).toBe("Понимаю вас.\nВ каком районе вам было бы удобнее?");
    expect(customerAgentMemoryText(sent, new Set(["Цена объекта №123: 1 250 000 сомони."]))).toBe(sent);
    for (const line of ["Объект свободен.", "Да, работаем в Худжанде.", "Комиссия 0%.", "Позвоним завтра.", "Сколько комнат хочешь и какой бюджет?"]) {
      expect(customerAgentHumanLineSafe(line), line).toBe(false);
    }
    expect(customerAgentAskKindOf("В каком районе вам было бы удобнее?")).toBe("location");
  });
  it("two live turns: the second identical lead is a repeat once the first one is remembered", () => {
    const lead = "Спасибо, что написали.";
    const first = rendered({ lead, ask: "Сколько комнат вы рассматриваете?" }, ask("rooms"))!;
    // The vetted spelling goes out, not the model's «.» (fourth review, п.2).
    expect(first).toBe("Спасибо, что написали!\nСколько комнат вы рассматриваете?");
    const remembered = customerAgentMemoryText(first, new Set());
    expect(remembered).toBe(first);
    // Before review #211 the memory dropped the whole turn (no template line), so the same words passed again.
    expect(reasonOf({ lead, ask: "На какую сумму вы рассчитываете?" }, { ...ask("budget"), prior: [] })).toBe("ok");
    expect(reasonOf({ lead, ask: "На какую сумму вы рассчитываете?" }, { ...ask("budget"), prior: [remembered] })).toBe("repeat");
    expect(reasonOf({ lead: "Здравствуйте!" }, { ...ask("budget"), prior: [remembered] })).toBe("double_greet");
  });
  it("an answer to the model's own district question continues the search like the template question", () => {
    const turns = [{ role: "user" as const, text: "двушка" }, { role: "assistant" as const, text: "Понял.\nВ каком районе вам было бы удобнее?" }];
    expect(customerSearchContinuation("в Фирдавси", turns)).toMatchObject({ rooms: 2, districtName: "Фирдавси" });
    expect(customerSearchContinuation("в Фирдавси", [turns[0], { role: "assistant", text: "Понял.\nКак вас зовут?" }])).toBeNull();
  });
});

describe("daily line: fact attempts are never «good» (review #211, п.7)", () => {
  it("counts used + shadow as good, fact attempts apart, intentional reasons outside the share", () => {
    const day = summarizeCustomerAgentAnswerDay([{ guard: "answer_dropped_shadow", count: 6 }, { guard: "answer_used", count: 2 },
      { guard: "answer_dropped_claim", count: 3 }, { guard: "answer_dropped_number", count: 1 }, { guard: "answer_dropped_not_eligible", count: 40 },
      { guard: "answer_dropped_cliche", count: 1 }, { guard: "say_used", count: 9 }]);
    expect(day).toMatchObject({ total: 13, good: 8, dropped: 5, factAttempts: 4, intentional: 40, alert: true });
  });
  it("stays silent on a clean day and alerts on one verifier error", () => {
    expect(summarizeCustomerAgentAnswerDay([{ guard: "answer_dropped_shadow", count: 9 }, { guard: "answer_dropped_cliche", count: 1 }]).alert).toBe(false);
    expect(summarizeCustomerAgentAnswerDay([{ guard: "answer_dropped_shadow", count: 99 }, { guard: "answer_dropped_error", count: 1 }]).alert).toBe(true);
  });
});

describe("core: lifted before the strict parse, shadow by default, its own switch (review #211, п.6)", () => {
  const LEAD = "Вот что могу сказать.";
  const TEMPLATE = "Цена объекта №123: 1 250 000 сомони.";
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
    const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "observed", observation: { kind: "facts", facts: facts(), kinds: ["price"] } }));
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
  it("the switch: empty or unknown = shadow, live and off only by the exact word", () => {
    expect(customerAgentAnswerMode({})).toBe("shadow");
    expect(customerAgentAnswerMode({ CUSTOMER_AGENT_ANSWER_MODE: "LIVE" })).toBe("shadow");
    // Since 9ab5a3a9 live needs a listed channel: no list and no channel = shadow (fail-safe); review4 covers the list itself.
    expect(customerAgentAnswerMode({ CUSTOMER_AGENT_ANSWER_MODE: "live" })).toBe("shadow");
    expect(customerAgentAnswerMode({ CUSTOMER_AGENT_ANSWER_MODE: "live", CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS: "ALL" }, "FACEBOOK")).toBe("live");
    expect(customerAgentAnswerMode({ CUSTOMER_AGENT_ANSWER_MODE: "off" })).toBe("off");
    expect(customerAgentAnswerMode({ CUSTOMER_AGENT_SAY_MODE: "live" })).toBe("shadow");
  });
  it("shadow (prod default): verified words are only counted, the template goes out", async () => {
    const { result } = await run({ lead: LEAD });
    expect(result.text).toBe(TEMPLATE);
    expect(result.answer).toEqual({ status: "dropped", reason: "shadow" });
    expect(result.decision).not.toHaveProperty("answer");
  });
  it("CUSTOMER_AGENT_SAY_MODE=live alone never sends the model's answer", async () => {
    const { result } = await run({ lead: LEAD }, { sayMode: "live" });
    expect(result.text).toBe(TEMPLATE);
    expect(result.answer).toEqual({ status: "dropped", reason: "shadow" });
  });
  it("live: the composed text goes out and the stored decision re-renders to the same print", async () => {
    const { result, f } = await run({ lead: LEAD }, { answerMode: "live" });
    expect(result.text).toBe(`${LEAD}\n${TEMPLATE}`);
    expect(result.answer).toEqual({ status: "used" });
    expect(result.decision).toMatchObject({ answer: { lead: LEAD } });
    expect(renderCustomerAgentDecision({ decision: result.decision, evidence: result.evidence, language: "ru", requestedFacts: f.frame.requestedFacts,
      knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", inputText: f.frame.inputText })).toBe(result.text);
  });
  it.each([["number", { lead: "Объект №123 стоит 900 000 сомони." }], ["claim", { lead: "Да, он свободен." }], ["length", "Объект №123 стоит 900 000 сомони."], ["length", 42]] as const)(
    "live: a bad answer (%s) costs nothing: template, one round, the reason in the counters", async (reason, answer) => {
      const { result, f } = await run(answer, { answerMode: "live" });
      expect(result.text).toBe(TEMPLATE);
      expect(result.answer).toEqual({ status: "dropped", reason });
      expect(result.decision).not.toHaveProperty("answer");
      expect(f.modelTurn).toHaveBeenCalledTimes(1);
    });
  it("off: no answer guidance (the say rules ride again) and an answer the model sends anyway is ignored", async () => {
    const text = (f: ReturnType<typeof fixture>) => f.modelTurn.mock.calls[0][0].contents.flatMap(c => c.parts.map(p => (p as { text?: string }).text ?? "")).join("\n");
    const dmContext = { surface: "dm", revisionId: hash, turns: [], publicState: { topic: "unknown" } as never } as const;
    const off = fixture({ answerMode: "off", verifiedContext: dmContext });
    off.modelTurn.mockResolvedValue(final({ answer: { lead: LEAD } }));
    const result = await runCustomerAgentTurn(off.frame, off.ports);
    expect(text(off)).not.toContain("answerGuidance");
    expect(text(off)).toContain("sayGuidance");
    expect(result).toMatchObject({ status: "ready", text: TEMPLATE, answer: { status: "absent" } });
  });
  it("asks for the human words in private messages for Russian AND Tajik, never in comments, never in the pinned prompt", async () => {
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
