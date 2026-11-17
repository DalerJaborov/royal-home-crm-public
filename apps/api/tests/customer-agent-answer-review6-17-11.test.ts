import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { customerAgentAnswerVerdict, customerAgentFixedLines, renderCustomerAgentDecision, renderCustomerAgentDecisionChecked } from "../src/ai/customerAgentRenderer.js";
import { renderCustomerAgentText, reportCustomerAgentAgreementOpening } from "../src/ai/customerAgentCore.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { CUSTOMER_AGENT_ANSWER_EXAMPLES, CUSTOMER_AGENT_ANSWER_GUIDANCE } from "../src/ai/customerAgentAnswer.js";
import { APPROVED_ASKS, HUMAN_PHRASES, humanPhraseAgrees, humanPhrasesClash, withoutAgreementOpenings } from "../src/ai/customerAgentHumanText.js";
import { RECEIPT_AGAIN, RETIRED_TEMPLATE_LINES } from "../src/ai/customerAgentLiveWording.js";
import { GUARD_LABELS } from "../src/ai/guardMetrics.js";
import { customerAgentAnswerDropReasonSchema } from "@royal-home/shared";
import { prisma } from "../src/db.js";

/**
 * Sixth review of #211 (17.11.2026, HEAD 5d2f0c5a; scratchpad/r6/p9.mts, p10.mts of the review session).
 *  п.1 The TEMPLATE said «Хорошо, принято.» / «Хуб, қабул шуд.» after two «Понял.» and «Беру» / «Приеду» / «Мегирам» (in prod since #48),
 *      and «Хорошо, записал.», «Конечно.» / «Бале.» are the same class. The third belt read only the model's words: now every core text
 *      passes withoutAgreementOpenings last, and a removal goes to the error journal (dedup).
 *  п.2 «С удовольствием расскажу.» is gone; «с удовольствием», «обязательно», «без проблем», «принято», «сделаем», «бемалол» (alone),
 *      «албатта», «ҳатман», «бешубҳа» agree; «Бемалол, рақамро нависед» / «Бемалол бигӯед, …?» stay «пожалуйста».
 *  п.3 One meaning once: «Понял вас. Поняла вас.», «Раҳмат! Ташаккур!», «Спасибо! Здравствуйте!» (greeting not first) are refused.
 *  п.4 A refusal for an agreement word has its own reason `agree` (answer_dropped_agree).
 */
const hash = "a".repeat(64);
const kh = customerAgentCompanyKnowledgeHash(readCustomerAgentCompanyKnowledge());
const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "1250000", currency: "TJS", availability: "AVAILABLE",
  publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only", builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: hash };
const price = [{ ref: "e0", value: { kind: "facts", facts, kinds: ["price"] } }];
type Turn = { role: "user" | "assistant"; text: string };
const input = (o: { language: "ru" | "tg"; inputText: string; turns?: Turn[]; social?: string; question?: string; evidence?: unknown[]; answer?: unknown; say?: string }) => {
  const evidence = o.evidence ?? [];
  const decision = { kind: "reply", refs: evidence.length ? ["e0"] : [], social: o.social ?? "none", question: o.question ?? "none",
    ...(o.answer === undefined ? {} : { answer: o.answer }), ...(o.say === undefined ? {} : { say: o.say }) };
  return { knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", knowledgeSourceHash: kh, language: o.language, inputText: o.inputText,
    requestedFacts: evidence.length ? ["price"] : [], evidence, decision,
    ...(o.turns ? { verifiedContext: { surface: "dm", revisionId: hash, publicState: { topic: "unknown" }, turns: o.turns } } : {}) } as never;
};
const verdict = (o: Parameters<typeof input>[0]) => customerAgentAnswerVerdict(input(o)) as { ok: boolean; text?: string; reason?: string } | null;
const CONSENT_START = /(?:^|[.!?…]\s+|\n)\s*(?:хорошо|хуб|ладно|майлаш|конечно|албатта|принято|қабул|с удовольствием|обязательно|без проблем|бешубҳа|ҳатман)(?![\p{L}])/iu;

