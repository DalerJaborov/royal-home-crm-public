import { describe, expect, it } from "vitest";
import { customerAgentAnswerVerdict, renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerSellerAskedTerms } from "../src/ai/customerAgentSellerGuard.js";
import { HUMAN_PHRASES } from "../src/ai/customerAgentHumanText.js";

/**
 * Third review of #211 (16.11.2026, HEAD ef13ea05; review-211/apps/api/tmp-review/probe4.ts). Round 3: the model's lead / close is
 * a WHOLE vetted phrase (not a word allowlist), «Хорошо/Хуб/Майлаш» never answer a customer's request, no time-of-day greeting,
 * «Саломат бошед!» is a farewell close. Every probe4 case is here.
 */
const hash = "a".repeat(64);
const facts = (o: Record<string, unknown> = {}) => ({ propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "1250000", currency: "TJS",
  availability: "AVAILABLE", publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only", builder: null, publicLink: null,
  updatedAt: "2026-10-15T00:00:00.000Z", signature: hash, ...o });
const knowledge = readCustomerAgentCompanyKnowledge(), kh = customerAgentCompanyKnowledgeHash(knowledge);
type Case = { language?: "ru" | "tg"; inputText: string; requestedFacts?: string[]; d: Record<string, unknown>; evidence?: unknown[] };
const inp = (o: Case, answer?: unknown) => ({ knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", knowledgeSourceHash: kh, language: o.language ?? "ru",
  inputText: o.inputText, requestedFacts: o.requestedFacts ?? [], evidence: o.evidence ?? [], decision: { ...o.d, ...(answer === undefined ? {} : { answer }) } }) as never;
const pol = (topic: string) => [{ ref: "e0", value: { kind: "company_policy", topic, knowledge, sourceHash: kh } }];
const reply = (refs: string[], question = "none", social = "none") => ({ kind: "reply", refs, social, question });
const cl = (question: string, social = "none") => ({ kind: "clarify", refs: [], social, question });
const price = [{ ref: "e0", value: { kind: "facts", facts: facts(), kinds: ["price"] } }];
const sold = [{ ref: "e0", value: { kind: "facts", facts: facts({ availability: "SOLD" }), kinds: ["price"] } }];
const C: Record<string, Case> = {
  discountRu: { inputText: "Можно скидку на 123?", requestedFacts: ["price"], d: reply(["e0"]), evidence: price },
  viewRu: { inputText: "Можно завтра посмотреть 123?", requestedFacts: ["price"], d: reply(["e0"]), evidence: price },
  discountTg: { language: "tg", inputText: "Тахфиф мешавад барои 123?", requestedFacts: ["price"], d: reply(["e0"]), evidence: price },
  priceRu: { inputText: "Цена объекта 123?", requestedFacts: ["price"], d: reply(["e0"]), evidence: price },
  priceTg: { language: "tg", inputText: "Нархи объекти 123 чанд?", requestedFacts: ["price"], d: reply(["e0"]), evidence: price },
  soldRu: { inputText: "Цена объекта 123?", requestedFacts: ["price"], d: reply(["e0"]), evidence: sold },
  soldTg: { language: "tg", inputText: "Нархи объекти 123 чанд?", requestedFacts: ["price"], d: reply(["e0"]), evidence: sold },
  comRu: { inputText: "Какая у вас комиссия?", d: reply(["e0"], "role"), evidence: pol("commission") },
  roomsRu: { inputText: "Ищу квартиру", d: cl("rooms") }, roomsTg: { language: "tg", inputText: "Хона мехарам", d: cl("rooms") },
  greetRu: { inputText: "Здравствуйте, ищу квартиру", d: cl("rooms", "greet") }, greetTg: { language: "tg", inputText: "Салом, хона мехарам", d: cl("rooms", "greet") },
  zoneRu: { inputText: "Вы работаете в Худжанде?", d: reply(["e0"]), evidence: pol("service_scope") },
};
const ok = (c: Case, answer: unknown) => !!(customerAgentAnswerVerdict(inp(c, answer)) as { ok?: boolean } | null)?.ok;

