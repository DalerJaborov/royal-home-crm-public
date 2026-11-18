import { describe, expect, it } from "vitest";
import type { RecruitmentPosition } from "@royal-home/shared";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { renderOperatorReply } from "../src/ai/operator/phrases.js";
import type { OperatorContext, OperatorDecision, OperatorState, Understanding } from "../src/ai/operator/types.js";

/**
 * ОПЕРАТОР ПРИЁМА ЗАЯВОК — РЕШЕНИЕ ШАГА (docs/bot-operator/SPEC.md). Каждая строка таблицы случаев 1–26 — тест ниже
 * (многоходовые — цепочкой ходов с переносом состояния), потом пределы, запреты и сторож-перебор по случайным ходам.
 * Модели нет: на вход `decide` идёт готовое `Understanding`, как его отдаст understand.ts.
 */
const PROPERTY_ID = "6f1c2d3e-0000-4000-8000-000000000164";
const OTHER_PROPERTY_ID = "6f1c2d3e-0000-4000-8000-000000000999";
const CONTACT_PHONE = "+992 00 000 00 01";

const u = (over: Partial<Understanding> = {}): Understanding => ({
  source: "model", role: null, question: "none", aboutThisProperty: false, details: {}, hasDetails: false, phone: null,
  callback: { when: null, textOnly: false, noCall: false }, language: null, languageHint: null, greeting: null, greetingOnly: false,
  ackOnly: false, thanksOnly: false, adOpener: false, bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false,
  job: { asked: null, openKey: null }, attachments: { voice: "none", ownPost: false, foreignPost: false, media: false }, hasText: true,
  outsidePlace: null, quote: "", ...over,
});
const ru = (over: Partial<Understanding> = {}) => u({ language: "ru", ...over });
const tg = (over: Partial<Understanding> = {}) => u({ language: "tg", ...over });

const position = (key: string, titleRu: string, titleTg: string, isOpen = true): RecruitmentPosition => ({
  key, revision: 1, titleRu, titleTg, detailsRu: "", detailsTg: "", isOpen, keywords: [], postCodes: [],
});
const MANAGER = position("sales-manager", "менеджер по продажам", "менеҷери фурӯш");

const focus164 = { propertyId: PROPERTY_ID, shortId: 164, priceText: { ru: "520 000 сомони", tg: "520 000 сомонӣ" }, sold: false };
const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "WHATSAPP", phoneKnown: true, leadExists: false, ad: { topic: null, propertyId: null }, focus: null,
  callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2, vacancies: { open: [MANAGER], contactPhone: CONTACT_PHONE },
  brandName: "Royal Home", sellerCommissionPercent: 2, outOfArea: false, ...over,
});
const IG = (over: Partial<OperatorContext> = {}) => ctx({ channel: "INSTAGRAM", phoneKnown: false, ...over });
const FB = (over: Partial<OperatorContext> = {}) => ctx({ channel: "FACEBOOK", phoneKnown: false, ...over });

type Turn = OperatorDecision & { text: string; keys: string[] };
function run(c: OperatorContext, turns: readonly Understanding[], start: OperatorState = initialOperatorState()): Turn[] {
  let state = start;
  return turns.map(turn => {
    const d = decide(state, turn, c);
    state = d.state;
    return { ...d, text: renderOperatorReply(d.steps, d.language), keys: d.steps.map(step => step.key) };
  });
}
const one = (c: OperatorContext, turn: Understanding, start?: OperatorState) => run(c, [turn], start)[0]!;
const leads = (turns: readonly Turn[]) => turns.flatMap(turn => turn.actions.filter(a => a.type === "accept_lead"));
const ASKS = ["ask_role", "ask_details_buyer", "ask_details_seller", "ask_details_missing", "ask_phone"];

