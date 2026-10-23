import { describe, expect, it, vi } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerPropertyAdmission, type CustomerPropertyEvidence } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerCompanyInformationRequested, customerAgentPropertyQuestionTexts,
  type CustomerAgentEvidence, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyInformationHash } from "../src/ai/customerAgentPublicProtocol.js";
import { recruitmentCatalogHash, customerRecruitmentRequested } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { containsRecruitmentExperienceInvitation } from "../src/ai/customerRecruitmentReply.js";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";
import { customerPropertyUrl } from "../src/lib/customerPropertyUrls.js";
import { customerPropertyEvidenceFromText } from "../src/lib/customerPropertyEvidence.js";
import { customerBarePropertyAnswer } from "../src/lib/customerBarePropertyAnswer.js";
import { customerPropertyUnresolvedReason } from "../src/lib/customerPropertyUnresolvedReason.js";
import { recruitmentOcrText } from "../src/lib/recruitmentOcr.js";
import { resolveCustomerPropertyEvidence, type CustomerPropertyRegistry } from "../src/lib/customerPropertyResolver.js";
import { logSystemError } from "../src/lib/systemError.js";

vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn() }));

const PROPERTY = "00000000-0000-4000-8000-000000000001";
const facts = { propertyId: PROPERTY, shortId: 123, price: "600000", currency: "TJS" as const, availability: "AVAILABLE" as const,
  publicAddress: "Synthetic district, Душанбе", addressPolicy: "district_city_only" as const, builder: null, publicLink: null,
  updatedAt: "2026-10-15T00:00:00.000Z", signature: "a".repeat(64) };
const characteristics = { type: "APARTMENT" as const, rooms: 2, areaSqm: "50", landAreaSotka: null, floor: 3, totalFloors: 9,
  condition: null, marketType: null, stage: null };
const info = { name: "Royal Home", city: "Душанбе", office: "ул. Тестовая, 1", services: "Продажа и помощь в покупке",
  hours: { start: "09:30", end: "18:00", daysOff: [0] } };
const company: CustomerAgentObservation = { kind: "company_information", information: info, sourceHash: customerAgentCompanyInformationHash(info) };
const context = (turns: Array<{ role: "user" | "assistant"; text: string }> = [], publicState: Record<string, unknown> = {}) =>
  customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns, publicState });
const position = (extra: Record<string, unknown> = {}) => ({ key: "smm", revision: 1, titleRu: "SMM-специалист", titleTg: "SMM-мутахассис",
  detailsRu: "", detailsTg: "", isOpen: true, keywords: ["smm"], postCodes: [], screeningRules: null, ...extra });
function vacancies(collecting: boolean, positions: ReturnType<typeof position>[] = []): CustomerAgentObservation {
  const value = { collecting, positions };
  return { kind: "open_vacancies", ...value, sourceHash: recruitmentCatalogHash(value) } as CustomerAgentObservation;
}
function render(evidence: CustomerAgentEvidence[], extra: Record<string, unknown> = {}, question = "none", language: "ru" | "tg" = "ru") {
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: evidence.map(e => e.ref), social: "none", question } as never,
    evidence, language, requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", ...extra });
}
const ev = (value: CustomerAgentObservation, ref = "e0"): CustomerAgentEvidence => ({ ref, value });

