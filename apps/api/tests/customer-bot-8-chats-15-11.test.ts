import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerAgentCompanyKnowledge } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerAgentFixedLines, customerAgentRetiredRepeatLines,
  type CustomerAgentEvidence, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerCommissionAmountLine, customerReplyCallsStaff, customerThanksOnly, customerTradeInQuestion,
  customerPartnershipOffer, customerStaffFollowUpFixedLines } from "../src/ai/customerAgentStaffFollowUp.js";
import { detectOutsideCoverage } from "../src/ai/coverageGuard.js";
import { batchWindowFor, debounceAndMerge } from "../src/messengers/debounceBuffer.js";

const { prisma } = await import("../src/db.js");
const { signalStaffFollowUp } = await import("../src/lib/customerDmAgentTurn.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

/**
 * Eight live Instagram chats of 13–15.11.2026 (owner's screenshots) and the independent review of #201: the classes,
 * not the scenarios. б «я уже писал выше / повторяю», в the seller's commission of a named sum (never a mortgage or a
 * discount), г a call promised only with a phone and the phone asked once, е a barter question, the service area, a
 * partnership offer, an empty search, д two quick messages → one turn (behind a switch), and the staff signal.
 * Every Tajik line the bot can say here is from tajik-phrasebook (live-agent-phrases.md) without a «(?)» mark.
 */
const knowledge: CustomerAgentCompanyKnowledge = { version: 1, source: "AGENCY_FACTS", city: "Душанбе", otherCities: false,
  commission: { sellerPercent: 2, buyerPercent: 0 }, rent: false, installments: false, mortgage: false, botNamesDiscount: false, guarantees: false };
const sourceHash = customerAgentCompanyKnowledgeHash(knowledge);
const policy = (topic: "commission" | "negotiation" | "service_scope"): CustomerAgentObservation =>
  ({ kind: "company_policy", topic, knowledge, sourceHash }) as CustomerAgentObservation;
const user = (text: string) => ({ role: "user" as const, text });
const bot = (text: string) => ({ role: "assistant" as const, text });
type Turn = { role: "user" | "assistant"; text: string };
const context = (turns: Turn[] = [], language: "ru" | "tg" = "tg") =>
  customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
    publicState: { language, topic: "unknown", openQuestion: "none" } });
type Decision = { kind: "reply" | "clarify"; refs: string[]; social: "none" | "greet" | "thank" | "acknowledge"; question: string };
function render(inputText: string, opts: { decision?: Partial<Decision>; evidence?: CustomerAgentEvidence[]; turns?: Turn[];
  language?: "ru" | "tg"; phone?: "none" | "current_input" | "scoped_contact"; requestedFacts?: string[] } = {}) {
  const language = opts.language ?? "tg";
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "none", question: "none", ...opts.decision } as never,
    evidence: opts.evidence ?? [], language, requestedFacts: (opts.requestedFacts ?? []) as never, knownPhoneSource: opts.phone ?? "none",
    maxOutputChars: 4000, surface: "dm", knowledgeSourceHash: sourceHash, inputText, verifiedContext: context(opts.turns ?? [], language) });
}
const FORBIDDEN = /выше|дар\s+боло|такрор|повтор|уже\s+пис|уже\s+напис|номафҳум/iu;
const COMMISSION_TG = "Ҳаққи хизмат барои фурӯшанда 2%, барои харидор 0% аст.";
const SERVICE_TG = "Барои хариду фурӯши амвол дар Душанбе кӯмак мекунем. Дар шаҳрҳои дигар кор намекунем.";
const SELLER_Q_TG = "Барои фурӯш шумораи ҳуҷраҳо, масоҳат, ноҳия ё нишонӣ, ошёна, ҳолати таъмир, нарх бо асъор-ро нависед. Ҳамаашро дар як паём фиристода метавонед.";
const ASK_TG = "Инро аниқ агенти мо мегӯяд. Рақами телефонатонро нависед, то агенти мо занг занад.";
const ASKS_PHONE = /рақами\s+телефон|номер\s+телефона/iu;

