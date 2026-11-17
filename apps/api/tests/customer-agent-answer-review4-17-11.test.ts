import { describe, expect, it } from "vitest";
import { customerAgentAnswerVerdict, customerAgentSentQuestion, renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerSellerAskedTerms } from "../src/ai/customerAgentSellerGuard.js";
import { HUMAN_PHRASES, customerAsksOrRequests, humanPhraseAgrees } from "../src/ai/customerAgentHumanText.js";
import { customerAgentAnswerMode, customerAgentAnswerLiveChannels } from "../src/lib/customerAgentFeaturePolicy.js";
import { traceCustomerCoreSchema } from "@royal-home/shared";
import { readFileSync } from "node:fs";

/**
 * Fourth review of #211 (17.11.2026, HEAD 10349c0b; probe5.ts / probe6.mts of the review session).
 *  п.1 An agreement phrase («Хорошо», «Хуб», «Майлаш») opens a reply only after a message that neither asks nor requests (this batch
 *      and the customer's previous message) and only when the reply carries no template fact line: the class, not a list of words.
 *  п.2 What goes out is the vetted phrase / approved question itself, never the model's casing or punctuation.
 *  п.3 «Какие все условия?» is a seller's question about the agency's terms.
 */
const hash = "a".repeat(64);
const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "1250000", currency: "TJS", availability: "AVAILABLE",
  publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only", builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: hash };
const knowledge = readCustomerAgentCompanyKnowledge(), kh = customerAgentCompanyKnowledgeHash(knowledge);
const price = [{ ref: "e0", value: { kind: "facts", facts, kinds: ["price"] } }];
type Turn = { role: "user" | "assistant"; text: string };
type Case = { language?: "ru" | "tg"; inputText: string; requestedFacts?: string[]; d: Record<string, unknown>; evidence?: unknown[]; turns?: Turn[] };
const inp = (c: Case, answer?: unknown) => ({ knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", knowledgeSourceHash: kh, language: c.language ?? "ru",
  inputText: c.inputText, requestedFacts: c.requestedFacts ?? [], evidence: c.evidence ?? [], decision: { ...c.d, ...(answer === undefined ? {} : { answer }) },
  ...(c.turns ? { verifiedContext: { surface: "dm", revisionId: hash, publicState: { topic: "unknown" }, turns: c.turns } } : {}) }) as never;
const reply = { kind: "reply", refs: ["e0"], social: "none", question: "none" };
const cl = (question: string, social = "none") => ({ kind: "clarify", refs: [], social, question });
const priced = (inputText: string, language: "ru" | "tg" = "ru"): Case => ({ language, inputText, requestedFacts: ["price"], d: reply, evidence: price });
const verdict = (c: Case, answer: unknown) => customerAgentAnswerVerdict(inp(c, answer)) as { ok: boolean; text?: string; reason?: string } | null;
const ok = (c: Case, answer: unknown) => !!verdict(c, answer)?.ok;

describe("п.1 probe6: an agreement phrase never answers a question or a request with a price line (15 of 15 were ok:true)", () => {
  const RU = ["Цену снизите на 123?", "Последняя цена на 123?", "Цена на 123 окончательная?", "Покажете 123?", "Ипотека на 123 есть?", "Отложите 123 для меня?",
    "Документы на 123 в порядке?"];
  const TG = ["Нархи 123-ро кам мекунед?", "Нархи 123 охирин аст?", "Барои 123 насия ҳаст?", "Ҳуҷҷатҳои 123 тоза аст?"];
  const pairs: Array<[string, "ru" | "tg", string]> = [...RU.map(q => [q, "ru", "Хорошо."] as [string, "ru", string]),
    ...TG.flatMap(q => [[q, "tg", "Хуб."], [q, "tg", "Майлаш."]] as Array<[string, "tg", string]>)];
  it("the probe has exactly 15 pairs", () => { expect(pairs).toHaveLength(15); });
  it.each(pairs)("%s (%s) + %s → template, no «да»", (question, language, lead) => {
    const c = priced(question, language);
    expect(ok(c, { lead })).toBe(false);
    const text = renderCustomerAgentDecision(inp(c, { lead }))!;
    expect(text).toBe(renderCustomerAgentDecision(inp(c)));
    expect(text.startsWith(lead)).toBe(false);
  });
  it.each(pairs)("%s (%s): a neutral lead still goes out", (question, language) => {
    expect(ok(priced(question, language), { lead: language === "ru" ? "Понимаю вас." : "Фаҳмидам." })).toBe(true);
  });
});

