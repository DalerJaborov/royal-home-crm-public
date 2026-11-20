import { describe, expect, it, vi } from "vitest";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { OPERATOR_PHRASES, renderOperatorReply } from "../src/ai/operator/phrases.js";
import { understandFallback, operatorContextLanguage } from "../src/ai/operator/understand.js";
import { runOperatorTurn } from "../src/ai/operator/index.js";
import { checkComposedReply, composeOperatorReply } from "../src/ai/operator/compose.js";
import { readOperatorState, serializeOperatorState } from "../src/ai/operator/state.js";
import { leadOnlyCallbackWhen } from "../src/ai/leadOnlyMode.js";
import { operatorWhenText } from "../src/ai/operator/phrases.js";
import { readRecoveryOwnIdentities } from "../src/lib/customerIngressClassification.js";
import type { OperatorContext, OperatorDecision, OperatorState, Understanding } from "../src/ai/operator/types.js";

/**
 * БОТ КЛИЕНТОВ ПО-ЧЕЛОВЕЧЕСКИ (владелец 20.11.2026; docs/bot-operator/SPEC.md, раздел «После заявки» и «Решения 20.11»).
 * На каждый пункт задания — тест, красный на main e5b356f84 и зелёный после правки. Модели нет: понимание подаётся готовым,
 * слова модели («своими словами») — подменой. Номера выдуманные.
 */
const u = (over: Partial<Understanding> = {}): Understanding => ({
  source: "model", role: null, question: "none", aboutThisProperty: false, details: {}, hasDetails: false, phone: null,
  callback: { when: null, textOnly: false, noCall: false }, language: null, languageHint: null, greeting: null, greetingOnly: false,
  ackOnly: false, thanksOnly: false, adOpener: false, bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false,
  job: { asked: null, openKey: null }, attachments: { voice: "none", ownPost: false, foreignPost: false, media: false }, hasText: true,
  outsidePlace: null, quote: "", ...over,
});
const ru = (over: Partial<Understanding> = {}) => u({ language: "ru", ...over });
const tg = (over: Partial<Understanding> = {}) => u({ language: "tg", ...over });
const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "WHATSAPP", phoneKnown: true, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 10:00", tg: "пагоҳ аз соати 10:00" }, recruiterPath: false, ad: { topic: null, propertyId: null }, focus: null,
  callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false,
  workHours: { from: "10:00", to: "22:30" }, ...over,
});
const FB = (over: Partial<OperatorContext> = {}) => ctx({ channel: "FACEBOOK", phoneKnown: false, ...over });
type Turn = OperatorDecision & { text: string; keys: string[] };
function run(c: OperatorContext, turns: readonly Understanding[], start: OperatorState = initialOperatorState()): Turn[] {
  let state = start, accepted = false;
  return turns.map(turn => {
    const d = decide(state, turn, accepted && !c.leadExists ? { ...c, leadPending: true } : c);
    accepted ||= d.actions.some(a => a.type === "accept_lead");
    state = d.state;
    return { ...d, text: renderOperatorReply(d.steps, d.language), keys: d.steps.map(step => step.key) };
  });
}
const afterLead = (): OperatorState => run(ctx(), [ru({ role: "buyer", details: { rooms: "2", district: "Сино", budget: "60000$" }, hasDetails: true })])[0]!.state;
const ASK_KEYS = ["ask_role", "ask_phone", "lead_and_details_seller", "lead_and_details_buyer", "lead_and_details_missing"];

