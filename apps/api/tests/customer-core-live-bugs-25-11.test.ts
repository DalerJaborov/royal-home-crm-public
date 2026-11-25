import { describe, expect, it } from "vitest";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { operatorCallbackTimeText, operatorPropertyFactsText, operatorSafeLandmark, renderOperatorReply, renderOperatorStep } from "../src/ai/operator/phrases.js";
import { operatorCallbackTime, understandFallback, understandingFromModel } from "../src/ai/operator/understand.js";
import { withoutOwnRepeats } from "../src/ai/operator/index.js";
import { leadOnlyOutgoing } from "../src/ai/leadOnlyMode.js";
import { hasCallTimePromise } from "../src/ai/callTimePromiseGuard.js";
import { groundedCustomerDmLanguage, resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";
import { withoutAdTemplatePhrases } from "../src/ai/adTemplatePhrase.js";
import type { OperatorContext, OperatorPropertyFocus, OperatorState } from "../src/ai/operator/types.js";

/**
 * Живые ошибки нового ядра бота на проде 25.11.2026 (D:\CRM\.tmp-bot-live-watch\findings.md, пункты 33 и 34). Каждый диалог —
 * дословные реплики клиента, прогон через то же понимание кодом (understandFallback), то же решение (decide), тот же сторож повтора
 * (withoutOwnRepeats) и ту же последнюю дверь режима (leadOnlyOutgoing), что и прод. Оператор один на WhatsApp, Instagram и
 * Facebook (lib/customerLeadOnlyCore.ts → ai/operator), поэтому каждый случай гоняется во всех трёх каналах.
 */
const PROPERTY_217 = "db7ad6d0-1e59-478d-8a9a-adc02ef53f34";
const PROPERTY_214 = "57f9362f-b852-4fc0-bfc8-5f7c8e4edb91";
const focus217: OperatorPropertyFocus = { propertyId: PROPERTY_217, shortId: 217, priceText: { ru: "235 000 USD", tg: "235 000 USD" }, sold: false,
  place: "Сино, Душанбе", characteristics: null, landmark: null };
const focus214: OperatorPropertyFocus = { propertyId: PROPERTY_214, shortId: 214, priceText: { ru: "890 000 сомони", tg: "890 000 сомонӣ" },
  sold: false, place: "Исмоили Сомони, Душанбе",
  characteristics: { type: "APARTMENT", rooms: 3, areaSqm: "95", landAreaSotka: null, floor: 5, totalFloors: 9, condition: "GOOD",
    marketType: "SECONDARY", stage: null },
  landmark: "рядом с ТЦ Садбарг" };

const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "WHATSAPP", phoneKnown: true, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "сегодня после 10:00", tg: "имрӯз баъд аз соати 10:00" }, recruiterPath: true, ad: { topic: null, propertyId: null },
  focus: null, callbackWhen: { ru: "завтра с 10:00", tg: "пагоҳ аз соати 10:00" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});
const CHANNELS = [
  { name: "INSTAGRAM", over: { channel: "INSTAGRAM" as const, phoneKnown: false } },
  { name: "FACEBOOK", over: { channel: "FACEBOOK" as const, phoneKnown: false } },
  { name: "WHATSAPP", over: { channel: "WHATSAPP" as const, phoneKnown: true } },
];

/** Диалог как на проде: понимание → решение → сторож повтора по прошлым ответам → последняя дверь режима. */
function dialog(c: OperatorContext, texts: string[], start: OperatorState = initialOperatorState()) {
  let state = start, accepted = false;
  const recent: Array<{ role: "user" | "assistant"; text: string }> = [];
  return texts.map(text => {
    const turnCtx = accepted && !c.leadExists ? { ...c, leadPending: true } : c;
    const u = understandFallback({ current: text, recent: [...recent] }, state, turnCtx);
    const d = decide(state, u, turnCtx);
    withoutOwnRepeats(d, [...recent]);
    state = d.state;
    if (d.actions.some(a => a.type === "accept_lead")) accepted = true;
    // Тишина — без текста (на проде ответ null; последняя дверь на пустую строку подставила бы своё «спасибо»).
    const out = d.steps.length ? leadOnlyOutgoing(renderOperatorReply(d.steps, d.language), d.language) : "";
    recent.push({ role: "user", text });
    if (out) recent.push({ role: "assistant", text: out });
    return { u, d, keys: d.steps.map(s => s.key), text: out };
  });
}
const PRICE_217 = /235\s?000/u;