describe("п.1 the template never opens a sentence with consent (two «Понял.» then «Беру» / «Приеду» / «Мегирам»)", () => {
  const CASES: Array<["ru" | "tg", string, string]> = [["ru", "Беру", "Понял."], ["ru", "Приеду", "Понял."], ["ru", "Беру за 900 тысяч", "Понял."], ["ru", "Ок", "Понял."],
    ["tg", "Мегирам", "Фаҳмидам."], ["tg", "Шанбе меоям", "Фаҳмидам."], ["tg", "Хуб", "Фаҳмидам."]];
  it.each(CASES)("%s «%s» after two «%s» → a neutral thanks, no «Хорошо/Хуб»", (language, inputText, ack) => {
    const turns: Turn[] = [ack, ack].flatMap(text => [{ role: "user", text: inputText }, { role: "assistant", text }]);
    const rendered = renderCustomerAgentDecisionChecked(input({ language, inputText, turns, social: "acknowledge" }));
    expect(rendered.text).toBe(language === "ru" ? "Спасибо за ваше сообщение." : "Ташаккур барои паёматон.");
    expect(rendered.text).not.toMatch(/хорошо|хуб|принято|қабул/iu);
    expect(rendered.agreement).toEqual([]);
    // The model's thanks on top changes nothing: still no consent anywhere in the sent text.
    const withLead = renderCustomerAgentDecision(input({ language, inputText, turns, social: "acknowledge", answer: { lead: language === "ru" ? "Спасибо!" : "Раҳмат!" } }));
    expect(withLead ?? "").not.toMatch(CONSENT_START);
  });
  it("«Записал.» / «Қайд кардам.» only where a receipt was saved (RECEIPT_AGAIN), no «Хорошо» in front", () => {
    expect(RECEIPT_AGAIN).toEqual({ ru: "Записал.", tg: "Қайд кардам." });
  });
  it("guard: no fixed line the renderer can produce opens a sentence with consent (retired lines are memory only)", () => {
    const retired = new Set(RETIRED_TEMPLATE_LINES);
    for (const line of ["Хорошо, принято.", "Хуб, қабул шуд.", "Хорошо, записал.", "Хуб, қайд кардам.", "Конечно.", "Бале."]) expect(retired.has(line)).toBe(true);
    const offenders = [...customerAgentFixedLines()].filter(line => !retired.has(line) && withoutAgreementOpenings(line).removed.length);
    expect(offenders).toEqual([]);
  });
  it("the same question asked again: the facts again after a neutral thanks, never «Конечно.» / «Бале.»", () => {
    for (const [language, inputText] of [["ru", "Цена объекта 123?"], ["tg", "Нархи объекти 123 чанд?"]] as const) {
      const first = renderCustomerAgentDecision(input({ language, inputText, evidence: price }))!;
      const again = renderCustomerAgentDecision(input({ language, inputText, evidence: price, turns: [{ role: "user", text: inputText }, { role: "assistant", text: first }] }))!;
      // Round 7 (п.4): the Tajik lead is «Раҳмат барои саволатон.», never a phrase the model may write itself.
      expect(again).toBe(`${language === "ru" ? "Спасибо за ваш вопрос." : "Раҳмат барои саволатон."}\n${first}`);
      expect(again).not.toMatch(CONSENT_START);
    }
  });
});