describe("1. после заявки бот не молчит, но и не продаёт «вторым голосом»", () => {
  it("вопрос по делу после заявки — заметка агенту и «передал ваш вопрос», а не тишина", () => {
    const t = run(ctx({ leadExists: true }), [ru({ question: "other", quote: "А адрес офиса какой?" })], afterLead())[0]!;
    expect(t.silent).toBe(false);
    expect(t.keys).toEqual(["question_noted"]);
    expect(t.text).toBe("Передал ваш вопрос агенту, он вам ответит.");
    expect(t.actions).toEqual([{ type: "append_note", note: "Вопрос клиента: «А адрес офиса какой?»", phone: null }]);
  });
  it("«Звоните завтра днём» после «номер получил» (живой диалог 19.11) — время в заметку и ответ", () => {
    const t = run(ctx({ leadExists: true }), [ru({ callback: { when: "завтра днём", textOnly: false, noCall: false }, quote: "Звоните завтра днём" })], afterLead())[0]!;
    expect(t.keys).toEqual(["callback_noted"]);
    expect(t.text).toMatch(/завтра днём/u);
    expect(t.actions[0]).toMatchObject({ type: "append_note", note: "Когда звонить: «завтра днём»" });
  });
  it("«когда позвонят?» — напоминание агенту заметкой и «напомнил агенту», без срока", () => {
    const t = run(ctx({ leadExists: true }), [tg({ question: "status", quote: "Кай занг мезанед?" })], afterLead())[0]!;
    expect(t.text).toBe("Ба агент дар бораи шумо хотиррасон кардам, ӯ бо шумо тамос мегирад.");
    expect(t.actions[0]).toMatchObject({ type: "append_note" });
  });
  it("приветствие после заявки — ответное приветствие и «заявка у агента», один раз", () => {
    const [first, second] = run(ctx({ leadExists: true }), [ru({ greetingOnly: true, greeting: "ru" }), ru({ greetingOnly: true, greeting: "ru" })], afterLead());
    expect(first!.text).toBe("Здравствуйте! Ваша заявка у агента, он с вами свяжется.");
    expect(second!.silent).toBe(true);
  });
  it("«ок» и смайлик после заявки — тишина (живой администратор на «ок» не отвечает)", () => {
    expect(run(ctx({ leadExists: true }), [ru({ ackOnly: true })], afterLead())[0]!.silent).toBe(true);
  });
  it("клиент дописывает подряд: «передал агенту» один раз на серию, все детали — в заметки, фразы не повторяются", () => {
    const c = ctx({ leadExists: true, recentTurn: true });
    const turns = run(c, [ru({ details: { floor: "5" }, hasDetails: true }), ru({ details: { renovation: "евро" }, hasDetails: true }),
      ru({ details: { area: "80" }, hasDetails: true })], afterLead());
    expect(turns.map(t => t.keys)).toEqual([["note_added"], [], []]);
    expect(turns.flatMap(t => t.actions).filter(a => a.type === "append_note")).toHaveLength(3);
    // Серия кончилась (прошло больше трёх минут) — отмечаем снова, другими словами.
    const later = run(ctx({ leadExists: true, recentTurn: false }), [ru({ details: { price: "1" }, hasDetails: true })], turns[2]!.state)[0]!;
    expect(later.keys).toEqual(["note_added"]);
    expect(later.text).not.toBe(turns[0]!.text);
  });
  it("сотрудник сам ведёт переписку (писал за последние N минут) — бот молчит, заметка агенту остаётся", () => {
    const t = run(ctx({ leadExists: true, staffActive: true }), [ru({ question: "other", quote: "Можно сегодня посмотреть?" })], afterLead())[0]!;
    expect(t.silent).toBe(true);
    expect(t.actions[0]).toMatchObject({ type: "append_note" });
  });
  it("после заявки бот не предлагает объекты и не переспрашивает бюджет и район (август 2026: «вторым голосом» нельзя)", () => {
    const c = ctx({ leadExists: true });
    const turns = run(c, [ru({ question: "other", quote: "А есть что-то дешевле?" }), ru({ role: "buyer", details: { budget: "50000$" }, hasDetails: true }),
      ru({ question: "property_other", quote: "Какие варианты есть в Сино?" }), ru({ bargain: true }), ru({ question: "staff" })], afterLead());
    for (const t of turns) {
      expect(t.keys.filter(key => ASK_KEYS.includes(key))).toEqual([]);
      expect(t.keys.filter(key => key.startsWith("property_"))).toEqual([]);
      expect(t.text).not.toMatch(/\?|вариант|№|https?:/u);
    }
  });
  it("выключатель «Бот отвечает и после заявки» ВЫКЛ — прежнее поведение: вопрос без новой детали остаётся без ответа", () => {
    const t = run(ctx({ leadExists: true, afterLeadReplies: false }), [ru({ question: "other", quote: "А адрес офиса какой?" })], afterLead())[0]!;
    expect(t.silent).toBe(true);
  });
  it("вакансия после заявки — путь рекрутёра, а не тишина (перенесено из правки 19.11)", () => {
    const t = run(ctx({ leadExists: true, recruiterPath: true }), [ru({ role: "job", quote: "А вакансия есть?" })], afterLead())[0]!;
    expect(t.handoff).toBe("recruiter");
  });
});