describe("п.33 IG 39ef4246 (реклама №217): время звонка клиента — агенту и коротким подтверждением, цена второй раз не звучит", () => {
  const LIVE = ["Салом", "Ин хонаро фурухтагиен", "Харидор", "Ҳамин вариант ҳаст", "Акси бурунии ҳамин домро доред", "+992900872422",
    "Пагоҳ ба соатои 13 : 00 занг зананд", "Ҳамин вариантро"];
  for (const { name, over } of CHANNELS) {
    it(`${name}: дословный диалог`, () => {
      const turns = dialog(ctx({ ...over, ad: { topic: "property", propertyId: PROPERTY_217 }, focus: focus217 }), LIVE);
      const byText = (text: string) => turns[LIVE.indexOf(text)]!;
      // Цена объекта звучит в разговоре один раз.
      expect(turns.filter(t => PRICE_217.test(t.text))).toHaveLength(1);
      // Номер (или WhatsApp) — заявка.
      expect(turns.flatMap(t => t.d.actions).filter(a => a.type === "accept_lead")).toHaveLength(1);
      const time = byText("Пагоҳ ба соатои 13 : 00 занг зананд");
      expect(time.u.callback.time).toEqual({ day: "tomorrow", part: null, relation: "at", clock: "13:00", clockTo: null });
      expect(time.keys).toEqual(["callback_time_noted"]);
      expect(time.text).toBe("Вақти мувофиқи шуморо ба агент расондам: пагоҳ соати 13:00.");
      expect(time.text).not.toMatch(PRICE_217);
      // Пожелание клиента — агенту в карточку (пометка заявки), его же словами.
      expect(time.d.actions).toContainEqual(expect.objectContaining({ type: "append_note",
        note: expect.stringContaining("Когда звонить: «завтра в 13:00»") }));
      // Своего срока бот не называет: последняя дверь фразу не трогает, а в ней нет глагола связи.
      expect(hasCallTimePromise(time.text)).toBe(false);
      const again = byText("Ҳамин вариантро");
      expect(again.text).not.toMatch(PRICE_217);
      // Ответ — без цены (в WhatsApp, где напоминание «заявка у агента» уже звучало, — тишина и пометка агенту).
      expect(again.d.actions.some(a => a.type === "append_note") || again.text !== "").toBe(true);
      expect(again.keys.some(key => key.startsWith("property_"))).toBe(false);
    });
  }

  it("сторож повтора: тот же факт другим вариантом — повтор (прежде «Нархи объекти №217 235 000 USD аст.», следом «Ин объекти №217, нархаш…»)", () => {
    const decision = { steps: [{ key: "property_price" as const, vars: { id: 217, price: "235 000 USD" }, variant: 0 }], language: "tg" as const,
      actions: [], silent: false };
    withoutOwnRepeats(decision, [{ role: "user", text: "Пагоҳ ба соатои 13 : 00 занг зананд" },
      { role: "assistant", text: "Нархи объекти №217 235 000 USD аст." }, { role: "user", text: "Ҳамин вариантро" }]);
    expect(decision.steps).toEqual([]);
    expect(decision.silent).toBe(true);
    // Та же цена под другим ключом (место с ценой) — тоже повтор.
    const place = { steps: [{ key: "property_price" as const, vars: { id: 214, price: "890 000 сомони" }, variant: 1 }], language: "ru" as const,
      actions: [], silent: false };
    withoutOwnRepeats(place, [{ role: "assistant", text: "Объект №214 в районе Исмоили Сомони, Душанбе, цена 890 000 сомони." }]);
    expect(place.steps).toEqual([]);
  });

  it("путь модели: модель не дала времени и пометила ход «цена объекта» — время всё равно агенту и клиенту, цены нет", () => {
    const lead: OperatorState = { ...initialOperatorState(), role: "buyer_property", propertyId: PROPERTY_217, leadAccepted: true, step: "done",
      language: "tg", flags: { ...initialOperatorState().flags, propertyLineFor: PROPERTY_217 } };
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, leadPending: true, ad: { topic: "property", propertyId: PROPERTY_217 }, focus: focus217 });
    const raw = { role: "none", roleQuote: "", question: "property_price", aboutThisProperty: true, rooms: "", district: "", budget: "", area: "",
      floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "tg",
      bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" };
    const u = understandingFromModel(raw, { current: "Пагоҳ ба соатои 13 : 00 занг зананд" }, lead, c)!.understanding;
    expect(u.callback.when).toBe("завтра в 13:00");
    const d = decide(lead, u, c);
    expect(d.steps.map(s => s.key)).toEqual(["callback_time_noted"]);
    expect(renderOperatorReply(d.steps, d.language)).toBe("Вақти мувофиқи шуморо ба агент расондам: пагоҳ соати 13:00.");
  });

  it("цена объекта после заявки — снова, только если клиент снова спросил цену словами", () => {
    const lead: OperatorState = { ...initialOperatorState(), role: "buyer_property", propertyId: PROPERTY_217, leadAccepted: true, step: "done",
      language: "tg", flags: { ...initialOperatorState().flags, propertyLineFor: PROPERTY_217 } };
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, leadExists: true, ad: { topic: "property", propertyId: PROPERTY_217 }, focus: focus217 });
    const [plain] = dialog(c, ["Ҳамин вариантро"], lead);
    expect(plain!.text).not.toMatch(PRICE_217);
    const [asked] = dialog(c, ["Нархаш чанд буд?"], lead);
    expect(asked!.text).toMatch(PRICE_217);
  });
});