describe("class б: never «I already wrote above» or «I repeat», and never silence instead", () => {
  const battery: Array<[string, Parameters<typeof render>, RegExp]> = [
    ["a fixed question asked again after a non-question (job)", ["хочу работать", { language: "ru", decision: { kind: "clarify", question: "job_position" },
      turns: [user("хочу работать"), bot("Какая должность вас интересует?")] }], /^Понял\.$/u],
    ["«фаҳмидам» after the commission: an acknowledgement, no hand-off (review С1)", ["фаҳмидам", { evidence: [{ ref: "e0", value: policy("commission") }],
      decision: { refs: ["e0"] }, turns: [user("комиссия чанд?"), bot(COMMISSION_TG)] }], /^Фаҳмидам\.$/u],
    ["the same commission to a real question again: «Бале.» once", ["комиссия чанд?", { evidence: [{ ref: "e0", value: policy("commission") }],
      decision: { refs: ["e0"] }, turns: [user("комиссия чанд?"), bot(COMMISSION_TG)] }], new RegExp(`^Бале\\.\\n${COMMISSION_TG}$`, "u")],
    ["asked a third time: a person takes over and the phone is asked", ["комиссия чанд?", { evidence: [{ ref: "e0", value: policy("commission") }],
      decision: { refs: ["e0"] }, turns: [user("комиссия чанд?"), bot(COMMISSION_TG), user("комиссия чанд?"), bot(`Бале.\n${COMMISSION_TG}`)] }],
      new RegExp(`^${ASK_TG}$`, "u")],
    ["the seller question asked again after a non-question: acknowledged", ["хуб", { decision: { kind: "clarify", question: "seller_details" },
      turns: [user("Мехоҳам хонаамро фурӯшам"), bot(`Салом!\n${SELLER_Q_TG}`)] }], /^Фаҳмидам\.$/u],
    ["a Dushanbe seller after the service area: the seller question (live case 4)", ["Хона дар Душанбе аст", {
      evidence: [{ ref: "e0", value: policy("service_scope") }], decision: { refs: ["e0"] }, turns: [user("Мехоҳам хонаамро фурӯшам"), bot(SERVICE_TG)] }],
      new RegExp(`^${SELLER_Q_TG}$`, "u")],
  ];
  it.each(battery)("%s", (_name, args, expected) => {
    const text = render(...args);
    expect(text).toBeTruthy();
    expect(text).toMatch(expected);
    expect(text).not.toMatch(FORBIDDEN);
    for (const retired of customerAgentRetiredRepeatLines()) expect(text).not.toContain(retired);
  });
  it("guard: no fixed line the renderer can still produce says «above» or «again»", () => {
    const retired = new Set(customerAgentRetiredRepeatLines());
    expect([...customerAgentFixedLines()].filter(line => !retired.has(line) && FORBIDDEN.test(line))).toEqual([]);
    for (const line of retired) expect(customerAgentFixedLines().has(line)).toBe(true); // old chats keep their memory
  });
  it("an acknowledgement or a questionnaire step never signals staff; only a hand-off does", () => {
    for (const [, args] of battery.slice(0, 3)) expect(customerReplyCallsStaff(render(...args)!)).toBe(false);
    expect(customerReplyCallsStaff(render(...battery[3][1])!)).toBe(true);
  });
});

