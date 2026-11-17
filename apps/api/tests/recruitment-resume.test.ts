import { describe, expect, it } from "vitest";
import { assessRecruitmentResume, DEFAULT_RECRUITMENT_SCREENING_RULES, REALTOR_RECRUITMENT_SCREENING_RULES,
  recruitmentScreeningRulesSchema, recruitmentPositionUpdateSchema } from "@royal-home/shared";
import { collectRecruitmentResume, extractRecruitmentAnswerFacts } from "../src/lib/recruitmentResume.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";

const eventKey = "a".repeat(64), nextEvent = "b".repeat(64);
const collect = (text: string, previous?: unknown) => collectRecruitmentResume({ text, previous, sourceEventKey: eventKey });

describe("vacancy-specific human screening", () => {
  it("keeps realtor restrictions separate from SMM and never rejects a candidate", () => {
    const resume = collect("Мне 21 год. Я сейчас учусь в университете. Я работаю в студии.\nОпыт: пока без опыта");
    const basic = { facts: resume.facts, name: "Synthetic", phone: "synthetic-contact" };
    const smm = assessRecruitmentResume({ ...basic, rules: DEFAULT_RECRUITMENT_SCREENING_RULES });
    const realtor = assessRecruitmentResume({ ...basic, rules: REALTOR_RECRUITMENT_SCREENING_RULES });
    expect(smm).toEqual({ missing: [], warnings: [], readyForReview: true });
    expect(realtor.missing).toEqual([]);
    expect(realtor.warnings).toHaveLength(3);
    expect(realtor.readyForReview).toBe(true);
    expect(realtor).not.toHaveProperty("eligible"); expect(realtor).not.toHaveProperty("status");
  });
  it("treats an explicit no-experience answer as available information, not a rejection", () => {
    const facts = collect("Опыт: нет опыта").facts;
    expect(assessRecruitmentResume({ rules: { ...DEFAULT_RECRUITMENT_SCREENING_RULES, requiredFacts: ["experience"] }, facts }))
      .toEqual({ missing: [], warnings: [], readyForReview: true });
  });
  it("distinguishes unanswered from false and adds only restrictions of the selected role", () => {
    const no = collect("Не учусь. Не работаю.").facts;
    const rules = { ...REALTOR_RECRUITMENT_SCREENING_RULES, requiredFacts: [] };
    expect(assessRecruitmentResume({ rules, facts: no }).missing).toEqual(["age"]);
    expect(assessRecruitmentResume({ rules }).missing).toEqual(["age", "studyingNow", "employedNow"]);
    expect(assessRecruitmentResume({ rules: { ...DEFAULT_RECRUITMENT_SCREENING_RULES, requiredFacts: [] } }).missing).toEqual([]);
    expect(assessRecruitmentResume({ rules, values: { age: 29, studyingNow: false, employedNow: false } }))
      .toEqual({ missing: [], warnings: [], readyForReview: true });
  });
  it("allows supplied materials to satisfy the résumé request without inventing their contents", () => {
    expect(assessRecruitmentResume({ name: "Synthetic", phone: "synthetic-contact", portfolioCount: 1 }).readyForReview).toBe(true);
    expect(assessRecruitmentResume({ name: "Synthetic", phone: "synthetic-contact" }).missing).toEqual(["about"]);
  });
  it("validates bounded rules and keeps old position updates compatible", () => {
    expect(recruitmentScreeningRulesSchema.safeParse({ ...DEFAULT_RECRUITMENT_SCREENING_RULES, minimumAge: 0 }).success).toBe(false);
    expect(recruitmentScreeningRulesSchema.safeParse({ ...DEFAULT_RECRUITMENT_SCREENING_RULES, requiredFacts: ["phone", "phone"] }).success).toBe(false);
    const { key, screeningRules, ...position } = recruitmentPositionTemplates()[0];
    expect(recruitmentPositionUpdateSchema.safeParse({ ...position, expectedRevision: 0 }).success).toBe(true);
    expect(screeningRules).toEqual(REALTOR_RECRUITMENT_SCREENING_RULES);
    expect(recruitmentPositionTemplates()[1].screeningRules).toEqual(DEFAULT_RECRUITMENT_SCREENING_RULES);
  });
});