describe("время звонка: разбор кодом (рус./тадж.) и ответ без своего срока", () => {
  const cases: Array<[string, string | null, string | null]> = [
    ["Пагоҳ ба соатои 13 : 00 занг зананд", "завтра в 13:00", "пагоҳ соати 13:00"],
    ["Позвоните завтра в 13:00", "завтра в 13:00", "пагоҳ соати 13:00"],
    ["пагоҳ соати 13 занг занед", "завтра в 13:00", "пагоҳ соати 13:00"],
    ["Звоните после обеда", "после обеда", "баъд аз нисфирӯзӣ"],
    ["Вечером", "вечером", "бегоҳӣ"],
    ["бегоҳ занг занед", "вечером", "бегоҳӣ"],
    ["Завтра в 2", "завтра в 14:00", "пагоҳ соати 14:00"],
    ["позвоните после 15", "после 15:00", "баъд аз соати 15:00"],
    ["С 11 до 2.30 удобно", "с 11:00 до 14:30", "аз соати 11:00 то 14:30"],
    // Не время звонка: комнаты, этаж, суммы, показ, вопрос без слова о звонке, рассказ без слов о времени.
    ["2 комнаты 5 этаж", null, null],
    ["Завтра в 13:00 можно посмотреть?", null, null],
    ["Завтра приеду", null, null],
    ["Позвоните мне", null, null],
    ["бюджет 13 000 долларов", null, null],
    ["Не звоните завтра", null, null],
    ["Пагоҳ занг назанед", null, null],
    ["Завтра сам позвоню", null, null],
    ["с 11 до 14", null, null],
    ["Позвоните вечером в 8", "вечером в 20:00", "бегоҳӣ соати 20:00"],
  ];
  for (const [text, ru, tg] of cases) {
    it(`«${text}»`, () => {
      const time = operatorCallbackTime(text);
      expect(operatorCallbackTimeText(time, "ru")).toBe(ru);
      expect(operatorCallbackTimeText(time, "tg")).toBe(tg);
    });
  }

  it("подтверждение времени и заявка со временем проходят последнюю дверь целиком (сторож срока их не режет: это слова клиента)", () => {
    for (const key of ["callback_time_noted", "lead_callback_time"] as const) {
      for (const language of ["ru", "tg"] as const) {
        for (const variant of [0, 1]) {
          const wish = language === "tg" ? "пагоҳ соати 13:00" : "завтра в 13:00";
          const text = renderOperatorStep({ key, vars: { wish }, variant }, language);
          expect(leadOnlyOutgoing(text, language), `${key}/${language}/${variant}`).toBe(text);
          expect(text).toContain(wish);
          // Без глагола связи рядом со временем: это не наше обещание «позвонит завтра».
          expect(text).not.toMatch(/позвон|свяж|занг|тамос/iu);
        }
      }
    }
  });

  it("время в первом же сообщении в WhatsApp (роль и время): заявка и «передаю агенту и удобное вам время: …»", () => {
    const [turn] = dialog(ctx(), ["Хочу купить квартиру, позвоните завтра в 13:00"]);
    expect(turn!.keys.at(-1)).toBe("lead_callback_time");
    expect(turn!.text).toContain("завтра в 13:00");
    expect(turn!.d.actions).toContainEqual(expect.objectContaining({ type: "accept_lead", callbackWhen: "завтра в 13:00" }));
  });

  it("время без разбора кодом (только слова модели) вслух не повторяем: прежняя фраза, время — в заметке", () => {
    const lead: OperatorState = { ...initialOperatorState(), role: "buyer", leadAccepted: true, step: "done", language: "ru" };
    const u = { ...understandFallback({ current: "как договоримся" }, lead, ctx({ leadExists: true })),
      callback: { when: "завтра днём", textOnly: false, noCall: false, time: null } };
    const d = decide(lead, u, ctx({ leadExists: true }));
    expect(d.steps.map(s => s.key)).toEqual(["callback_noted"]);
  });
});

