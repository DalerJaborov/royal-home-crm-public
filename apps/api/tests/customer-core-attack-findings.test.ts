import { describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema } from "@royal-home/shared";
import { detectClientLanguage } from "../src/ai/clientLanguage.js";
import { resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";
import { customerDmAbuseKind } from "../src/ai/customerAgentAbuse.js";
import { renderCustomerAgentDecision, customerCompanyInformationRequested, customerAgentFixedLines,
  type CustomerAgentEvidence, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyInformationHash } from "../src/ai/customerAgentPublicProtocol.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";

/** Findings of the attack stand run of 24.10.2026 (docs/customer-core-attack.md): the causes, not the scenarios. */
const context = (turns: Array<{ role: "user" | "assistant"; text: string }> = [], extra: Record<string, unknown> = {}) =>
  customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
    publicState: { language: "ru", topic: "unknown", openQuestion: "none" }, ...extra });
const user = (text: string) => ({ role: "user" as const, text });
const bot = (text: string) => ({ role: "assistant" as const, text });
function render(question: string, inputText: string, verifiedContext = context(), evidence: CustomerAgentEvidence[] = [],
  extra: Record<string, unknown> = {}) {
  return renderCustomerAgentDecision({ decision: { kind: "clarify", refs: [], social: "none", question } as never, evidence,
    language: "ru", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText, verifiedContext, ...extra });
}
const info = { name: "Royal Home", city: "Душанбе", office: "ул. Тестовая, 1", services: "Продажа и помощь в покупке",
  hours: { start: "09:30", end: "18:00", daysOff: [0] } };
const company: CustomerAgentObservation = { kind: "company_information", information: info, sourceHash: customerAgentCompanyInformationHash(info) };
const position = { key: "smm", revision: 1, titleRu: "SMM-специалист", titleTg: "SMM-мутахассис", detailsRu: "", detailsTg: "",
  isOpen: true, keywords: ["smm"], postCodes: [], screeningRules: null };
const vacancies = { kind: "open_vacancies", collecting: true, positions: [position],
  sourceHash: recruitmentCatalogHash({ collecting: true, positions: [position] }) } as unknown as CustomerAgentObservation;

describe("class 1: short Tajik phrases without Tajik letters", () => {
  it.each(["офисатон кучост", "чанд пул", "кучост", "акс фиристед 20", "метавонам тамошо кунам фардо?", "ошёна чандум?",
    "вазифаи агент кушода?", "резюме мефиристам", "salom, in khona chand pul", "kor bormi", "narxi chand 12"])("%s is Tajik", text => {
    expect(detectClientLanguage(text)).toBe("tg");
    expect(resolveCustomerDmLanguage(text, ["Здравствуйте, нужна квартира"])).toBe("tg");
  });
  it("keeps Russian and English as they were", () => {
    expect(detectClientLanguage("Сколько стоит офис в центре?")).toBe("ru");
    expect(detectClientLanguage("Покажите фото, пожалуйста")).toBe("ru");
    expect(detectClientLanguage("hello do you have apartments")).toBe("unknown");
    expect(detectClientLanguage("Hello, do you have apartments in the center?")).toBe("unknown");
    expect(detectClientLanguage("what is the price in Sino")).toBe("unknown");
  });
});

describe("class 2: the finished buyer questionnaire is asked once", () => {
  const known = { intake: { role: "buyer", sellerKnown: [], buyerKnown: ["location", "rooms", "budget"] } };
  it("asks preferences the first time", () => {
    expect(render("preferences", "до 600000", context([user("в Сино"), bot("Сколько комнат вам нужно?")], known))).toContain("Что ещё важно");
  });
  it("moves on instead of repeating it", () => {
    const history = context([user("до 600000"), bot("Что ещё важно при выборе: например, этаж или состояние ремонта?")], known);
    const text = render("preferences", "Сино", history)!;
    expect(text).not.toContain("Что ещё важно");
    expect(text).toContain("пришлите номер объекта");
  });
  it("keeps the rest of the reply when only the question is repeated", () => {
    const history = context([bot("Какой район вам подходит?")]);
    const text = renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "thank", question: "location" }, evidence: [],
      language: "ru", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText: "спасибо", verifiedContext: history });
    expect(text).toBe("Спасибо!");
  });
  it("still asks a question that the previous turn did not ask", () => {
    expect(render("location", "двушку", context([bot("Сколько комнат вам нужно?")]))).toBe("Какой район вам подходит?");
  });
});

describe("class 3: a named position is not asked again", () => {
  const evidence: CustomerAgentEvidence[] = [{ ref: "e0", value: vacancies }];
  it("reads the role from the current message even when the catalog text is not shown", () => {
    const text = render("job_position", "вот моё резюме: Анна, 24 года, SMM 2 года", context(), evidence)!;
    expect(text).not.toContain("Какая должность");
  });
  it("reads the role from the history", () => {
    const text = render("job_position", "мне 23, опыт 2 года", context([user("smm"), bot("Какая должность вас интересует?")]), evidence)!;
    expect(text).not.toContain("Какая должность");
  });
  it("an empty catalog does not silence the reply", () => {
    const empty = { kind: "open_vacancies", collecting: true, positions: [], sourceHash: recruitmentCatalogHash({ collecting: true, positions: [] }) } as unknown as CustomerAgentObservation;
    expect(render("job_position", "хочу работать агентом", context(), [{ ref: "e0", value: empty }])).toBeTruthy();
  });
  it("still asks when no role was named", () => {
    expect(render("job_position", "хочу работать", context(), evidence)).toContain("Какая должность");
  });
});