describe("п.1 the class: question mark, question word, imperative, request word, the previous message, a fact line", () => {
  it.each([
    ["no question mark: imperative", "ru", "Покажите квартиру 123", "Хорошо."],
    ["no question mark: «вы»-verb", "ru", "Снизите немного", "Хорошо, понял вас."],
    ["no question mark: particle «ли»", "ru", "Есть ли рассрочка", "Хорошо."],
    ["no question mark: final price", "ru", "Это последняя цена", "Хорошо, спасибо."],
    ["tg without «?»: «насия ҳаст»", "tg", "Насия ҳаст", "Хуб."],
    ["tg without «?»: «кам кунед»", "tg", "Нархашро кам кунед", "Майлаш."],
    ["tg typed without Tajik letters", "tg", "Хуччатхояш тоза аст", "Хеле хуб."],
    ["tg question suffix «-ми»", "tg", "Ипотека мешавадми", "Хуб, фаҳмидам."],
    ["tg «оё»", "tg", "Оё тахфиф мешавад", "Хуб."],
    ["a question earlier in the batch", "ru", "Можно скидку\nну ладно, жду", "Хорошо."],
  ] as const)("%s: «%s» → no agreement", (_name, language, inputText, lead) => {
    const c: Case = { language, inputText, d: cl("name") };
    expect(ok(c, { lead })).toBe(false);
    expect(ok(c, { lead: language === "ru" ? "Понял вас, спасибо." : "Фаҳмидам, раҳмат." })).toBe(true);
  });
  it("the customer's previous message asked for a discount: «Ну» now is no «да» either", () => {
    const turns: Turn[] = [{ role: "user", text: "Можно скидку на 123?" }, { role: "assistant", text: "Цена объекта №123: 1 250 000 сомони." }];
    const c: Case = { inputText: "Ну", d: cl("name"), turns };
    expect(ok(c, { lead: "Хорошо." })).toBe(false);
    expect(ok(c, { lead: "Понял вас." })).toBe(true);
  });
  it("a template fact line in the reply: no agreement even after a plain statement", () => {
    const c = priced("Объект 123");
    expect(ok(c, { lead: "Хорошо." })).toBe(false);
    expect(ok(c, { lead: "Понимаю вас." })).toBe(true);
  });
});

describe("п.1 agreement stays where it is honest: a plain statement and no fact line", () => {
  it.each([
    ["ru", "Ищу квартиру", "rooms", "Хорошо."], ["ru", "Ищу квартиру в Сино", "rooms", "Хорошо, понял вас."], ["ru", "3 комнаты", "budget", "Хорошо, спасибо."],
    ["ru", "Бюджет до 60 тысяч", "location", "Хорошо."], ["ru", "Спасибо, жду звонка", "name", "Хорошо."], ["ru", "Здравствуйте, ищу квартиру", "rooms", "Хорошо, понимаю вас."],
    ["ru", "Извините, я в Сино ищу", "rooms", "Хорошо."], ["ru", "Видел ваше объявление на сайте", "rooms", "Хорошо, понял вас."],
    ["tg", "Хона мехарам", "rooms", "Хуб."], ["tg", "Се ҳуҷра", "budget", "Майлаш."], ["tg", "Дар Сино", "rooms", "Хеле хуб."],
    ["tg", "Раҳмат, интизорам", "name", "Хуб, фаҳмидам."], ["tg", "Бубахшед, хона мехарам", "rooms", "Хуб."],
  ] as const)("%s «%s» → «%s» goes out", (language, inputText, question, lead) => {
    expect(ok({ language, inputText, d: cl(question) }, { lead })).toBe(true);
  });
  it("after a plain previous message too («Ищу квартиру», then «3 комнаты»)", () => {
    const turns: Turn[] = [{ role: "user", text: "Ищу квартиру" }, { role: "assistant", text: "Сколько комнат вам нужно?" }];
    expect(ok({ inputText: "3 комнаты", d: cl("budget"), turns }, { lead: "Хорошо." })).toBe(true);
  });
});

