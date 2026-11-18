import { describe, expect, it, vi, beforeEach } from "vitest";
// Pure renderer and core with fake ports: the database is a stub; only the 131047 block below drives it.
const db = vi.hoisted(() => ({ rows: [] as unknown[], updates: 0 }));
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {},
  $transaction: async (run: (tx: unknown) => unknown) => run({
    $queryRaw: async () => db.rows,
    $executeRaw: async () => { db.updates++; return 1; },
  }) } }));
const push = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock("../src/push.js", () => ({ sendPushToAgents: async (_ids: string[], payload: unknown) => { push.sent.push(payload); return 1; } }));
vi.mock("../src/lib/recipients.js", () => ({ findAgentsWithPermission: async () => ["agent-1"] }));
import { customerAgentVerifiedContextSchema, recruitmentPhoneLine, type CustomerAgentCompanyKnowledge } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerAgentQuestionCatalog, customerAgentFixedLines, customerAgentCallbackQuestionLast,
  type CustomerAgentEvidence, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerAgencyDirectQuestion, customerAgencyDirectAnswer, customerAgencyDirectAnswerLines } from "../src/ai/customerAgentConversationPolicy.js";
import { customerPolicyTermAsked, customerAgencyTermsAsked, customerCommissionWordsAsked } from "../src/ai/customerAgentPolicyAsked.js";
import { customerBareAffirmation } from "../src/ai/customerAgentFollowUp.js";
import { isCustomerShortCallbackYes } from "../src/ai/customerAskSignals.js";
import { APPROVED_ASKS, withoutInventedClaims } from "../src/ai/customerAgentHumanText.js";
import { customerStaffFollowUpLine, customerPhoneAskLines } from "../src/ai/customerAgentStaffFollowUp.js";
import { leadOnlyCallOfferLast, leadOnlyHotIntent, leadOnlyOutgoing, leadOnlyPhoneLine,
  leadOnlyReply } from "../src/ai/leadOnlyMode.js";
import { PUBLIC_AGENCY_CONTACT, PUBLIC_AGENCY_WHATSAPP } from "../src/lib/publicAgencyContact.js";
import { AGENCY_FACTS, companyInfoBlock } from "../src/ai/agencyFacts.js";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { noteCustomerDeliveryWindowClosed } from "../src/lib/customerDeliverySettlement.js";

/**
 * Аудит «бот как живой сотрудник» 17.11.2026 (D:/TASKS-2026-11-14/reports/bot-ideal-audit-2026-11-17.md): каждая фраза клиента из
 * таблицы классов — сценарий. Слой РЕШЕНИЯ ядра (шаг 1a, 18.11.2026). Режим «только заявки» включён на проде с 17.11: общие двери
 * (ответ на прямой вопрос, номер офиса, сторож выдумок) проверены и в его чистых функциях (ai/leadOnlyMode.ts). Сигналы руководству,
 * комментарии и щит — шаг 1b (it.todo ниже).
 */
const knowledge: CustomerAgentCompanyKnowledge = { version: 1, source: "AGENCY_FACTS", city: "Душанбе", otherCities: false,
  commission: { sellerPercent: 2, buyerPercent: 0 }, rent: false, installments: false, mortgage: false, botNamesDiscount: false, guarantees: false };
const sourceHash = customerAgentCompanyKnowledgeHash(knowledge);
type Topic = "commission" | "negotiation" | "legal" | "rental" | "service_scope" | "payment";
const policy = (topic: Topic): CustomerAgentObservation => ({ kind: "company_policy", topic, knowledge, sourceHash }) as CustomerAgentObservation;
const user = (text: string) => ({ role: "user" as const, text });
const bot = (text: string) => ({ role: "assistant" as const, text });
type Turn = { role: "user" | "assistant"; text: string };
type Channel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK";
const context = (turns: Turn[] = [], topic = "unknown", channel?: Channel) =>
  customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
    publicState: { language: "unknown", topic, openQuestion: "none" }, ...(channel ? { channel } : {}) });