describe("thanks get a short polite answer", () => {
  it.each(["Рахмат", "раҳмат калон", "Ташаккур ака", "хуб, рахмат", "Спасибо!", "спс", "ок спасибо 🙏"])("%s is a bare thanks", text => {
    expect(customerThanksOnly(text)).toBe(true);
  });
  it.each(["Рахмат, нархаш чанд?", "спасибо, а сколько комнат", "Мехоҳам хонаамро фурӯшам", "рахмат 935000000"])("%s is not", text => {
    expect(customerThanksOnly(text)).toBe(false);
  });
  it("answers «Марҳамат! Саломат бошед!», another wording next time, and calls nobody (live case 4)", () => {
    const first = render("Рахмат", { decision: { kind: "clarify", question: "topic" }, turns: [user("Мо дар шахри Кайрокум"), bot("Мутаассифона, мо танҳо дар Душанбе кор мекунем.")] });
    expect(first).toBe("Марҳамат! Саломат бошед!");
    expect(render("Рахмат", { turns: [user("Рахмат"), bot(first!), user("хуб")] })).toBe("Марҳамат!");
    expect(render("Спасибо", { language: "ru", decision: { social: "thank", question: "location" }, turns: [bot("Какой район вам подходит?")] }))
      .toBe("Пожалуйста! Всего доброго.");
    expect(customerReplyCallsStaff(first!)).toBe(false);
  });
});

describe("class в: only the seller's commission of a named sum (review В1)", () => {
  const commission: CustomerAgentEvidence[] = [{ ref: "e0", value: policy("commission") }];
  const seller = [user("Мехоҳам хонаамро фурӯшам"), bot(`Салом!\n${COMMISSION_TG}\n${SELLER_Q_TG}`)];
  it("live case 8: «2 % анар ма 700 000 фрушум» → 2% × 700 000 = 14 000, digits only in Tajik", () => {
    const text = render("Кимат охи 2 % анар ма 700 000 фрушум и як копча пул меша", { evidence: commission,
      decision: { kind: "clarify", question: "seller_details" }, turns: seller })!;
    expect(text).toBe("2% × 700 000 = 14 000");
  });
  it("Russian seller: the company percent, even when the customer names another", () => {
    expect(render("если продам за 1 200 000 сомони, 3% это сколько?", { language: "ru", evidence: commission, decision: { refs: ["e0"] },
      turns: [user("хочу продать квартиру"), bot("Для продавца комиссия 2%.")] })).toContain("Комиссия продавца 2%: от 1 200 000 сомони это 24 000 сомони.");
  });
  it.each([
    ["a buyer's mortgage", "ипотека 20% от 500 000 это сколько?", [user("хочу купить квартиру"), bot("Какой район вам подходит?")]],
    ["a discount", "скидка 5% от 80 000 будет?", seller],
    ["an annual rate", "12% годовых от 300 000", seller],
    ["an unknown role", "Квартира стоит 500 000, какая у вас комиссия?", []],
  ] as Array<[string, string, Turn[]]>)("no sum for %s", (_name, text, turns) => {
    const out = render(text, { language: "ru", evidence: commission, decision: { refs: ["e0"] }, turns }) ?? "";
    expect(out).not.toMatch(/×|это\s+\d|составит/u);
  });
  it("no sum when the commission was not read this turn, and a phone is not a price", () => {
    expect(render("2% от 700 000 сколько?", { turns: seller, decision: { kind: "clarify", question: "seller_details" } }) ?? "").not.toContain("14 000");
    expect(customerCommissionAmountLine("комиссия 2% а мой номер 935 55 33 35", "tg", 2)).toBeNull();
  });
});

describe("class г: a call only with a phone, the phone asked once (review С6)", () => {
  const trade = "Мошин хам кабул мекунед?";
  it("no phone, never asked: the hand-off asks for it", () => {
    expect(render(trade)).toBe(ASK_TG);
  });
  it("no phone, already asked in this chat: no second request", () => {
    const text = render(trade, { turns: [user("салом"), bot("Рақами телефонатонро нависед, то агенти мо занг занад."), user("баъд")] })!;
    expect(text).toBe("Инро аниқ агенти мо мегӯяд.");
    expect(text).not.toMatch(ASKS_PHONE);
  });
  it("phone known: the agent calls, nothing is asked", () => {
    const text = render(trade, { phone: "scoped_contact" })!;
    expect(text).toBe("Инро аниқ агенти мо мегӯяд. Агенти мо дар вақти корӣ ба шумо занг мезанад.");
    expect(customerReplyCallsStaff(text)).toBe(true);
  });
  it("every fixed line that promises a call or a staff member is a hand-off line (the turn signals a person)", () => {
    const promise = /позвонит|занг\s+мезанад|агент\s+подбер|руководству/iu;
    for (const line of customerStaffFollowUpFixedLines().filter(line => promise.test(line))) expect(customerReplyCallsStaff(line)).toBe(true);
  });
});

