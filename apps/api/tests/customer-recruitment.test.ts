import { describe, expect, it } from "vitest";
import { recruitmentPositionUpdateSchema, recruitmentPostCode, recruitmentKeyword, customerAgentToolCallSchema } from "@royal-home/shared";
import { customerRecruitmentRequested, customerRecruitmentTopic, recruitmentCatalogHash, isCustomerVacanciesObservation } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { customerAgentToolDefinitions } from "../src/ai/customerAgentToolDefinitions.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";
import { vacancyOfficeAddress, vacancyOfficeAddressTg, VACANCY_FACTS } from "../src/ai/vacancyFacts.js";

const position = { key: "synthetic-agent", titleRu: "Агент по недвижимости", titleTg: "Агент оид ба амвол",
  detailsRu: "Доход от сделок, размер заранее не гарантируется.", detailsTg: "Даромад аз аҳдҳо, маблағ пешакӣ кафолат дода намешавад.",
  isOpen: true, postCodes: ["Synthetic01"], keywords: [], revision: 1 };
function observation(positions = [position], collecting = true) {
  const facts = { collecting, positions }; return { kind: "open_vacancies" as const, ...facts, sourceHash: recruitmentCatalogHash(facts) };
}
function render(language: "ru" | "tg", value = observation(), question: "none" | "budget" | "job_experience" = "none", inputText = "Есть вакансии?", knownKey?: string) {
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "none", question },
    evidence: [{ ref: "e0", value }], language, inputText, requestedFacts: [], surface: "dm", knownPhoneSource: "none", maxOutputChars: 4000,
    ...(knownKey ? { verifiedContext: { surface: "dm" as const, revisionId: "1".repeat(64), turns: [],
      publicState: { language, topic: "job" as const, openQuestion: "none" as const, jobPositionKey: knownKey } } } : {}) });
}
describe("current recruitment facts", () => {
  it("keeps owner-approved onsite SMM conditions separate from the agent commission and uses the canonical office", () => {
    const templates = recruitmentPositionTemplates(), video = templates.find(row => row.key === "smm-videographer")!;
    const agent = templates.find(row => row.key === "real-estate-agent")!;
    expect(video.titleRu).toBe("SMM-специалист / видеограф");
    expect(video.detailsRu).toContain("с понедельника по субботу");
    expect(video.detailsRu).toContain("Удалённая работа не предусмотрена");
    expect(video.detailsRu).toContain(vacancyOfficeAddress()); expect(video.detailsTg).toContain(vacancyOfficeAddressTg());
    expect(video.detailsRu).toContain("кофе, печенье");
    expect(video.detailsRu).toContain("резюме или просто расскажите о себе");
    expect(video.detailsRu).toContain("по желанию");
    expect(video.detailsRu).not.toContain(VACANCY_FACTS.pay.salary);
    expect(video.detailsRu).not.toMatch(/\d+%|\d{1,2}:\d{2}/u);
    expect(agent.detailsRu).toContain(VACANCY_FACTS.pay.salary);
    expect(templates.every(row => row.isOpen === false && !row.postCodes.length)).toBe(true);
    expect(video.keywords).toEqual(["контент"]);
  });
  it.each(["вакансия агента", "ищу работу", "ҷойи кор ҳаст?", "SMM менеджер", "видеограф"])("recognizes job wording: %s", text => expect(customerRecruitmentRequested(text)).toBe(true));
  it("keeps jobs out of property intake while allowing an explicit later topic switch", () => {
    expect(customerRecruitmentTopic("Можно подробнее?", "unknown", true)).toBe("job");
    expect(customerRecruitmentTopic("мой номер", "job")).toBe("job");
    expect(customerRecruitmentTopic("Хочу продать свою квартиру", "job", true)).toBe("seller");
    expect(customerRecruitmentTopic("Хочу купить квартиру", "job")).toBe("buyer");
    expect(customerRecruitmentTopic("Мне нужно квартира аренда", "job", true)).toBe("rent");
    expect(customerRecruitmentTopic("Ищу квартиру в аренду", "unknown", true)).toBe("rent");
    expect(customerRecruitmentTopic("Хона ба иҷора лозим", "job", true)).toBe("rent");
  });
  it.each(["ru", "tg"] as const)("renders staff facts in %s without invented pay, contact or saved application", language => {
    const text = render(language, observation(), "budget", language === "ru" ? "Вакансия: агент по недвижимости" : "Ҷойи кор: агент оид ба амвол");
    expect(text).toContain(language === "ru" ? position.titleRu : position.titleTg);
    expect(text).toContain(language === "ru" ? position.detailsRu : position.detailsTg);
    expect(text).not.toMatch(/992|1000|500|сохранен|сабт шуд|бюджет|буҷет/iu);
    expect(text).toContain(language === "ru" ? "резюме или просто расскажите о себе" : "Резюме фиристед ё дар бораи худ");
  });
  it("does not import another role's salary or stale built-in vacancy defaults", () => {
    const video = { ...position, key: "synthetic-video", titleRu: "SMM-менеджер / видеограф", titleTg: "Менеҷери SMM / видеограф", detailsRu: "", detailsTg: "", postCodes: [] };
    const text = render("ru", observation([position, video]), "none", "Вакансия видеограф");
    expect(text).toContain("условия этой должности пока не опубликованы");
    expect(text).not.toContain(position.detailsRu);
  });
  it.each([["ru", "Можно работать удалённо?"], ["ru", "А суббота рабочая?"], ["tg", "Аз хона кор кардан мешавад?"]] as const)(
    "answers a %s work-format follow-up from the selected CRM conditions: %s", (language, text) => {
      const template = recruitmentPositionTemplates().find(row => row.key === "smm-videographer")!;
      const video = { ...template, isOpen: true, revision: 1 };
      const result = render(language, observation([video]), "none", text, video.key);
      expect(result).toContain(language === "ru" ? "Удалённая работа не предусмотрена" : "Кори фосилавӣ пешбинӣ нашудааст");
      expect(result).toContain(language === "ru" ? "с понедельника по субботу" : "аз душанбе то шанбе");
      expect(result).not.toMatch(/\d+%|\$\d+|будем ждать вас завтра/iu);
    });
  it("does not ask a property or application question when no opening is confirmed", () => {
    expect(render("ru", observation([], false), "budget")).toBe("Приём откликов через этот чат сейчас не ведётся.");
    expect(isCustomerVacanciesObservation(observation([position], false))).toBe(false);
  });
  it("rejects mutated facts and closed rows despite a valid outer shape", () => {
    expect(isCustomerVacanciesObservation({ ...observation(), positions: [{ ...position, detailsRu: "made up pay" }] })).toBe(false);
    expect(isCustomerVacanciesObservation(observation([{ ...position, isOpen: false }]))).toBe(false);
  });
  it("uses the same closed validator for a public read tool and rejects private arguments", () => {
    expect(customerAgentToolCallSchema.safeParse({ name: "get_open_vacancies", args: {} }).success).toBe(true);
    expect(customerAgentToolCallSchema.safeParse({ name: "get_open_vacancies", args: { clientId: "foreign" } }).success).toBe(false);
    expect(customerAgentToolDefinitions(["get_open_vacancies"])[0].parameters).toMatchObject({ type: "object", additionalProperties: false });
  });
  it.each(["Synthetic01", "https://www.instagram.com/reel/Synthetic01/?igsh=tracking"])("parses an actual supported publication reference: %s", value => expect(recruitmentPostCode(value)).toBe("Synthetic01"));
  it.each(["КОНТЕНТ", "  контент!!!  ", "👏Контент🔥"])("normalizes a whole campaign keyword: %s", value => expect(recruitmentKeyword(value)).toBe("контент"));
  it.each(["у вас плохой контент", "мой друг сказал контент", "не хочу контент"])("does not turn arbitrary wording into a campaign keyword: %s", value => expect(recruitmentKeyword(value)).toBeNull());
  it.each(["https://instagram.com.evil.invalid/reel/Synthetic01/", "https://evil.invalid/instagram.com/reel/Synthetic01", "https://user@instagram.com/reel/Synthetic01/", "http://instagram.com/reel/Synthetic01/", "https://instagram.com/reel/Synthetic01/extra"])("rejects an untrusted URL: %s", value => expect(recruitmentPostCode(value)).toBeNull());
  it("requires explicit state and optimistic revision, rejecting private or decision fields", () => {
    const { key, revision, ...data } = position;
    expect(recruitmentPositionUpdateSchema.safeParse({ ...data, expectedRevision: 0 }).success).toBe(true);
    expect(recruitmentPositionUpdateSchema.safeParse({ ...data, expectedRevision: 0, eligible: true }).success).toBe(false);
    expect(recruitmentPositionUpdateSchema.safeParse({ ...data, expectedRevision: 0, postCodes: ["Synthetic01", "Synthetic01"] }).success).toBe(false);
  });
});