describe("2. без «одним сообщением» и без допроса: заявка сразу, детали — мягко после", () => {
  it("Messenger, продавец (скриншот владельца): условия и номер, без списка из шести пунктов", () => {
    const t = run(FB(), [ru({ role: "seller", question: "fee" })])[0]!;
    expect(t.text).toBe("Комиссия агентства 2%. Напишите, пожалуйста, ваш номер телефона, агент перезвонит.");
    expect(t.text).not.toMatch(/одним сообщением|площадь|этаж|ремонт/u);
  });
  it("номер пришёл — заявка в этот же ход и один мягкий вопрос о недостающем; ответ на него — заметка", () => {
    const turns = run(FB(), [tg({ role: "seller" }), tg({ phone: "+992900000001" }), tg({ details: { district: "Сино", rooms: "3" }, hasDetails: true })]);
    expect(turns[1]!.actions.filter(a => a.type === "accept_lead")).toHaveLength(1);
    expect(turns[1]!.text).toBe("Ташаккур, ба агент расондам, ӯ ба зудӣ занг мезанад, то он вақт метавонед дар бораи хона гӯед: ноҳия, чанд ҳуҷра ва нарх.");
    expect(turns[2]!.keys).toEqual(["note_added"]);
  });
});

describe("3. своими словами: модель пишет, код проверяет, готовая фраза — страховка", () => {
  const template = "Спасибо, передал агенту, он позвонит вам в ближайшее время, а пока можете рассказать о квартире: район, сколько комнат и цену.";
  it("живой ответ модели под тот же шаг проходит проверку", async () => {
    const live = "Спасибо! Ваша заявка уже у агента, он позвонит вам в ближайшее время. Если хотите, расскажите пока о квартире: район, сколько комнат и цену.";
    const result = await composeOperatorReply({ steps: [{ key: "lead_and_details_seller", vars: { when: "в ближайшее время" }, variant: 0 }],
      template, language: "ru", current: "Хочу продать квартиру", model: vi.fn(async () => ({ reply: live })) });
    expect(result).toEqual({ text: live, source: "model" });
  });
  it("модель добавила цифру, вопрос, обещание или сменила язык — уходит готовая фраза", () => {
    expect(checkComposedReply("Агент позвонит через 10 минут.", "Передал агенту.", "ru")).toBe("digits");
    expect(checkComposedReply("Передал агенту. Какой у вас бюджет?", "Передал агенту.", "ru")).toBe("question");
    expect(checkComposedReply("Передал агенту, он вам позвонит.", "Передал агенту.", "ru")).toBe("promise");
    expect(checkComposedReply("Ба агент расондам, ташаккур.", "Передал агенту.", "ru")).toBe("language");
    expect(checkComposedReply("Пришлите фото квартиры.", "Передал агенту.", "ru")).toBe("banned");
    expect(checkComposedReply("Для покупателя комиссия 2%.", "Для покупателя наши услуги бесплатны.", "ru")).not.toBeNull();
  });
  it("рубильник выключен — модель не зовётся вовсе; молчание модели — готовая фраза", async () => {
    const model = vi.fn(async () => ({ reply: "Ок" }));
    const turn = await runOperatorTurn({ storedState: null, input: { current: "Хочу продать квартиру" }, ctx: ctx(), model: async () => null,
      ownWords: { enabled: false, model } });
    expect(model).not.toHaveBeenCalled();
    expect(turn.text).toContain("Поможем продать");
    const silent = await composeOperatorReply({ steps: [{ key: "note_added", vars: {}, variant: 0 }], template: "Передал агенту.", language: "ru",
      current: "5 этаж", model: async () => null });
    expect(silent).toMatchObject({ text: "Передал агенту.", source: "template", rejected: "no_answer" });
  });
});