describe("sourced résumé facts", () => {
  it.each([
    ["studyingNow", "не работаю"], ["studyingNow", "работаю"], ["studyingNow", "нет, не работаю"], ["studyingNow", "да, работаю"],
    ["studyingNow", "кор намекунам"], ["studyingNow", "кор мекунам"],
    ["employedNow", "не учусь"], ["employedNow", "учусь"], ["employedNow", "нет, не учусь"], ["employedNow", "да, учусь"],
    ["employedNow", "намехонам"], ["employedNow", "мехонам"],
  ] as const)("does not answer %s using another subject: %s", (key, text) => {
    expect(extractRecruitmentAnswerFacts(text, key)[key]).toBeUndefined();
  });
  it.each(["не работаю", "учусь", "намехонам", "кор намекунам", "сейчас работаю", "я не учусь", "ага", "ҳа", "ха", "неа"])(
    "does not mistake a status statement for a bare name: %s", text => {
      expect(extractRecruitmentAnswerFacts(text, "name").name).toBeUndefined();
    });
  it.each(["studyingNow", "employedNow"] as const)("leaves contradictory, third-party and future answers to %s unresolved", key => {
    for (const text of ["да, не работаю", "нет, учусь", "да, намехонам", "не, мехонам", "он работает", "она учится", "буду работать", "буду учиться", "ӯ кор мекунад", "ӯ мехонад", "кор хоҳам кард"]) {
      expect(extractRecruitmentAnswerFacts(text, key)[key], text).toBeUndefined();
    }
  });
  it.each([
    ["studyingNow", "не учусь", false], ["studyingNow", "учусь", true], ["studyingNow", "намехонам", false], ["studyingNow", "мехонам", true],
    ["employedNow", "не работаю", false], ["employedNow", "работаю", true], ["employedNow", "кор намекунам", false], ["employedNow", "кор мекунам", true],
  ] as const)("retains the matching %s answer %s", (key, text, expected) => {
    expect(extractRecruitmentAnswerFacts(text, key)[key]).toMatchObject({ value: expected, quote: text });
  });
  it.each(["studyingNow", "employedNow"] as const)("keeps plain yes/no aliases valid for %s", key => {
    for (const text of ["нет", "неа", "не"]) expect(extractRecruitmentAnswerFacts(text, key)[key]?.value, text).toBe(false);
    for (const text of ["да", "ага", "ҳа", "ха", "бале"]) expect(extractRecruitmentAnswerFacts(text, key)[key]?.value, text).toBe(true);
  });
  it("preserves an explicit independent other field without inventing the queried field", () => {
    const facts = extractRecruitmentAnswerFacts("Не работаю", "studyingNow");
    expect(facts.employedNow).toEqual({ value: false, quote: "Не работаю" });
    expect(facts.studyingNow).toBeUndefined();
    expect(extractRecruitmentAnswerFacts("Синтетик Тестов", "name").name?.value).toBe("Синтетик Тестов");
  });
  it("keeps literal evidence for available fields and does not infer the rest", () => {
    const text = "Меня зовут Синтетик. Мне 29 лет.\nГород: Душанбе\nОбразование: дизайн\nОпыт: монтаж\nЯзыки: русский\nНавыки: съемка\nПрограммы: Premiere\nГотов начать: после встречи";
    const result = collect(text);
    expect(result.facts.age?.value).toBe(29); expect(result.facts.city?.value).toBe("Душанбе");
    expect(result.facts.tools?.value).toBe("Premiere"); expect(result.facts.skills?.value).toBe("съемка");
    expect(result.facts.education?.value).toBe("дизайн"); expect(result.facts.languages?.value).toBe("русский");
    expect(result.facts.startWhen?.value).toBe("после встречи");
    for (const fact of Object.values(result.facts)) {
      expect(fact.sourceEventKey).toBe(eventKey); expect(text).toContain(fact.quote);
    }
    expect(result.facts.employedNow).toBeUndefined(); expect(result.facts.studyingNow).toBeUndefined();
  });
  it("preserves prior sources and accepts a later explicit correction", () => {
    const before = collect("Мне 24 года. Не работаю.");
    const after = collectRecruitmentResume({ previous: before, text: "Мне 25 лет", sourceEventKey: nextEvent });
    expect(after.facts.age).toMatchObject({ value: 25, sourceEventKey: nextEvent });
    expect(after.facts.employedNow).toMatchObject({ value: false, sourceEventKey: eventKey });
  });
  it("does not fabricate personal facts from questions, friends or a course", () => {
    for (const text of ["Другу 22 года, он не работает", "Друг сказал: мне 22 года", "Можно без опыта?", "Буду работать в офисе", "Учусь на курсах монтажа"]) {
      const result = collect(text);
      expect(result.facts.age).toBeUndefined(); expect(result.facts.employedNow).toBeUndefined(); expect(result.facts.studyingNow).toBeUndefined();
    }
    expect(collect("Можно без опыта?").facts.about).toBeUndefined();
    expect(collect("https://example.invalid/portfolio/123456789").facts.phone).toBeUndefined();
    expect(collect("Мой номер 900000011").facts.phone?.value).toBe("+992900000011");
  });
  it("does not turn old unstructured model output into sourced facts", () => {
    expect(collect("Здравствуйте", { age: 34, experience: "inferred" })).toEqual({ version: 1, facts: {} });
  });
  it("interprets bare answers only for a proven message question, never a document", () => {
    expect(collect("29").facts.age).toBeUndefined();
    expect(collectRecruitmentResume({ text: "29", sourceEventKey: eventKey, answerTo: "age" }).facts.age)
      .toMatchObject({ value: 29, quote: "29", sourceEventKey: eventKey });
    expect(collectRecruitmentResume({ text: "нет", sourceEventKey: eventKey, answerTo: "studyingNow" }).facts.studyingNow?.value).toBe(false);
    expect(collectRecruitmentResume({ text: "Premiere", sourceEventKey: eventKey, answerTo: "tools" }).facts.tools?.value).toBe("Premiere");
    expect(collectRecruitmentResume({ text: "29", sourceEventKey: eventKey, answerTo: "age", sourceKind: "document" }).facts.age).toBeUndefined();
  });
});