type Decision = { kind: "reply" | "clarify"; refs: string[]; social: "none" | "greet" | "thank" | "acknowledge"; question: string };
function render(inputText: string, opts: { decision?: Partial<Decision>; evidence?: CustomerAgentEvidence[]; turns?: Turn[];
  language?: "ru" | "tg"; topic?: string; phone?: "none" | "current_input"; channel?: Channel } = {}) {
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "none", question: "none", ...opts.decision } as never,
    evidence: opts.evidence ?? [], language: opts.language ?? "ru", requestedFacts: [], knownPhoneSource: opts.phone ?? "none",
    maxOutputChars: 4000, surface: "dm", knowledgeSourceHash: sourceHash, inputText,
    verifiedContext: context(opts.turns ?? [], opts.topic, opts.channel) });
}
const OFFICE = PUBLIC_AGENCY_CONTACT.phone, WA = PUBLIC_AGENCY_WHATSAPP.phone;
const WA_CALLS = /whats\s*app[^.\n]*(?:звон|занг)|(?:звон|занг)[^.\n]*whats\s*app/iu;

describe("класс 1: прямой вопрос — сначала ответ из фактов (решение владельца 18.11.2026)", () => {
  it("«Ватсап?» в самом WhatsApp: «да, вы пишете нам в WhatsApp», без «подскажет агент»", () => {
    const text = render("Ватсап?", { channel: "WHATSAPP", decision: { social: "acknowledge" } })!;
    expect(text).toContain("Да, вы пишете нам в WhatsApp.");
    expect(text).not.toMatch(/агент/iu);
  });
  it("«WhatsApp доред?» в Instagram: «Бале, WhatsApp: номер»", () => {
    expect(render("WhatsApp доред?", { language: "tg", channel: "INSTAGRAM" })).toBe(`Бале, WhatsApp: ${WA}.`);
  });
  it.each([["Ака ватсап дорен?", "INSTAGRAM"], ["Ватсаб доран ин номер?", "WHATSAPP"], ["Ватсап", "FACEBOOK"]] as const)("«%s» → «да»", (input, channel) => {
    expect(render(input, { language: "tg", channel })).toMatch(/^Бале, /u);
  });
  it("«Можно позвонить?» → номер офиса, без встречного вопроса", () => {
    const text = render("Можно позвонить?", { decision: { kind: "clarify", question: "callback_consent" } })!;
    expect(text).toContain(`Да, позвоните: ${OFFICE}.`);
    expect(text).not.toMatch(/хотите, чтобы сотрудник/iu);
  });
  it.each(["номер офиса?", "Какой у вас номер телефона?", "Дайте ваш номер, я позвоню"])("«%s» → номер офиса", input => {
    expect(render(input)).toContain(OFFICE);
  });
  it("«Хози занг занам, мешавад?» → «Бале, занг занед: офис», не «Мехоҳед корманд…»", () => {
    const text = render("Хози занг занам, мешавад?", { language: "tg", decision: { kind: "clarify", question: "callback_consent" } })!;
    expect(text).toContain(`Бале, занг занед: ${OFFICE}.`);
    expect(text).not.toContain("Мехоҳед корманд");
  });
  it("«ракамхоятонро дихед, ман занг занам» (FB 17.11) → номер офиса", () => {
    expect(render("ракамхоятонро дихед, ман занг занам", { language: "tg" })).toContain(OFFICE);
  });
  it("звонки в WhatsApp не включены: «можно позвонить по ватсапу?» → номер офиса, о звонках в WhatsApp ни слова", () => {
    const text = render("можно позвонить по ватсапу?", { channel: "INSTAGRAM" })!;
    expect(text).toContain(OFFICE);
    expect(text).not.toMatch(WA_CALLS);
    for (const line of customerAgencyDirectAnswerLines()) expect(line).not.toMatch(WA_CALLS);
  });
  it("«Куда можно отправить резюме?» (IG 17.11) → «сюда» и номер Нозы, один раз", () => {
    const text = render("Куда можно отправить резюме?", { topic: "job" })!;
    expect(text).toContain("Резюме можно прислать сюда, в этот чат.");
    expect(text).toContain(recruitmentPhoneLine("ru"));
    const again = render("Куда можно отправить резюме?", { topic: "job", turns: [user("Куда резюме?"), bot(text)] })!;
    expect(again.split(recruitmentPhoneLine("ru")).length).toBe(1);
  });
  it("свой номер клиента и «позвоните» — не вопрос о нашем номере", () => {
    expect(customerAgencyDirectQuestion("Мой номер 927123456, позвоните")).toBeNull();
    expect(customerAgencyDirectQuestion("номер объекта 123?")).toBeNull();
    expect(customerAgencyDirectQuestion("ватсап не надо")).toBeNull();
  });
  it("«Рудаки обслуживаете?» → да, зона Душанбе и Рудаки; продавцу из Рудаки нет «агар дар шаҳри шумо…»", () => {
    expect(render("Рудаки обслуживаете?", { evidence: [{ ref: "e0", value: policy("service_scope") }], decision: { refs: ["e0"] } })).toMatch(/Рудак/iu);
    const seller = render("Хонаам дар Рудакӣ, мефурӯшам. Рақамам 927123456", { language: "tg", phone: "current_input",
      evidence: [{ ref: "e0", value: policy("service_scope") }], decision: { refs: ["e0"] } }) ?? "";
    expect(seller).not.toMatch(/агар дар шаҳри|Мутаассифона, мо танҳо/iu);
  });
  it("факты каналов — в одном месте фактов (AGENCY_FACTS) и в блоке компании обоих ботов", () => {
    expect(AGENCY_FACTS.whatsapp).toBe(WA);
    expect(AGENCY_FACTS.callsInWhatsapp).toBe(false);
    expect(companyInfoBlock()).toContain(WA);
    expect(companyInfoBlock()).not.toMatch(/несуществующий WhatsApp/iu);
  });
});

