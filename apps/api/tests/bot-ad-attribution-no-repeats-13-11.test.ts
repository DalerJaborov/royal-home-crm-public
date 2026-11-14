import { describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema, recruitmentPhoneLine, type CustomerPropertyFactKind } from "@royal-home/shared";
import { isJobAdRef } from "../src/ai/adTemplateOpener.js";
import { isAckOnlyMessage, isThanksOnlyMessage } from "../src/ai/ackOnly.js";
import { firstTouchAdPatch } from "../src/lib/adAttribution.js";
import { customerIngressPayloadHash, customerNormalizedIngressSchema } from "../src/lib/customerIngressPayload.js";
import { customerAgentFixedLines, customerAgentLineDigest, renderCustomerAgentDecision,
  type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";

/**
 * 13.11.2026, разбор живых чатов 12.11: реклама вакансии без метки на диалоге и
 * «какой объект?» кандидату; список из трёх объектов и блок вакансии по 3-4 раза.
 */
const NL = String.fromCharCode(10);
const hash = "a".repeat(64);
type Turn = { role: "user" | "assistant"; text: string };
const user = (text: string): Turn => ({ role: "user", text });
const bot = (text: string): Turn => ({ role: "assistant", text });
const context = (turns: Turn[], extra: Record<string, unknown> = {}, topic = "buyer") => customerAgentVerifiedContextSchema.parse({
  surface: "dm", revisionId: hash, turns, publicState: { language: "ru", topic, openQuestion: "none" }, ...extra });
const facts = (kinds: CustomerPropertyFactKind[]): CustomerAgentEvidence => ({ ref: "e0", value: { kind: "facts", kinds, facts: {
  propertyId: "00000000-0000-4000-8000-000000000069", shortId: 69, publicLink: null, publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only",
  price: "500000", currency: "TJS", availability: "AVAILABLE", builder: null, updatedAt: "2026-10-31T00:00:00.000Z", signature: "s".repeat(64),
  characteristics: { type: "APARTMENT", rooms: 2, areaSqm: "65", landAreaSotka: null, floor: 5, totalFloors: 9, condition: "GOOD", marketType: null, stage: null } } } as never });
function render(inputText: string, verifiedContext: ReturnType<typeof context>, evidence: CustomerAgentEvidence[], decision: object = {}) {
  return renderCustomerAgentDecision({ decision: { kind: "reply", social: "none", question: "none", refs: evidence.map(e => e.ref), ...decision } as never,
    evidence, language: "ru", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText, verifiedContext });
}

describe("A. реклама вакансии узнаётся, «работаем» в рекламе квартиры не вакансия", () => {
  it.each(["Вакансия: менеджер по продажам", "Ищем сотрудников, работа в офисе", "Приглашаем на работу", "Ҷои кор барои менеҷер", "job"])(
    "вакансия: %s", text => { expect(isJobAdRef(text)).toBe(true); });
  it.each(["Квартира в Сино, работаем без комиссии", "Агентство работает с 2015 года", "Мы работаем для вас", "2-комнатная, 65 м²"])(
    "не вакансия: %s", text => { expect(isJobAdRef(text)).toBe(false); });
});

describe("A. атрибуция пишется первым касанием и не перезаписывается", () => {
  it("пустые поля заполняются, занятые остаются", () => {
    expect(firstTouchAdPatch({}, { adExternalId: "ad-1", adClickId: "clid-1", adTopic: "job" }))
      .toEqual({ adExternalId: "ad-1", adClickId: "clid-1", adTopic: "job" });
    expect(firstTouchAdPatch({ adExternalId: "ad-1", adTopic: "job", adClickId: null }, { adExternalId: "ad-2", adTopic: "property", adClickId: "clid-2", adPropertyId: "p-2" }))
      .toEqual({ adClickId: "clid-2", adPropertyId: "p-2" });
    expect(firstTouchAdPatch({ adExternalId: "ad-1", adClickId: "c", adTopic: "job", adPropertyId: "p" }, { adExternalId: "ad-1" })).toEqual({});
  });
});

describe("A. новое поле входа ядра не ломает очередь", () => {
  const base = { version: 1, channel: "WHATSAPP", peer: "992900000001", accountExternalId: "phone-1", eventKind: "message", eventId: "wamid.1",
    inputText: "Здравствуйте", source: { path: "$.entry[0]", frameHash: "b".repeat(64) },
    observations: { providerEcho: false, referralOnly: false }, media: [], propertyEvidence: [{ kind: "ad", origin: "referral", reference: "ad-1" }] };
  it("старый конверт без adContext читается, хэш события от adContext не зависит", () => {
    const old = customerNormalizedIngressSchema.parse(base);
    const withAd = customerNormalizedIngressSchema.parse({ ...base, adContext: { adId: "ad-1", adRef: "Вакансия менеджер", adClickId: "clid-1" } });
    expect(customerIngressPayloadHash(withAd)).toBe(customerIngressPayloadHash(old));
  });
  it("лишнее поле в adContext не принимается", () => {
    expect(customerNormalizedIngressSchema.safeParse({ ...base, adContext: { adId: "ad-1", phone: "+992" } }).success).toBe(false);
  });
});

describe("A. реклама без объекта: один живой вопрос, без «объект не определился»", () => {
  const unresolved: CustomerAgentEvidence = { ref: "e0", value: { kind: "property_unresolved", status: "missing", reason: "ad_unmapped" } };
  it("первый раз спрашивает, что интересует", () => {
    const text = render("Здравствуйте", context([]), [unresolved], { kind: "clarify", question: "property" });
    expect(text).toBe("Подскажите, пожалуйста, что вас интересует?");
  });
  it("второй раз тот же вопрос не задаётся", () => {
    const first = render("Здравствуйте", context([]), [unresolved], { kind: "clarify", question: "property" })!;
    const again = render("Здравствуйте", context([user("Здравствуйте"), bot(first)]), [unresolved], { kind: "clarify", question: "property" });
    expect(again).not.toBe(first);
  });
  it("вопрос попадает в память разговора как фиксированная строка", () => {
    expect(customerAgentFixedLines().has("Подскажите, пожалуйста, что вас интересует?")).toBe(true);
  });
});

describe("B. блок, уже отправленный в разговоре, не уходит снова", () => {
  const all = [facts(["price", "address", "characteristics"])];
  const block = () => render("расскажите", context([user("расскажите")]), all)!;
  it("A, B, A: блок двухходовой давности ловится по памяти строк, а не только по прошлому ходу", () => {
    const a = block();
    expect(a.split(NL).length).toBeGreaterThanOrEqual(3);
    const digests = a.split(NL).map(customerAgentLineDigest);
    const again = render("расскажите", context([user("расскажите"), bot("Какой бюджет вы рассматриваете?"), user("1 млн")], { sentLineDigests: digests }), all)!;
    expect(again).not.toContain("500 000");
    expect(again.split(NL)).toHaveLength(1);
    expect(again).not.toContain("—");
    expect(again).not.toMatch(/Повторю ещё раз/u);
  });
  it("без памяти строк тот же блок при новом разговоре уходит как есть", () => {
    expect(render("расскажите", context([user("привет"), bot("Здравствуйте!")]), all)).toBe(block());
  });
  it("вопрос, который ещё не задавали, остаётся после короткой строки", () => {
    const a = block();
    const again = render("расскажите", context([user("расскажите"), bot(a)]), all, { question: "budget" })!;
    expect(again.split(NL)).toHaveLength(2);
    expect(again.endsWith("Какой бюджет вы рассматриваете?")).toBe(true);
  });
  it("короткая строка во второй раз другая, третьей копии нет", () => {
    const a = block();
    const second = render("расскажите", context([user("расскажите"), bot(a)]), all)!;
    const third = render("расскажите", context([user("расскажите"), bot(a), user("расскажите"), bot(second)]), all)!;
    expect(third).not.toBe(second);
  });
});

describe("B. список вакансий показывается один раз, вопрос по работе получает ответ", () => {
  const position = { key: "real-estate-agent", revision: 1, titleRu: "Менеджер по продажам недвижимости", titleTg: "Менеҷери фурӯши амволи ғайриманқул",
    detailsRu: "", detailsTg: "", isOpen: true, keywords: [], postCodes: [] };
  const second = { ...position, key: "smm", titleRu: "SMM-менеджер", titleTg: "Менеҷери SMM" };
  const data = { collecting: true, positions: [position, second] };
  const catalog: CustomerAgentEvidence = { ref: "e0", value: { kind: "open_vacancies", ...data, sourceHash: recruitmentCatalogHash(data) } as never };
  const listed = ["Сейчас открыты вакансии:", position.titleRu, second.titleRu, recruitmentPhoneLine("ru")].join(NL);
  it("первый раз список и номер специалиста", () => {
    const text = render("какие есть вакансии?", context([], {}, "job"), [catalog])!;
    expect(text).toContain("Сейчас открыты вакансии:");
    expect(text).toContain(recruitmentPhoneLine("ru"));
  });
  it.each(["какой график?", "сколько платят?", "где офис?", "а как устроиться?"])("после списка «%s» не печатает список заново", question => {
    const text = render(question, context([user("какие есть вакансии?"), bot(listed)], {}, "job"), [catalog])!;
    expect(text).not.toContain("Сейчас открыты вакансии:");
    expect(text).not.toContain(second.titleRu);
    expect(text).toContain(recruitmentPhoneLine("ru"));
  });
  it("список ловится и по памяти строк, когда ход со списком выпал из шести последних", () => {
    const digests = listed.split(NL).map(customerAgentLineDigest);
    const text = render("а зарплата?", context([user("ок"), bot("Хорошо, принято."), user("а зарплата?")], { sentLineDigests: digests }, "job"), [catalog])!;
    expect(text).not.toContain("Сейчас открыты вакансии:");
  });
});

describe("B. поиск без уже показанных объектов: пусто — значит «новых нет», а не «ничего не найдено»", () => {
  const search = (nextPage: boolean): CustomerAgentEvidence => ({ ref: "e0", value: { kind: "property_search",
    query: { type: "APARTMENT", rooms: 2, ...(nextPage ? { nextPage: true } : {}) }, coverage: "bounded_ranked_pool", poolLimit: 500,
    policyHash: "c".repeat(64), cards: [], linksAllowed: true } as never });
  it("исключили показанные и ничего не осталось", () => {
    const text = render("двушка есть?", context([]), [search(true)])!;
    expect(text).toContain("Новых вариантов по этому запросу сейчас нет");
    expect(text).not.toContain("не найдено");
  });
  it("обычный пустой поиск говорит как раньше", () => {
    expect(render("двушка есть?", context([]), [search(false)])).toContain("подходящих вариантов не найдено");
  });
});

describe("B. «спасибо» — только благодарность, «ок» на вопрос — ответ", () => {
  it.each(["спасибо", "Спасибо большое!", "рахмат брат", "ташаккур 🙏", "thanks"])("благодарность: %s", text => {
    expect(isThanksOnlyMessage(text)).toBe(true);
  });
  it.each(["ок", "да, спасибо", "хорошо спасибо", "спасибо, а зарплата?", "спасибо 900123456"])("не только благодарность: %s", text => {
    expect(isThanksOnlyMessage(text)).toBe(false);
  });
  it("ок по-прежнему подтверждение", () => { expect(isAckOnlyMessage("ок")).toBe(true); });
});