describe("таблица случаев SPEC.md (1–26)", () => {
  it("1. Messenger без рекламы, «Сколько стоят ваши услуги?» → бесплатно для покупателя и вопрос о роли, без комиссии", () => {
    const t = one(FB(), ru({ question: "fee" }));
    expect(t.keys).toEqual(["buyer_free", "ask_role"]);
    expect(t.text).toMatch(/бесплатн/u);
    expect(t.text).not.toMatch(/2%|Рудаки/u);
    expect(t.state.asked.role).toBe(1);
  });

  it("2. продолжение №1, «Сколько стоить эта квартира»: объект рекламы известен → объект и цена + просьба номера", () => {
    const c = FB({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus: focus164 });
    const [, second] = run(c, [ru({ question: "fee" }), ru({ aboutThisProperty: true, question: "property_price" })]);
    expect(second!.keys).toEqual(["property_price", "ask_phone"]);
    expect(second!.text).toContain("№164");
    expect(second!.text).toContain("520 000 сомони");
    expect(second!.text).not.toMatch(/варианты от/u);
  });

  it("2. объект неизвестен → просьба номера, заявка с пометкой «спрашивал цену объекта с рекламы»", () => {
    const turns = run(FB(), [ru({ question: "fee" }), ru({ aboutThisProperty: true, question: "property_price" }), ru({ phone: "+992935551234" })]);
    expect(turns[1]!.keys).toEqual(["ask_phone"]);
    const [lead] = leads(turns);
    expect(lead).toMatchObject({ role: "buyer", phone: "+992935551234" });
    expect(lead && "note" in lead ? lead.note : "").toContain("Спрашивал цену объекта с рекламы");
    expect(turns[2]!.keys).toEqual(["phone_received"]);
  });

  it("3. WhatsApp, реклама собственникам, «Хочу продать квартиру» → детали; ответ → заявка без «удобно?»; дальше вопросов нет", () => {
    const c = ctx({ ad: { topic: "seller", propertyId: null } });
    const turns = run(c, [ru({ role: "seller" }), ru({ details: { district: "Сино", rooms: "3" }, hasDetails: true }), ru({ ackOnly: true, role: null })]);
    expect(turns[0]!.keys).toEqual(["seller_intro", "ask_details_seller"]);
    expect(turns[0]!.text).toContain("2%");
    expect(turns[1]!.keys).toEqual(["lead_known_phone"]);
    expect(turns[1]!.text).toMatch(/передал агенту/u);
    expect(turns.map(t => t.text).join(" ")).not.toMatch(/удобно|купить или продать/iu);
    expect(leads(turns)).toHaveLength(1);
    expect(leads(turns)[0]).toMatchObject({ role: "seller", outOfArea: false });
    expect(turns[2]!.silent).toBe(true);
  });

  it("4. WhatsApp, «Продать недвижимость» → «С 11 до 2.30 удобно»: время повторяем и пишем в заметку", () => {
    const turns = run(ctx(), [ru({ role: "seller" }), ru({ callback: { when: "с 11:00 до 14:30", textOnly: false, noCall: false } })]);
    expect(turns[1]!.keys).toEqual(["lead_callback"]);
    expect(turns[1]!.text).toContain("с 11:00 до 14:30");
    const [lead] = leads(turns);
    expect(lead).toMatchObject({ callbackWhen: "с 11:00 до 14:30" });
    expect(lead && "note" in lead ? lead.note : "").toContain("Когда звонить: «с 11:00 до 14:30»");
    expect(turns.map(t => t.text).join(" ")).not.toMatch(/удобно\?/u);
  });

  it("5. WhatsApp, «Мехоҳам хонаамро фурӯшам» → «Хонаи мо дар Ромит»: заявка outOfArea, клиенту без отказа и без Рудаки", () => {
    const turns = run(ctx(), [tg({ role: "seller" }), tg({ outsidePlace: "Ромит", details: { district: "Ромит" }, hasDetails: true })]);
    expect(turns[0]!.language).toBe("tg");
    expect(turns[1]!.keys).toEqual(["out_of_area_accepted"]);
    expect(turns[1]!.text).toMatch(/^Ташаккур/u);
    expect(turns[1]!.text).not.toMatch(/Рӯдакӣ|Рудаки|намекунем|танҳо/u);
    const [lead] = leads(turns);
    expect(lead).toMatchObject({ role: "seller", outOfArea: true });
    expect(lead && "note" in lead ? lead.note : "").toContain("Объект не в Душанбе: Ромит");
  });

  it("6. WhatsApp, покупатель: после первого ответа на вопрос о деталях — заявка, без списка и без второго вопроса", () => {
    const turns = run(ctx(), [tg({ role: "buyer" }), tg({ details: { rooms: "2", renovation: "ремонт", budget: "700 ҳазор" }, hasDetails: true })]);
    expect(turns[0]!.keys).toEqual(["ask_details_buyer"]);
    expect(turns[1]!.keys).toEqual(["lead_known_phone"]);
    expect(turns[1]!.text).toMatch(/ба агент расондам/u);
    expect(turns[1]!.text).not.toMatch(/№|варианты|https?:/u);
    expect(leads(turns)[0]).toMatchObject({ role: "buyer", propertyId: null });
  });

  it("7. WhatsApp, «Не, ватсапда нависед» после обещания звонка → «агент напишет в WhatsApp», пометка агенту", () => {
    const turns = run(ctx(), [tg({ role: "seller", details: { district: "Сино", rooms: "2", area: "60", floor: "3", renovation: "бор", price: "50000" }, hasDetails: true }),
      tg({ callback: { when: null, textOnly: true, noCall: false } })]);
    expect(turns[0]!.state.leadAccepted).toBe(true);
    expect(turns[1]!.keys).toEqual(["text_only_noted"]);
    expect(turns[1]!.text).toContain("WhatsApp");
    expect(turns[1]!.actions).toEqual([{ type: "append_note", note: "Просит писать в WhatsApp, не звонить", phone: null }]);
  });

  it("8. голосовые: расшифровано — обычный ход; не расшифровано — одна просьба написать текстом, шаг не двигается", () => {
    const transcribed = one(ctx(), ru({ role: "seller", attachments: { voice: "transcribed", ownPost: false, foreignPost: false, media: false } }));
    expect(transcribed.keys).toEqual(["seller_intro", "ask_details_seller"]);
    const failed = u({ hasText: false, attachments: { voice: "failed", ownPost: false, foreignPost: false, media: false } });
    const turns = run(ctx(), [ru({ role: "seller" }), failed, failed, failed]);
    expect(turns[1]!.keys).toEqual(["voice_failed"]);
    expect(turns[2]!.silent).toBe(true);
    expect(turns[3]!.silent).toBe(true);
    expect(turns[3]!.state.step).toBe("details");
    expect(turns.map(t => t.text).join(" ").match(/2%/gu)?.length ?? 0).toBe(1);
  });

  it("9. Instagram, «Асалом, услугатон чихелияй?» → «Ваалайкум ассалом! Шумо хона мехаред ё мефурӯшед?»", () => {
    const t = one(IG(), tg({ greeting: "assalom", question: "services" }));
    expect(t.text).toBe("Ваалайкум ассалом! Шумо хона мехаред ё мефурӯшед?");
    expect(t.text).not.toMatch(/Рӯдакӣ/u);
  });

  it("10. Instagram, реклама объекта, «Сколько стоят ваши услуги?» → «Это объект №164, цена …» + номер", () => {
    const t = one(IG({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus: focus164 }), ru({ question: "fee" }));
    expect(t.keys).toEqual(["property_price", "ask_phone"]);
    expect(t.text).toMatch(/^Это объект №164, цена 520 000 сомони\./u);
    expect(t.text).not.toMatch(/бесплатн/u);
  });

  it("11. тот же чат: «Mo 3 xonai furuwi dorem. Narxi reklama?» → продавец: комиссия один раз и вопрос о деталях; три квартиры — одна заявка", () => {
    const c = IG({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus: focus164 });
    const turns = run(c, [ru({ question: "fee" }), tg({ role: "seller", details: { units: "3" }, hasDetails: true, question: "other" }),
      tg({ details: { district: "Сино" }, hasDetails: true }), tg({ phone: "+992935551234" })]);
    expect(turns[1]!.keys).toEqual(["seller_intro", "ask_details_seller"]);
    expect(turns[1]!.state.role).toBe("seller");
    expect(turns[1]!.state.propertyId).toBeNull();
    expect(turns.map(t => t.text).join(" ").match(/2%/gu)?.length).toBe(1);
    const all = leads(turns);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ role: "seller", propertyId: null });
    expect("note" in all[0]! ? all[0].note : "").toContain("объектов: 3");
  });

  it("12. WhatsApp, реклама вакансии, «Привет! Можно узнать об этом подробнее?» → сразу ответ по вакансиям", () => {
    const t = one(ctx({ ad: { topic: "job", propertyId: null } }), ru({ adOpener: true, greeting: "ru", aboutThisProperty: false }));
    expect(t.keys).toEqual(["jobs_list", "job_contact"]);
    expect(t.text).toContain("менеджер по продажам");
    expect(t.text).toContain(CONTACT_PHONE);
    expect(t.actions).toEqual([]);
  });

  it("13. «Вакансия SMM-специалиста ещё актуальна?»: закрыта → «набора нет, открыто …»; открыта → контакт", () => {
    const closed = one(ctx(), ru({ role: "job", job: { asked: "SMM-специалиста", openKey: null } }));
    expect(closed.keys).toEqual(["job_closed", "job_contact"]);
    expect(closed.text).toMatch(/набора на «SMM-специалиста» нет, открыто: менеджер по продажам/u);
    const smm = position("smm", "SMM-специалист", "мутахассиси SMM");
    const open = one(ctx({ vacancies: { open: [MANAGER, smm], contactPhone: CONTACT_PHONE } }),
      ru({ role: "job", job: { asked: "SMM-специалиста", openKey: "smm" } }));
    expect(open.keys).toEqual(["job_open", "job_contact"]);
    expect(open.text).toContain("«SMM-специалист» открыта");
    const none = one(ctx({ vacancies: { open: [], contactPhone: CONTACT_PHONE } }), ru({ role: "job", job: { asked: "SMM", openKey: null } }));
    expect(none.keys).toEqual(["jobs_none"]);
  });

  it("14. «Хизматрасониятонро қимматтар??» при известном продавце → по-таджикски «Комиссияи агентӣ 2%.»", () => {
    const turns = run(ctx(), [tg({ role: "seller" }), tg({ question: "fee" })]);
    expect(turns[1]!.text).toBe("Комиссияи агентӣ 2%.");
    expect(turns[1]!.state.role).toBe("seller");
    expect(turns[1]!.state.step).toBe("details");
  });

  it("15. «Я хочу продоват свою квартиру» после «Мефурушам» → роль продавца не теряется, вопроса покупателю нет", () => {
    const turns = run(IG(), [tg({ role: "seller" }), ru({ role: "seller" })]);
    expect(turns.flatMap(t => t.keys)).not.toContain("ask_details_buyer");
    expect(turns[1]!.state.role).toBe("seller");
    // Тот же продавец, вопрос о деталях ещё не задавали (первым ходом был только вопрос о комиссии) — задаётся продавцу.
    const start = run(ctx(), [tg({ role: "seller" })])[0]!.state;
    const fresh = { ...start, asked: { ...start.asked, details: 0 }, step: "start" as const };
    expect(one(ctx(), ru({ role: "seller" }), fresh).keys).toContain("ask_details_seller");
  });

  it("16. «Салом» → «Ту <имя> нестӣ?» → «Не, ин агентии {бренд}…» + вопрос о роли другими словами", () => {
    const c = ctx({ brandName: "Arvan estate" });
    const turns = run(c, [u({ languageHint: "tg", greeting: "salom", greetingOnly: true }), tg({ question: "identity" })]);
    expect(turns[0]!.text).toBe("Ассалому алайкум! Шумо хона мехаред ё мефурӯшед?");
    expect(turns[1]!.keys).toEqual(["identity", "ask_role"]);
    expect(turns[1]!.text).toContain("Arvan estate");
    expect(turns[1]!.text).not.toContain("Royal Home");
    expect(turns[1]!.steps[1]!.variant).toBe(1);
  });

  it("17. «мы хотим сдать дом» + детали → сразу «Арендой не занимаемся…», без комиссии и продажи", () => {
    const t = one(ctx(), ru({ role: "rent", details: { rooms: "3" }, hasDetails: true }));
    expect(t.keys).toEqual(["rent_refusal"]);
    expect(t.text).toBe("Арендой не занимаемся, только покупка и продажа.");
    expect(t.actions).toEqual([]);
  });

  it("18. Instagram, после принятой заявки «Бале» → тишина; «рахмат» → одно «Марҳамат»", () => {
    const turns = run(IG(), [tg({ role: "buyer", details: { rooms: "2", district: "Сино", budget: "60000$" }, hasDetails: true }),
      tg({ phone: "+992935551234" }), u({ ackOnly: true }), u({ thanksOnly: true, ackOnly: true }), u({ thanksOnly: true, ackOnly: true })]);
    expect(turns[1]!.state.leadAccepted).toBe(true);
    expect(turns[2]!.silent).toBe(true);
    expect(turns[3]!.text).toBe("Марҳамат.");
    expect(turns[4]!.silent).toBe(true);
  });

  it("19. «Салом» → «Ассалому алайкум! Шумо хона мехаред ё мефурӯшед?»", () => {
    const t = one(IG(), u({ languageHint: "tg", greeting: "salom", greetingOnly: true }));
    expect(t.text).toBe("Ассалому алайкум! Шумо хона мехаред ё мефурӯшед?");
  });

  it("20. пересланный чужой пост: на языке разговора; язык неизвестен — таджикский; один раз", () => {
    const post = u({ hasText: false, attachments: { voice: "none", ownPost: false, foreignPost: true, media: true } });
    const unknown = run(IG(), [post, post]);
    expect(unknown[0]!.language).toBe("tg");
    expect(unknown[0]!.keys).toEqual(["foreign_post"]);
    expect(unknown[1]!.silent).toBe(true);
    const russian = run(IG(), [ru({ role: "buyer" }), post]);
    expect(russian[1]!.text).toMatch(/^Это не наше объявление/u);
  });

  it("21. объект известен, «Дорого. По-братски скидку сделаете?» → торг у собственника, шаг «контакт», торг в заметке", () => {
    const c = IG({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus: focus164 });
    const turns = run(c, [ru({ bargain: true, question: "other" }), ru({ phone: "+992935551234" })]);
    expect(turns[0]!.keys).toEqual(["bargain", "ask_phone"]);
    expect(turns[0]!.text).toMatch(/собственником/u);
    expect(turns[0]!.text).not.toMatch(/скидк\p{L}* (?:будет|есть|сделаем)|%/u);
    const [lead] = leads(turns);
    expect(lead && "note" in lead ? lead.note : "").toContain("Спрашивал про торг и скидку");
    // Строку объекта вытеснил ответ о торге — её скажем следующим ходом, а не забудем.
    expect(turns[0]!.state.flags.propertyLineFor).toBeNull();
  });

  it("22. грубость → одна спокойная фраза, сотрудник, дальше бот молчит и вопросов не задаёт", () => {
    const turns = run(IG(), [ru({ rude: true }), ru({ role: "buyer" }), ru({ question: "fee" })]);
    expect(turns[0]!.keys).toEqual(["rude_calm"]);
    expect(turns[0]!.actions).toEqual([{ type: "call_staff", reason: "rude", manager: false }]);
    expect(turns[1]!.silent && turns[2]!.silent).toBe(true);
    expect(leads(turns)).toHaveLength(0);
  });

  it("23. «Вы бот? Дайте живого человека» → «Я помощник агентства, отвечаю сразу» + шаг «контакт»", () => {
    const ig = one(IG(), ru({ botQuestion: true, question: "staff" }));
    expect(ig.keys).toEqual(["bot_identity", "ask_phone"]);
    expect(ig.text).toMatch(/^Я помощник агентства, отвечаю сразу\./u);
    const wa = one(ctx(), ru({ botQuestion: true }));
    expect(wa.keys).toEqual(["bot_identity", "lead_known_phone"]);
    expect(leads([wa as Turn])[0]).toMatchObject({ role: null });
  });

  it("24. не по теме → одна фраза «Мы помогаем купить и продать недвижимость в Душанбе», второй раз не отвечаем", () => {
    const turns = run(IG(), [ru({ offTopic: true }), ru({ offTopic: true })]);
    expect(turns[0]!.text).toBe("Мы помогаем купить и продать недвижимость в Душанбе.");
    expect(turns[1]!.silent).toBe(true);
    expect(turns[1]!.state.asked.role).toBe(0);
  });

  it("25. «Не звоните мне, я просто смотрю» → «Напишите, когда будет удобно.», номер больше не просим", () => {
    const noCall = { when: null, textOnly: false, noCall: true };
    const turns = run(IG(), [ru({ role: "buyer", details: { rooms: "2", district: "Сино", budget: "50000$" }, hasDetails: true }),
      ru({ callback: noCall }), ru({ ackOnly: true }), ru({ question: "other" })]);
    expect(turns[0]!.keys).toEqual(["ask_phone"]);
    expect(turns[1]!.text).toBe("Напишите, когда будет удобно.");
    expect(turns.slice(1).flatMap(t => t.keys)).not.toContain("ask_phone");
    expect(turns.flatMap(t => t.actions).filter(a => a.type === "call_staff")).toHaveLength(0);
  });

  it("26. жалоба на агента → «Передам руководителю, с вами свяжутся.», руководитель, заявку не заводим", () => {
    const t = one(ctx(), ru({ complaint: true, role: "buyer" }));
    expect(t.text).toBe("Передам руководителю, с вами свяжутся.");
    expect(t.actions).toEqual([{ type: "call_staff", reason: "complaint", manager: true }]);
    expect(t.state.closed).toBe(true);
  });
});

