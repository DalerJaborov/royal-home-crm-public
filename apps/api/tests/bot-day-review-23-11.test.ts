/**
 * РАЗБОР СУТОК БОТА НА ПРОДЕ 22–23.11.2026 (замаскированные переписки, только чтение). Каждый случай — живая реплика клиента
 * и то, что бот ответил; тест держит исправленный ответ. Без модели и без базы: понимание — запасные правила или подставленный
 * ответ модели (тот, что дала модель на проде), решение — чистая функция оператора.
 *
 *  A. C6: карточка без живого агента — «Ваалейкум ассалом! Записали, с вами свяжутся сегодня.» после месяца тишины; клиент:
 *     «Вы не раз это говорили». Теперь без срока и без «свяжутся»; обещание, которое уже не выполнили, второй раз не звучит.
 *  D. C8: кнопка рекламы «Можно узнать об этом подробнее?» дважды, потом «Покупаем» → «Это точно скажет агент.» (вопрос
 *     прилип из кнопки). C2: «Салом алекум» после заявки → «Ба агент расондам.» (приветствие не узнано). C1: «Не. Рахмат» →
 *     «Вы хотите купить или продать недвижимость?» (отказ без предложения звонка не услышан, ответ по-русски).
 *  E. C10: «Купит квартира» после кнопки рекламы → «Это точно скажет агент. Если хотите, агент позвонит…» вместо заявки.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/ai/guardMetrics.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/guardMetrics.js")>()), guardFired: vi.fn() }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn() }));

const { decide, initialOperatorState } = await import("../src/ai/operator/decide.js");
const { understandFallback, understandingFromModel } = await import("../src/ai/operator/understand.js");
const { renderOperatorReply, OPERATOR_PHRASES } = await import("../src/ai/operator/phrases.js");
const { contactPromiseUnkept } = await import("../src/lib/contactPromiseUnkept.js");
const { clientSaidNothingSubstantive } = await import("../src/ai/adTemplatePhrase.js");
const { isNeutralShortReply } = await import("../src/ai/customerDmLanguage.js");
type Ctx = import("../src/ai/operator/types.js").OperatorContext;
type State = import("../src/ai/operator/types.js").OperatorState;
type Turn = { role: "user" | "assistant"; text: string };

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  channel: "WHATSAPP", phoneKnown: true, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "сегодня с 09:30", tg: "имрӯз аз соати 09:30" }, recruiterPath: true, ad: { topic: "seller", propertyId: null }, focus: null,
  callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});
/** Ответ модели целиком (поля, которых нет в `over`, — «пусто»), как его возвращает операторская модель. */
const modelAnswer = (over: Record<string, unknown>) => ({
  role: "none", roleQuote: "", question: "none", aboutThisProperty: false, rooms: "", district: "", budget: "", area: "", floor: "",
  renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "none",
  bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "", ...over,
});
function turn(state: State, c: Ctx, text: string, recent: Turn[] = [], model?: Record<string, unknown>) {
  const input = { current: text, recent };
  const u = model ? understandingFromModel(modelAnswer(model), input, state, c)!.understanding : understandFallback(input, state, c);
  const d = decide(state, u, c);
  return { u, d, keys: d.steps.map(step => step.key), text: renderOperatorReply(d.steps, d.language) };
}
const AD = "Здравствуйте! Можно узнать об этом подробнее?";