describe("probe4 A/B/C: word combinations, implicit «да», praise, time greetings, spelling tricks", () => {
  it.each([
    ["ru Хорошо = yes to discount", C.discountRu, { lead: "Хорошо." }],
    ["ru Хорошо, могу = yes", C.discountRu, { lead: "Хорошо, могу." }],
    ["ru Хорошо = yes to viewing tomorrow", C.viewRu, { lead: "Хорошо, понял вас." }],
    ["tg Хуб = yes to discount", C.discountTg, { lead: "Хуб." }],
    ["tg Майлаш = yes", C.discountTg, { lead: "Майлаш." }],
    ["tg Хеле хуб = yes", C.discountTg, { lead: "Хеле хуб." }],
    ["ru Это ваше (possession)", C.priceRu, { lead: "Это ваше." }],
    ["ru Это ваше + sold", C.soldRu, { lead: "Это ваше." }],
    ["tg Ин барои шумо", C.priceTg, { lead: "Ин барои шумо." }],
    ["tg Ин барои шумо + sold", C.soldTg, { lead: "Ин барои шумо." }],
    ["ru вам ждать + sold", C.soldRu, { lead: "Вам ждать." }],
    ["ru Могу и это + sold", C.soldRu, { lead: "Могу и это." }],
    ["ru zone: Понимаю, могу", C.zoneRu, { lead: "Понимаю, могу." }],
    ["ru zone: Могу ответить", C.zoneRu, { lead: "Могу ответить." }],
    ["ru comm: Вам и за это спасибо", C.comRu, { lead: "Вам и за это спасибо." }],
    ["ru Это очень хорошо + price", C.priceRu, { lead: "Это очень хорошо." }],
    ["ru Очень приятно + price", C.priceRu, { lead: "Очень приятно." }],
    ["ru close Это хорошо", C.priceRu, { close: "Это очень хорошо." }],
    ["tg Ин хуб + price", C.priceTg, { lead: "Ин хуб." }],
    ["tg Хуб кор + price", C.priceTg, { lead: "Хуб кор." }],
    ["ru comm: Это хорошо для вас", C.comRu, { lead: "Это хорошо для вас." }],
    ["ru Добрый вечер (time)", C.greetRu, { lead: "Добрый вечер!" }],
    ["ru Доброе утро (time)", C.greetRu, { lead: "Доброе утро!" }],
    ["tg Шом ба хайр", C.greetTg, { lead: "Шом ба хайр!" }],
    ["tg no tajik letters: Фахмидам", C.priceTg, { lead: "Фахмидам." }],
    ["tg Рахмат", C.priceTg, { lead: "Рахмат, ки навиштед." }],
    ["tg homoglyph latin a", C.priceTg, { lead: "Фаҳмидaм." }],
    ["ru combining acute", C.priceRu, { lead: "Понима́ю вас." }],
    ["ru cyr homoglyph i", C.priceRu, { lead: "Спасибо, понімаю." }],
    ["tg ҳ vs һ", C.priceTg, { lead: "Фаһмидам." }],
    ["tg ӣ decomposed", C.priceTg, { lead: "Фаҳмидам, раӣ." }],
    ["ru hyphen join", C.priceRu, { lead: "Понимаю-вас." }],
    ["ru warm next to sold", C.soldRu, { lead: "Рады вашему сообщению." }],
    ["ru agree next to sold", C.soldRu, { lead: "Хорошо." }],
  ] as Array<[string, Case, unknown]>)("%s → template", (_name, c, answer) => {
    expect(ok(c, answer)).toBe(false);
    expect(renderCustomerAgentDecision(inp(c, answer))).toBe(renderCustomerAgentDecision(inp(c)));
  });
  it.each([
    ["ru Понял, спасибо", C.priceRu, { lead: "Понял, спасибо." }],
    ["ru Спасибо, что вы написали", C.priceRu, { lead: "Спасибо, что вы написали." }],
    ["ru zero-width inside", C.priceRu, { lead: `Пони${String.fromCharCode(0x200b)}маю вас.` }],
    ["ru soft hyphen", C.priceRu, { lead: `Пони${String.fromCharCode(0xad)}маю вас.` }],
    ["ru neutral answer to a request", C.viewRu, { lead: "Понимаю вас." }],
    ["tg neutral answer to a request", C.discountTg, { lead: "Фаҳмидам." }],
    ["ru neutral next to sold", C.soldRu, { lead: "Понимаю вас." }],
    ["ru farewell after sold", C.soldRu, { close: "Всего доброго!" }],
    ["tg farewell after sold", C.soldTg, { close: "Саломат бошед!" }],
  ] as Array<[string, Case, unknown]>)("%s → goes out", (_name, c, answer) => {
    expect(ok(c, answer)).toBe(true);
  });
});

