import { describe, expect, it, vi } from "vitest";
// Pure renderer: no database is touched; the stub keeps tests/setup.ts from resetting one.
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));
import { customerAgentVerifiedContextSchema, customerHandoverAckText, customerHandoverAckTexts, recruitmentPhoneLine,
  retiredRecruitmentPhoneLines, type CustomerAgentCompanyKnowledge } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerAgentFixedLines, customerAgentRetiredRepeatLines,
  type CustomerAgentEvidence, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerReplyCallsStaff } from "../src/ai/customerAgentStaffFollowUp.js";
import { RETIRED_TEMPLATE_LINES } from "../src/ai/customerAgentLiveWording.js";
import { customerSellerIntakeQuestion, customerSellerIntakeQuestionLines } from "../src/ai/customerAgentIntake.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";

/**
 * Аудит бота 16.11.2026 (convs-5d.jsonl, 189 чатов): классы нового ядра, на каждый — живые тексты клиентов.
 * 1 кнопка рекламы → «пришлите номер объекта» (65 чатов); 4 вакансии: номер Нозы повторно, свой номер кандидата пропал,
 * «никто не берёт» → «Извините за неудобство»; 5 служебные квитанции; 6 «я уточнял» после ссылки и «Понял.» на цифры;
 * 7 зона — Душанбе и Рудаки; 3 запрещённые слова в таджикских шаблонах (сторож на все строки рендера).
 */
const knowledge: CustomerAgentCompanyKnowledge = { version: 1, source: "AGENCY_FACTS", city: "Душанбе", otherCities: false,
  commission: { sellerPercent: 2, buyerPercent: 0 }, rent: false, installments: false, mortgage: false, botNamesDiscount: false, guarantees: false };
const sourceHash = customerAgentCompanyKnowledgeHash(knowledge);
const policy = (topic: "legal" | "rental" | "service_scope"): CustomerAgentObservation =>
  ({ kind: "company_policy", topic, knowledge, sourceHash }) as CustomerAgentObservation;
const user = (text: string) => ({ role: "user" as const, text });
const bot = (text: string) => ({ role: "assistant" as const, text });
type Turn = { role: "user" | "assistant"; text: string };
const context = (turns: Turn[] = [], topic = "unknown") =>
  customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
    publicState: { language: "unknown", topic, openQuestion: "none" } });
type Decision = { kind: "reply" | "clarify"; refs: string[]; social: "none" | "greet" | "thank" | "acknowledge"; question: string };
function render(inputText: string, opts: { decision?: Partial<Decision>; evidence?: CustomerAgentEvidence[]; turns?: Turn[];
  language?: "ru" | "tg"; topic?: string; phone?: "none" | "current_input" } = {}) {
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "none", question: "none", ...opts.decision } as never,
    evidence: opts.evidence ?? [], language: opts.language ?? "ru", requestedFacts: [], knownPhoneSource: opts.phone ?? "none",
    maxOutputChars: 4000, surface: "dm", knowledgeSourceHash: sourceHash, inputText, verifiedContext: context(opts.turns ?? [], opts.topic) });
}
const AD_RU = "Привет! Можно узнать об этом подробнее?";
const AD_Q_RU = "Подскажите, что вас интересует: купить, продать недвижимость или работа у нас?";

describe("1. кнопка рекламы без метки — живой вопрос, а не «пришлите номер объекта»", () => {
  it.each([[AD_RU], ["Здравствуйте! Можно узнать об этом подробнее?"], ["Здравствуйте можно по подробнее пожалуйста"]])("%s", input => {
    const text = render(input, { decision: { kind: "clarify", social: "greet", question: "property" } })!;
    expect(text).toBe(`Здравствуйте!\n${AD_Q_RU}`);
    expect(text).not.toMatch(/номер объекта|объект вы имеете/u);
  });
  it("«Салом» после кнопки: по-таджикски, без второго приветствия и без «какой объект» (16680508, 15.11)", () => {
    const text = render("Салом", { language: "tg", decision: { kind: "clarify", social: "greet", question: "property" },
      turns: [user(AD_RU), bot(`Здравствуйте!\n${AD_Q_RU}`)] })!;
    expect(text).toBe("Чӣ хизмат кунам?");
  });
  it("клиент сказал своё — обычный вопрос ядра остаётся", () => {
    expect(render("Хочу купить квартиру", { decision: { kind: "clarify", question: "rooms" } })).toBe("Сколько комнат вам нужно?");
  });
});

describe("приветствие: «Ваалайкум ассалом!» на «Ассалому алейкум», один раз за чат", () => {
  it("ответ на салам (live-agent-phrases: «Ваалайкум ассалом! Чӣ хизмат кунам?»)", () => {
    expect(render("Ассалому алейкум", { language: "tg", decision: { social: "greet", question: "role" } }))
      .toBe("Ваалайкум ассалом!\nЧӣ хизмат кунам?");
  });
  it("уже здоровались — не здороваемся снова (c3cf25f7, a46f734b)", () => {
    const text = render("Салом", { language: "tg", decision: { social: "greet", question: "role" },
      turns: [user("Хона мефурушед?"), bot("Ассалому алайкум!\nШумо хона мехаред ё мефурӯшед?"), user("ха")] })!;
    expect(text).not.toMatch(/Салом|Ассалому|Ваалайкум/u);
    expect(text.trim()).not.toBe("");
  });
});