describe("п.34 WA 71b59168 (реклама №214): шаблон Meta не решает язык, «конкретней» — факты карточки", () => {
  const META = "Какие услуги вы предлагаете?";
  for (const { name, over } of CHANNELS) {
    it(`${name}: одно сообщение-пачка «шаблон + нарх / хона / сурога», потом «конкретней»`, () => {
      const c = ctx({ ...over, ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
      const [first, second] = dialog(c, [`${META}\nнарх\nхона\nсурога`, "конкретней"]);
      expect(first!.d.language).toBe("tg");
      expect(first!.text).toContain("Объекти №214 дар ноҳияи Исмоили Сомони, Душанбе");
      expect(first!.text).toContain("890 000 сомонӣ");
      // «Конкретней»: известные факты карточки, без номера дома; «скажет агент» — нет, язык прежний.
      expect(second!.d.language).toBe("tg");
      expect(second!.keys[0]).toBe("property_details");
      expect(second!.text).toMatch(/^Объекти №214: ҳуҷраҳо: 3, масоҳат: 95 м², ошёна: 5 аз 9, ҳолат: /u);
      expect(second!.text).toContain("мӯлҷал: рядом с ТЦ Садбарг");
      expect(second!.text).not.toMatch(/агент(?:и мо)? мегӯяд|скажет агент/iu);
      // Из одного «конкретней» после фактов заявку не заводим (находка 34: «сразу увод и заявка»).
      expect(second!.d.actions.filter(a => a.type === "accept_lead")).toHaveLength(0);
    });
  }

  it("сообщения по одному: шаблон, потом «нарх», «хона», «сурога» — ответ по-таджикски", () => {
    const c = ctx({ ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const turns = dialog(c, [META, "нарх", "хона", "сурога"]);
    const answered = turns.filter(t => t.text);
    expect(answered.at(-1)!.d.language).toBe("tg");
    expect(turns.slice(1).some(t => /890 000 сомонӣ/u.test(t.text))).toBe(true);
    // «Сурога» после заявки — место с сайта, а не «передал ваш вопрос».
    expect(turns.at(-1)!.text).toContain("Объекти №214 дар ноҳияи Исмоили Сомони, Душанбе");
  });

  it("ответ модели «ru» на пачку с шаблоном не перебивает таджикские слова клиента", () => {
    const c = ctx({ ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const raw = { role: "buyer", roleQuote: "", question: "property_price", aboutThisProperty: true, rooms: "", district: "", budget: "", area: "",
      floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "ru",
      bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" };
    const checked = understandingFromModel(raw, { current: `${META}\nнарх\nхона\nсурога` }, initialOperatorState(), c);
    expect(checked!.understanding.language).toBe("tg");
  });

  it("класс во всём ядре: язык диалога в ядре тоже по словам клиента, а не по шаблону", () => {
    expect(withoutAdTemplatePhrases(`${META}\nнарх\nхона\nсурога`)).toBe("нарх\nхона\nсурога");
    expect(withoutAdTemplatePhrases(META)).toBe("");
    expect(withoutAdTemplatePhrases("Привет! Можно узнать об этом подробнее? Нархаш чанд?")).toBe("Привет! Нархаш чанд?");
    expect(resolveCustomerDmLanguage(`${META}\nнарх\nхона\nсурога`)).toBe("tg");
    expect(groundedCustomerDmLanguage(`${META}\nнархаш чанд, хона дар кучо`)).toBe("tg");
    // Одна кнопка — прежний путь, язык не ломается.
    expect(resolveCustomerDmLanguage(META)).toBe("ru");
  });

  it("«скажет агент» — только для факта, которого нет в карточке; названная характеристика — только она", () => {
    const c = ctx({ ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const seen: OperatorState = { ...initialOperatorState(), role: "buyer_property", propertyId: PROPERTY_214, language: "ru", step: "contact",
      spoken: { offer_call: 1 }, flags: { ...initialOperatorState().flags, propertyLineFor: PROPERTY_214 } };
    const [rooms] = dialog(c, ["Сколько комнат?"], seen);
    expect(rooms!.text).toMatch(/^Объект №214: комнат: 3\./u);
    const bare = ctx({ ad: { topic: "property", propertyId: PROPERTY_214 }, focus: { ...focus214, characteristics: null, landmark: null } });
    const [nothing] = dialog(bare, ["конкретней"], seen);
    expect(nothing!.keys[0]).toBe("details_by_agent");
  });

  it("строки объекта ещё не было: «подробнее» — факты вместе с номером и ценой одной фразой", () => {
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const [turn] = dialog(c, ["Расскажите конкретнее про квартиру"]);
    expect(turn!.keys[0]).toBe("property_details_price");
    expect(turn!.text).toContain("цена 890 000 сомони");
  });

  it("ориентир клиенту — только короткой фразой без цифр (номер дома, «82 мкр» — у агента)", () => {
    expect(operatorSafeLandmark("рядом с ТЦ Садбарг")).toBe("рядом с ТЦ Садбарг");
    expect(operatorSafeLandmark("ул. Рудаки 45, дом 12")).toBeNull();
    expect(operatorSafeLandmark("82 мкр")).toBeNull();
    expect(operatorPropertyFactsText({ characteristics: null, landmark: "за Овиром" }, "ru")).toBe("ориентир: за Овиром");
    expect(operatorPropertyFactsText({ characteristics: null, landmark: null }, "ru")).toBeNull();
  });
});