describe("probe4 D: realistic warm phrases (tightness: vetted ones pass, the rest is the template)", () => {
  const RU_PASS = ["Здравствуйте!", "Спасибо, что написали!", "Понимаю вас.", "Благодарю за терпение.", "Извините за задержку.", "Вот что могу сказать.",
    "Спасибо, что обратились к нам.", "Понял вас, спасибо.", "Ясно, спасибо.", "Спасибо за ваше сообщение.", "Рады, что вы обратились.",
    "Спасибо, что дождались ответа.", "Извините, что пришлось ждать.", "Понимаю, это важный вопрос.", "Спасибо за интерес."];
  const RU_DROP = ["Спасибо за вопрос.", "Хороший вопрос.", "Отлично!", "Конечно!", "Секунду.", "Сейчас подскажу.", "Давайте посмотрим.",
    "Вот информация по этому объекту.", "Очень приятно.",
    // round 5 (17.11): no agreement phrase at all, so these moved from «passes» to «dropped»
    "Хорошо, понял вас.", "Хорошо.", "Хорошо, спасибо.",
    // round 6 (17.11): «С удовольствием» reads as «да» to «Сделаете скидку?»
    "С удовольствием расскажу."];
  const TG_PASS = ["Ассалому алайкум!", "Раҳмат, ки навиштед!", "Фаҳмидам.", "Ташаккур барои саволатон.", "Бубахшед барои таъхир.", "Раҳмат барои сабр.",
    "Хуш омадед!", "Фаҳмидам, раҳмат.", "Ташаккур, ки ба мо муроҷиат кардед.", "Мефаҳмам.", "Инак маълумот.", "Раҳмати калон!",
    "Ташаккур барои паёматон.", "Бубахшед, ки интизор шудед.", "Салом!", "Раҳмат, фаҳмидам.", "Ташаккур барои таваҷҷуҳ."];
  const TG_DROP = ["Саволи хуб.", /* round 5: no agreement phrase */ "Хуб.", "Хеле хуб.", "Хуб, фаҳмидам.", "Майлаш."];
  const ruCase = (lead: string) => /здрав/iu.test(lead) ? C.greetRu : C.roomsRu;
  const tgCase = (lead: string) => /ассалом|салом|хуш омад/iu.test(lead) ? C.greetTg : C.roomsTg;
  it.each(RU_PASS)("ru lead passes: %s", lead => { expect(ok(ruCase(lead), { lead, ask: "Сколько комнат вам нужно?" })).toBe(true); });
  it.each(RU_DROP)("ru lead dropped: %s", lead => { expect(ok(ruCase(lead), { lead, ask: "Сколько комнат вам нужно?" })).toBe(false); });
  it.each(TG_PASS)("tg lead passes: %s", lead => { expect(ok(tgCase(lead), { lead, ask: "Чанд ҳуҷра лозим аст?" })).toBe(true); });
  it.each(TG_DROP)("tg lead dropped: %s", lead => { expect(ok(tgCase(lead), { lead, ask: "Чанд ҳуҷра лозим аст?" })).toBe(false); });
  it.each([["Всего доброго!", true], ["Спасибо!", true], ["Хорошего вам дня!", false], ["Будем рады помочь.", false], ["Обращайтесь!", false], ["Хорошего вечера!", false]] as const)(
    "ru close %s → %s", (close, expected) => { expect(ok(C.priceRu, { close })).toBe(expected); });
  it.each([["Саломат бошед!", true], ["Барори кор!", true], ["Раҳмат!", true], ["Бо эҳтиром.", true], ["Рӯзи хуш!", false], ["Шом ба хайр!", false]] as const)(
    "tg close %s → %s", (close, expected) => { expect(ok(C.priceTg, { close })).toBe(expected); });
  it("every vetted phrase passes in its own role and language where nothing forbids it (the list never teaches a dropped phrase)", () => {
    for (const language of ["ru", "tg"] as const) {
      for (const [lead, kind] of HUMAN_PHRASES[language].lead) {
        const c = kind === "greeting" ? (language === "ru" ? C.greetRu : C.greetTg) : language === "ru" ? C.roomsRu : C.roomsTg;
        expect(ok(c, { lead }), `${language} ${lead}`).toBe(true);
      }
      for (const [close] of HUMAN_PHRASES[language].close) expect(ok(language === "ru" ? C.priceRu : C.priceTg, { close }), `${language} ${close}`).toBe(true);
    }
  });
});

describe("probe4 E: seller terms — a question about terms, never the flat's amenities", () => {
  const seller = { intake: { role: "seller", sellerKnown: [], buyerKnown: [] }, turns: [] } as never;
  it.each([["Чи шарту шароит доред?", true], ["Какие у вас условия?", true], ["Продаю квартиру, все условия есть", false], ["Хонаамро мефурӯшам, ҳама шароит дорад", false],
    ["Хонаи 3 ҳуҷрагӣ, шароиташ хуб", false], ["Шароитатон чӣ хел?", true], ["Условия?", true], ["Шартҳоятон чист", true], ["Условия какие у вас", true],
    ["Все условия есть?", false], ["Квартира со всеми условиями, интересует?", false]] as const)("%s → %s", (text, expected) => {
    expect(customerSellerAskedTerms({ inputText: text, verifiedContext: seller })).toBe(expected);
  });
});