describe("A. C6: без живого агента и после невыполненного обещания бот не обещает «с вами свяжутся»", () => {
  const leadState = (): State => ({ ...initialOperatorState(), leadAccepted: true, step: "done", language: "ru" });

  it("«Салом алайкум» по карточке без агента: приветствие и «записали, увидит сотрудник» — без срока и без «свяжутся»", () => {
    const c = ctx({ leadExists: true, cardAgentActive: false });
    const t = turn(leadState(), c, "Салом алайкум");
    expect(t.keys).toEqual(["greet_assalom", "no_agent_noted"]);
    expect(t.text).not.toMatch(/свяж|сегодня|завтра|тамос/iu);
    expect(t.text).toBe("Ваалейкум ассалом! Записали, ваше сообщение увидит сотрудник.");
    expect(t.d.actions).toContainEqual({ type: "follow_up" });
  });

  it("ни один вариант «записали» ни на одном языке не называет срок и не обещает связаться", () => {
    for (const language of ["ru", "tg"] as const) for (const text of OPERATOR_PHRASES.no_agent_noted[language]) {
      expect(text, text).not.toMatch(/\{when\}|свяж|тамос\s+мегиранд|занг/iu);
    }
  });

  it("агент есть, но прошлое обещание не выполнено: «когда позвонят?» — без нового обещания, агенту и РОПу сигнал", () => {
    const c = ctx({ leadExists: true, cardAgentActive: true, promiseUnkept: true });
    const t = turn(leadState(), c, "Когда со мной свяжутся?");
    expect(t.keys).toEqual(["no_agent_noted"]);
    expect(t.text).not.toMatch(/свяж|позвонит|ответит/iu);
    expect(t.d.actions).toContainEqual({ type: "call_staff", reason: "promise_unkept" });
    // Обещание выполнено (или его не было) — прежний ответ «напомнил агенту».
    expect(turn(leadState(), ctx({ leadExists: true }), "Когда со мной свяжутся?").keys).toEqual(["lead_status"]);
  });

  it("«ок» после невыполненного обещания — тишина без сигнала (повод «ок» не новый)", () => {
    const t = turn(leadState(), ctx({ leadExists: true, promiseUnkept: true }), "Ок");
    expect(t.d.actions.some(action => action.type === "call_staff")).toBe(false);
  });

  const NOW = new Date("2026-11-22T13:46:00Z");
  const at = (iso: string) => new Date(iso).toISOString();
  const history = [
    { role: "user", content: "Продаю 3-комн. на Рудаки", at: at("2026-10-16T13:40:00Z") },
    { role: "assistant", content: "Мирзо-Али! Передал Сурайё, чтобы она позвонила вам завтра", at: at("2026-10-16T13:42:00Z"), by: { kind: "bot" } },
    { role: "user", content: "Ок", at: at("2026-10-16T13:42:30Z") },
    { role: "user", content: "Салом алайкум", at: at("2026-11-22T13:46:00Z") },
  ];
  it("C6 живьём: обещание звонка 16.10, звонка и ответа сотрудника нет — обещание не выполнено", () => {
    expect(contactPromiseUnkept(history, null, NOW)).toBe(true);
  });
  it("агент звонил после обещания, или сотрудник ответил в переписке — обещание выполнено", () => {
    expect(contactPromiseUnkept(history, new Date("2026-10-17T06:00:00Z"), NOW)).toBe(false);
    const answered = [...history.slice(0, 3), { role: "assistant", content: "Здравствуйте, завтра покажем", at: at("2026-10-17T07:00:00Z"), by: { kind: "agent" } }, history[3]];
    expect(contactPromiseUnkept(answered, null, NOW)).toBe(false);
  });
  it("ночное обещание «позвонит завтра с 09:30» в 01:00 — ещё не нарушено: два часа считаются в рабочем окне", () => {
    const hours = { start: "09:30", end: "18:00" };
    // Обещание 22.11 в 23:00 по Душанбе (18:00Z), клиент пишет 23.11 в 01:00 (20:00Z) и в 12:00 (07:00Z).
    const night = [{ role: "assistant", content: "Спасибо, передаю агенту, он позвонит вам на этот номер завтра с 09:30.", at: at("2026-11-22T18:00:00Z"), by: { kind: "bot" } }];
    expect(contactPromiseUnkept(night, null, new Date("2026-11-22T20:00:00Z"), hours)).toBe(false);
    expect(contactPromiseUnkept(night, null, new Date("2026-11-23T05:00:00Z"), hours)).toBe(false); // 10:00 — полчаса работы
    expect(contactPromiseUnkept(night, null, new Date("2026-11-23T07:00:00Z"), hours)).toBe(true);  // 12:00 — 2,5 часа работы
  });

  it("обещанию меньше двух часов — ещё рано; обещание сотрудника — не обещание бота", () => {
    const fresh = [{ role: "assistant", content: "Спасибо, передаю агенту, он позвонит вам на этот номер в ближайшее время.", at: at("2026-11-22T12:30:00Z"), by: { kind: "bot" } }];
    expect(contactPromiseUnkept(fresh, null, NOW)).toBe(false);
    const staff = [{ role: "assistant", content: "Агент позвонит вам завтра", at: at("2026-11-20T12:30:00Z"), by: { kind: "agent" } }];
    expect(contactPromiseUnkept(staff, null, NOW)).toBe(false);
  });
});