describe("class е: barter, narrowly (live case 5, review С2)", () => {
  it.each(["Мошин хам кабул мекунед?", "машину в зачёт возьмёте?", "обмен квартиры на дом рассматриваете?", "Бартер бо мошин мешавад?",
    "Хонаро бо мошин иваз мекунед?", "иваз ба ҳавлӣ мешавад?"])("%s is barter", text => {
    expect(customerTradeInQuestion(text)).toBe(true);
  });
  it.each(["Ищу дом плюс гараж для машины", "Есть парковка для машины? Принимаете наличные?", "Квартира с местом для авто, доплата за ремонт нужна?",
    "Ҷои мошин ҳаст? Ба ҷои нақд корт қабул мекунед?", "обменять доллары где", "мошинаи худро мондан мумкин?", "скидка будет?",
    "Хонаамро иваз кардан мехоҳам", "рақамамро иваз кардам"])("%s is not", text => {
    expect(customerTradeInQuestion(text)).toBe(false);
  });
  it("drops the discount line, keeps one question (the phone), signals a person", () => {
    const text = render("Мошин хам кабул мекунед?", { evidence: [{ ref: "e0", value: policy("negotiation") }], decision: { refs: ["e0"], question: "budget" } })!;
    expect(text).toBe(ASK_TG);
    expect(customerReplyCallsStaff(text)).toBe(true);
  });
});

describe("a partnership offer goes to management (live case 2, review С3)", () => {
  const offer = "Здравствуйте! Меня зовут Шахноза, я менеджер дизайн-студии. Хотела бы предложить вам сотрудничество. Мы занимаемся дизайн-проектами квартир.";
  it("is recognised; a seller, a job seeker and a client are not partners", () => {
    expect(customerPartnershipOffer(offer)).toBe(true);
    expect(customerPartnershipOffer("Здравствуйте! У меня к вам предложение о сотрудничестве, наша студия делает ремонт")).toBe(true);
    expect(customerPartnershipOffer("Наша компания поможет продать квартиры быстрее, предлагаем партнёрство")).toBe(true);
    for (const text of ["Предлагаю сотрудничество: у меня квартира на продажу, продайте её", "Ман ба шумо ҳамкорӣ пешниҳод мекунам, хонаамро фурӯшед",
      "Хочу предложить сотрудничество, ищу работу агентом", "хочу продать квартиру через ваше агентство"]) expect(customerPartnershipOffer(text)).toBe(false);
  });
  it("is passed on with the phone question once, and a person is signalled", () => {
    const text = render(offer, { language: "ru", decision: { social: "thank" } })!;
    expect(text).toBe("Спасибо, передам руководству.\nОставьте, пожалуйста, номер телефона для связи.");
    expect(customerReplyCallsStaff(text)).toBe(true);
    expect(render("Наша компания предлагает сотрудничество", { decision: { social: "thank" } })).toBe("Ташаккур, дархости шумо қабул шуд.\nБемалол, рақами телефонатонро нависед.");
  });
});

