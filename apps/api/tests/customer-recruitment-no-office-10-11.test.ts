import { describe, expect, it, vi } from "vitest";
import { customerAgentVerifiedContextSchema } from "@royal-home/shared";
import { renderCustomerAgentDecision, type CustomerAgentEvidence, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyInformationHash } from "../src/ai/customerAgentPublicProtocol.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";

vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn() }));

/**
 * Ответ кандидату о вакансии (решение владельца 10.11.2026): должность, две-три
 * строки условий и телефон — БЕЗ адреса офиса и часов работы, если кандидат о них
 * не спрашивал. Раньше тема «работа» оставляла подмешанную ядром справку о
 * компании, и кандидат получал адрес и расписание, о которых не просил.
 */
const info = { name: "Royal Home", city: "Душанбе", office: "ул. Тестовая, 1", services: "Продажа и помощь в покупке",
  hours: { start: "09:30", end: "18:00", daysOff: [0] } };
const company: CustomerAgentObservation = { kind: "company_information", information: info, sourceHash: customerAgentCompanyInformationHash(info) };
const position = { key: "real-estate-agent", revision: 1, titleRu: "Менеджер по продажам недвижимости", titleTg: "Менеҷери фурӯши амвол",
  detailsRu: "Зарплата договорная, бонусы за результат, обучение и поддержка.\nПо всем вопросам звоните 777 070 100.",
  detailsTg: "Маош бо созиш, бонус барои натиҷа, омӯзиш ва дастгирӣ.\nБарои ҳама саволҳо ба 777 070 100 занг занед.",
  isOpen: true, keywords: ["менеджер", "агент"], postCodes: [], screeningRules: null };
const catalogValue = { collecting: true, positions: [position] };
const vacancies = { kind: "open_vacancies", ...catalogValue, sourceHash: recruitmentCatalogHash(catalogValue) } as CustomerAgentObservation;
const context = customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns: [],
  publicState: { topic: "job", jobPositionKey: "real-estate-agent" } });
const evidence: CustomerAgentEvidence[] = [{ ref: "e0", value: vacancies }, { ref: "e1", value: company }];
const render = (inputText: string, language: "ru" | "tg" = "ru") => renderCustomerAgentDecision({
  decision: { kind: "reply", refs: ["e0", "e1"], social: "none", question: "none" } as never, evidence, language, requestedFacts: [],
  knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText, verifiedContext: context });

describe("вакансия: без адреса офиса и часов (10.11.2026)", () => {
  it("на вопрос о вакансии — должность, условия и телефон, без адреса", () => {
    const text = render("Здравствуйте. Можно узнать об этой вакансии подробнее?") ?? "";
    expect(text).toContain("Менеджер по продажам недвижимости");
    expect(text).toContain("777 070 100");
    expect(text).not.toContain("Тестовая");
    expect(text).not.toMatch(/09:30|18:00/);
  });
  it("по-таджикски тоже без адреса", () => {
    const text = render("Салом, дар бораи ҷойи кор маълумот диҳед", "tg") ?? "";
    expect(text).toContain("777 070 100");
    expect(text).not.toContain("Тестовая");
  });
  it("если кандидат сам спросил, где офис, адрес остаётся", () => {
    expect(render("Где находится ваш офис?") ?? "").toContain("Тестовая");
  });
});