describe("D. Понимание: кнопка рекламы, «алекум», отказ без предложения звонка", () => {
  it("C8: «Покупаем» после двух кнопок рекламы — заявка без «это точно скажет агент» (вопрос из кнопки не прилипает)", () => {
    const recent: Turn[] = [{ role: "user", text: AD }, { role: "assistant", text: "Здравствуйте! Вы хотите купить или продать недвижимость?" },
      { role: "user", text: AD }, { role: "assistant", text: "Подскажите, пожалуйста: вы покупаете или продаёте?" }];
    const state: State = { ...initialOperatorState(), language: "ru", asked: { role: 2, details: 0, phone: 0 }, step: "role" };
    // Модель на проде: роль покупатель по «Покупаем», а вопрос «other» — из кнопки выше.
    const t = turn(state, ctx(), "Покупаем", recent, { role: "buyer", roleQuote: "Покупаем", question: "other", language: "ru" });
    expect(t.u.question).toBe("none");
    expect(t.keys).not.toContain("details_by_agent");
    expect(t.d.actions.some(action => action.type === "accept_lead")).toBe(true);
    expect(t.text).not.toMatch(/точно скажет агент/u);
  });

  it("вопрос словами после кнопки — по-прежнему вопрос («А где находится?»)", () => {
    const recent: Turn[] = [{ role: "user", text: AD }];
    const t = turn(initialOperatorState(), ctx(), "А где находится", recent, { role: "none", question: "other", language: "ru" });
    expect(t.u.question).toBe("other");
  });

  it.each(["Салом алекум", "Ассалому алейкум", "Салом алайкум", "Асалом алейкум", "Салам алейкум"])("C2: «%s» — приветствие, а не дело", (text) => {
    expect(clientSaidNothingSubstantive(text)).toBe(true);
    expect(isNeutralShortReply(text)).toBe(true);
  });

  it("C2 живьём: «Салом алекум» после заявки — «Ваалайкум ассалом» и напоминание, а не «Ба агент расондам»", () => {
    const state: State = { ...initialOperatorState(), leadAccepted: true, step: "done", language: "tg", spoken: { note_added: 1 } };
    const t = turn(state, ctx({ leadExists: true }), "Салом алекум");
    expect(t.u.greetingOnly).toBe(true);
    expect(t.keys).not.toContain("note_added");
    expect(t.keys).toEqual(["greet_assalom", "lead_reminder"]);
    expect(t.d.actions.some(action => action.type === "append_note")).toBe(false);
  });

  it("C1: «Не. Рахмат» на вопрос о роли (Instagram) — отказ: без второго вопроса о роли, по-таджикски", () => {
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, ad: { topic: null, propertyId: null } });
    const state: State = { ...initialOperatorState(), asked: { role: 1, details: 0, phone: 0 }, step: "role", spoken: { ask_role: 1 } };
    const t = turn(state, c, "Не. Рахмат");
    expect(t.keys).toEqual(["no_call_ack"]);
    expect(t.d.language).toBe("tg");
    expect(t.text).not.toMatch(/купить или продать|мехаред ё мефурӯшед/u);
    // Повтор отказа — тишина, без нового вопроса.
    expect(turn(t.d.state, c, "Не. Рахмат").keys).toEqual([]);
  });

  it.each([["нет спасибо", "ru"], ["не, раҳмат", "tg"], ["Не надо, спасибо", "ru"], ["Лозим нест", "tg"]] as const)("отказ «%s» — «пишите, когда удобно» на языке клиента (%s)", (text, language) => {
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, ad: { topic: null, propertyId: null } });
    const t = turn({ ...initialOperatorState(), asked: { role: 1, details: 0, phone: 0 }, step: "role", spoken: { ask_role: 1 } }, c, text);
    expect(t.keys).toEqual(["no_call_ack"]);
    expect(t.d.language).toBe(language);
  });

  it("«Нет, хочу узнать цену» и «нет, я продаю» — не отказ: разговор идёт дальше", () => {
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, ad: { topic: null, propertyId: null } });
    const s0 = { ...initialOperatorState(), asked: { role: 1, details: 0, phone: 0 }, step: "role" as const, spoken: { ask_role: 1 } };
    expect(turn(s0, c, "Нет, хочу узнать цену").keys).not.toEqual(["no_call_ack"]);
    expect(turn(s0, c, "нет, я продаю квартиру").keys).not.toEqual(["no_call_ack"]);
  });
});

describe("E. C10: роль без «?» — не вопрос, интерес не отменяется", () => {
  it("«Купит квартира» после кнопки рекламы (WhatsApp) — заявка, а не «это точно скажет агент» и предложение звонка", () => {
    const recent: Turn[] = [{ role: "user", text: AD }, { role: "assistant", text: "Здравствуйте! Вы хотите купить или продать недвижимость?" }];
    const state: State = { ...initialOperatorState(), language: "ru", asked: { role: 1, details: 0, phone: 0 }, step: "role" };
    const t = turn(state, ctx(), "Купит квартира", recent, { role: "buyer", roleQuote: "Купит квартира", question: "property_other", aboutThisProperty: false, language: "ru" });
    expect(t.u.roleByQuestion).toBe(false);
    expect(t.keys).not.toContain("offer_call");
    expect(t.keys).not.toContain("details_by_agent");
    expect(t.d.actions.some(action => action.type === "accept_lead")).toBe(true);
  });

  it("вопрос со знаком («Квартира продаётся?») — по-прежнему покупатель только по вопросу", () => {
    const t = turn(initialOperatorState(), ctx(), "Квартира продаётся?", [], { role: "buyer", roleQuote: "Квартира продаётся", question: "property_other", language: "ru" });
    expect(t.u.roleByQuestion).toBe(true);
    // Вопрос о цене без знака («нархаш чанд») — тоже вопрос: интерес к звонку ещё не проявлен.
    expect(turn(initialOperatorState(), ctx(), "нархаш чанд", [], { role: "buyer", roleQuote: "нархаш чанд", question: "property_price", language: "tg" }).u.roleByQuestion).toBe(true);
  });
});