describe("класс 3: один вопрос — один раз за разговор", () => {
  const CALLBACK_TG = "Мехоҳед корманд ба шумо занг занад?";
  it("Саид (WA 17.11): «Мехоҳед корманд…» уже был, клиент ответил — второй раз не спрашиваем", () => {
    const turns = [user("Ок"), bot("Номи шумо чист?"), user("Саид"), bot(CALLBACK_TG), user("Ок"), bot("Фаҳмидам.")];
    const text = render("Хуб", { language: "tg", turns, decision: { kind: "clarify", question: "callback_consent" } }) ?? "";
    expect(text).not.toContain(CALLBACK_TG);
  });
  it("тот же вид вопроса другими словами (одобренная формулировка) тоже считается заданным", () => {
    const turns = [bot(APPROVED_ASKS.ru.callback_consent[2]), user("потом"), bot("Понял.")];
    expect(render("а цена?", { turns, decision: { kind: "clarify", question: "callback_consent" } }) ?? "").not.toContain("Вы хотите, чтобы сотрудник вам позвонил?");
  });
  it("имя спросили и проигнорировали — не спрашиваем снова (соискатель: 6 раз за чат, 10.11)", () => {
    const turns = [bot("Как к вам обращаться?"), user("хочу купить квартиру"), bot("Сколько комнат вам нужно?"), user("2")];
    expect(render("в Сино", { turns, decision: { kind: "clarify", question: "name" } }) ?? "").not.toContain("Как к вам обращаться?");
  });
});

