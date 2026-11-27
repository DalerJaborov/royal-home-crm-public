import { describe, expect, it } from "vitest";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { renderOperatorReply } from "../src/ai/operator/phrases.js";
import { understandFallback, understandingFromModel } from "../src/ai/operator/understand.js";
import { runOperatorTurn, withoutOwnRepeats } from "../src/ai/operator/index.js";
import { botWelcomeDelivered, readOperatorState, seedStateFromBotWelcome, serializeOperatorState } from "../src/ai/operator/state.js";
import { leadOnlyOutgoing } from "../src/ai/leadOnlyMode.js";
import type { OperatorAction, OperatorContext, OperatorState, PhraseKey } from "../src/ai/operator/types.js";

/**
 * Живая ошибка 27.11.2026, 02:14 по Душанбе (корпус регрессии ядра бота). Владелец впервые написал на второй номер WhatsApp
 * «Арван» одно «Салом алейкум» и получил «Ваалайкум ассалом! Дархостатон назди агент аст, ӯ бо шумо тамос мегирад.»; на
 * «Какой дархост, я же ничего ещё не сказал» — «Напомнил агенту о вас, он с вами свяжется.» и пометку агенту.
 *
 * Корень: к новой переписке привязана карточка клиента (звонок 18.11, соседняя переписка того же номера, #480), и оператор
 * считал любую привязанную карточку заявкой ЭТОГО разговора — память «заявка принята» ставилась на первом же ходе. Теперь
 * приветствие и слова без дела в переписке, где по сути ещё ничего не сказано, идут обычным путём: приветствие и «чем помочь:
 * купить или продать?», от имени бренда номера. Оператор один на WhatsApp, Instagram, Facebook, Telegram и сайт
 * (lib/customerLeadOnlyCore.ts и messengers/conversation.ts → lib/operatorTurn.ts → ai/operator), поэтому класс гоняется во всех.
 */

const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "WHATSAPP", phoneKnown: true, leadExists: true, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "сегодня после 10:00", tg: "имрӯз баъд аз соати 10:00" }, recruiterPath: true, ad: { topic: null, propertyId: null },
  focus: null, callbackWhen: { ru: "завтра с 10:00", tg: "пагоҳ аз соати 10:00" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});
const ARVAN: Partial<OperatorContext> = { brandName: "Arvan", ownBrand: true };
type Turn = { role: "user" | "assistant"; text: string };

/** Фразы, которыми бот говорит «заявка у агента» или отмечает передачу агенту. */
const LEAD_TALK: ReadonlySet<PhraseKey> = new Set(["lead_reminder", "lead_status", "no_agent_noted", "note_added", "question_noted"]);
/** Действия, которые трогают агента или руководство (пометка, сигнал, заявка). */
const touchesPeople = (actions: readonly OperatorAction[]) => [...actions];

/** Диалог как на проде: понимание кодом → решение → сторож повтора → последняя дверь режима; память — через сериализацию. */
function dialog(c: OperatorContext, texts: string[], start: OperatorState = initialOperatorState(), now = new Date("2026-11-26T21:14:00Z")) {
  let stored: unknown = serializeOperatorState(start, now);
  const recent: Turn[] = [];
  return texts.map((text, index) => {
    const at = new Date(now.getTime() + index * 60_000);
    const state = readOperatorState(stored, at);
    const u = understandFallback({ current: text, recent: [...recent] }, state, c);
    const d = decide(state, u, c);
    withoutOwnRepeats(d, [...recent], [], { priceAsked: u.priceAsked === true });
    stored = serializeOperatorState(d.state, at);
    const out = d.steps.length ? leadOnlyOutgoing(renderOperatorReply(d.steps, d.language), d.language) : "";
    recent.push({ role: "user", text });
    if (out) recent.push({ role: "assistant", text: out });
    return { u, d, keys: d.steps.map(step => step.key), text: out };
  });
}