describe("F10 company information: services, hours and address by word boundaries", () => {
  it.each([["Какие у вас услуги?", "ru"], ["Чем вы занимаетесь?", "ru"]] as const)("answers the services question %s without the office", (inputText, language) => {
    const text = render([ev(company)], { inputText, language });
    expect(text).toBe("Услуги Royal Home: продажа и помощь в покупке.");
  });
  it("answers хизматҳо in Tajik with the services only", () => {
    expect(render([ev(company)], { inputText: "Шумо кадом хизматҳо доред?", language: "tg" })).toBe("Хизматҳои Royal Home: фурӯш ва кӯмак дар харидани амвол.");
  });
  it("keeps the services question for the automatic read, and not the commission one", () => {
    expect(customerCompanyInformationRequested("Какие у вас услуги?")).toBe(true);
    expect(customerCompanyInformationRequested("Хизматҳои шумо кадомҳоянд?")).toBe(true);
    expect(customerCompanyInformationRequested("Ҳаққи хизмат чанд фоиз аст?")).toBe(false);
    expect(customerCompanyInformationRequested("Сколько стоят услуги риелтора?")).toBe(false);
  });
  it.each(["До скольки вы работаете?", "Кай кор мекунед? Соат чанд?", "Часы работы подскажите"])("answers only the hours for %s", inputText => {
    const text = render([ev(company)], { inputText }) ?? "";
    expect(text).toContain("Сотрудники на связи с 09:30 до 18:00"); expect(text).not.toContain("Офис Royal Home");
  });
  it("treats суроға as an address question, not as hours", () => {
    const text = render([ev(company)], { inputText: "Суроғаи шумо кадом аст?", language: "tg" }) ?? "";
    expect(text).toContain("Идораи Royal Home: Душанбе, ул. Тестовая, 1.");
  });
  it("does not read «участок» as «час»", () => {
    const text = render([ev(company)], { inputText: "Где ваш офис? Мне нужен участок" }) ?? "";
    expect(text).toContain("Офис Royal Home: Душанбе, ул. Тестовая, 1.");
  });
});

describe("F10 price per square metre is server arithmetic", () => {
  const priceFacts = (extra: Record<string, unknown> = {}) => ev({ kind: "facts", kinds: ["price"], facts: { ...facts, ...extra } } as CustomerAgentObservation);
  it("is computed from the confirmed price and area, whole units, marked approximate", () => {
    const text = render([priceFacts({ characteristics })], { inputText: "Сколько стоит квадратный метр?", requestedFacts: ["price"] });
    expect(text).toBe("Цена объекта №123: 600 000 сомони.\nЦена за квадратный метр: ≈ 12 000 сомони.");
  });
  it("rounds to a whole number", () => {
    const text = render([priceFacts({ price: "123456.78", characteristics: { ...characteristics, areaSqm: "54.5" } })], { inputText: "цена за м2", requestedFacts: ["price"] });
    expect(text).toContain("≈ 2 265 сомони");
  });
  it("says honestly that the area is not given", () => {
    const text = render([priceFacts()], { inputText: "цена за кв.м?", requestedFacts: ["price"] }) ?? "";
    expect(text).toContain("Площадь не указана"); expect(text).not.toContain("≈");
  });
  it("is not added to a plain price question", () => {
    expect(render([priceFacts({ characteristics })], { inputText: "Сколько стоит?", requestedFacts: ["price"] })).toBe("Цена объекта №123: 600 000 сомони.");
  });
  it.each(["Сколько стоит квадратный метр в объекте №123?", "Цена за м² объекта #123", "Нархи як метри мураббаъ дар объекти №5?"])("is a fast-path price question: %s", text => {
    expect(classifyCustomerPropertyFactIntent(text)).toEqual(["price"]);
  });
});

describe("F11 one meaning block is rendered once", () => {
  it("collapses two refs to the same company information", () => {
    const text = render([ev(company, "e0"), ev(company, "e1")], { inputText: "Где ваш офис?" }) ?? "";
    expect(text.match(/Офис Royal Home/g)).toHaveLength(1); expect(text.match(/Сотрудники на связи/g)).toHaveLength(1);
  });
  it("collapses identical vacancy catalogs and identical fact blocks", () => {
    const catalog = vacancies(true, [position()]);
    const text = render([ev(catalog, "e0"), ev(catalog, "e1")], { inputText: "Есть вакансии?" }) ?? "";
    expect(text.match(/SMM-специалист/g)).toHaveLength(1);
  });
});

