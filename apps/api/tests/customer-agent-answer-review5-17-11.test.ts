import { describe, expect, it } from "vitest";
import { customerAgentAnswerVerdict, renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { CUSTOMER_AGENT_ANSWER_GUIDANCE, validateCustomerAgentAnswer } from "../src/ai/customerAgentAnswer.js";
import { HUMAN_PHRASES, humanPhraseAgrees, humanPhraseMatch, humanPhraseAcknowledges } from "../src/ai/customerAgentHumanText.js";

/**
 * Fifth review of #211 (17.11.2026, HEAD 9ab5a3a9; scratchpad/r5/p7.mts, p8.mts of the review session).
 *  п.1 BLOCKER: an agreement phrase passed when the customer OFFERS or ARRANGES rather than asks («Беру за 900», «Приеду в субботу»,
 *      «Мегирам», Latin): «Хорошо.» / «Хуб.» / «Майлаш.» + a question, read as «да». First live: no agreement phrase at all, and any
 *      phrase with an agreement word is refused even if the list gets one later.
 *  п.3 The same phrase twice in one part or in lead + close («Хорошо. Хорошо.», «Спасибо! Спасибо!», «Хуб. Хуб.») is refused.
 *  tajik-phrasebook do-not-say №7: «Понял вас.» / «Фаҳмидам.» alone is dry; it goes out only in front of a fact line or a question.
 */
const hash = "a".repeat(64);
const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "1250000", currency: "TJS", availability: "AVAILABLE",
  publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only", builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: hash };
const kh = customerAgentCompanyKnowledgeHash(readCustomerAgentCompanyKnowledge());
const price = [{ ref: "e0", value: { kind: "facts", facts, kinds: ["price"] } }];
type Case = { language: "ru" | "tg"; inputText: string; evidence?: unknown[]; question?: string; prior?: string[]; social?: string };
const inp = (c: Case, answer?: unknown) => {
  const ev = c.evidence ?? [];
  const d = ev.length ? { kind: "reply", refs: ["e0"], social: c.social ?? "none", question: c.question ?? "none" }
    : { kind: "clarify", refs: [], social: c.social ?? "none", question: c.question ?? "budget" };
  const turns = (c.prior ?? []).map(text => ({ role: "user" as const, text }));
  return { knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", knowledgeSourceHash: kh, language: c.language, inputText: c.inputText,
    requestedFacts: ev.length ? ["price"] : [], evidence: ev, decision: { ...d, ...(answer === undefined ? {} : { answer }) },
    ...(turns.length ? { verifiedContext: { surface: "dm", revisionId: hash, publicState: { topic: "unknown" }, turns } } : {}) } as never;
};
const verdict = (c: Case, answer: unknown) => customerAgentAnswerVerdict(inp(c, answer)) as { ok: boolean; text?: string; reason?: string } | null;

/** Every agreement phrase the list had before round 5. */
const OLD_AGREE = { ru: ["Хорошо.", "Хорошо, понял вас.", "Хорошо, понимаю вас.", "Хорошо, спасибо."], tg: ["Хуб.", "Хеле хуб.", "Хуб, фаҳмидам.", "Майлаш."] } as const;

// p7.mts «agree»: the inputs that passed through the renderer with an agreement phrase (40 of 44 read as «да»).
const RU = ["Скидку сделайте", "Хотелось бы скидочку", "Скидон будет", "Беру за 900 тысяч", "Согласен на 900 тысяч", "Хочу за 900", "За 900 отдаёте", "Берёте комиссию",
  "Приеду в субботу", "Подъеду в 5", "Хочу глянуть квартиру", "Хочу увидеть квартиру", "Жду звонка", "Жду вашего звонка вечером", "Оформляем", "Беру",
  "Цена договорная", "Цена", "Подробнее", "Обмен рассматриваете", "Обмен на машину", "Без посредников", "Только без комиссии", "Хочу снизить",
  "Покажите", "Сделаете дешевле", "Нужна рассрочка", "Документы чистые", "Торг уместен", "Готов внести залог", "Задаток оставлю"];
const TG = ["Нархашро кам кунед", "Шанбе меоям", "Ман меоям", "Мегирам", "Нишон диҳед", "Барои ман нигоҳ доред", "Ба 900 медиҳед", "Ба 900 розӣ ҳастам",
  "Пагоҳ меоям", "Занг занед", "Интизори занг ҳастам", "Иваз мекунед", "Иваз ба мошин", "Пешпардохт медиҳам", "Ҳуҷҷаташ тоза", "Ҳуҷҷаташ тозаст",
  "Нарх", "Маълумоти бештар", "Бо насия", "Хона нишон диҳед"];
const LATIN = ["narkhro kam mekuned", "narxro kam mekuned", "skidka mekuned", "skidka budet", "mojno skidku", "skidku sdelayte", "pokajite kvartiru", "zavtra pridu",
  "nishon dihed", "mumkin", "kai omadan mumkin", "Скидка boladimi", "сделаете skidku", "nasiya hast"];
const TRADE_IN = new Set(["Обмен на машину", "Иваз ба мошин"]);
const voice = (text: string) => `<untrusted_content kind="voice">${text}</untrusted_content>`;
const VOICE = ["скидку сделаете", "приеду в субботу посмотреть", "беру за девятьсот"].map(voice);
const HISTORY: Array<[string[], string]> = [[["Можно скидку?"], "Ну так что"], [["Можно скидку?", "3 комнаты"], "Ну так что"], [["Скидку сделайте", "Алло"], "Жду"],
  [["Приеду в субботу"], "Жду"], [["Можно скидку?"], "3 комнаты"], [["Скидка будет?", "Бюджет 900"], "Район Сино"]];

const CASES: Array<[string, Case]> = [
  ...RU.flatMap(inputText => [[`ru «${inputText}»`, { language: "ru", inputText }], [`ru «${inputText}» + price`, { language: "ru", inputText, evidence: price }]] as Array<[string, Case]>),
  ...TG.flatMap(inputText => [[`tg «${inputText}»`, { language: "tg", inputText }], [`tg «${inputText}» + price`, { language: "tg", inputText, evidence: price }]] as Array<[string, Case]>),
  ...LATIN.flatMap(inputText => [[`latin→ru «${inputText}»`, { language: "ru", inputText }], [`latin→tg «${inputText}»`, { language: "tg", inputText }]] as Array<[string, Case]>),
  ...VOICE.map(inputText => [`voice «${inputText}»`, { language: "ru", inputText }] as [string, Case]),
  ...HISTORY.map(([prior, inputText]) => [`history ${prior.join(" / ")} → «${inputText}»`, { language: "ru", inputText, prior }] as [string, Case]),
];

describe("п.1 BLOCKER: no agreement word ever reaches the customer (p7: offers, arrangements, Latin, voice, a request two messages back)", () => {
  it("the corpus is the whole probe: 31 ru + 20 tg + 14 Latin + 3 voice + 6 history inputs", () => {
    expect([RU.length, TG.length, LATIN.length, VOICE.length, HISTORY.length]).toEqual([31, 20, 14, 3, 6]);
    expect(CASES).toHaveLength(31 * 2 + 20 * 2 + 14 * 2 + 3 + 6);
  });
  it.each(CASES)("%s: every old agreement lead → the template, no «да»", (_name, c) => {
    const template = renderCustomerAgentDecision(inp(c));
    for (const lead of OLD_AGREE[c.language]) {
      const v = verdict(c, { lead });
      expect(v?.ok, `${lead}: ${JSON.stringify(v)}`).toBe(false);
      const sent = renderCustomerAgentDecision(inp(c, { lead }))!;
      expect(sent).toBe(template);
      expect(sent.split("\n").some(line => OLD_AGREE[c.language].some(phrase => line.startsWith(phrase.replace(/[.,]$/u, ""))))).toBe(false);
    }
    // The other language's agreement and an unlisted one are refused too.
    for (const lead of ["Хорошо.", "Хуб.", "Майлаш.", "Ладно.", "Конечно.", "Бале.", "Албатта.", "Ок."]) expect(verdict(c, { lead })?.ok, lead).toBe(false);
  });
  it.each(CASES)("%s: a thanks lead still goes out (the model's words are not banned wholesale)", (_name, c) => {
    const lead = c.language === "ru" ? "Спасибо, что написали!" : "Раҳмат, ки навиштед!";
    const v = verdict(c, { lead });
    // A trade-in keeps its own template path (no model words there at all, customerAgentAnswerVerdict).
    if (TRADE_IN.has(c.inputText)) { expect(v).toEqual({ ok: false, reason: "not_eligible" }); return; }
    expect(v?.ok, JSON.stringify(v)).toBe(true);
    expect(humanPhraseAgrees(v!.text!.split("\n")[0])).toBe(false);
  });
  it("the list carries no agreement phrase (CI guard: a «Хорошо.» added later fails here)", () => {
    for (const language of ["ru", "tg"] as const) for (const role of ["lead", "close"] as const) {
      for (const [text] of HUMAN_PHRASES[language][role]) expect(humanPhraseAgrees(text), `${language} ${role} ${text}`).toBe(false);
    }
  });
  it("second guard: an agreement phrase added to the list (any tag) is still refused", () => {
    const edited = {
      ru: { lead: [...HUMAN_PHRASES.ru.lead, ["Хорошо.", "neutral"], ["Конечно, понял вас.", "neutral"]], close: [...HUMAN_PHRASES.ru.close, ["Договорились!", "farewell"]] },
      tg: { lead: [...HUMAN_PHRASES.tg.lead, ["Хуб.", "neutral"], ["Майлаш.", "neutral"]], close: HUMAN_PHRASES.tg.close },
    } as unknown as typeof HUMAN_PHRASES;
    expect(humanPhraseMatch("Хорошо.", "ru", "lead", edited)).toBeNull();
    expect(humanPhraseMatch("Конечно, понял вас.", "ru", "lead", edited)).toBeNull();
    expect(humanPhraseMatch("Договорились!", "ru", "close", edited)).toBeNull();
    expect(humanPhraseMatch("Хуб.", "tg", "lead", edited)).toBeNull();
    expect(humanPhraseMatch("Майлаш.", "tg", "lead", edited)).toBeNull();
    // The edited copy still matches its ordinary phrases: the refusal is the agreement word, not a broken index.
    expect(humanPhraseMatch("Понял вас.", "ru", "lead", edited)?.text).toBe("Понял вас.");
  });
  it("the model guidance forbids agreement words and offers thanks first, «понял» only before a fact or a question", () => {
    expect(CUSTOMER_AGENT_ANSWER_GUIDANCE).toContain("не пиши никогда");
    for (const phrase of ["Спасибо, что написали!", "Раҳмат, ки навиштед!", "Ташаккур барои паёматон."]) expect(CUSTOMER_AGENT_ANSWER_GUIDANCE).toContain(phrase);
    expect(CUSTOMER_AGENT_ANSWER_GUIDANCE).toContain("только перед фактом или вопросом");
    expect(CUSTOMER_AGENT_ANSWER_GUIDANCE).not.toMatch(/только в ответ на сообщение без вопроса/u);
    // No agreement phrase is offered in the phrase lists of the guidance.
    const lists = CUSTOMER_AGENT_ANSWER_GUIDANCE.split("\n").filter(line => line.startsWith("Фразы "));
    expect(lists).toHaveLength(4);
    for (const line of lists) for (const phrase of line.slice(line.indexOf(":") + 1).split("|")) expect(humanPhraseAgrees(phrase), phrase).toBe(false);
  });
});

describe("п.3 the same phrase twice is refused (it went out as «Спасибо! Спасибо!», «Хуб. Хуб.»)", () => {
  const roomsRu: Case = { language: "ru", inputText: "Ищу квартиру", question: "rooms" };
  const roomsTg: Case = { language: "tg", inputText: "Хона мехарам", question: "rooms" };
  const greetRu: Case = { ...roomsRu, inputText: "Здравствуйте, ищу квартиру", social: "greet" };
  const greetTg: Case = { ...roomsTg, inputText: "Салом, хона мехарам", social: "greet" };
  const pricedRu: Case = { language: "ru", inputText: "Цена объекта 123?", evidence: price };
  const pricedTg: Case = { language: "tg", inputText: "Нархи объекти 123 чанд?", evidence: price };
  it.each([
    [roomsRu, "Спасибо! Спасибо!"], [roomsRu, "Понимаю вас. Понимаю вас."], [roomsRu, "Спасибо! СПАСИБО!"], [roomsRu, "Понял вас. понял вас"],
    [greetRu, "Здравствуйте! Здравствуйте!"], [roomsTg, "Раҳмат! Раҳмат!"], [roomsTg, "Фаҳмидам. Фаҳмидам."], [greetTg, "Салом! Салом!"],
    [roomsRu, "Хорошо. Хорошо."], [roomsTg, "Хуб. Хуб."],
  ] as Array<[Case, string]>)("lead «%s»", (c, lead) => {
    expect(verdict(c, { lead })?.ok).toBe(false);
    expect(renderCustomerAgentDecision(inp(c, { lead }))).toBe(renderCustomerAgentDecision(inp(c)));
  });
  it("the reason is «repeat» (not a fact attempt in the day line)", () => {
    expect(verdict(roomsRu, { lead: "Спасибо! Спасибо!" })?.reason).toBe("repeat");
    expect(verdict(roomsTg, { lead: "Раҳмат! Раҳмат!" })?.reason).toBe("repeat");
  });
  it.each([[pricedRu, "Спасибо!", "Спасибо!"], [pricedTg, "Раҳмат!", "Раҳмат!"], [pricedTg, "Ташаккур!", "Ташаккур!"], [pricedRu, "Понимаю вас. Спасибо!", "Спасибо!"]] as Array<[Case, string, string]>)(
    "lead «%s» + close «%s» → repeat", (c, lead, close) => {
      expect(verdict(c, { lead, close })).toEqual({ ok: false, reason: "repeat" });
    });
  it("two different phrases still go out", () => {
    expect(verdict(roomsRu, { lead: "Спасибо! Понял вас." })?.text).toBe("Спасибо! Понял вас.\nСколько комнат вам нужно?");
    expect(verdict(pricedRu, { lead: "Понимаю вас.", close: "Спасибо!" })?.ok).toBe(true);
    expect(verdict(pricedTg, { lead: "Раҳмат!", close: "Саломат бошед!" })?.ok).toBe(true);
  });
});

describe("do-not-say №7: «Понял вас.» / «Фаҳмидам.» never goes out alone, without a fact line or a question after it", () => {
  const base = { surface: "dm" as const, maxOutputChars: 2000, inputText: "Ищу квартиру" };
  const socialOnly = (language: "ru" | "tg") => ({ social: [language === "ru" ? "Здравствуйте!" : "Ассалому алайкум!"], facts: [], question: null });
  const ACK = { ru: ["Понял вас.", "Поняла вас.", "Понимаю вас.", "Понял, спасибо.", "Понял вас, спасибо.", "Ясно, спасибо.", "Понимаю, это важный вопрос.", "Спасибо! Понял вас."],
    tg: ["Фаҳмидам.", "Мефаҳмам.", "Фаҳмидам, раҳмат.", "Раҳмат, фаҳмидам.", "Фаҳмидам, ташаккур.", "Раҳмат! Фаҳмидам."] } as const;
  it("every acknowledgement phrase of the list is recognised as one", () => {
    for (const language of ["ru", "tg"] as const) for (const lead of ACK[language]) expect(humanPhraseAcknowledges(lead), lead).toBe(true);
    for (const lead of ["Спасибо, что написали!", "Раҳмат, ки навиштед!", "Ташаккур барои паёматон.", "Извините за задержку.", "Инак маълумот."]) expect(humanPhraseAcknowledges(lead), lead).toBe(false);
  });
  it.each((["ru", "tg"] as const).flatMap(language => ACK[language].map(lead => [language, lead] as const)))("%s «%s» alone → refused", (language, lead) => {
    expect(validateCustomerAgentAnswer({ ...base, language, answer: { lead }, template: socialOnly(language) }).ok).toBe(false);
    expect(validateCustomerAgentAnswer({ ...base, language, answer: { lead, close: language === "ru" ? "Всего доброго!" : "Саломат бошед!" }, template: socialOnly(language) }).ok).toBe(false);
  });
  it.each((["ru", "tg"] as const).flatMap(language => ACK[language].map(lead => [language, lead] as const)))("%s «%s» before a fact line or a question → goes out", (language, lead) => {
    const fact = { social: [], facts: [language === "ru" ? "Цена объекта №123: 1 250 000 сомони." : "Нархи объекти №123: 1 250 000 сомонӣ."], question: null };
    expect(validateCustomerAgentAnswer({ ...base, language, answer: { lead }, template: fact }).ok).toBe(true);
    const ask = { social: [], facts: [], question: { line: language === "ru" ? "Сколько комнат вам нужно?" : "Чанд ҳуҷра лозим аст?", kind: "rooms" as const } };
    expect(validateCustomerAgentAnswer({ ...base, language, answer: { lead }, template: ask }).ok).toBe(true);
  });
  it("a thanks lead alone is fine", () => {
    expect(validateCustomerAgentAnswer({ ...base, language: "ru", answer: { lead: "Спасибо, что написали!" }, template: socialOnly("ru") }).ok).toBe(true);
    expect(validateCustomerAgentAnswer({ ...base, language: "tg", answer: { lead: "Раҳмат, ки навиштед!" }, template: socialOnly("tg") }).ok).toBe(true);
  });
});