describe("п.1 detector and the phrase list stay one class", () => {
  it.each(["Цена?", "Сколько стоит", "Где находится", "Покажите", "Скиньте фото", "Можно посмотреть", "Есть ли ипотека", "Сделаете скидку",
    "Нарх чанд", "Куҷо аст", "Нишон диҳед", "Расмашро фиристед", "Мумкин бинам", "Ҳуҷҷат ҳаст", "Пагоҳ омадан мешавад", "Чӣ хел", "Тахфиф медиҳед"])("asks: %s", text => {
    expect(customerAsksOrRequests(text)).toBe(true);
  });
  it.each(["Ищу квартиру", "3 комнаты с балконами", "Квартира со всеми удобствами", "Бюджет 50 тысяч", "Спасибо, жду звонка", "Здравствуйте",
    "В бюджете до 60", "Видел на сайте", "Хона мехарам", "Се ҳуҷра", "Раҳмат, ки навиштед", "Шумо гуфтед, ман интизорам", "Дар Сино", "Бубахшед", ""])("states: %s", text => {
    expect(customerAsksOrRequests(text)).toBe(false);
  });
  it("every vetted phrase with an agreement word is tagged «agree», and every «agree» carries one (a new «Конечно.» cannot slip in untagged)", () => {
    for (const language of ["ru", "tg"] as const) for (const role of ["lead", "close"] as const) {
      for (const [text, kind] of HUMAN_PHRASES[language][role]) expect(humanPhraseAgrees(text), `${language} ${role} ${text}`).toBe(kind === "agree");
    }
  });
  it.each(["Конечно.", "Ладно.", "Договорились.", "Да.", "Бале.", "Албатта.", "Ҳа.", "Хорошо, договорились."])("unlisted agreement «%s» is refused anyway", lead => {
    expect(ok({ inputText: "Ищу квартиру", d: cl("rooms") }, { lead })).toBe(false);
  });
});

describe("п.2 the vetted phrase goes out, never the model's casing or punctuation", () => {
  const rooms: Case = { inputText: "Ищу квартиру", d: cl("rooms") };
  const ask = "Сколько комнат вам нужно?";
  it.each([["ХОРОШО.", "Хорошо."], ["хорошо", "Хорошо."], ["«Хорошо».", "Хорошо."], ["Хорошо понял вас", "Хорошо, понял вас."],
    ["Хорошо; понял вас.", "Хорошо, понял вас."], ["Хорошо, понял вас!!!", "Хорошо, понял вас."], ["понимаю вас", "Понимаю вас."],
    ["СПАСИБО ЗА ТЕРПЕНИЕ", "Спасибо за терпение."], ["Хорошо. Понял вас", "Хорошо. Понял вас."]] as const)("lead «%s» → «%s»", (lead, sent) => {
    const v = verdict(rooms, { lead });
    expect(v?.ok).toBe(true);
    expect(v?.text).toBe(`${sent}\n${ask}`);
  });
  it("Tajik: «ФАҲМИДАМ» → «Фаҳмидам.», «раҳмат ки навиштед» → «Раҳмат, ки навиштед!»", () => {
    const c: Case = { language: "tg", inputText: "Хона мехарам", d: cl("rooms") };
    expect(verdict(c, { lead: "ФАҲМИДАМ" })?.text?.split("\n")[0]).toBe("Фаҳмидам.");
    expect(verdict(c, { lead: "раҳмат ки навиштед" })?.text?.split("\n")[0]).toBe("Раҳмат, ки навиштед!");
  });
  it("a glued tail that is not a whole phrase is refused", () => {
    for (const lead of ["Хорошо понял вас спасибо", "Хорошо понял", "Понял вас хорошо", "Хорошо-понял вас."]) expect(ok(rooms, { lead }), lead).toBe(false);
  });
  it("close: «всего доброго» → «Всего доброго!»", () => {
    expect(verdict(priced("Цена объекта 123?"), { close: "всего доброго" })?.text?.split("\n").at(-1)).toBe("Всего доброго!");
  });
  it("ask: the approved wording goes out, and the delivery seal still records the callback question", () => {
    const c: Case = { inputText: "Ищу квартиру", d: cl("callback_consent") };
    const answer = { lead: "Понял вас.", ask: "ХОТИТЕ, ЧТОБЫ СОТРУДНИК ВАМ ПОЗВОНИЛ?" };
    const v = verdict(c, answer);
    expect(v?.ok).toBe(true);
    expect(v?.text).toBe("Понял вас.\nХотите, чтобы сотрудник вам позвонил?");
    const input = inp(c, answer);
    expect(customerAgentSentQuestion(input, renderCustomerAgentDecision(input)!)).toBe("callback_consent");
  });
});