describe("F13 «no vacancies» answers", () => {
  it("never says CRM and tells an empty catalog from a switched-off one", () => {
    const empty = render([ev(vacancies(true))], { inputText: "Есть работа?" }) ?? "";
    const off = render([ev(vacancies(false))], { inputText: "Есть работа?" }) ?? "";
    expect(empty).toBe("Сейчас открытых вакансий нет."); expect(off).toBe("Приём откликов через этот чат сейчас не ведётся.");
    expect(`${empty}${off}`).not.toMatch(/CRM/);
    expect(render([ev(vacancies(true))], { inputText: "Есть работа?", language: "tg" })).not.toMatch(/CRM/);
  });
  it("names the ad's vacancy when it is known", () => {
    expect(render([ev(vacancies(true))], { inputText: "Есть работа?", verifiedContext: context([], { topic: "job", jobPositionKey: "smm" }) }))
      .toBe("По этой вакансии набор сейчас не подтверждён.");
  });
  it("does not suppress the customer's next step after an empty catalog", () => {
    expect(render([ev(vacancies(true))], { inputText: "Есть работа?" }, "name")).toBe("Сейчас открытых вакансий нет.\nКак к вам обращаться?");
    expect(render([ev(vacancies(true))], { inputText: "Есть работа?" }, "job_position")).toBe("Сейчас открытых вакансий нет.");
    expect(render([ev(vacancies(true))], { inputText: "Есть работа?" }, "budget")).toBe("Сейчас открытых вакансий нет.");
  });
  it("recognises «есть работа?» as a job request that reads the catalog", () => {
    for (const text of ["Есть работа?", "У вас есть работа", "Шумо кор доред?"]) expect(customerRecruitmentRequested(text)).toBe(true);
    expect(customerRecruitmentRequested("Есть работники у вас?")).toBe(false);
  });
});

describe("F07 the résumé is asked once", () => {
  const saved = ev({ kind: "receipt", outcome: "job_application_saved" }, "e1");
  const job = { topic: "job", jobPositionKey: "smm" };
  const catalog = ev(vacancies(true, [position()]));
  const perceived = (subject: "document" | "home_interior", readableText: string) => ({ language: "ru", transcript: "", subject, visible: [], readableText, speech: "none" });
  const renderJob = (extra: Record<string, unknown>, turns: Array<{ role: "user" | "assistant"; text: string }> = []) =>
    render([catalog, saved], { verifiedContext: context(turns, job), ...extra }, "name") ?? "";
  it("control: a bare message after the receipt still gets one request for the résumé", () => {
    expect(renderJob({ inputText: "Здравствуйте" })).toContain("Пришлите резюме");
  });
  it("does not ask for it after a document or a photographed résumé", () => {
    const text = renderJob({ inputText: "", mediaPerception: perceived("document", "Резюме. Меня зовут Мадина. Опыт: три года ведения Instagram") });
    expect(text).toContain("Сведения добавлены к отклику на вакансию."); expect(text).not.toContain("Пришлите резюме");
  });
  it("does not ask after the candidate described themselves in text", () => {
    const text = renderJob({ inputText: "Меня зовут Мадина, мне 26 лет, пять лет веду Instagram для магазинов и умею снимать Reels" });
    expect(text).not.toContain("Пришлите резюме");
  });
  it("does not ask a second time", () => {
    const text = renderJob({ inputText: "Здравствуйте" }, [{ role: "assistant", text: "Пришлите резюме или просто расскажите о себе и своём опыте." }]);
    expect(text).not.toContain("Пришлите резюме");
  });
  it("the text of a document counts as given facts", () => {
    const withDoc = renderJob({ inputText: "", mediaPerception: perceived("document", "Меня зовут Мадина") });
    expect(withDoc).not.toContain("Как к вам обращаться?");
  });
  it.each(["Можете прислать резюме или рассказать о себе.", "Присылайте резюме на проверку.", "Отправьте, пожалуйста, ваше резюме.", "Резюме фиристед.", "Резюмеро фиристед."])("recognises the invitation: %s", text => {
    expect(containsRecruitmentExperienceInvitation([text])).toBe(true);
  });
  it("photographed résumé counts, a room photo does not", () => {
    expect(recruitmentOcrText(["image"], { subject: "document", readableText: "Меня зовут Мадина" })).toBe("Меня зовут Мадина");
    expect(recruitmentOcrText(["image"], { subject: "home_interior", readableText: "Цена 100000 тел 927000000" })).toBe("");
    expect(recruitmentOcrText(["document"], { subject: "other", readableText: " текст " })).toBe("текст");
    expect(recruitmentOcrText(["document"], { subject: "document", readableText: "  " })).toBe("");
  });
});