describe("живой диалог 27.11 (1a59f7b1): второй номер WhatsApp «Арван», карточка от звонка", () => {
  it("«Салом алейкум» — приветствие и «купить или продать?» от имени Арвана; ни «заявка у агента», ни пометки агенту", () => {
    const [hello, denial] = dialog(ctx(ARVAN), ["Салом алейкум", "Какой дархост, я же ничего ещё не сказал"]);
    expect(hello!.keys).toEqual(["greet_assalom", "ask_role_brand"]);
    expect(hello!.text).toBe("Ваалайкум ассалом! Шумо ба агентии Arvan навиштед, хона мехаред ё мефурӯшед?");
    expect(hello!.text).not.toMatch(/дархост|агент\s+аст|тамос/iu);
    expect(touchesPeople(hello!.d.actions)).toEqual([]);
    expect(hello!.d.state.leadAccepted).toBe(false);
    // Клиент, как на проде, всё равно пишет «Какой дархост…» (по-русски): ответ по-русски, без «напомнил агенту», без пометки.
    expect(denial!.u.deniesRequest).toBe(true);
    expect(denial!.d.language).toBe("ru");
    expect(denial!.keys.filter(key => LEAD_TALK.has(key))).toEqual([]);
    expect(denial!.keys).toEqual(["ask_role"]);
    expect(denial!.text).toMatch(/купить или продать|покупаете или продаёте/u);
    expect(touchesPeople(denial!.d.actions)).toEqual([]);
  });

  it("модель на «Какой дархост…» метит «вопрос о статусе» и «жалобу» — код сильнее: ни «напомнил агенту», ни руководителя", () => {
    const state = dialog(ctx(ARVAN), ["Салом алейкум"])[0]!.d.state;
    const recent: Turn[] = [{ role: "user", text: "Салом алейкум" },
      { role: "assistant", text: "Ваалайкум ассалом! Шумо ба агентии Arvan навиштед, хона мехаред ё мефурӯшед?" }];
    const model = { role: "none", roleQuote: "", question: "status", aboutThisProperty: false, rooms: "", district: "", budget: "", area: "",
      floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "ru",
      bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: true, jobPosition: "", outsidePlace: "" };
    const c = ctx(ARVAN);
    const u = understandingFromModel(model, { current: "Какой дархост, я же ничего ещё не сказал", recent }, state, c)!.understanding;
    expect(u.question).not.toBe("status");
    expect(u.complaint).toBe(false);
    const d = decide(state, u, c);
    expect(d.steps.map(step => step.key).filter(key => LEAD_TALK.has(key) || key === "complaint_ack")).toEqual([]);
    expect(d.actions).toEqual([]);
  });

  it("память, которую успела записать ошибка на проде, на следующее приветствие не повторяет «заявка у агента»", () => {
    // Как в BotConversation.leadOnlyPending переписки 1a59f7b1 после двух ходов: step done, leadAccepted, роль не названа.
    const poisoned: OperatorState = { ...initialOperatorState(), step: "done", leadAccepted: true, language: "tg",
      spoken: { greet_assalom: 1, lead_reminder: 1, lead_status: 1 } };
    const nextDay = new Date("2026-11-28T05:00:00Z");
    const [t] = dialog(ctx(ARVAN), ["Салом"], poisoned, nextDay);
    expect(t!.keys.filter(key => LEAD_TALK.has(key))).toEqual([]);
    expect(t!.keys).toContain("ask_role");
    expect(touchesPeople(t!.d.actions)).toEqual([]);
  });
});

const CHANNELS = ["WHATSAPP", "INSTAGRAM", "FACEBOOK", "TELEGRAM", "WEBSITE"] as const;
const GREETINGS = ["Салом алейкум", "Ассалому алайкум", "Салом", "Здравствуйте", "Привет", "Добрый день", "?"];

describe("класс: приветствие у клиента с карточкой из другого места — во всех каналах и на обоих номерах", () => {
  for (const channel of CHANNELS) for (const brand of [{ name: "Royal Home", over: {} }, { name: "Arvan", over: ARVAN }]) {
    it(`${channel} / ${brand.name}: приветствие — «купить или продать?», без «заявка у агента», без пометок и сигналов`, () => {
      for (const agent of [true, false]) for (const text of GREETINGS) {
        const c = ctx({ channel: channel as OperatorContext["channel"], phoneKnown: channel === "WHATSAPP", cardAgentActive: agent, ...brand.over });
        const [t] = dialog(c, [text]);
        const where = `${channel}/${brand.name}/агент ${agent}: «${text}» → ${t!.text}`;
        expect(t!.keys.filter(key => LEAD_TALK.has(key)), where).toEqual([]);
        expect(t!.keys.some(key => key === "ask_role" || key === "ask_role_brand"), where).toBe(true);
        expect(touchesPeople(t!.d.actions), where).toEqual([]);
        expect(t!.text, where).not.toMatch(/заявк|дархост|у агента|агенту|назди агент/iu);
        expect(t!.text, where).not.toMatch(/[—–]/u);
        // Первое слово на номере бренда — от его имени; на основном номере — прежний вопрос.
        if (text !== "?") expect(t!.keys.includes("ask_role_brand"), where).toBe(brand.name === "Arvan");
      }
    });
  }

  it("язык ответа — по приветствию клиента: «Здравствуйте» по-русски, «Салом алейкум» по-таджикски, на «вы» / «шумо»", () => {
    const [ru] = dialog(ctx(ARVAN), ["Здравствуйте"]);
    expect(ru!.text).toBe("Здравствуйте! Вы написали в агентство Arvan, хотите купить или продать недвижимость?");
    const [tg] = dialog(ctx(), ["Салом алейкум"]);
    expect(tg!.text).toBe("Ваалайкум ассалом! Шумо хона мехаред ё мефурӯшед?");
  });
});