describe("класс 2: «Ҳо / хо / Бале / Ок» после предложения звонка — согласие, код закрывает", () => {
  it.each(["Ҳо", "хо", "Хо", "Бале", "Ок", "ок", "Ҳа"])("«%s» — короткое «да»", word => {
    expect(customerBareAffirmation(word)).toBe(true);
    expect(isCustomerShortCallbackYes(word)).toBe(true);
  });
  it("вопрос о звонке узнаётся в шаблоне и в одобренных словах", () => {
    expect(customerAgentCallbackQuestionLast("Фаҳмидам.\nМехоҳед корманд ба шумо занг занад?")).toBe(true);
    expect(customerAgentCallbackQuestionLast("Хотите, чтобы наш сотрудник вам позвонил?")).toBe(true);
    expect(customerAgentCallbackQuestionLast("Сколько комнат вам нужно?")).toBe(false);
  });
  it("«Ҳо» никогда не получает строку про торг (IG 17.11)", () => {
    const text = render("Ҳо", { language: "tg", evidence: [{ ref: "e0", value: policy("negotiation") }], decision: { refs: ["e0"] },
      turns: [bot("Мехоҳед корманд ба шумо занг занад?")] }) ?? "";
    expect(text).not.toMatch(/соҳибмулк|тахфиф/iu);
  });
  it("ядро: «Ҳо» на вопрос о звонке — запись звонка сервером, без хода модели", async () => {
    const f = coreFixture({ inputText: "Ҳо", language: "tg", tools: [{ name: "request_callback", description: "callback" }],
      verifiedContext: context([user("Хона мехарам"), bot("Мехоҳед корманд ба шумо занг занад?")], "buyer") });
    f.executeAllowedTool.mockResolvedValue({ status: "observed", observation: { kind: "receipt", outcome: "callback_requested" } });
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", text: "Ташаккур, дархости шумо қабул шуд." });
    expect(f.executeAllowedTool).toHaveBeenCalledWith({ name: "request_callback", args: expect.objectContaining({ topic: expect.any(String) }) }, expect.anything());
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("ядро: журнал отказал в согласии — обычный ход модели, ничего не сказано заранее", async () => {
    const f = coreFixture({ inputText: "Ок", tools: [{ name: "request_callback", description: "callback" }],
      verifiedContext: context([bot("Вы хотите, чтобы сотрудник вам позвонил?")], "buyer") });
    f.executeAllowedTool.mockResolvedValue({ status: "denied", reason: "callback_not_requested" });
    await runCustomerAgentTurn(f.frame, f.ports);
    expect(f.modelTurn).toHaveBeenCalled();
  });
  it("ядро: чистый прямой вопрос «Ватсап?» отвечается без модели", async () => {
    const f = coreFixture({ inputText: "Ватсап?", verifiedContext: context([], "unknown", "WHATSAPP") });
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "ready", text: "Да, вы пишете нам в WhatsApp." });
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("режим «только заявки»: «Ок» на «Агент позвонит вам на этот номер, удобно?» узнаётся как ответ на предложение звонка", () => {
    const offer = leadOnlyReply({ scenario: "seller", language: "ru", phone: { kind: "whatsapp" }, when: { kind: "soon" }, sellerCommissionPercent: 2 });
    expect(leadOnlyCallOfferLast(offer)).toBe(true);
    expect(leadOnlyCallOfferLast(leadOnlyPhoneLine({ kind: "whatsapp" }, { kind: "tomorrow_from", from: "10:00" }, "tg")!)).toBe(true);
    expect(leadOnlyCallOfferLast("Сколько комнат вам нужно?")).toBe(false);
  });
});

describe("класс 2: уместность фактов — торг только на вопрос о торге и не продавцу", () => {
  const negotiation: CustomerAgentEvidence[] = [{ ref: "e0", value: policy("negotiation") }];
  it("покупатель спросил о скидке — строка есть (контроль)", () => {
    expect(render("Скидка будет?", { evidence: negotiation, decision: { refs: ["e0"] } })).toMatch(/торг/iu);
  });
  it("продавец «бо савдо мешавад» — строки про собственника нет (он и есть собственник)", () => {
    const text = render("Хонаамро мефурӯшам, бо савдо мешавад", { language: "tg", evidence: negotiation, decision: { refs: ["e0"] } }) ?? "";
    expect(text).not.toMatch(/соҳибмулк/iu);
  });
  it("«Az 2% kam nameshava» — про нашу комиссию, не про торг с собственником", () => {
    expect(customerPolicyTermAsked("negotiation", "Az 2% kam nameshava")).toBe(false);
    expect(customerCommissionWordsAsked("Az 2% kam nameshava")).toBe(true);
    expect(render("Az 2% kam nameshava", { language: "tg", evidence: negotiation, decision: { refs: ["e0"] } }) ?? "").not.toMatch(/соҳибмулк/iu);
  });
  it("«Этаж ва нарх» — ни торга, ни юр. чистоты, ни аренды", () => {
    const evidence: CustomerAgentEvidence[] = [{ ref: "e0", value: policy("negotiation") }, { ref: "e1", value: policy("legal") }, { ref: "e2", value: policy("rental") }];
    expect(render("Этаж ва нарх", { language: "tg", evidence, decision: { refs: ["e0", "e1", "e2"] } }) ?? "").not.toMatch(/соҳибмулк|ҳуқуқ|иҷора/iu);
  });
});

describe("«Понял.» не подменяется «подскажет агент», если на вопрос есть факт", () => {
  it("«Ватсап?» с решением «понял» → факт, не STAFF", () => {
    const text = render("Ватсап?", { phone: "current_input", channel: "WHATSAPP", decision: { social: "acknowledge" } })!;
    expect(text).not.toMatch(/Это точно подскажет наш агент/u);
    expect(text).toContain("WhatsApp");
  });
});

describe("«амвол» → «хона», как в APPROVED_ASKS (tajik-phrasebook)", () => {
  it("вопрос темы и починки — одним словом с одобренным списком", () => {
    const topic = customerAgentQuestionCatalog("tg").filter(entry => entry.question === "topic" || entry.question === "role").map(entry => entry.text);
    for (const line of topic) expect(line).not.toMatch(/амвол/iu);
    expect(topic).toContain(APPROVED_ASKS.tg.topic[0]);
  });
  it("старые строки с «амвол» узнаются памятью", () => {
    expect(customerAgentFixedLines().has("Шумо дар бораи амвол маълумот мехоҳед ё дар бораи кор?")).toBe(true);
  });
});

describe("класс 3: в WhatsApp номер не просим — все пути ядра", () => {
  it("вопрос номера гасится в WhatsApp даже без отметки номера", () => {
    expect(render("Хочу купить", { channel: "WHATSAPP", decision: { kind: "clarify", question: "phone" } }) ?? "").not.toMatch(/номер телефона/iu);
  });
  it("передача агенту в WhatsApp — без просьбы номера", () => {
    const text = render("а ипотека для иностранцев как оформляется?", { channel: "WHATSAPP", decision: { social: "acknowledge" } }) ?? "";
    expect(text).not.toMatch(/номер телефона|рақами телефон/iu);
  });
  it("продавцу в WhatsApp после сведений — удобное время звонка, а не номер", () => {
    const text = render("Хона дар пушти опера балет 95 кв каропка", { language: "tg", channel: "WHATSAPP",
      turns: [user("Хонаамро мефурӯшам"), bot("Хонаатон чанд ҳуҷра, чанд квадрат, дар куҷо, кадом ошёна, бо таъмир ё каробка ва нархаш чанд? Ҳамаи маълумотро дар як паём нависед.")],
      decision: { social: "acknowledge", kind: "clarify", question: "seller_details" } })!;
    expect(text).toContain("Кай барои шумо мувофиқ аст, ки агент занг занад?");
    expect(text).not.toMatch(/рақами телефон/iu);
  });
  it("режим «только заявки» в WhatsApp: строка о звонке без просьбы номера (контроль)", () => {
    expect(leadOnlyPhoneLine({ kind: "whatsapp" }, { kind: "soon" }, "ru")).not.toMatch(/напишите|оставьте/iu);
  });
});

describe("класс 3: после сведений продавца — всегда шаг к номеру", () => {
  it("Instagram: «Хона дар пушти опера балет 95 кв каропка» → не голое «Фаҳмидам.», а просьба номера", () => {
    const text = render("Хона дар пушти опера балет 95 кв каропка", { language: "tg", channel: "INSTAGRAM",
      turns: [user("Хонаамро мефурӯшам"), bot("Хонаатон чанд ҳуҷра, чанд квадрат, дар куҷо, кадом ошёна, бо таъмир ё каробка ва нархаш чанд? Ҳамаи маълумотро дар як паём нависед.")],
      decision: { social: "acknowledge" } })!;
    expect(text).not.toBe("Фаҳмидам.");
    expect(text).toContain("Рақами телефонатонро нависед, то агенти мо занг занад.");
  });
  it("номер уже просили — второй раз не просим", () => {
    const turns = [user("Хонаамро мефурӯшам"), bot("Рақами телефонатонро нависед, то агенти мо занг занад."), user("ҳоло не")];
    const text = render("3 ҳуҷра, 80 кв, Сино", { language: "tg", turns, decision: { social: "acknowledge" } }) ?? "";
    expect(text).not.toContain("Рақами телефонатонро нависед");
  });
});

describe("тупик «агент позвонит» без номера (стенд атак, 14 из 73)", () => {
  it("без номера — просьба номера без обещания звонка", () => {
    const line = customerStaffFollowUpLine("ru", "none", { said: () => false, phoneAsked: false });
    expect(line).not.toMatch(/позвон|свяжется/iu);
    expect(customerPhoneAskLines()).toContain(line);
  });
  it("старая просьба (с «позвонил») всё ещё узнаётся как уже заданная", () => {
    expect(customerPhoneAskLines()).toContain("Это точно подскажет наш агент. Напишите, пожалуйста, ваш номер телефона, чтобы агент вам позвонил.");
  });
  it("соискатель («хочу работать у вас») — номер Нозы, а не «подскажет наш агент»", () => {
    const text = render("хочу работать у вас, как устроиться?", { topic: "job", decision: { social: "acknowledge" } }) ?? "";
    expect(text).not.toMatch(/подскажет наш агент/iu);
  });
  it("с номером (WhatsApp) обещание звонка законно", () => {
    expect(customerStaffFollowUpLine("ru", "scoped_contact", { said: () => false, phoneAsked: false })).toMatch(/позвонит/u);
  });
});

describe("класс 6: сторож выдумок в последней двери", () => {
  it.each([
    "Ватсап дар ҳамин рақам нест.", "WhatsApp надорем, ба ҳамин ҷо нависед.", "Мо бо WhatsApp пул намегирем.",
    "Имрӯз баъд аз соати 10:00 агенти мо ба шумо занг мезанад.", "Дархости шуморо ба агенти мо Ноза додам, вай ҳозир занг мезанад.",
    "Имрӯз агенти мо Сайфуллоев ба шумо занг мезанад.", "Ҷойгиршавӣ: маҳаллаи Лучоби поён.", "Позвоните нам по WhatsApp.",
  ])("«%s» вырезается", sentence => {
    expect(withoutInventedClaims(sentence).removed).toHaveLength(1);
  });
  it("факты хода остаются: часы офиса, адрес объекта из карточки, номер Нозы, «не могу подтвердить»", () => {
    const keep = ["Сотрудники на связи с 10:00 до 22:30 по Душанбе.", "Ҷойгиршавӣ: Навбахор 2, Сино.", recruitmentPhoneLine("ru"), recruitmentPhoneLine("tg"),
      "Точное расположение пока не могу подтвердить.", `Да, WhatsApp: ${WA}.`, "Агент позвонит вам в рабочее время."];
    for (const line of keep) expect(withoutInventedClaims(line, ["10:00", "Навбахор 2, Сино"]).removed).toEqual([]);
  });
  it("ответ рендера с адресом не из фактов теряет только эту фразу", () => {
    expect(withoutInventedClaims("Спасибо!\nРасположение: Зарафшон, наздики бозорча.").text).toBe("Спасибо!");
  });
  it("режим «только заявки»: «нет WhatsApp» и имя агента не уходят, время из Настроек остаётся", () => {
    expect(leadOnlyOutgoing("WhatsApp надорем. Агент позвонит вам на этот номер сегодня с 10:00. Удобно?", "ru"))
      .toBe("Агент позвонит вам на этот номер сегодня с 10:00. Удобно?");
  });
});

describe("«Условия, пожалуйста» — вопрос (остаток ревью #269)", () => {
  it.each(["Условия, пожалуйста", "Условия пожалуйста", "Пожалуйста, условия", "Шартҳо, илтимос", "Условия."])("«%s» спрашивает условия", text => {
    expect(customerAgencyTermsAsked(text)).toBe(true);
  });
  it("описание остаётся описанием", () => {
    expect(customerAgencyTermsAsked("мне условия не важны")).toBe(false);
    expect(customerAgencyTermsAsked("все условия есть")).toBe(false);
  });
});

describe("131047: окно WhatsApp 24 часа закрыто — без повтора, клиента видит человек (доставка ядра)", () => {
  beforeEach(() => { db.rows = []; db.updates = 0; push.sent = []; });
  it("отказ не про окно (131026) не трогает доставку", async () => {
    expect(await noteCustomerDeliveryWindowClosed({ mid: "wamid.1", errorCode: 131026, error: "Message undeliverable" })).toBe(false);
    expect(db.updates).toBe(0);
  });
  it("131047 по нашей части: метка и одно уведомление сотрудникам", async () => {
    db.rows = [{ id: "att-1", partId: "part-1", errorCode: null, conversationId: "conv-1", channel: "WHATSAPP" }];
    expect(await noteCustomerDeliveryWindowClosed({ mid: "wamid.1", errorCode: 131047, error: "Re-engagement message" })).toBe(true);
    expect(db.updates).toBe(1);
    expect(push.sent).toHaveLength(1);
    expect(JSON.stringify(push.sent[0])).toContain("/messages?open=conv-1");
  });
  it("второй такой же статус — без второго уведомления", async () => {
    db.rows = [{ id: "att-1", partId: "part-1", errorCode: "window_closed", conversationId: "conv-1", channel: "WHATSAPP" }];
    expect(await noteCustomerDeliveryWindowClosed({ mid: "wamid.1", errorCode: 131047, error: "Re-engagement message" })).toBe(false);
    expect(push.sent).toHaveLength(0);
  });
});

describe("класс 5: горячий покупатель «где / куда ехать» — режим «только заявки» узнаёт его (дом №192, WA 12.11)", () => {
  it.each(["гучо равем", "рафта бинем", "мо харидори аникем", "кучо биёем"])("«%s» — горячие слова", text => {
    expect(leadOnlyHotIntent(text)).toBe(true);
  });
  it("«где ваш офис?» — вопрос о компании, не горячий (контроль)", () => {
    expect(leadOnlyHotIntent("где ваш офис?")).toBe(false);
  });
});

describe("класс 7: соискатель", () => {
  it("номер соискателя без Нозы в чате — не «подскажет наш агент, он позвонит» (IG 17.11)", () => {
    const text = render("927123456", { topic: "job", decision: { social: "acknowledge" } }) ?? "";
    expect(text).not.toMatch(/подскажет наш агент|позвонит вам/iu);
  });
});

describe("пункты аудита шага 1b (сигналы руководству, комментарии, щит)", () => {
  it.todo("1b: вопрос клиента без ответа 30+ мин — за 2 мин тревога и короткое «агент ответит» (класс 9)");
  it.todo("1b: после передачи агенту клиент ждёт 4–19 ч — норма ответа и напоминание (главное, п.9)");
  it.todo("1b: комментарии — «Благодарим за поддержку ✨» по-русски таджикской аудитории, «ба директ нависед» вместо номера");
  it.todo("1b: комментарий продавца с данными — не публичный «кадом объект», «бо савдо мешавад» — не строка про торг публично");
  it.todo("1b: «НОМЕРОТА ПАПАРТО ЗАНГ ЗАНМ» в комментарии без ответа (unsupported_decision_evidence)");
});

const hash = "a".repeat(64);
function coreFixture(overrides: Partial<CustomerCoreFrame>) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "x", knownPhoneSource: "none", requestedFacts: [],
    revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
      providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
      limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
    startedAt: Date.now(), operation, tools: [], ...overrides };
  const final: CustomerAgentModelTurn = { text: JSON.stringify({ kind: "reply", refs: [], social: "acknowledge", question: "none" }), calls: [], modelParts: [] };
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async () => final);
  const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "denied", reason: "unavailable" }));
  const ports = { modelTurn, executeAllowedTool, assertCurrent: vi.fn<CustomerCorePorts["assertCurrent"]>(async () => true),
    requestStop: vi.fn<CustomerCorePorts["requestStop"]>(reason => controller.abort(reason)), observeLateToolResult: vi.fn<CustomerCorePorts["observeLateToolResult"]>() } satisfies CustomerCorePorts;
  return { frame, modelTurn, executeAllowedTool, ports };
}