describe("4. язык не скачет: номер без слов — язык разговора, а не «русский по умолчанию»", () => {
  it("таджикский разговор, память языка пуста, клиент прислал только номер — ответ по-таджикски (скриншот владельца)", async () => {
    const recent = [{ role: "assistant" as const, text: "Шумо хона мехаред ё мефурӯшед?" }, { role: "user" as const, text: "Хонаамро мефурӯшам" }];
    const turn = await runOperatorTurn({ storedState: null, ctx: FB(), model: async () => null,
      input: { current: "+992 90 000 00 01", recent } });
    expect(turn.language).toBe("tg");
    expect(turn.text).toMatch(/^Ташаккур/u);
    expect(turn.actions.filter(a => a.type === "accept_lead")).toHaveLength(1);
  });
  it("язык разговора: последний уверенный язык клиента, иначе последняя реплика бота или сотрудника", () => {
    expect(operatorContextLanguage([{ role: "user", text: "Салом, хона мехарам" }, { role: "user", text: "ок" }])).toBe("tg");
    expect(operatorContextLanguage([{ role: "assistant", text: "Салом апачон, пагоҳ меравем мебинем" }, { role: "user", text: "900000001" }])).toBe("tg");
    expect(operatorContextLanguage([])).toBeNull();
    // Клиент писал по-русски, сотрудник ответил по-таджикски из Business Suite, клиент прислал только номер — таджикский.
    expect(operatorContextLanguage([{ role: "user", text: "Хочу продать квартиру" }, { role: "assistant", text: "Салом, рақаматонро нависед, занг мезанем" },
      { role: "user", text: "+992 90 000 00 01" }])).toBe("tg");
    const fallback = understandFallback({ current: "900000001", recent: [{ role: "user", text: "Хонаамро мефурӯшам" }] }, initialOperatorState(), FB());
    expect(fallback.contextLanguage).toBe("tg");
  });
});

describe("5. номер → заявка всегда; обещание звонка честное", () => {
  it("номер вместе с «не по теме» — всё равно заявка", () => {
    const t = run(FB(), [ru({ offTopic: true, phone: "+992900000001" })])[0]!;
    expect(t.actions.filter(a => a.type === "accept_lead")).toHaveLength(1);
  });
  it("после грубости или жалобы бот молчит, но номер клиента становится заявкой", () => {
    const turns = run(FB(), [ru({ complaint: true }), ru({ phone: "+992900000001" })]);
    expect(turns[1]!.silent).toBe(true);
    expect(turns[1]!.actions.filter(a => a.type === "accept_lead")).toHaveLength(1);
  });
  it("запасной ход после сбоя: номер без ясной роли — заявка, а не вопрос «купить или продать?»", async () => {
    const turn = await runOperatorTurn({ storedState: null, ctx: { ...FB(), ad: undefined as never }, model: async () => null,
      input: { current: "+992 90 000 00 01" } });
    expect(turn.degraded).toBe(true);
    expect(turn.actions.filter(a => a.type === "accept_lead")).toHaveLength(1);
  });
  it("вечер и ночь: не «в ближайшее время», а честно «завтра с <начало>»; последний час дня — тоже завтра", () => {
    const when = (now: string) => operatorWhenText(leadOnlyCallbackWhen({ now, workHoursStart: "10:00", workHoursEnd: "22:30" }));
    expect(when("23:40")).toEqual({ ru: "завтра с 10:00", tg: "пагоҳ аз соати 10:00" });
    expect(when("21:45")).toEqual({ ru: "завтра с 10:00", tg: "пагоҳ аз соати 10:00" });
    expect(when("08:00")).toEqual({ ru: "сегодня с 10:00", tg: "имрӯз аз соати 10:00" });
    expect(when("15:00")).toEqual({ ru: "в ближайшее время", tg: "ба зудӣ" });
  });
  it("проверяющий из Настроек и уволенный сотрудник — не «номер сотрудника» на входе ядра; действующий сотрудник — по-прежнему", async () => {
    const queries: string[] = [];
    const db = { $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?"); queries.push(sql);
      if (sql.includes("MessengerAccount")) return [];
      if (sql.includes("Settings")) return [{ pageId: null, waId: null, reviewers: ["+992 90 000 00 07"] }];
      return [{ phone: "+992900000007" }, { phone: "+992900000008" }];
    } };
    const own = await readRecoveryOwnIdentities(db as never);
    expect(queries.find(sql => sql.includes("\"Agent\""))).toMatch(/"isActive"/u);
    expect(own.staffPhones.has("992900000007")).toBe(false);
    expect(own.staffPhones.has("992900000008")).toBe(true);
  });
  it("«сброс» от проверяющего — разговор с нуля; от клиента — обычное слово", async () => {
    const stored = serializeOperatorState(afterLead());
    const reset = await runOperatorTurn({ storedState: stored, ctx: ctx({ reviewer: true }), model: async () => null, input: { current: "сброс" } });
    expect(reset.state).toMatchObject({ role: "unknown", leadAccepted: false, step: "start" });
    expect(reset.text).toBe(OPERATOR_PHRASES.reviewer_reset.ru[0]);
    const client = await runOperatorTurn({ storedState: stored, ctx: ctx({ leadExists: true }), model: async () => null, input: { current: "сброс" } });
    expect(client.state.leadAccepted).toBe(true);
  });
});