describe("п.1 the last door: withoutAgreementOpenings on the whole text", () => {
  it.each([
    ["Хорошо, принято.", ""], ["Хуб, қабул шуд.", ""], ["Хорошо, записал.", "Записал."], ["Конечно.", ""], ["Бале.", ""], ["Да.", ""], ["Бемалол.", ""],
    ["Хеле хуб!", ""], ["Майлаш", ""], ["Ok, понял.", "Понял."], ["«Хорошо», понял.", "Понял."], ["С удовольствием! Объект №5.", "Объект №5."],
    ["Спасибо!\nКонечно, цена 900 000.\nКакой бюджет?", "Спасибо!\nЦена 900 000.\nКакой бюджет?"], ["Без проблем, обязательно позвоним.", "Обязательно позвоним."], // round 7: no mark after «обязательно»
  ])("%j → %j", (text, expected) => {
    const checked = withoutAgreementOpenings(text);
    expect(checked.text).toBe(expected);
    expect(checked.removed.length).toBeGreaterThan(0);
  });
  it.each(["Да, объект свободен.", "Бале, дар ноҳияи Сино вариантҳо ҳастанд.", "Да, конечно. Расскажите о себе и своём опыте на таджикском.",
    "Бемалол, рақамро нависед.", "Бемалол бигӯед, чӣ қадар маблағ дар назар доред?", "Согласно договору, цена 900.", "Окна на юг.",
    "Объект дода мешавад.", "Можно рассмотреть эти варианты:", "Хорошая квартира в Сино.", "Спасибо, передам руководству."])("no false hit: %j", text => {
    expect(withoutAgreementOpenings(text)).toEqual({ text, removed: [] });
  });
  it("every vetted phrase and approved question passes the door untouched", () => {
    for (const language of ["ru", "tg"] as const) {
      for (const role of ["lead", "close"] as const) for (const [text] of HUMAN_PHRASES[language][role]) expect(withoutAgreementOpenings(text).removed).toEqual([]);
      for (const list of Object.values(APPROVED_ASKS[language])) for (const text of list) expect(withoutAgreementOpenings(text).removed).toEqual([]);
    }
  });
  it("a `say` phrase «Хорошо, понимаю вас.» is refused by the say check (round 7, п.3): the template goes out, nothing to report", () => {
    const rendered = renderCustomerAgentDecisionChecked(input({ language: "ru", inputText: "Беру за 900", say: "Хорошо, понимаю вас.", social: "acknowledge" }));
    expect(rendered.text).toBe("Понял.");
    expect(rendered.agreement).toEqual([]);
    // The seal re-renders the same text (one door).
    expect(renderCustomerAgentDecision(input({ language: "ru", inputText: "Беру за 900", say: "Хорошо, понимаю вас.", social: "acknowledge" }))).toBe("Понял.");
  });
  it("the core door logs the removal to the error journal (logSystemError), once per sentence (dedup)", async () => {
    const sentence = `Хорошо, проверка ${Date.now()}.`;
    reportCustomerAgentAgreementOpening([sentence, sentence]);
    reportCustomerAgentAgreementOpening([sentence]);
    await new Promise(resolve => setTimeout(resolve, 300));
    await expect.poll(async () => (await prisma.errorLog.findMany({ where: { message: { contains: sentence } } })).length, { timeout: 15_000, interval: 200 }).toBe(1);
    const row = await prisma.errorLog.findFirst({ where: { message: { contains: sentence } } });
    expect(row?.message).toContain("Слово согласия в начале фразы убрано");
    // Round 7 (п.3): the model's «Хорошо, …» never reaches the journal (the say check refuses it); review7 checks that no row is written.
    expect(renderCustomerAgentText(input({ language: "ru", inputText: "Беру за 900", say: "Хорошо, понимаю вас.", social: "acknowledge" }))).toBe("Понял.");
  });
  it("source guard: the core renders customer text only through renderCustomerAgentText (the checked door)", () => {
    const core = readFileSync(new URL("../src/ai/customerAgentCore.ts", import.meta.url), "utf8");
    expect(core).not.toMatch(/renderCustomerAgentDecision\(/u);
    expect((core.match(/renderCustomerAgentDecisionChecked\(/gu) ?? []).length).toBe(1);
  });
});

describe("п.2 «С удовольствием расскажу.» removed; the eager forms agree; «бемалол» before a request does not", () => {
  it("the phrase is gone from the list and from the model guidance", () => {
    expect(HUMAN_PHRASES.ru.lead.map(([text]) => text)).not.toContain("С удовольствием расскажу.");
    expect(CUSTOMER_AGENT_ANSWER_GUIDANCE).not.toContain("С удовольствием расскажу.");
  });
  it.each(["С удовольствием расскажу.", "С удовольствием!", "Обязательно.", "Без проблем.", "Принято.", "Сделаем.", "Бемалол.", "Бемалол!", "Албатта.", "Ҳатман.",
    "Бешубҳа!", "Хуб, қабул шуд.", "Ҳатман, фаҳмидам."])("%j agrees", text => { expect(humanPhraseAgrees(text)).toBe(true); });
  it.each(["Бемалол, рақамро нависед.", "Бемалол бигӯед, чӣ қадар маблағ дар назар доред?", "Бемалол, агент ба шумо тамос мегирад."])("%j does not agree («пожалуйста»)", text => {
    expect(humanPhraseAgrees(text)).toBe(false);
  });
  it("no remaining vetted phrase or approved question agrees; the Tajik «Бемалол бигӯед» example still passes", () => {
    for (const language of ["ru", "tg"] as const) {
      for (const role of ["lead", "close"] as const) for (const [text] of HUMAN_PHRASES[language][role]) expect([text, humanPhraseAgrees(text)]).toEqual([text, false]);
      for (const list of Object.values(APPROVED_ASKS[language])) for (const text of list) expect([text, humanPhraseAgrees(text)]).toEqual([text, false]);
    }
    const example = CUSTOMER_AGENT_ANSWER_EXAMPLES.tg[0];
    const v = verdict({ language: "tg", inputText: "3 ҳуҷра", question: "budget", answer: example });
    expect(v?.ok).toBe(true);
    expect(v?.text).toContain("Бемалол бигӯед, чӣ қадар маблағ дар назар доред?");
  });
});

describe("п.3 one meaning once in the whole reply; a greeting only first", () => {
  const ru = { language: "ru" as const, inputText: "3 комнаты", question: "budget" };
  const tg = { language: "tg" as const, inputText: "3 ҳуҷра", question: "budget" };
  it.each([
    [ru, "Понял вас. Поняла вас."], [ru, "Понимаю вас. Понял вас."], [ru, "Понял вас, спасибо. Понял, спасибо."], [ru, "Спасибо! Спасибо за интерес."],
    [ru, "Извините за задержку. Извините за ожидание."], [tg, "Раҳмат! Ташаккур!"], [tg, "Фаҳмидам. Мефаҳмам."], [tg, "Фаҳмидам, раҳмат. Раҳмат, фаҳмидам."],
  ])("%#: lead %j → repeat", (c, lead) => { expect(verdict({ ...c, answer: { lead } })).toEqual({ ok: false, reason: "repeat" }); });
  it("a greeting not first is refused, first is fine", () => {
    expect(verdict({ ...ru, social: "greet", answer: { lead: "Спасибо! Здравствуйте!" } })?.ok).toBe(false);
    expect(verdict({ ...tg, social: "greet", answer: { lead: "Раҳмат! Салом!" } })?.ok).toBe(false);
    expect(verdict({ ...ru, social: "greet", answer: { lead: "Здравствуйте! Спасибо!" } })?.ok).toBe(true);
    expect(humanPhrasesClash(["Здравствуйте!", "Спасибо!"])).toBe(false);
    expect(humanPhrasesClash(["Спасибо!", "Здравствуйте!"])).toBe(true);
  });
  it("two groups in one reply are fine («Спасибо! Понял вас.»), the same group across lead and close is not", () => {
    expect(verdict({ ...ru, answer: { lead: "Спасибо! Понял вас." } })?.ok).toBe(true);
    const fact = { language: "ru" as const, inputText: "Цена объекта 123?", evidence: price };
    expect(verdict({ ...fact, answer: { lead: "Спасибо, что написали!", close: "Всего доброго!" } })?.ok).toBe(true);
    expect(verdict({ ...fact, answer: { lead: "Спасибо, что написали!", close: "Спасибо за ваш вопрос!" } })).toEqual({ ok: false, reason: "repeat" });
    const factTg = { language: "tg" as const, inputText: "Нархи объекти 123 чанд?", evidence: price };
    expect(verdict({ ...factTg, answer: { lead: "Раҳмат, ки навиштед!", close: "Ташаккур, саломат бошед!" } })).toEqual({ ok: false, reason: "repeat" });
  });
  it("the template's own thanks that stays (no lead) and a thanks close: refused", () => {
    expect(verdict({ language: "ru", inputText: "Цена объекта 123?", evidence: price, social: "thank", answer: { close: "Спасибо!" } })).toEqual({ ok: false, reason: "repeat" });
    expect(verdict({ language: "ru", inputText: "Цена объекта 123?", evidence: price, social: "thank", answer: { close: "Всего доброго!" } })?.ok).toBe(true);
  });
});

describe("п.4 an agreement word is its own drop reason (answer_dropped_agree)", () => {
  it("the reason exists with a label", () => {
    expect(customerAgentAnswerDropReasonSchema.options).toContain("agree");
    expect(GUARD_LABELS.answer_dropped_agree).toMatch(/согласия/u);
  });
  it.each([["ru", "Хорошо."], ["ru", "С удовольствием расскажу."], ["ru", "Хорошо, понял вас."], ["ru", "Обязательно."], ["tg", "Хуб."], ["tg", "Майлаш."], ["tg", "Бемалол."]] as const)(
    "%s lead %j → agree", (language, lead) => {
      expect(verdict({ language, inputText: language === "ru" ? "Беру" : "Мегирам", question: "budget", answer: { lead } })).toEqual({ ok: false, reason: "agree" });
    });
  it("a fact claim keeps its own (serious) reason: «Да, свободен.» is a claim first; «Албатта.» alone is an agreement (round 7, п.5)", () => {
    expect(verdict({ language: "ru", inputText: "Свободен?", question: "budget", answer: { lead: "Да, свободен." } })?.reason).toBe("claim");
    expect(verdict({ language: "tg", inputText: "Мегирам", question: "budget", answer: { lead: "Албатта." } })?.reason).toBe("agree");
  });
});
