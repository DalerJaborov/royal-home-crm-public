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
import { recruitmentAlertKind } from "../src/lib/customerRecruitmentAlert.js";

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
  // Review #206 С1: a seller's facts and a buyer's budget are ordinary answers — the next question, never «скажет агент».
  it("продавец дал данные (c3cf25f7) → следующий вопрос анкеты, не «Фаҳмидам.» и не передача агенту", () => {
    const text = render("Хона 4 хонаги 101кв 6 этаж", { language: "tg", decision: { social: "acknowledge" },
      turns: [user("Мехоҳам хонаамро фурӯшам"), bot("Ассалому алайкум!")] })!;
    expect(text).not.toBe("Фаҳмидам.");
    expect(text).toMatch(/^Хонаатон/u);
    expect(customerReplyCallsStaff(text)).toBe(false);
  });
  it("покупатель «до 50000» на вопрос о бюджете → не передача агенту", () => {
    const text = render("до 50000", { decision: { social: "acknowledge" },
      turns: [user("Хочу купить квартиру"), bot("Какой бюджет вы рассматриваете?")] })!;
    expect(customerReplyCallsStaff(text)).toBe(false);
  });
  it.each([["до 50000. А в Сино есть варианты?", "ru", "Хочу купить квартиру", "Какой бюджет вы рассматриваете?"],
    ["50000 доллар, ипотека хаст?", "tg", "Хона мехарам", "Чӣ қадар маблағ дар назар доред?"]] as const)(
    "вопрос клиента вместе с данными (повторное ревью Н1): «%s» → человек, не следующий вопрос анкеты", (input, language, first, asked) => {
    const text = render(input, { language, decision: { social: "acknowledge" }, turns: [user(first), bot(asked)] })!;
    expect(customerReplyCallsStaff(text)).toBe(true);
    expect(text).not.toMatch(/Сколько комнат|Кадом тарафи/u);
  });
  it("вопрос с цифрами, на который нечего ответить, → человек", () => {
    const text = render("а 92 мкр есть?", { language: "ru", decision: { social: "acknowledge" } })!;
    expect(customerReplyCallsStaff(text)).toBe(true);
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
    // The vacancy owners get the signal with the number in the same transaction (lib/customerRecruitmentAlert.ts).
    expect(recruitmentAlertKind(text)).toBe("phone_given");
  });
  it("«звонила, никто не берёт» (19f20dec, 13.11 18:18): не «Извините за неудобство», а человек", () => {
    const text = render("Я два раза звонила никто не поднимает трубку", { topic: "job", turns: given, decision: { social: "apologize" } })!;
    expect(text).not.toContain("неудобство");
    expect(recruitmentAlertKind(text)).toBe("complaint");
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
    expect(text).toContain("Объекти №191: нархаш 96 100 доллар аст.");
    expect(text).not.toMatch(/USD|Нархи объект/u);
  });
});