describe("пределы и запреты", () => {
  it("вопрос о роли — не больше двух раз, второй другими словами; после двух непонятных — тишина и сотрудник (один раз)", () => {
    const turns = run(IG(), [ru({ greetingOnly: true, greeting: "ru" }), ru({ ackOnly: true }), ru({ question: "other" }), ru({ ackOnly: true })]);
    expect(turns[0]!.keys).toEqual(["greet", "ask_role"]);
    expect(turns[1]!.keys).toEqual(["ask_role"]);
    expect(turns[1]!.text).not.toBe(turns[0]!.text.replace(/^Здравствуйте! /u, ""));
    expect(turns[2]!.silent).toBe(true);
    expect(turns[2]!.actions).toEqual([{ type: "call_staff", reason: "role_unclear", manager: false }]);
    expect(turns[3]!.silent && turns[3]!.actions.length === 0).toBe(true);
    // Ясная роль после передачи сотруднику — разговор продолжается.
    expect(one(IG(), ru({ role: "buyer" }), turns[3]!.state).keys).toEqual(["ask_details_buyer"]);
  });

  it("вопрос о деталях один раз, только про недостающее, любой ответ принимается", () => {
    const partial = one(ctx(), ru({ role: "buyer", details: { rooms: "2" }, hasDetails: true }));
    expect(partial.keys).toEqual(["ask_details_missing"]);
    expect(partial.text).toBe("Напишите, пожалуйста, ещё район и сумму.");
    const full = one(ctx(), ru({ role: "buyer", details: { rooms: "2", district: "Сино", budget: "60000$" }, hasDetails: true }));
    expect(full.keys).toEqual(["lead_known_phone"]);
    const turns = run(ctx(), [ru({ role: "buyer" }), ru({ ackOnly: true })]);
    expect(turns[1]!.keys).toEqual(["lead_known_phone"]);
  });

  it("встречный вопрос на вопрос о деталях: ответ на него, без повтора вопроса и без заявки; следующий ответ — заявка", () => {
    const turns = run(ctx(), [ru({ role: "seller" }), ru({ question: "area" }), ru({ details: { price: "80000$" }, hasDetails: true })]);
    expect(turns[1]!.keys).toEqual(["where_work"]);
    expect(turns[1]!.text).toBe("Работаем по Душанбе.");
    expect(leads(turns.slice(0, 2))).toHaveLength(0);
    expect(turns[2]!.keys).toEqual(["lead_known_phone"]);
  });

  it("WhatsApp (номер известен): ни просьбы номера, ни «удобно?», заявка в тот же ход", () => {
    const c = ctx({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus: focus164 });
    const t = one(c, ru({ adOpener: true, greeting: "ru" }));
    expect(t.keys).toEqual(["property_price", "lead_known_phone"]);
    expect(leads([t as Turn])[0]).toMatchObject({ role: "buyer", propertyId: PROPERTY_ID });
    expect(t.text).not.toMatch(/удобно|номер телефона/iu);
  });

  it("Instagram: номер просим до maxPhoneAsks (вторая просьба другими словами), дальше тишина и сотрудник", () => {
    const c = IG({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus: focus164 });
    const turns = run(c, [ru({ adOpener: true }), ru({ question: "other" }), ru({ ackOnly: true }), ru({ ackOnly: true })]);
    expect(turns[0]!.keys).toEqual(["property_price", "ask_phone"]);
    expect(turns[1]!.keys).toEqual(["ask_phone"]);
    expect(turns[1]!.steps[0]!.variant).toBe(1);
    expect(turns[2]!.silent).toBe(true);
    expect(turns[2]!.actions).toEqual([{ type: "call_staff", reason: "phone_not_given", manager: false }]);
    expect(turns[3]!.actions).toEqual([]);
    const strict = run(IG({ maxPhoneAsks: 1 }), [ru({ role: "buyer", details: { rooms: "2", district: "Сино", budget: "1" }, hasDetails: true }), ru({ ackOnly: true })]);
    expect(strict[1]!.actions.map(a => a.type)).toEqual(["call_staff"]);
    // Номер после передачи сотруднику — всё равно заявка.
    expect(leads(run(c, [ru({ phone: "+992935551234" })], turns[3]!.state))).toHaveLength(1);
  });

  it("комиссия продавцу — сама один раз; на прямой вопрос продавца — ответ; покупателю — никогда", () => {
    const seller = run(IG(), [ru({ role: "seller" }), ru({ details: { district: "Сино" }, hasDetails: true }), ru({ question: "fee" })]);
    expect(seller.map(t => t.text).join(" ").match(/2%/gu)?.length).toBe(2);
    const buyer = run(IG(), [ru({ role: "buyer", question: "fee" }), ru({ question: "fee" }), ru({ phone: "+992935551234", question: "fee" })]);
    expect(buyer.map(t => t.text).join(" ")).not.toMatch(/%|комисси/iu);
    // Продавец с вопросом о районе в первом ходе: комиссия не теряется, звучит при заявке.
    const deferred = run(ctx(), [ru({ role: "seller", question: "area" }), ru({ details: { price: "1" }, hasDetails: true })]);
    expect(deferred[0]!.keys).toEqual(["where_work", "ask_details_seller"]);
    expect(deferred[1]!.keys).toEqual(["seller_commission", "lead_known_phone"]);
  });

  it("после принятой заявки — ни одного вопроса; новая деталь — заметка и одно «Передал агенту»", () => {
    const turns = run(ctx(), [ru({ role: "buyer", details: { rooms: "2", district: "Сино", budget: "1" }, hasDetails: true }),
      ru({ details: { floor: "5" }, hasDetails: true }), ru({ details: { renovation: "евро" }, hasDetails: true }), ru({ role: "seller" }),
      ru({ question: "other" }), ru({ greetingOnly: true })]);
    expect(turns[1]!.keys).toEqual(["note_added"]);
    expect(turns[1]!.actions[0]).toMatchObject({ type: "append_note" });
    expect(turns[2]!.silent).toBe(true);
    expect(turns[2]!.actions[0]).toMatchObject({ type: "append_note" });
    expect(turns.slice(1).flatMap(t => t.keys).filter(key => ASKS.includes(key))).toEqual([]);
    expect(leads(turns)).toHaveLength(1);
  });

  it("карточка уже есть (leadExists) — состояние с нуля, но вопросов нет", () => {
    const t = one(ctx({ leadExists: true }), ru({ role: "buyer" }));
    expect(t.silent).toBe(true);
    expect(t.state.leadAccepted).toBe(true);
  });

  it("вложения: фото продавца — одно «агент снимет сам», шаг не двигается; наш пост — покупатель объекта", () => {
    const photo = u({ hasText: false, attachments: { voice: "none", ownPost: false, foreignPost: false, media: true } });
    const turns = run(ctx(), [ru({ role: "seller" }), photo, photo]);
    expect(turns[1]!.keys).toEqual(["photo_ack"]);
    expect(turns[1]!.text).toBe("Спасибо, фото и видео агент снимет сам.");
    expect(turns[2]!.silent).toBe(true);
    expect(turns[2]!.state.step).toBe("details");
    const ownPost = one(IG({ focus: focus164 }), u({ hasText: false, attachments: { voice: "none", ownPost: true, foreignPost: false, media: true } }));
    expect(ownPost.keys).toEqual(["property_price", "ask_phone"]);
    expect(ownPost.state.role).toBe("buyer_property");
  });

  it("новый объект в разговоре: строка объекта для нового номера, старая — не повторяется без вопроса о цене", () => {
    const c = IG({ focus: focus164 });
    const turns = run(c, [ru({ aboutThisProperty: true }), ru({ ackOnly: true }), ru({ question: "property_price", aboutThisProperty: true })]);
    expect(turns[0]!.keys).toEqual(["property_price", "ask_phone"]);
    expect(turns[1]!.keys).toEqual(["ask_phone"]);
    expect(turns[2]!.state.asked.phone).toBe(2);
    const other = { ...focus164, propertyId: OTHER_PROPERTY_ID, shortId: 999 };
    const next = one(IG({ focus: other }), ru({ attachments: { voice: "none", ownPost: true, foreignPost: false, media: true } }), turns[1]!.state);
    expect(next.text).toContain("№999");
  });

  it("аренда и вакансия не заводят заявку; продавец после отказа в аренде — обычный продавец", () => {
    const turns = run(ctx(), [ru({ role: "rent" }), ru({ thanksOnly: true, ackOnly: true }), ru({ role: "seller" })]);
    expect(turns[1]!.keys).toEqual(["welcome"]);
    expect(turns[2]!.keys).toEqual(["seller_intro", "ask_details_seller"]);
    expect(leads(run(ctx(), [ru({ role: "job", phone: "+992935551234" })]))).toHaveLength(0);
  });

  it("язык липкий: «ок», цифры и кнопка рекламы его не меняют; осмысленный текст — меняет", () => {
    const turns = run(IG(), [tg({ role: "buyer" }), u({ ackOnly: true, languageHint: "ru" }), ru({ details: { rooms: "2" }, hasDetails: true })]);
    expect(turns[1]!.language).toBe("tg");
    expect(turns[2]!.language).toBe("ru");
  });

  it("чистая функция: прежнее состояние не меняется, один вход — один выход", () => {
    const start = initialOperatorState();
    const snapshot = JSON.stringify(start);
    const a = decide(start, ru({ role: "seller" }), ctx());
    const b = decide(start, ru({ role: "seller" }), ctx());
    expect(JSON.stringify(start)).toBe(snapshot);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("сторож-перебор: инварианты на случайных разговорах", () => {
  // Детерминированный генератор (без Math.random): падение воспроизводится по номеру разговора.
  function rng(seed: number) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
  const pick = <T,>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
  function randomTurn(r: () => number): Understanding {
    const chance = (p: number) => r() < p;
    return u({
      role: pick(r, [null, null, null, "buyer", "seller", "rent", "job"] as const),
      question: pick(r, ["none", "none", "fee", "services", "property_price", "area", "identity", "staff", "other"] as const),
      aboutThisProperty: chance(0.2), details: chance(0.3) ? { rooms: "2", district: chance(0.5) ? "Сино" : null } : {},
      hasDetails: chance(0.3), phone: chance(0.1) ? "+992935551234" : null,
      callback: { when: chance(0.1) ? "с 11:00 до 14:30" : null, textOnly: chance(0.05), noCall: chance(0.05) },
      language: pick(r, [null, "ru", "tg"] as const), languageHint: pick(r, [null, "ru", "tg"] as const),
      greeting: pick(r, [null, null, "assalom", "salom", "ru"] as const), greetingOnly: chance(0.1), ackOnly: chance(0.15),
      thanksOnly: chance(0.05), adOpener: chance(0.1), bargain: chance(0.08), rude: chance(0.02), botQuestion: chance(0.05),
      offTopic: chance(0.05), complaint: chance(0.02), outsidePlace: chance(0.05) ? "Гиссар" : null, hasText: chance(0.9),
      attachments: { voice: pick(r, ["none", "none", "transcribed", "failed"] as const), ownPost: chance(0.05), foreignPost: chance(0.05), media: chance(0.1) },
      job: { asked: chance(0.3) ? "SMM" : null, openKey: chance(0.2) ? "sales-manager" : null },
    });
  }
  it("2000 разговоров по 8 ходов: шагов ≤ 2, вопрос ≤ 1, пределы вопросов, комиссия только продавцу, после заявки без вопросов", () => {
    for (let n = 1; n <= 2000; n++) {
      const r = rng(n);
      const c = ctx({ channel: pick(r, ["WHATSAPP", "INSTAGRAM", "FACEBOOK", "TELEGRAM"] as const), phoneKnown: r() < 0.5,
        ad: { topic: pick(r, [null, "property", "seller", "job"] as const), propertyId: r() < 0.5 ? PROPERTY_ID : null },
        focus: r() < 0.5 ? focus164 : null, maxPhoneAsks: 1 + Math.floor(r() * 3), leadExists: r() < 0.05 });
      let state = initialOperatorState(), accepted = 0;
      for (let turn = 0; turn < 8; turn++) {
        const before = state;
        const d = decide(before, randomTurn(r), c);
        const text = renderOperatorReply(d.steps, d.language);
        const where = `разговор ${n}, ход ${turn}: ${text}`;
        expect(d.steps.length, where).toBeLessThanOrEqual(2);
        expect((text.match(/\?/gu) ?? []).length, where).toBeLessThanOrEqual(1);
        expect(text, where).not.toMatch(/Рудаки|Рӯдакӣ|—|удобно\?/u);
        expect(d.state.asked.role, where).toBeLessThanOrEqual(2);
        expect(d.state.asked.details, where).toBeLessThanOrEqual(1);
        expect(d.state.asked.phone, where).toBeLessThanOrEqual(c.maxPhoneAsks);
        if (d.steps.some(step => step.key === "seller_intro" || step.key === "seller_commission")) expect(d.state.role, where).toBe("seller");
        if (before.leadAccepted || before.closed) expect(d.steps.filter(step => ASKS.includes(step.key)), where).toEqual([]);
        if (c.phoneKnown) expect(d.steps.map(step => step.key), where).not.toContain("ask_phone");
        accepted += d.actions.filter(a => a.type === "accept_lead").length;
        expect(d.silent, where).toBe(d.steps.length === 0);
        state = d.state;
      }
      expect(accepted, `разговор ${n}`).toBeLessThanOrEqual(1);
    }
  });
});
