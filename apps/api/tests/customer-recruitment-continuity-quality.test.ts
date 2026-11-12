import { describe, expect, it } from "vitest";
import type { CustomerAgentModelTurn, CustomerCoreFrame, CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { runCustomerAgentTurn } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";
import type { CustomerAgentVerifiedContext } from "@royal-home/shared";

const hash = "a".repeat(64);
const positions = recruitmentPositionTemplates().map(row => ({ ...row, isOpen: true, revision: 1 }));
const catalogFacts = { collecting: true, positions };
const catalog = { kind: "open_vacancies" as const, ...catalogFacts, sourceHash: recruitmentCatalogHash(catalogFacts) };
const agent = positions.find(row => row.key === "real-estate-agent")!;
const video = positions.find(row => row.key === "smm-videographer")!;
// Phone-only recruitment (owner 10–11.11.2026): the bot names the role and gives the specialist's number.
const phoneLine = (language: "ru" | "tg") => language === "ru"
  ? "Всю информацию о работе даст по телефону наш специалист Ноза: 777 070 100. Позвоните, пожалуйста."
  : "Маълумоти пурраро дар бораи кор мутахассиси мо Ноза бо телефон медиҳад: 777 070 100. Лутфан занг занед.";

function makeContext(language: "ru" | "tg", turns: CustomerAgentVerifiedContext["turns"], jobPositionKey?: string): CustomerAgentVerifiedContext {
  return { surface: "dm", revisionId: hash, turns, recruitmentKnown: ["name", "age", "about"],
    publicState: { language, topic: "job", openQuestion: "none", ...(jobPositionKey ? { jobPositionKey } : {}) } };
}

function fixture(inputText: string, language: "ru" | "tg", question: string, context?: CustomerAgentVerifiedContext,
  currentCatalog = catalog) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 2,
    signal: controller.signal, accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = {
    surface: "dm", language, inputText, knownPhoneSource: "none", requestedFacts: [], verifiedContext: context,
    revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash,
      knowledgeSchemaHash: hash, knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
      limits: { maxRounds: 2, maxToolCalls: 2, maxInputChars: 20_000, maxOutputChars: 3000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
    startedAt: Date.now(), operation, tools: [{ name: "get_open_vacancies", description: "Current open roles" }],
  };
  const modelTurn: CustomerCorePorts["modelTurn"] = async () => ({
    text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "none", question }), calls: [], modelParts: [],
  } satisfies CustomerAgentModelTurn);
  const executeAllowedTool: CustomerCorePorts["executeAllowedTool"] = async call => call.name === "get_open_vacancies"
    ? { status: "observed", observation: structuredClone(currentCatalog) }
    : { status: "denied", reason: "unexpected_tool" };
  const ports: CustomerCorePorts = { modelTurn, executeAllowedTool, assertCurrent: async () => true,
    requestStop: reason => controller.abort(reason), observeLateToolResult: () => {} };
  return runCustomerAgentTurn(frame, ports);
}

async function firstAcceptedVacancy(language: "ru" | "tg", key = video.key) {
  const position = positions.find(row => row.key === key)!;
  const first = await fixture(language === "ru" ? `Вакансия ${position.titleRu} актуальна?` : `Ҷойи кори ${position.titleTg} ҳаст?`,
    language, "job_experience");
  if (first.status !== "ready") throw new Error("Expected a synthetic vacancy reply");
  expect(first.text).toContain(language === "ru" ? position.titleRu : position.titleTg);
  expect(first.text).toContain(phoneLine(language));
  return first.text;
}