describe("F06 an unresolved reference says why", () => {
  const unresolved = (reason?: string, status: "missing" | "ambiguous" = "missing") => ev({ kind: "property_unresolved", status, ...(reason ? { reason } : {}) } as CustomerAgentObservation);
  const question = "Какой объект вы имеете в виду? Пришлите номер объекта или ссылку.";
  it.each([
    ["unsupported", "Эту ссылку открыть не получилось: такой формат ссылок я не читаю."],
    ["untrusted_origin", "Эта ссылка ведёт не на наши публикации, по ней объект определить не могу."],
    ["not_found", "По этой ссылке или номеру объект не нашёлся."],
    ["lookup_unavailable", "Сейчас не получилось проверить объект, это временный сбой. Попробуйте ещё раз чуть позже."],
  ])("%s", (reason, line) => {
    expect(render([unresolved(reason)], {}, "property")).toBe(`${line}\n${question}`);
  });
  it("plain question without a reason, and a different one for an ambiguous match", () => {
    expect(render([unresolved()], {}, "property")).toBe(question);
    expect(render([unresolved(undefined, "ambiguous")], {}, "property")).toContain("несколько объектов");
  });
  it("the bare number that answers it is still understood, also after the repair wording", () => {
    const rendered = render([unresolved("not_found")], {}, "property") ?? "";
    const ask = (text: string) => customerBarePropertyAnswer("172", context([{ role: "assistant", text }]));
    expect(ask(rendered)).toBe(172);
    expect(ask(customerAgentPropertyQuestionTexts("ru")[1])).toBe(172);
    expect(ask("Я уточнял, о каком объекте речь. Пришлёте номер объекта или ссылку?")).toBe(172);
    expect(ask("Спасибо")).toBeNull();
  });
  it("derives the reason from the held evidence only", () => {
    const ev1 = (reference: string): CustomerPropertyEvidence => ({ kind: "untrusted_reference", origin: "message", reference });
    expect(customerPropertyUnresolvedReason([ev1("unsupported_format")], "missing")).toBe("unsupported");
    expect(customerPropertyUnresolvedReason([ev1("untrusted_origin")], "denied")).toBe("untrusted_origin");
    expect(customerPropertyUnresolvedReason([{ kind: "url", origin: "message", reference: "https://royalhome.tj/listing/1" }], "missing")).toBe("not_found");
    expect(customerPropertyUnresolvedReason([], "missing")).toBe("no_reference");
    expect(customerPropertyUnresolvedReason([ev1("unsupported_format")], "ambiguous")).toBeUndefined();
  });
  it("all members of a showcase sold: tells so instead of «could not identify»", () => {
    const sold = (n: number) => ({ ...facts, propertyId: `00000000-0000-4000-8000-00000000000${n}`, shortId: n, availability: "SOLD" as const, price: null,
      publicAddress: null, publicLink: null, signature: String(n).repeat(64) });
    const value = { kind: "publication_properties", source: { channel: "INSTAGRAM", resourceId: "1", publicationId: "2" }, mappingSignature: "b".repeat(64),
      kinds: ["availability"], cards: [sold(1), sold(2)] } as CustomerAgentObservation;
    expect(render([ev(value)], { surface: "public_comment", inputText: "Есть ещё?" })).toBe("Все объекты из этой подборки проданы. Подобрать похожие?");
  });
});