describe("ход по делу у клиента с карточкой — прежний путь карточки, без второй заявки", () => {
  it("«Хочу купить квартиру» после приветствия — пометка в карточку и «передал агенту», заявки нет", () => {
    const [, buy] = dialog(ctx(ARVAN), ["Салом алейкум", "Хочу купить квартиру"]);
    expect(buy!.d.state.leadAccepted).toBe(true);
    expect(buy!.d.actions.some(action => action.type === "accept_lead")).toBe(false);
    expect(buy!.d.actions.some(action => action.type === "append_note")).toBe(true);
    expect(buy!.keys).toEqual(["note_added"]);
  });

  it("«Когда со мной свяжутся?» — клиент сам спрашивает о заявке: «напомнил агенту» и пометка", () => {
    const [t] = dialog(ctx(), ["Когда со мной свяжутся?"]);
    expect(t!.keys).toEqual(["lead_status"]);
    expect(t!.d.actions).toContainEqual(expect.objectContaining({ type: "append_note" }));
  });

  it("после хода по делу приветствие в той же переписке — приветствие и «заявка у агента», без пометки и сигнала", () => {
    const turns = dialog(ctx(), ["Хочу продать квартиру", "Салом"], initialOperatorState(), new Date("2026-11-27T05:00:00Z"));
    // Через сутки «заявка у агента» снова можно сказать один раз (state.ts): второй ход — на следующий день.
    const later = dialog(ctx(), ["Салом"], turns[0]!.d.state, new Date("2026-11-28T06:00:00Z"));
    expect(later[0]!.keys).toEqual(["greet", "lead_reminder"]);
    expect(later[0]!.d.actions).toEqual([]);
  });
});

describe("нет напоминания агенту", () => {
  it("ни приветствие, ни «я ничего не говорил» не дают ни пометки, ни сигнала, ни заявки — ни с агентом, ни без", () => {
    for (const agent of [true, false]) {
      const turns = dialog(ctx({ cardAgentActive: agent, ...ARVAN }), ["Ассалому алайкум", "Я ничего не просил", "Какая заявка?", "Кадом дархост?"]);
      for (const t of turns) {
        expect(t.keys.filter(key => LEAD_TALK.has(key)), t.text).toEqual([]);
        expect(touchesPeople(t.d.actions).filter(action => action.type !== "call_staff" || action.reason !== "unclear"), t.text).toEqual([]);
      }
    }
  });

  it("отрицание просьбы в переписке, где заявка правда есть, — приглашение написать и тихая пометка агенту, без «напомнил»", () => {
    const lead: OperatorState = { ...initialOperatorState(), role: "buyer", step: "done", leadAccepted: true, language: "ru", flags: { ...initialOperatorState().flags, leadHere: true } };
    const [t] = dialog(ctx(), ["Я ничего не просил"], lead);
    expect(t!.keys).toEqual(["greet_continue"]);
    expect(t!.d.actions).toEqual([{ type: "append_note", note: "Клиент пишет, что ни о чём не просил: «Я ничего не просил»", phone: null }]);
  });

  it("распознавание отрицания: русское, таджикское, без спецбукв; обычные вопросы о заявке им не считаются", () => {
    const denies = (text: string) => understandFallback({ current: text, recent: [] }, initialOperatorState(), ctx()).deniesRequest;
    for (const text of ["Какой дархост, я же ничего ещё не сказал", "я ничего не просил", "Какая заявка?", "Кадом дархост?",
      "Ман ҳеҷ чиз нагуфтам", "ман хеч чиз нагуфтам", "Я не оставлял никакой заявки"]) expect(denies(text), text).toBe(true);
    for (const text of ["Что с заявкой?", "Когда позвонят?", "Хочу оставить заявку", "Салом", "Дархост додам, кай занг мезанед?"]) {
      expect(denies(text), text).toBe(false);
    }
  });
});

/**
 * ПРИВЕТСТВИЕ ДО ПЕРВОГО СЛОВА (27.11.2026, #488 + эта правка): WhatsApp `request_welcome` отправляет «Ассалому алейкум! Ин Арван…
 * купить или продать?» и кладёт его в переписку с отметкой `botWelcome`. Ядро обязано считать это своим прошлым ходом: на первое
 * «Салом» не здороваться заново и не спрашивать то же самое второй раз.
 */