describe("class 4: a repeated reply is varied, never silenced", () => {
  it("answers a repeated question with an honest notice, a different one each time", () => {
    const first = render("job_position", "хочу работать", context([user("хочу работать"), bot("Какая должность вас интересует?")]))!;
    expect(first).toContain("Я уже писал об этом выше");
    const second = render("job_position", "хочу работать", context([user("хочу работать"), bot("Какая должность вас интересует?"),
      user("хочу работать"), bot(first)]))!;
    expect(second).not.toBe(first);
    expect(second).toContain("своими словами");
    expect(second).not.toContain("Какая должность");
  });
  it("introduces the same facts when they are asked for again", () => {
    const line = "Офис Royal Home: Душанбе, ул. Тестовая, 1.\nСотрудники на связи с 09:30 до 18:00 по Душанбе. Выходные: воскресенье.";
    const asked = render("none", "где ваш офис?", context([user("где ваш офис?"), bot(line)]), [{ ref: "e0", value: company }],
      { decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" } });
    expect(asked).toMatch(/^Повторю ещё раз:\n/u);
    expect(asked).toContain("ул. Тестовая, 1");
  });
  it("words a bare acknowledgement differently the third time instead of letting the shield swallow it", () => {
    const ack = (turns: Array<{ role: "user" | "assistant"; text: string }>) => renderCustomerAgentDecision({
      decision: { kind: "reply", refs: [], social: "acknowledge", question: "none" }, evidence: [], language: "ru", requestedFacts: [],
      knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText: "цена 1500000", verifiedContext: context(turns) });
    expect(ack([])).toBe("Понял.");
    expect(ack([user("в Фирдавси"), bot("Понял.")])).toBe("Понял.");
    const third = ack([user("в Фирдавси"), bot("Понял."), user("120 метров"), bot("Понял.")]);
    expect(third).toBe("Хорошо, принято.");
    const fourth = ack([user("a"), bot("Понял."), user("b"), bot("Понял."), user("c"), bot(third!)]);
    expect(fourth).toBe("Ясно, спасибо.");
  });
  it("keeps a greeting that was not just said", () => {
    const text = renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "greet", question: "none" }, evidence: [], language: "ru",
      requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText: "привет", verifiedContext: context([bot("Какой район?")]) });
    expect(text).toBe("Здравствуйте!");
  });
  it("lets the fixed wording into conversation memory", () => {
    const lines = customerAgentFixedLines();
    for (const line of ["Что ещё важно при выборе: например, этаж или состояние ремонта?", "Какая должность вас интересует?",
      "Расскажите о недвижимости, которую хотите продать.", "Повторю ещё раз:", "Хорошо, принято."]) expect(lines.has(line)).toBe(true);
  });
});

describe("class 5: threats, insults and spam get no company facts", () => {
  it.each([["я вас найду и сожгу ваш офис", "threat"], ["убью вас всех", "threat"], ["аҳмақ шумо", "insult"], ["ты тупой бот", "insult"],
    ["бешарм", "insult"], ["подпишись на мой канал", "spam"], ["заработок без вложений пиши мне в директ", "spam"],
    ["казино 100% выигрыш t.me/xyz", "spam"]])("%s is %s", (text, kind) => {
    expect(customerDmAbuseKind(text)).toBe(kind);
  });
  it.each(["где ваш офис?", "убитая квартира в Сино, цена?", "зарезервируйте квартиру", "уничтожьте мои данные", "можно подписаться на ваш канал?",
    "вы мошенники, деньги верните", "сколько стоит дом", "Салом, мехоҳам хона харам"])("%s is an ordinary message", text => {
    expect(customerDmAbuseKind(text)).toBeNull();
  });
  it("does not read the office for a threat but still answers a real office question", () => {
    expect(customerCompanyInformationRequested("я вас найду и сожгу ваш офис")).toBe(false);
    expect(customerCompanyInformationRequested("где находится ваш офис?")).toBe(true);
    const evidence: CustomerAgentEvidence[] = [{ ref: "e0", value: company }];
    const decision = { kind: "reply", refs: ["e0"], social: "acknowledge", question: "none" } as never;
    const threat = renderCustomerAgentDecision({ decision, evidence, language: "ru", requestedFacts: [], knownPhoneSource: "none",
      maxOutputChars: 4000, surface: "dm", inputText: "я вас найду и сожгу ваш офис", verifiedContext: context() })!;
    expect(threat).not.toMatch(/Тестовая|Офис|Душанбе/u);
    expect(threat.length).toBeLessThan(200);
    const real = renderCustomerAgentDecision({ decision, evidence, language: "ru", requestedFacts: [], knownPhoneSource: "none",
      maxOutputChars: 4000, surface: "dm", inputText: "где находится ваш офис?", verifiedContext: context() })!;
    expect(real).toContain("ул. Тестовая, 1");
  });
  it("answers in the customer's language", () => {
    const text = renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "acknowledge", question: "none" } as never, evidence: [],
      language: "tg", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText: "аҳмақ шумо", verifiedContext: context() })!;
    expect(text).toContain("лаҳн");
  });
});