describe("the service area: «only Dushanbe» only for an object outside (live case 4, review В2)", () => {
  const scope: CustomerAgentEvidence[] = [{ ref: "e0", value: policy("service_scope") }];
  it("a Dushanbe seller hears the area once, never «other cities»", () => {
    const first = render("Мехоҳам хонаамро фурӯшам", { evidence: scope, decision: { refs: ["e0"], question: "seller_details" } })!;
    expect(first).toContain("Барои хариду фурӯши амвол дар Душанбе ва ноҳияи Рӯдакӣ кӯмак мекунем.");
    expect(first).not.toContain("шаҳрҳои дигар");
  });
  it("a seller whose flat is in Qayroqqum gets a short apology and no questionnaire", () => {
    expect(render("Мо дар шахри Кайрокум гулистон", { evidence: scope, decision: { refs: ["e0"], question: "seller_details" },
      turns: [user("Мехоҳам хонаамро фурӯшам"), bot(`Салом!\n${SELLER_Q_TG}`)] })).toBe("Мутаассифона, мо танҳо дар Душанбе ва ноҳияи Рӯдакӣ кор мекунем.");
  });
  it.each([["Ман аз Хуҷанд ҳастам, барои писарам хона мехарам", "tg"], ["Я живу в Худжанде, хочу купить квартиру сыну", "ru"]] as const)(
    "a buyer from elsewhere is our client, not refused: %s", (text, language) => {
      const out = render(text, { language, evidence: scope, decision: { refs: ["e0"], question: "budget" } })!;
      expect(out).not.toMatch(/Мутаассифона|К сожалению/u);
      expect(out).toBeTruthy();
    });
  // Owner 15.11.2026 verbatim: «Да, Рудаки берём» — the Rudaki district is in the service area, like Dushanbe.
  it.each(["Дар н Рудаки карор дорад", "н. Рудаки", "Рӯдакӣ", "маркази н Рудаки", "район Рудаки", "Rudaki", "Сомониён"])(
    "Rudaki is in the area: %s", text => {
      expect(detectOutsideCoverage(text)).toBeNull();
      expect(detectOutsideCoverage(`Ман аз Кӯлоб ҳастам, хонаам ${text}`)).toBeNull(); // like Dushanbe, it lifts the cut
    });
  it("a seller from Rudaki is not refused: the questionnaire goes on (live case 1)", () => {
    const text = render("Хонаам дар маркази н Рудаки, 2 ҳуҷра", { evidence: scope, decision: { refs: ["e0"], question: "seller_details" },
      turns: [user("Хона дорем фурухтан даркор")] })!;
    expect(text).not.toMatch(/Мутаассифона|шаҳрҳои дигар/u);
    expect(text).toContain("Барои фурӯш");
  });
});

describe("an empty search goes to an agent with the phone question, the old «позвонит» line too", () => {
  const search = (nextPage: boolean): CustomerAgentEvidence[] => [{ ref: "e0", value: { kind: "property_search",
    query: { type: "APARTMENT", rooms: 2, ...(nextPage ? { nextPage: true } : {}) }, coverage: "bounded_ranked_pool", poolLimit: 500,
    policyHash: "c".repeat(64), cards: [] } as unknown as CustomerAgentObservation }];
  it("nothing fits (live case 7): honest line, the phone asked, no budget question", () => {
    const text = render("Салом ман барои салон помишеня харидани хастам то 30 40 квадрат", { evidence: search(false), decision: { refs: ["e0"], question: "budget" } })!;
    expect(text).toBe("Дар интихоби ҷорӣ варианти мувофиқ ёфт нашуд.\nРақами телефонатонро нависед, то агенти мо занг занад.");
    expect(customerReplyCallsStaff(text)).toBe(true);
  });
  it("no new options: no promise of a call without a phone", () => {
    expect(render("боз?", { language: "ru", evidence: search(true), decision: { refs: ["e0"] } }))
      .toBe("Новых вариантов по этому запросу сейчас нет.\nАгент подберёт варианты вручную. Напишите, пожалуйста, ваш номер телефона, чтобы агент вам позвонил.");
    expect(render("боз?", { language: "ru", evidence: search(true), decision: { refs: ["e0"] }, phone: "scoped_contact" }))
      .toBe("Новых вариантов по этому запросу сейчас нет.\nАгент подберёт варианты вручную и позвонит вам в рабочее время.");
  });
});