describe("7. зона: Душанбе и район Рудаки", () => {
  it.each([["ru", "В каком городе вы работаете?"], ["tg", "Шумо дар кадом шаҳр кор мекунед?"]] as const)("%s", (language, input) => {
    const text = render(input, { language, evidence: [{ ref: "e0", value: policy("service_scope") }], decision: { refs: ["e0"] } })!;
    expect(text).toMatch(language === "tg" ? /Душанбе ва ноҳияи Рӯдакӣ/u : /Душанбе и районе Рудаки/u);
    expect(text).not.toMatch(/амвол|в городе Душанбе\./u);
  });
});

describe("ответ по вопросу: юридическая справка и аренда — только когда о них спросили", () => {
  it.each(["Хочу продать квартиру", "Мехоҳам хонаамро фурӯшам"])("«%s» — без «юридической чистоты»", input => {
    const text = render(input, { evidence: [{ ref: "e0", value: policy("legal") }], decision: { refs: ["e0"], question: "seller_details" } })!;
    expect(text).not.toMatch(/юридическ|ҳуқуқ/u);
    expect(text.trim()).not.toBe("");
  });
  it("«Тобеи марказ намешавад» — без «арендой не занимаемся» (#30)", () => {
    const text = render("Тобеи марказ намешавад", { language: "tg", evidence: [{ ref: "e0", value: policy("rental") }], decision: { refs: ["e0"] },
      turns: [user("Хона мехарам"), bot("Кадом тарафи шаҳрро мехоҳед?")] })!;
    expect(text).not.toMatch(/иҷора|аренд/u);
  });
  it("про документы спросили — справка остаётся", () => {
    const text = render("Документы чистые? Техпаспорт есть?", { evidence: [{ ref: "e0", value: policy("legal") }], decision: { refs: ["e0"] } })!;
    expect(text).toContain("Не могу гарантировать юридическую чистоту объекта.");
  });
});

describe("6. ссылка — не «о каком объекте речь», «Понял.» — не ответ на цифры", () => {
  const unresolved: CustomerAgentEvidence = { ref: "e0", value: { kind: "property_unresolved", status: "missing", reason: "no_reference" } };
  it("прислал ссылку (14677daa, 13.11): человек смотрит, без «Я уточнял»", () => {
    const text = render("https://www.instagram.com/p/DfkpyxjMd5P/", { evidence: [unresolved],
      decision: { kind: "clarify", refs: ["e0"], question: "property" }, turns: [user("Цена?"), bot("Какой объект вы имеете в виду? Пришлите номер объекта или ссылку.")] })!;
    expect(text).not.toMatch(/уточнял|Какой объект/u);
    expect(customerReplyCallsStaff(text)).toBe(true);
  });
  it.each(["Хона 4 хонаги 101кв 6 этаж", "Ай тарафои 92 33 гаи чалчам мардон"])("«%s» → не одно «Фаҳмидам.»", input => {
    const text = render(input, { language: "tg", decision: { social: "acknowledge" } })!;
    expect(text).not.toBe("Фаҳмидам.");
    expect(text.trim()).not.toBe("");
  });
  it("«ок» — короткое «Понял.» остаётся", () => {
    expect(render("ок", { decision: { social: "acknowledge" } })).toBe("Понял.");
  });
});