describe("adaptive current-role questions", () => {
  const render = (rules: typeof DEFAULT_RECRUITMENT_SCREENING_RULES, context: Record<string, unknown> = {}, inputText = "Подробнее", surface: "dm" | "public_comment" = "dm") => {
    const position = { ...recruitmentPositionTemplates()[1], screeningRules: rules, isOpen: true, revision: 1 };
    const facts = { collecting: true, positions: [position] };
    return renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "job_required" },
      evidence: [{ ref: "e0", value: { kind: "open_vacancies", ...facts, sourceHash: recruitmentCatalogHash(facts) } }],
      language: "ru", requestedFacts: [], surface, knownPhoneSource: "none", maxOutputChars: 6000, inputText,
      verifiedContext: { surface, revisionId: "a".repeat(64), turns: [], publicState: { language: "ru", topic: "job", openQuestion: "none", jobPositionKey: position.key }, ...context } });
  };
  const phone = "Всю информацию о работе даст по телефону наш специалист Ноза: 777 070 100. Позвоните, пожалуйста.";
  it("asks no screening question whatever the vacancy's configured fields are: the role and the specialist's phone only (phone-only recruitment, 10-11.11.2026)", () => {
    for (const rules of [{ ...DEFAULT_RECRUITMENT_SCREENING_RULES, requiredFacts: ["tools" as const] }, { ...REALTOR_RECRUITMENT_SCREENING_RULES, requiredFacts: [] }]) {
      const text = render(rules)!;
      expect(text).toContain(recruitmentPositionTemplates()[1]!.titleRu);
      expect(text).toContain(phone);
      expect(text).not.toMatch(/Какими программами|Сколько вам полных лет|Вы сейчас работаете|Вы сейчас учитесь|резюме/u);
    }
    const rules = { ...REALTOR_RECRUITMENT_SCREENING_RULES, requiredFacts: [] };
    const answered = render(rules, { recruitmentKnown: ["age"], recruitmentAnswerTo: "studyingNow" }, "нет")!;
    expect(answered).toContain(phone);
    expect(answered).not.toMatch(/Вы сейчас работаете в другом месте|Вы сейчас учитесь в школе|Сколько вам полных лет/u);
  });
  it("never publishes private screening questions in a public comment", () => {
    const text = render({ ...REALTOR_RECRUITMENT_SCREENING_RULES, requiredFacts: [] }, {}, "Подробнее", "public_comment")!;
    expect(text).toContain(phone); expect(text).not.toContain("Сколько вам полных лет?");
    expect(text).not.toMatch(/резюме|личные сообщения/u);
  });
});