describe("память старых разговоров переживает выкат", () => {
  it("отметки убранных фраз («одним сообщением») в памяти не обнуляют роль, язык и «заявка принята»", () => {
    const now = new Date("2026-11-20T10:00:00.000Z");
    const legacy = { ...serializeOperatorState({ ...afterLead(), role: "seller", language: "tg" }, now),
      spoken: { seller_intro: 1, ask_details_seller_phone: 1, phone_received: 1 } };
    const state = readOperatorState(legacy, now);
    expect(state).toMatchObject({ role: "seller", language: "tg", leadAccepted: true });
    expect(state.spoken).toEqual({ seller_intro: 1, phone_received: 1 });
  });
});

describe("ревью #333", () => {
  it("эстафета: сотрудник писал недавно — бот молчит и зовёт его; номер, а в WhatsApp ясная роль — заявка; вакансия — рекрутёр", () => {
    const quiet = run(FB({ staffThread: true, staffActive: true }), [ru({ greetingOnly: true, greeting: "ru" })])[0]!;
    expect(quiet.silent).toBe(true);
    expect(quiet.yielded).toBe(true);
    expect(quiet.actions).toEqual([{ type: "call_staff", reason: "staff_thread" }]);
    const phone = run(FB({ staffThread: true, staffActive: true }), [ru({ phone: "+992900000001" })])[0]!;
    expect(phone.actions.map(a => a.type)).toEqual(["accept_lead", "call_staff"]);
    const wa = run(ctx({ staffThread: true, staffActive: true }), [ru({ role: "buyer", quote: "Хочу купить квартиру" })])[0]!;
    expect(wa.actions.map(a => a.type)).toEqual(["accept_lead", "call_staff"]);
    const job = run(ctx({ staffThread: true, staffActive: true, recruiterPath: true }), [ru({ role: "job" })])[0]!;
    expect(job.handoff).toBe("recruiter");
  });
  it("эстафета не вечна: сотрудник молчит дольше срока — обычный шаг без повторного приветствия и сигнал ему", () => {
    const t = run(FB({ staffThread: true, staffActive: false }), [ru({ greetingOnly: true, greeting: "ru" })])[0]!;
    expect(t.keys).toEqual(["ask_role"]);
    expect(t.actions).toEqual([{ type: "call_staff", reason: "staff_thread" }]);
  });
  it("вложение без слов: один короткий ответ на языке разговора и вопрос о роли; повтор — тишина и один сигнал", () => {
    const media = u({ hasText: false, attachments: { voice: "none", ownPost: false, foreignPost: false, media: true } });
    const turns = run(FB(), [media, media, media]);
    expect(turns[0]!.text).toBe("Спасибо, получил. Вы хотите купить или продать недвижимость?");
    expect(turns[1]!.silent).toBe(true);
    expect(turns[1]!.actions).toEqual([{ type: "call_staff", reason: "attachments" }]);
    expect(turns[2]!.silent && turns[2]!.actions.length === 0).toBe(true);
    const tgFirst = run(FB(), [media], { ...initialOperatorState(), language: "tg" })[0]!;
    expect(tgFirst.text).toBe("Ташаккур, гирифтам. Шумо хона мехаред ё мефурӯшед?");
  });
  it("дважды непонятно («Оае», «Ттк», «Мр») — тишина и один сигнал человеку", () => {
    const turns = run(FB(), [ru(), ru(), ru(), ru()]);
    expect(turns[2]!.silent).toBe(true);
    expect(turns[2]!.actions).toEqual([{ type: "call_staff", reason: "unclear" }]);
    expect(turns[3]!.actions).toEqual([]);
  });
  it("запасной ход после сбоя: соискателю и арендатору заявку не заводит", async () => {
    const stored = serializeOperatorState({ ...initialOperatorState(), role: "job" });
    const turn = await runOperatorTurn({ storedState: stored, ctx: { ...FB(), ad: undefined as never }, model: async () => null,
      input: { current: "+992 90 000 00 01" } });
    expect(turn.actions.filter(a => a.type === "accept_lead")).toEqual([]);
  });
  it("круглосуточное окно 00:00–24:00: в 23:30 — «в ближайшее время», а не «завтра с 00:00»", () => {
    expect(leadOnlyCallbackWhen({ now: "23:30", workHoursStart: "00:00", workHoursEnd: "24:00" })).toEqual({ kind: "soon" });
    expect(leadOnlyCallbackWhen({ now: "23:30", workHoursStart: "00:00", workHoursEnd: "23:59" })).toEqual({ kind: "soon" });
  });
  it("проверка «своими словами»: сроки, новые действия, имя, «ты», деньги — только из готовой фразы; бот не выдаёт себя за человека", () => {
    const template = "Спасибо, передал агенту, он позвонит вам завтра с 10:00.";
    expect(checkComposedReply("Спасибо, передал агенту, он позвонит вам сегодня.", "Спасибо, передал агенту, он позвонит вам завтра.", "ru")).toBe("time");
    expect(checkComposedReply("Спасибо, передал агенту, он приедет и покажет квартиру.", template, "ru")).not.toBeNull();
    expect(checkComposedReply("Спасибо, передал агенту Фарходу, он позвонит вам завтра с 10:00.", template, "ru")).toBe("name");
    expect(checkComposedReply("Передал агенту, он ответит в течение часа.", "Передал агенту.", "ru")).not.toBeNull();
    expect(checkComposedReply("Спасибо, твой вопрос передал агенту.", "Передал агенту.", "ru")).toBe("informal");
    expect(checkComposedReply("Ташаккур, дархостат ба агент расид.", "Ба агент расондам.", "tg")).toBe("informal");
    expect(checkComposedReply("Для вас бесплатно, платит продавец.", "Для покупателя наши услуги бесплатны.", "ru")).toBe("money");
    expect(checkComposedReply("Спасибо, передал агенту, он позвонит вам завтра с 10:00.", template, "ru")).toBeNull();
  });
});