describe("ревью #206: вакансии без ложных срабатываний (В1, В2), сигнал кругу вакансий с номером (В3)", () => {
  const position = { key: "real-estate-agent", revision: 1, titleRu: "Менеджер по продажам недвижимости", titleTg: "Менеҷери фурӯш",
    detailsRu: "", detailsTg: "", isOpen: true, keywords: [], postCodes: [] };
  const given = [user("Я по поводу вакансии"), bot(["Открыта вакансия:", position.titleRu, recruitmentPhoneLine("ru")].join("\n"))];
  const job = (input: string, turns = given) => render(input, { topic: "job", turns, decision: { social: "none" } }) ?? "";
  it.each(["Когда собеседование?", "Здравствуйте, я по поводу собеседования", "Мне Ноза звонила, всё хорошо", "Ноза ба ман занг зад, ташаккур",
    "Я позвонил, договорились на завтра", "Хорошо, никто не против"])("«%s» — не жалоба", input => {
    expect(job(input)).not.toMatch(/не получилось связаться|хабар додем/u);
  });
  it.each(["Я два раза звонила никто не поднимает трубку", "Звоню, не берут трубку", "Занг задам, намегирад"])("«%s» — жалоба после номера Нозы", input => {
    expect(job(input)).toMatch(/не получилось связаться|хабар додем/u);
  });
  it("жалоба до номера Нозы — не «передал Нозе»", () => {
    expect(job("Звоню, не берут трубку", [user("Я по поводу вакансии")])).not.toContain("Передал Нозе");
  });
  it.each(["Могу выйти с 20.11.2026", "Зарплата 3000-5000?", "Опыт с 2019 2024", "Мне 25 лет, опыт 3 года", "ИНН 123456789"])("«%s» — не номер телефона", input => {
    expect(job(input)).not.toContain("передал ваш номер");
  });
  it.each(["Мой номер 93 555 12 34", "+992 93 555 1234", "WhatsApp: 935551234"])("«%s» — номер кандидата", input => {
    expect(job(input)).toBe("Спасибо, передал ваш номер Нозе, она сама вам позвонит.");
  });
  it("сигнал: круг вакансий, номер в тексте, свой тег на каждый номер; не встал в очередь — исключение", async () => {
    const { enqueueRecruitmentCandidateAlertTx } = await import("../src/lib/customerRecruitmentAlert.js");
    const rows: Array<Record<string, unknown>> = [];
    const tx = { pendingDirectorAlert: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); return data; } } };
    const reply = "Спасибо, передал ваш номер Нозе, она сама вам позвонит.";
    await enqueueRecruitmentCandidateAlertTx(tx as never, { replyText: reply, customerText: "Мой номер 93 555 12 34", conversationId: "c1", channel: "WHATSAPP", eventKey: "e".repeat(64) });
    await enqueueRecruitmentCandidateAlertTx(tx as never, { replyText: reply, customerText: "Другой: 91 777 88 99", conversationId: "c1", channel: "WHATSAPP", eventKey: "f".repeat(64) });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ recipientPermission: "vacancies.view" });
    expect(String(rows[0].body)).toMatch(/93.?555.?12.?34|935551234/u);
    expect(rows[0].tag).not.toBe(rows[1].tag);
    expect(rows[0].url).toBe("/messages?open=c1");
    // «Cannot get through» (re-review Н2): who to call and the link to this chat.
    rows.length = 0;
    await enqueueRecruitmentCandidateAlertTx(tx as never, { replyText: "Извините, что не получилось связаться. Передал Нозе, она сама вам позвонит.",
      customerText: "Звоню, не берут трубку", conversationId: "c2", channel: "WHATSAPP", eventKey: "a".repeat(64), peer: "992935551234" });
    expect(rows[0]).toMatchObject({ url: "/messages?open=c2", recipientPermission: "vacancies.view" });
    expect(String(rows[0].body)).toContain("+992935551234");
    expect(await enqueueRecruitmentCandidateAlertTx(tx as never, { replyText: "Понял.", customerText: "ок", conversationId: "c1", channel: "WHATSAPP", eventKey: "e".repeat(64) })).toBeNull();
    const broken = { pendingDirectorAlert: { create: async () => { throw new Error("db down"); } } };
    await expect(enqueueRecruitmentCandidateAlertTx(broken as never, { replyText: reply, customerText: "Мой номер 93 555 12 34", conversationId: "c1", channel: "WHATSAPP", eventKey: "e".repeat(64) })).rejects.toThrow();
  });
  it("сигнал о кандидате не идёт общей дверью «скажет агент»", () => {
    expect(customerReplyCallsStaff("Спасибо, передал ваш номер Нозе, она сама вам позвонит.")).toBe(false);
  });
  it("«Мне 25 лет» до номера Нозы — номер Нозы, не «расскажет Ноза» без номера (С1)", () => {
    const text = render("Мне 25 лет, что дальше?", { topic: "job", turns: [user("работа есть?"), bot("Здравствуйте!")], decision: { social: "acknowledge" } }) ?? "";
    expect(text).toContain("777 070 100");
  });
});

describe("ревью #206: язык старого ядра не тронут (С2), цены с номером (С3), «подробнее» после списка (С4), бюджет (С6), М1", () => {
  it("общий определитель без расширения ведёт себя как раньше; ядро — с душанбинским словарём", async () => {
    const { detectClientLanguage } = await import("../src/ai/clientLanguage.js");
    const { resolveCustomerDmLanguage } = await import("../src/ai/customerDmLanguage.js");
    expect(detectClientLanguage("Оиди вакансия маъоумот медоден")).toBe("unknown"); // legacy: as before 16.11
    expect(resolveCustomerDmLanguage("Оиди вакансия маъоумот медоден")).toBe("tg");
    for (const text of ["Ман по работе омадам", "Работа хаст?", "Работа даркор", "Салом ман по объявлению", "Все хуб", "Ман хамту по работе"]) {
      expect(resolveCustomerDmLanguage(text), text).toBe("tg");
    }
  });
  it("две цены по-таджикски различимы", () => {
    const card = (shortId: number, price: string) => ({ ref: `f${shortId}`, value: { kind: "facts", kinds: ["price"], facts: { propertyId: `p${shortId}`, shortId,
      signature: `s${shortId}`, price, currency: "USD", availability: "AVAILABLE", publicAddress: null, publicLink: null, characteristics: null } } as never });
    const text = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["f191", "f205"], social: "none", question: "none" } as never,
      evidence: [card(191, "96100"), card(205, "54000")], language: "tg", requestedFacts: ["price"], knownPhoneSource: "none", maxOutputChars: 4000,
      surface: "dm", knowledgeSourceHash: sourceHash, inputText: "нархашон чанд", verifiedContext: context() })!;
    expect(text).toContain("№191"); expect(text).toContain("№205");
  });
  it("«можно поподробнее» после показанного списка — не вопрос «купить, продать или работа»", () => {
    const text = render("Можно поподробнее?", { decision: { kind: "clarify", question: "property" },
      turns: [user("Привет! Можно узнать об этом подробнее?"), bot("Можно рассмотреть эти варианты:\n1. Объект №69\n2. Объект №70")] }) ?? "";
    expect(text).not.toContain("купить, продать недвижимость или работа");
  });
  it("бюджет по-таджикски без навязанной валюты", () => {
    expect(render("Хона мехарам", { language: "tg", decision: { kind: "clarify", question: "budget" } })).toBe("Чӣ қадар маблағ дар назар доред?");
  });
  it("после приветствия старого ядра «Ассалому алейкум! …» второй раз не здороваемся", () => {
    const text = render("Салом", { language: "tg", decision: { social: "greet", question: "role" },
      turns: [user("Хона"), bot("Ассалому алейкум! Ман ёрдамчии Royal Home.")] }) ?? "";
    expect(text).not.toMatch(/Ваалайкум|Ассалому/u);
  });
});