const created = { conversations: [] as string[], clients: [] as string[], agents: [] as string[] };
afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: created.conversations.map(id => `client-waiting-${id}`) } } });
  await prisma.notification.deleteMany({ where: { tag: { in: created.conversations.map(id => `client-waiting-${id}`) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: created.conversations } } });
  await prisma.client.deleteMany({ where: { id: { in: created.clients } } });
  if (created.agents.length) await deleteAgentsWithTraces(created.agents);
});
const chat = async (clientId?: string) => {
  const row = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `b8-${randomUUID()}`, messages: [], ...(clientId ? { clientId } : {}) },
    select: { id: true } });
  created.conversations.push(row.id);
  return row.id;
};

describe("the staff signal of a promise (review С4, С7)", () => {
  it("the DM turn signals through the one door after a hand-off reply", () => {
    const source = readFileSync(new URL("../src/lib/customerDmAgentTurn.ts", import.meta.url), "utf8");
    expect(source).toContain("if (customerReplyCallsStaff(sealed.text)) void signalStaffFollowUp(");
    expect(source).not.toContain("notifyStaffFollowUpCustomerTurn");
  });
  it("no agent: management gets it once per chat until a person answers, then again (re-review Н-нов-3)", async () => {
    const id = await chat();
    const at = Date.now() - 120_000;
    expect(await signalStaffFollowUp(id, at)).toBe("director");
    expect(await signalStaffFollowUp(id, at)).toBe("skipped");
    expect(await signalStaffFollowUp(id, at + 20_000)).toBe("skipped"); // nobody answered yet: no second CRITICAL
    await prisma.botConversation.update({ where: { id }, data: { messages: [
      { role: "assistant", content: "Салом!", at: new Date(at + 40_000).toISOString(), by: { kind: "agent", agentId: "x", agentName: "Агент" } }] } });
    expect(await signalStaffFollowUp(id, at + 60_000)).toBe("director"); // a person answered: a new promise is signalled
    const queued = await prisma.pendingDirectorAlert.findMany({ where: { tag: `client-waiting-${id}` } });
    expect(queued).toHaveLength(2);
    expect(queued[0].body).toContain("бот ответил клиенту, что это уточнит агент");
  }, 30_000);
  it("an assigned agent gets the push, not everyone who reads chats", async () => {
    const agentId = await createTestAgent(`Б8 ${randomUUID().slice(0, 6)}`);
    created.agents.push(agentId);
    const client = await prisma.client.create({ data: { fullName: "Клиент Б8", phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      source: "INSTAGRAM", assignedAgentId: agentId } });
    created.clients.push(client.id);
    expect(await signalStaffFollowUp(await chat(client.id), Date.now())).toBe("agent");
  }, 30_000);
});

describe("class д: two quick messages make one turn; switch on by default (live case 3, owner 15.11 «Да, 6 секунд можно»)", () => {
  const send = (id: string, text: string, merge: boolean) =>
    debounceAndMerge("BotConversation", id, text, undefined, batchWindowFor({ accepted: true, hasMedia: false, mergeQuickRepeats: merge }));
  const later = <T>(ms: number, run: () => Promise<T>) => new Promise<T>((resolve, reject) => setTimeout(() => run().then(resolve, reject), ms));
  it("switch on: 3.5 s apart → one winner with both texts", async () => {
    const id = await chat();
    const results = await Promise.all([send(id, "Мехоҳам хонаамро фурӯшам", true), later(3_500, () => send(id, "Мехоҳам хонаамро фурӯшам 2", true))]);
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.texts).toEqual(["Мехоҳам хонаамро фурӯшам", "Мехоҳам хонаамро фурӯшам 2"]);
  }, 30_000);
  it("switch off: each message wins its own turn, as before 15.11", async () => {
    const id = await chat();
    const results = await Promise.all([send(id, "a", false), later(3_500, () => send(id, "b", false))]);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(batchWindowFor({ accepted: true, hasMedia: false })!.delayMs).toBe(0);
  }, 30_000);
});