describe("4. вакансии: номер Нозы один раз, свой номер кандидата, жалоба — человеку", () => {
  const position = { key: "real-estate-agent", revision: 1, titleRu: "Менеджер по продажам недвижимости", titleTg: "Менеҷери фурӯш",
    detailsRu: "", detailsTg: "", isOpen: true, keywords: [], postCodes: [] };
  const data = { collecting: true, positions: [position] };
  const catalog: CustomerAgentEvidence = { ref: "e0", value: { kind: "open_vacancies", ...data, sourceHash: recruitmentCatalogHash(data) } as never };
  const given = [user("Я по поводу вакансии"), bot(["Открыта вакансия:", position.titleRu, recruitmentPhoneLine("ru")].join("\n"))];
  it("свой номер после номера Нозы (6fd2a4ab, 16.11 02:25): «передал Нозе» и сигнал человеку", () => {
    const text = render("для ватсап напишите 880807101 для звонка 501037101", { topic: "job", turns: given, evidence: [catalog], decision: { refs: ["e0"] } })!;
    expect(text).toBe("Спасибо, передал ваш номер Нозе, она сама вам позвонит.");
    expect(customerReplyCallsStaff(text)).toBe(true);
  });
  it("«звонила, никто не берёт» (19f20dec, 13.11 18:18): не «Извините за неудобство», а человек", () => {
    const text = render("Я два раза звонила никто не поднимает трубку", { topic: "job", turns: given, decision: { social: "apologize" } })!;
    expect(text).not.toContain("неудобство");
    expect(customerReplyCallsStaff(text)).toBe(true);
  });
  it.each(["какие обязанности?", "какой график?", "Написала вам в ватсап"])("после номера «%s» — номер не повторяется", input => {
    const text = render(input, { topic: "job", turns: given, evidence: [catalog], decision: { refs: ["e0"] } }) ?? "";
    expect(text).not.toContain("777 070 100");
  });
  it("таджикская строка Нозы без «лутфан» и «мутахассис»; старая помнится как уже сказанная", () => {
    expect(recruitmentPhoneLine("tg")).not.toMatch(/лутфан|мутахассис/iu);
    const old = retiredRecruitmentPhoneLines()[0];
    const text = render("чанд маош?", { language: "tg", topic: "job", turns: [user("кор"), bot(`Ҷойи кори кушода:\n${position.titleTg}\n${old}`)],
      evidence: [catalog], decision: { refs: ["e0"] } }) ?? "";
    expect(text).not.toContain("777 070 100");
  });
});

describe("5. квитанции человеческими словами, один раз", () => {
  const receipt = (outcome: string): CustomerAgentEvidence => ({ ref: "r0", value: { kind: "receipt", outcome } as never });
  it("заявка человеку", () => {
    expect(customerHandoverAckText("ru")).toBe("Спасибо, передал ваше сообщение сотруднику.");
    expect(customerHandoverAckText("tg")).toBe("Ташаккур, дархости шумо қабул шуд.");
    // A part planned before the change is still delivered.
    expect(customerHandoverAckTexts("ru")).toContain("Заявка на связь с сотрудником сохранена.");
  });
  it("«Ташаккур, қайд кардам.» не повторяется в одном чате (31f39fcb: пять раз)", () => {
    const first = render("19", { language: "tg", topic: "job", evidence: [receipt("job_application_saved")], decision: { refs: ["r0"] } });
    expect(first).toContain("Ташаккур, қайд кардам.");
    const again = render("Сола хастам", { language: "tg", topic: "job", evidence: [receipt("job_application_saved")], decision: { refs: ["r0"] },
      turns: [user("19"), bot("Ташаккур, қайд кардам.")] }) ?? "";
    expect(again).not.toContain("Ташаккур, қайд кардам.");
  });
});

describe("3. сторож: запрещённые владельцем слова ни в одной строке рендера (tajik-phrasebook, do-not-say)", () => {
  const BANNED = /лутфан|безаҳмат|безахмат|хоҳиш\s+мекунем|мутахассис|муфассал|ёрӣ\s+медиҳем|\s—\s/iu;
  const retired = new Set([...RETIRED_TEMPLATE_LINES, ...retiredRecruitmentPhoneLines(), ...customerAgentRetiredRepeatLines()]);
  it("все фиксированные строки, которые рендер может сказать сейчас", () => {
    const live = [...customerAgentFixedLines()].filter(line => !retired.has(line) && !/Барои фурӯш .*-ро нависед/u.test(line));
    expect(live.filter(line => BANNED.test(line))).toEqual([]);
    expect(BANNED.test(recruitmentPhoneLine("tg"))).toBe(false);
  });
  it("вопрос продавцу живыми словами, без «нарх бо асъор-ро»", () => {
    expect(customerSellerIntakeQuestion([], "tg")).toBe("Хонаатон чанд ҳуҷра, чанд квадрат, дар куҷо, кадом ошёна, бо таъмир ё каробка ва нархаш чанд? Ҳамаи маълумотро дар як паём нависед.");
    expect(customerSellerIntakeQuestionLines()).toContain("Барои фурӯш шумораи ҳуҷраҳо, масоҳат, ноҳия ё нишонӣ, ошёна, ҳолати таъмир, нарх бо асъор-ро нависед. Ҳамаашро дар як паём фиристода метавонед.");
  });
  it("таджикская цена — по разговорнику", () => {
    const facts = { kind: "facts", kinds: ["price"], facts: { propertyId: "p", shortId: 191, signature: "s", price: "96100", currency: "USD",
      availability: "AVAILABLE", publicAddress: null, publicLink: null, characteristics: null } } as never;
    const text = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["f0"], social: "none", question: "none" } as never,
      evidence: [{ ref: "f0", value: facts }], language: "tg", requestedFacts: ["price"], knownPhoneSource: "none", maxOutputChars: 4000,
      surface: "dm", knowledgeSourceHash: sourceHash, inputText: "нархаш чанд", verifiedContext: context() });
    expect(text).toContain("Нархаш 96 100 доллар аст.");
    expect(text).not.toMatch(/USD|Нархи объект/u);
  });
});