describe("customer recruitment continuity through the real core and renderer", () => {
  it.each(["ru", "tg"] as const)("does not repeat the accepted current vacancy after a candidate answer in %s", async language => {
    const prior = await firstAcceptedVacancy(language);
    const input = language === "ru"
      ? "Меня зовут Рустам. Мне 29 лет. Опыт: три года монтажа и SMM."
      : "Номи ман Рустам. Ман 29 сола. Таҷриба: се сол монтаж ва SMM.";
    const result = await fixture(input, language, "job_required", makeContext(language, [{ role: "assistant", text: prior }], video.key));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // No questionnaire question follows the candidate's answer: only the phone line is given.
    expect(result.text).toContain(phoneLine(language));
    expect(result.text).not.toContain(language === "ru" ? "Какой номер телефона" : "кадом рақами телефон");
    expect(result.text).not.toContain(language === "ru" ? video.detailsRu.split("\n")[0] : video.detailsTg.split("\n")[0]);
    expect(result.evidence.some(item => item.value.kind === "receipt")).toBe(false);
    expect(result.text).not.toMatch(/свяжемся|позвоним|мы вам перезвоним|тамос мегирем|занг мезанем/iu);
  });

  it("shows a fresh vacancy with the phone line and no details when no accepted assistant presentation exists", async () => {
    const result = await fixture("Вакансия видеографа актуальна?", "ru", "job_experience");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.text).toContain(video.titleRu);
    expect(result.text).toContain(phoneLine("ru"));
    expect(result.text).not.toContain(video.detailsRu.split("\n")[0]);
  });

  it("does not treat a title-only assistant question as an accepted vacancy presentation", async () => {
    const titleOnly = `Вас интересует вакансия ${video.titleRu}?`;
    const result = await fixture("Меня зовут Рустам, мне 29 лет.", "ru", "job_required",
      makeContext("ru", [{ role: "assistant", text: titleOnly }], video.key));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.text).toContain(video.titleRu);
    expect(result.text).toContain(phoneLine("ru"));
    expect(result.text).not.toContain(video.detailsRu.split("\n")[0]);
  });

  it("never republishes conditions, current or stale, when prior assistant details for the same title are stale", async () => {
    const outdated = `Открыта вакансия: ${video.titleRu}\nУсловия: удалённая работа и высокая зарплата.`;
    const result = await fixture("Меня зовут Рустам, мне 29 лет.", "ru", "job_required",
      makeContext("ru", [{ role: "assistant", text: outdated }], video.key));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.text).toContain(phoneLine("ru"));
    expect(result.text).not.toContain(video.detailsRu.split("\n")[0]);
    expect(result.text).not.toContain("Удалённая работа не предусмотрена");
    expect(result.text).not.toContain("высокая зарплата");
  });

  it("suppresses a repeat when verified assistant history contains the current title and conditions", async () => {
    const current = `Открыта вакансия: ${video.titleRu}\n${video.detailsRu}`;
    const result = await fixture("Меня зовут Рустам, мне 29 лет.", "ru", "job_required",
      makeContext("ru", [{ role: "assistant", text: current }], video.key));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.text).not.toContain(video.titleRu);
    expect(result.text).not.toContain(video.detailsRu.split("\n")[0]);
    expect(result.text).toContain(phoneLine("ru"));
  });

  it("accepts current Tajik conditions when the vacancy title is identical in both languages", async () => {
    const sameTitle = { ...video, titleRu: "SMM-видеограф", titleTg: "SMM-видеограф",
      detailsRu: "Съёмка недвижимости в офисе.", detailsTg: "Наворбардории амвол дар офис." };
    const bilingualPositions = positions.map(row => row.key === video.key ? sameTitle : row);
    const facts = { collecting: true, positions: bilingualPositions };
    const bilingualCatalog = { kind: "open_vacancies" as const, ...facts, sourceHash: recruitmentCatalogHash(facts) };
    const prior = `${sameTitle.titleTg}\n${sameTitle.detailsTg}`;
    const result = await fixture("Номи ман Рустам, 29 сола.", "tg", "job_required",
      makeContext("tg", [{ role: "assistant", text: prior }], video.key), bilingualCatalog);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.text).not.toContain(sameTitle.titleRu);
    expect(result.text).not.toContain(sameTitle.detailsTg);
  });

  it("uses the newly selected position when the candidate switches roles", async () => {
    const prior = await firstAcceptedVacancy("ru", agent.key);
    const result = await fixture("Теперь интересует вакансия видеографа", "ru", "job_experience",
      makeContext("ru", [{ role: "assistant", text: prior }], agent.key));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.text).toContain(video.titleRu);
    expect(result.text).toContain(phoneLine("ru"));
    expect(result.text).not.toContain(video.detailsRu.split("\n")[0]);
  });

  it("answers salary and full-details follow-ups with the phone line only, never with published conditions", async () => {
    const prior = await firstAcceptedVacancy("ru");
    const context = makeContext("ru", [{ role: "assistant", text: prior }], video.key);
    const salary = await fixture("Какая зарплата?", "ru", "none", context);
    expect(salary.status).toBe("ready");
    if (salary.status !== "ready") return;
    expect(salary.text).toContain(phoneLine("ru"));
    expect(salary.text).not.toContain("Размер зарплаты");
    expect(salary.text).not.toMatch(/\b\d{4,}\b/u);

    const details = await fixture("Расскажите все условия подробнее", "ru", "none", context);
    expect(details.status).toBe("ready");
    if (details.status !== "ready") return;
    expect(details.text).toContain(phoneLine("ru"));
    for (const paragraph of video.detailsRu.split("\n")) expect(details.text).not.toContain(paragraph);
  });
});