describe("F06 links and numbers the customer actually types", () => {
  it("reads an account-qualified Instagram post, rejects an opaque Facebook share link", () => {
    expect(customerPropertyUrl("https://www.instagram.com/royalhome.tj/p/ABC123/")).toEqual({ kind: "instagram", shortcode: "ABC123", url: "https://www.instagram.com/p/ABC123/" });
    expect(customerPropertyUrl("https://instagram.com/p/ABC123/")).toMatchObject({ kind: "instagram", shortcode: "ABC123" });
    for (const kind of ["p", "r", "v"]) expect(customerPropertyUrl(`https://www.facebook.com/share/${kind}/1AbCdEf/`)).toEqual({ kind: "unsupported" });
  });
  it("accepts links written without https://", () => {
    expect(customerPropertyEvidenceFromText("смотрю instagram.com/p/ABC123/")).toEqual([{ kind: "url", origin: "message", reference: "https://www.instagram.com/p/ABC123/" }]);
    expect(customerPropertyEvidenceFromText("www.royalhome.tj/listing/12.")).toEqual([{ kind: "url", origin: "message", reference: "https://royalhome.tj/listing/12" }]);
    // An opaque share link is no longer rejected here: the resolver expands it once (customer-core-tails-23-10).
    expect(customerPropertyEvidenceFromText("facebook.com/share/p/1AbC/")).toEqual([{ kind: "url", origin: "message", reference: "https://www.facebook.com/share/p/1AbC/" }]);
    expect(customerPropertyEvidenceFromText("https://www.instagram.com/p/ABC123/")).toHaveLength(1);
  });
  it("reads «номер 1234», «id 77», «рақами объект 9» but never a phone or a stray number", () => {
    const refs = (text: string) => customerPropertyEvidenceFromText(text).map(item => item.reference);
    expect(refs("номер 1234")).toEqual(["short:1234"]); expect(refs("id 77")).toEqual(["short:77"]);
    expect(refs("рақами объект 9")).toEqual(["short:9"]); expect(refs("объект №12")).toEqual(["short:12"]);
    expect(refs("мой номер 98 765 4321")).toEqual([]); expect(refs("номер телефона 123")).toEqual([]);
    expect(refs("номер 927123456")).toEqual([]);
  });
  it("a bare «номер 1234» is a fast-path property reference", () => {
    expect(classifyCustomerPropertyFactIntent("Сколько стоит номер 1234?")).toEqual(["price"]);
  });
});

describe("F06 a transient lookup failure is retried once and reported", () => {
  const scope = { conversationId: PROPERTY, scopeKey: "c".repeat(64), accountId: null, channel: "WEBSITE" as const } satisfies Pick<CustomerPropertyAdmission, "conversationId" | "scopeKey" | "accountId" | "channel">;
  const evidence: CustomerPropertyEvidence[] = [{ kind: "url", origin: "message", reference: "https://royalhome.tj/listing/12" }];
  const registry = (url: CustomerPropertyRegistry["url"]): CustomerPropertyRegistry => ({ url, ad: async () => null, media: async () => [], reply: async () => [], selector: async () => [] });
  it("succeeds on the retry", async () => {
    const url = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce([PROPERTY]);
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry(url))).toMatchObject({ status: "resolved", propertyId: PROPERTY });
    expect(url).toHaveBeenCalledTimes(2);
  });
  it("stays lookup_unavailable (not «not found») and reaches the system journal", async () => {
    const url = vi.fn().mockRejectedValue(new Error("db down"));
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry(url))).toMatchObject({ status: "missing", reason: "lookup_unavailable" });
    expect(logSystemError).toHaveBeenCalledWith("api", expect.stringContaining("db down"), expect.objectContaining({ dedupKey: "customer-property-lookup-failed" }));
  });
  it("does not retry a deterministic answer", async () => {
    const url = vi.fn().mockResolvedValue([]);
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry(url))).toMatchObject({ status: "missing", reason: "not_found" });
    expect(url).toHaveBeenCalledTimes(1);
  });
});