describe("п.3 «Какие все условия?» is the seller asking the agency's terms", () => {
  const seller = { intake: { role: "seller", sellerKnown: [], buyerKnown: [] }, turns: [] } as never;
  it.each([["Какие все условия?", true], ["Каковы все условия?", true], ["Какие все условия у вас", true], ["Все условия есть?", false],
    ["Квартира со всеми условиями, интересует?", false], ["Продаю квартиру, все условия есть", false], ["Хонаи 3 ҳуҷрагӣ, ҳама шароит дорад", false]] as const)(
    "%s → %s", (text, expected) => { expect(customerSellerAskedTerms({ inputText: text, verifiedContext: seller })).toBe(expected); });
});

describe("live on one channel first (CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS, 17.11.2026)", () => {
  const ALL = ["WHATSAPP", "INSTAGRAM", "FACEBOOK", "WEBSITE"] as const;
  it("live and no list: live on every channel (as before)", () => {
    for (const env of [{ CUSTOMER_AGENT_ANSWER_MODE: "live" }, { CUSTOMER_AGENT_ANSWER_MODE: "live", CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS: " , " }]) {
      for (const channel of ALL) expect(customerAgentAnswerMode(env, channel)).toBe("live");
      expect(customerAgentAnswerMode(env)).toBe("live");
    }
  });
  it("live and a list: live only on the listed channels, shadow on the others", () => {
    const env = { CUSTOMER_AGENT_ANSWER_MODE: "live", CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS: " whatsapp, Website ,WHATSAPP" };
    expect(customerAgentAnswerLiveChannels(env)).toEqual(["WHATSAPP", "WEBSITE"]);
    expect(customerAgentAnswerMode(env, "WHATSAPP")).toBe("live");
    expect(customerAgentAnswerMode(env, "WEBSITE")).toBe("live");
    expect(customerAgentAnswerMode(env, "INSTAGRAM")).toBe("shadow");
    expect(customerAgentAnswerMode(env, "FACEBOOK")).toBe("shadow");
    expect(customerAgentAnswerMode(env)).toBe("shadow");
    // A typo or a channel the core never sees is ignored, never «all channels».
    const typo = { CUSTOMER_AGENT_ANSWER_MODE: "live", CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS: "telegram, whatsap" };
    for (const channel of ALL) expect(customerAgentAnswerMode(typo, channel)).toBe("shadow");
  });
  it("off stays off and shadow stays shadow whatever the list says", () => {
    for (const channel of ALL) {
      expect(customerAgentAnswerMode({ CUSTOMER_AGENT_ANSWER_MODE: "off", CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS: channel }, channel)).toBe("off");
      expect(customerAgentAnswerMode({ CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS: channel }, channel)).toBe("shadow");
      expect(customerAgentAnswerMode({ CUSTOMER_AGENT_ANSWER_MODE: "LIVE", CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS: channel }, channel)).toBe("shadow");
    }
  });
  it("the turn trace carries the mode; the variable reaches the api container (empty by default)", () => {
    expect(traceCustomerCoreSchema.parse({ status: "ready", rounds: 1, toolCalls: 0, receiptOutcomes: [], answerStatus: "dropped", answerDropReason: "shadow",
      answerMode: "shadow" })).toMatchObject({ answerMode: "shadow" });
    expect(() => traceCustomerCoreSchema.parse({ status: "ready", rounds: 1, toolCalls: 0, receiptOutcomes: [], answerMode: "on" })).toThrow();
    const compose = readFileSync(new URL("../../../docker-compose.prod.yml", import.meta.url), "utf8");
    expect(compose).toContain('CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS: "${CUSTOMER_AGENT_ANSWER_LIVE_CHANNELS:-}"');
  });
});