describe("приветствие бота до первого слова клиента: ядро знает, что уже спросило", () => {
  const welcomeText = "Ассалому алейкум! Ин Арван. Шумо хона харидан мехоҳед ё фурӯхтан?\n\nЗдравствуйте! Это Арван. Подскажите, вы хотите купить жильё или продать?";
  async function afterWelcome(texts: string[], over: Partial<OperatorContext> = ARVAN) {
    let stored: unknown = null;
    const recent: Turn[] = [{ role: "assistant", text: welcomeText }];
    const out = [];
    for (const [index, text] of texts.entries()) {
      const turn = await runOperatorTurn({ storedState: stored, ctx: ctx({ botWelcomed: true, leadExists: false, ...over }),
        now: new Date(Date.UTC(2026, 10, 27, 5, index)), input: { current: text, recent: [...recent] }, model: async () => null });
      stored = turn.stored;
      recent.push({ role: "user", text });
      if (turn.text) recent.push({ role: "assistant", text: turn.text });
      out.push({ keys: turn.steps.map(step => step.key), text: turn.text ?? "", state: turn.state });
    }
    return out;
  }

  it("«Салом» / «Здравствуйте» после приветствия — короткое тёплое приглашение, без повторного «купить или продать?»", async () => {
    for (const hello of ["Салом", "Салом алейкум", "Ассалому алайкум", "Здравствуйте", "Привет", "Добрый день"]) {
      const [t] = await afterWelcome([hello]);
      expect(t!.keys, hello).toEqual(["greet_continue"]);
      expect(t!.text, hello).not.toMatch(/купить|продать|хона мехаред|мефурӯшед|харидан|покупаете|продаёте/iu);
      expect(t!.text, hello).not.toMatch(/[—–]/u);
      expect(t!.text, hello).toMatch(/Нависед|напишите/u);
    }
  });

  it("клиент ответил по делу — обычный путь: роль принята, вопроса о роли нет", async () => {
    const [t] = await afterWelcome(["Хочу купить квартиру"]);
    expect(t!.state.role).toBe("buyer");
    expect(t!.keys).not.toContain("ask_role");
    expect(t!.keys).not.toContain("ask_role_brand");
  });

  it("неясный ответ — вопрос второй раз другими словами (первое слово не повторяется), потом человек, как и без приветствия", async () => {
    const [unclear1, unclear2] = await afterWelcome(["Не знаю", "Ну так"]);
    expect(unclear1!.keys).toEqual(["ask_role"]);
    expect(unclear1!.text).toBe("Подскажите, пожалуйста: вы покупаете или продаёте?");
    expect(unclear2!.state.step).toBe("handoff");
  });

  it("без приветствия в переписке (флага нет) — прежнее поведение: приветствие и вопрос от имени бренда", async () => {
    const turn = await runOperatorTurn({ storedState: null, ctx: ctx({ ...ARVAN, leadExists: false }), now: new Date("2026-11-27T05:00:00Z"),
      input: { current: "Салом", recent: [] }, model: async () => null });
    expect(turn.steps.map(step => step.key)).toEqual(["greet", "ask_role_brand"]);
  });

  it("память уже не чистая (роль известна, что-то говорили) — отметка приветствия её не трогает", () => {
    const known: OperatorState = { ...initialOperatorState(), role: "seller", asked: { role: 1, details: 0, phone: 0 } };
    expect(seedStateFromBotWelcome(known)).toBe(false);
    const spoke: OperatorState = { ...initialOperatorState(), spoken: { greet_continue: 1 } };
    expect(seedStateFromBotWelcome(spoke)).toBe(false);
    expect(seedStateFromBotWelcome(initialOperatorState())).toBe(true);
  });

  it("доставленное приветствие учитывается, не ушедшее (deliveryStatus failed), чужая реплика и пустая лента — нет", () => {
    const ok = { role: "assistant", content: "x", botWelcome: true };
    expect(botWelcomeDelivered([ok])).toBe(true);
    expect(botWelcomeDelivered([{ ...ok, deliveryStatus: "failed" }])).toBe(false);
    expect(botWelcomeDelivered([{ role: "assistant", content: "x" }])).toBe(false);
    expect(botWelcomeDelivered([{ role: "user", content: "x", botWelcome: true }])).toBe(false);
    expect(botWelcomeDelivered([])).toBe(false);
    expect(botWelcomeDelivered(null)).toBe(false);
  });
});