describe("ИНВАРИАНТ (ревью #333, второй круг): нет пути «ни ответа бота, ни сигнала живому человеку»", () => {
  function rng(seed: number) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
  const pick = <T,>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
  it("3000 разговоров × карточка/агент/переписка сотрудника: каждая тишина — либо сигнал, либо оправданное исключение", () => {
    for (let n = 1; n <= 3000; n++) {
      const r = rng(n);
      const leadExists = r() < 0.3, cardAgentActive = r() < 0.6, staffThread = r() < 0.3;
      const c = ctx({ channel: pick(r, ["WHATSAPP", "INSTAGRAM", "FACEBOOK"] as const), phoneKnown: r() < 0.5, leadExists, cardAgentActive,
        staffThread, staffActive: staffThread && r() < 0.5, recruiterPath: r() < 0.5, leadPending: true, maxPhoneAsks: 1 + Math.floor(r() * 2),
        recentTurn: r() < 0.3, afterLeadReplies: r() < 0.8 });
      let state = initialOperatorState();
      for (let turn = 0; turn < 8; turn++) {
        const chance = (p: number) => r() < p;
        const turnU = u({ role: pick(r, [null, null, null, "buyer", "seller", "rent", "job"] as const),
          question: pick(r, ["none", "none", "fee", "other", "status", "staff", "area"] as const), hasDetails: chance(0.2),
          details: chance(0.2) ? { rooms: "2" } : {}, phone: chance(0.1) ? "+992900000001" : null, language: pick(r, [null, "ru", "tg"] as const),
          greeting: pick(r, [null, "ru", "assalom"] as const), greetingOnly: chance(0.1), ackOnly: chance(0.15), thanksOnly: chance(0.05),
          rude: chance(0.03), complaint: chance(0.03), offTopic: chance(0.05), hasText: chance(0.85), quote: chance(0.5) ? "Скажите, пожалуйста" : "",
          callback: { when: null, textOnly: false, noCall: chance(0.05) },
          attachments: { voice: "none", ownPost: false, foreignPost: chance(0.05), media: chance(0.15) } });
        const before = state;
        const d = decide(before, turnU, c);
        state = d.state;
        if (!d.silent || d.handoff) continue;
        const signalled = d.actions.some(a => a.type === "call_staff" || a.type === "follow_up");
        // Оправданные исключения: карточка с живым агентом (агенту штатный пуш о каждом сообщении); «ок», «спасибо»;
        // спам «не по теме»; человека по этому эпизоду уже звали; аренда и вакансия, на которые уже ответили.
        const excused = (d.state.leadAccepted && c.cardAgentActive) || turnU.ackOnly || turnU.thanksOnly || turnU.offTopic ||
          before.staffCalled || before.closed || before.flags.signaled.length > 0 || ["rent", "job"].includes(d.state.role);
        expect(signalled || excused, `разговор ${n}, ход ${turn}: ${JSON.stringify({ leadExists, cardAgentActive, staffThread, role: turnU.role })}`).toBe(true);
      }
    }
  });
});
