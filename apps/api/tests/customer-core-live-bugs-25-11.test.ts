import { describe, expect, it } from "vitest";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { operatorCallbackTimeText, operatorPropertyFactsText, renderOperatorReply, renderOperatorStep } from "../src/ai/operator/phrases.js";
import { operatorCallbackTime, understandFallback, understandingFromModel } from "../src/ai/operator/understand.js";
import { withoutOwnRepeats } from "../src/ai/operator/index.js";
import { leadOnlyOutgoing } from "../src/ai/leadOnlyMode.js";
import { hasCallTimePromise } from "../src/ai/callTimePromiseGuard.js";
import { groundedCustomerDmLanguage, resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";
import { adTemplatePhraseCut, withoutAdTemplatePhrases } from "../src/ai/adTemplatePhrase.js";
import type { OperatorContext, OperatorPropertyFocus, OperatorState } from "../src/ai/operator/types.js";

/**
 * Живые ошибки нового ядра бота на проде 25.11.2026 (D:\CRM\.tmp-bot-live-watch\findings.md, пункты 33 и 34) и находки ревью #425.
 * Каждый диалог — дословные реплики клиента, прогон через то же понимание кодом (understandFallback), то же решение (decide), тот же
 * сторож повтора (withoutOwnRepeats, с признаком «спросили цену», как в runOperatorTurn) и ту же последнюю дверь режима
 * (leadOnlyOutgoing), что и прод. Оператор один на WhatsApp, Instagram и Facebook (lib/customerLeadOnlyCore.ts → ai/operator),
 * поэтому каждый живой диалог гоняется во всех трёх каналах.
 */
const PROPERTY_217 = "db7ad6d0-1e59-478d-8a9a-adc02ef53f34";
const PROPERTY_214 = "57f9362f-b852-4fc0-bfc8-5f7c8e4edb91";
const focus217: OperatorPropertyFocus = { propertyId: PROPERTY_217, shortId: 217, priceText: { ru: "235 000 USD", tg: "235 000 USD" }, sold: false,
  place: "Сино, Душанбе", characteristics: null };
const focus214: OperatorPropertyFocus = { propertyId: PROPERTY_214, shortId: 214, priceText: { ru: "890 000 сомони", tg: "890 000 сомонӣ" },
  sold: false, place: "Исмоили Сомони, Душанбе",
  characteristics: { type: "APARTMENT", rooms: 3, areaSqm: "95", landAreaSotka: null, floor: 5, totalFloors: 9, condition: "GOOD",
    marketType: "SECONDARY", stage: null } };

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
type Turn = { role: "user" | "assistant"; text: string };

/** Диалог как на проде: понимание → решение → сторож повтора по прошлым ответам → последняя дверь режима. */
function dialog(c: OperatorContext, texts: string[], start: OperatorState = initialOperatorState(), history: Turn[] = []) {
  let state = start, accepted = false;
  const recent: Turn[] = [...history];
  return texts.map(text => {
    const turnCtx = accepted && !c.leadExists ? { ...c, leadPending: true } : c;
    const u = understandFallback({ current: text, recent: [...recent] }, state, turnCtx);
    const d = decide(state, u, turnCtx);
    withoutOwnRepeats(d, [...recent], [], { priceAsked: u.priceAsked === true });
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
const leadState = (propertyId: string, language: "ru" | "tg"): OperatorState => ({ ...initialOperatorState(), role: "buyer_property", propertyId,
  leadAccepted: true, step: "done", language, flags: { ...initialOperatorState().flags, propertyLineFor: propertyId } });

describe("п.33 IG 39ef4246 (реклама №217): время звонка клиента — агенту и коротким подтверждением, цена второй раз не звучит", () => {
  const LIVE = ["Салом", "Ин хонаро фурухтагиен", "Харидор", "Ҳамин вариант ҳаст", "Акси бурунии ҳамин домро доред", "+992900872422",
    "Пагоҳ ба соатои 13 : 00 занг зананд", "Ҳамин вариантро"];
  for (const { name, over } of CHANNELS) {
    it(`${name}: дословный диалог`, () => {
      const turns = dialog(ctx({ ...over, ad: { topic: "property", propertyId: PROPERTY_217 }, focus: focus217 }), LIVE);
      const byText = (text: string) => turns[LIVE.indexOf(text)]!;
      // Цена объекта звучит в разговоре один раз.
      expect(turns.filter(t => PRICE_217.test(t.text))).toHaveLength(1);
      expect(turns.flatMap(t => t.d.actions).filter(a => a.type === "accept_lead")).toHaveLength(1);
      const time = byText("Пагоҳ ба соатои 13 : 00 занг зананд");
      expect(time.u.callback.time).toEqual({ day: "tomorrow", part: null, relation: "at", clock: "13:00", clockTo: null, confident: true });
      expect(time.keys).toEqual(["callback_time_noted"]);
      expect(time.text).toBe("Вақти дар назар доштаатонро ба агент навиштам: «пагоҳ соати 13:00».");
      // Агенту в карточку — и разобранное время, и слова клиента целиком.
      expect(time.d.actions).toContainEqual({ type: "append_note", phone: null,
        note: "Когда звонить: «завтра в 13:00». Слова клиента: «Пагоҳ ба соатои 13 : 00 занг зананд»" });
      // Своего срока бот не называет: в фразе нет глагола связи, последняя дверь её не трогает.
      expect(hasCallTimePromise(time.text)).toBe(false);
      const again = byText("Ҳамин вариантро");
      expect(again.text).not.toMatch(PRICE_217);
      // «Ҳамин вариантро» — клиент повторил то, что уже в заявке: напоминание «заявка у агента» раз в сутки. В WhatsApp оно уже
      // прозвучало на «Акси бурунии…» (заявка там ушла раньше), поэтому тишина и слова клиента — пометкой агенту.
      if (name === "WHATSAPP") {
        expect(again.keys).toEqual([]);
        expect(again.d.actions).toContainEqual(expect.objectContaining({ type: "append_note", note: "Клиент пишет: «Ҳамин вариантро»" }));
      } else {
        expect(again.keys).toEqual(["lead_reminder"]);
      }
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

  it("ревью #425: прямой «Сколько стоит?» после заявки, цена была в прошлом ответе — отвечаем ценой, не тишиной и не сигналом", () => {
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, leadExists: true, ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const history: Turn[] = [{ role: "user", text: "нарх" }, { role: "assistant", text: "Это объект №214, цена 890 000 сомони." },
      { role: "user", text: "+992900000000" }, { role: "assistant", text: "Спасибо, номер получил, агент вам позвонит." }];
    const [turn] = dialog(c, ["Сколько стоит?"], leadState(PROPERTY_214, "ru"), history);
    expect(turn!.u.priceAsked).toBe(true);
    expect(turn!.d.silent).toBe(false);
    expect(turn!.d.actions.some(a => a.type === "call_staff")).toBe(false);
    expect(turn!.text).toContain("890 000 сомони");
  });

  it("цена объекта после заявки — снова, только если клиент снова спросил цену словами", () => {
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, leadExists: true, ad: { topic: "property", propertyId: PROPERTY_217 }, focus: focus217 });
    const [plain] = dialog(c, ["Ҳамин вариантро"], leadState(PROPERTY_217, "tg"));
    expect(plain!.text).not.toMatch(PRICE_217);
    const [asked] = dialog(c, ["Нархаш чанд буд?"], leadState(PROPERTY_217, "tg"));
    expect(asked!.text).toMatch(PRICE_217);
  });

  it("путь модели: модель не дала времени и пометила ход «цена объекта» — время всё равно агенту и клиенту, цены нет", () => {
    const lead = leadState(PROPERTY_217, "tg");
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, leadPending: true, ad: { topic: "property", propertyId: PROPERTY_217 }, focus: focus217 });
    const raw = { role: "none", roleQuote: "", question: "property_price", aboutThisProperty: true, rooms: "", district: "", budget: "", area: "",
      floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "tg",
      bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" };
    const u = understandingFromModel(raw, { current: "Пагоҳ ба соатои 13 : 00 занг зананд" }, lead, c)!.understanding;
    expect(u.callback.when).toBe("завтра в 13:00");
    const d = decide(lead, u, c);
    expect(d.steps.map(s => s.key)).toEqual(["callback_time_noted"]);
    expect(renderOperatorReply(d.steps, d.language)).toBe("Вақти дар назар доштаатонро ба агент навиштам: «пагоҳ соати 13:00».");
  });
});

describe("время звонка: только явное время, без досчёта часов; вслух — только при уверенном совпадении", () => {
  const cases: Array<[string, string | null, string | null]> = [
    ["Пагоҳ ба соатои 13 : 00 занг зананд", "завтра в 13:00", "пагоҳ соати 13:00"],
    ["Позвоните завтра в 13:00", "завтра в 13:00", "пагоҳ соати 13:00"],
    ["пагоҳ соати 13 занг занед", "завтра в 13", "пагоҳ соати 13"],
    ["Звоните после обеда", "после обеда", "баъд аз нисфирӯзӣ"],
    ["Вечером", "вечером", "бегоҳӣ"],
    ["Утром", "утром", "саҳар"],
    ["бегоҳ занг занед", "вечером", "бегоҳӣ"],
    // Часы не досчитываем: «в 2» остаётся «в 2», агент разберётся с клиентом.
    ["Завтра в 2", "завтра в 2", "пагоҳ соати 2"],
    ["Позвоните вечером в 8", "вечером в 8", "бегоҳӣ соати 8"],
    ["позвоните в 3 часа", "в 3", "соати 3"],
    ["С 11 до 2.30 удобно", "с 11 до 2:30", "аз соати 11 то 2:30"],
    // Ревью #425 (блокер): число рядом с «мкр / микрорайон» и голый час без слова часа, дня или минут — не время.
    ["Хочу купить квартиру в 12 мкр, позвоните", null, null],
    ["Позвоните, ищу в 19 микрорайоне", null, null],
    ["Позвоните в 7", null, null],
    ["позвоните после 15", null, null],
    // Не время звонка: комнаты, этаж, суммы, показ, вопрос без слова о звонке, рассказ, «не звоните», «сам позвоню», голый промежуток.
    ["2 комнаты 5 этаж", null, null],
    ["Завтра в 13:00 можно посмотреть?", null, null],
    ["Завтра приеду", null, null],
    ["Позвоните мне", null, null],
    ["бюджет 13 000 долларов", null, null],
    ["Не звоните завтра", null, null],
    ["Пагоҳ занг назанед", null, null],
    ["Завтра сам позвоню", null, null],
    ["с 11 до 14", null, null],
    ["с 2 до 3 комнаты, позвоните", null, null],
  ];
  for (const [text, ru, tg] of cases) {
    it(`«${text}»`, () => {
      const time = operatorCallbackTime(text);
      expect(operatorCallbackTimeText(time, "ru")).toBe(ru);
      expect(operatorCallbackTimeText(time, "tg")).toBe(tg);
    });
  }

  it("время внутри сообщения о другом — агенту в заметку словами клиента, вслух не повторяем (не уверены)", () => {
    const time = operatorCallbackTime("Хочу купить квартиру, позвоните завтра в 13:00");
    expect(time).toMatchObject({ day: "tomorrow", clock: "13:00", confident: false });
    const [turn] = dialog(ctx(), ["Хочу купить квартиру, позвоните завтра в 13:00"]);
    expect(turn!.keys.at(-1)).toBe("lead_callback");
    expect(turn!.text).not.toMatch(/13:00|завтра/u);
    expect(turn!.d.actions).toContainEqual(expect.objectContaining({ type: "accept_lead", callbackWhen: "завтра в 13:00",
      note: expect.stringContaining("Слова клиента: «Хочу купить квартиру, позвоните завтра в 13:00»") }));
  });

  it("сообщение — целиком пожелание времени, заявка в этот же ход (WhatsApp, роль уже названа): «передаю агенту и удобное вам время: «…»»", () => {
    const buyer: OperatorState = { ...initialOperatorState(), role: "buyer", language: "ru", asked: { role: 0, details: 1, phone: 0 } };
    const [turn] = dialog(ctx(), ["Позвоните завтра в 13:00"], buyer);
    expect(turn!.keys.at(-1)).toBe("lead_callback_time");
    expect(turn!.text).toContain("«завтра в 13:00»");
  });

  it("подтверждение времени и заявка со временем проходят последнюю дверь целиком (сторож срока их не режет: это слова клиента)", () => {
    for (const key of ["callback_time_noted", "lead_callback_time"] as const) {
      for (const language of ["ru", "tg"] as const) {
        for (const variant of [0, 1]) {
          const wish = language === "tg" ? "пагоҳ соати 13:00" : "завтра в 13:00";
          const text = renderOperatorStep({ key, vars: { wish }, variant }, language);
          expect(leadOnlyOutgoing(text, language), `${key}/${language}/${variant}`).toBe(text);
          expect(text).toContain(`«${wish}»`);
          // Без глагола связи рядом со временем: это не наше обещание «позвонит завтра».
          expect(text).not.toMatch(/позвон|свяж|занг|тамос/iu);
        }
      }
    }
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
      // «Конкретней»: факты карточки; адрес — только район и город, ориентира нет; «скажет агент» — нет; язык прежний.
      expect(second!.d.language).toBe("tg");
      expect(second!.keys[0]).toBe("property_details");
      expect(second!.text).toBe("Объекти №214: ҳуҷраҳо: 3, масоҳат: 95 м², ошёна: 5 аз 9, ҳолат: ҳолати хуб.");
      expect(second!.text).not.toMatch(/агент(?:и мо)? мегӯяд|скажет агент|мӯлҷал|ориентир/iu);
      // Из одного «конкретней» после фактов заявку не заводим (находка 34: «сразу увод и заявка»).
      expect(second!.d.actions.filter(a => a.type === "accept_lead")).toHaveLength(0);
    });
  }

  it("сообщения по одному: шаблон, потом «нарх», «хона», «сурога» — ответ по-таджикски, «сурога» после заявки — место с сайта", () => {
    const c = ctx({ ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const turns = dialog(c, [META, "нарх", "хона", "сурога"]);
    expect(turns.filter(t => t.text).at(-1)!.d.language).toBe("tg");
    expect(turns.slice(1).some(t => /890 000 сомонӣ/u.test(t.text))).toBe(true);
    expect(turns.at(-1)!.text).toBe("Объекти №214 дар ноҳияи Исмоили Сомони, Душанбе ҷойгир аст.");
  });

  it("ответ модели «ru» на пачку с шаблоном не перебивает таджикские слова клиента", () => {
    const c = ctx({ ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const raw = { role: "buyer", roleQuote: "", question: "property_price", aboutThisProperty: true, rooms: "", district: "", budget: "", area: "",
      floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "ru",
      bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" };
    const checked = understandingFromModel(raw, { current: `${META}\nнарх\nхона\nсурога` }, initialOperatorState(), c);
    expect(checked!.understanding.language).toBe("tg");
  });

  it("ревью #425: без шаблона язык модели не теряется из-за двойного пробела или « \\n» (явный признак «шаблон вырезан»)", () => {
    const c = ctx({ ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const raw = { role: "buyer", roleQuote: "", question: "property_price", aboutThisProperty: true, rooms: "", district: "", budget: "", area: "",
      floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "ru",
      bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" };
    for (const current of ["Skolko stoit  kvartira v Sino?", "Skolko stoit \nkvartira v Sino?"]) {
      expect(adTemplatePhraseCut(current).cut, current).toBe(false);
      expect(understandingFromModel(raw, { current }, initialOperatorState(), c)!.understanding.language, current).toBe("ru");
    }
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
    expect(rooms!.u.priceAsked).toBe(false);
    expect(rooms!.text).toMatch(/^Объект №214: комнат: 3\./u);
    const bare = ctx({ ad: { topic: "property", propertyId: PROPERTY_214 }, focus: { ...focus214, characteristics: null } });
    const [nothing] = dialog(bare, ["конкретней"], seen);
    expect(nothing!.keys[0]).toBe("details_by_agent");
  });

  it("строки объекта ещё не было: «подробнее» — факты вместе с номером и ценой одной фразой", () => {
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const [turn] = dialog(c, ["Расскажите конкретнее про квартиру"]);
    expect(turn!.keys[0]).toBe("property_details_price");
    expect(turn!.text).toContain("цена 890 000 сомони");
    expect(turn!.d.state.flags.propertyLineFor).toBe(PROPERTY_214);
  });

  it("ревью #425: свой запрос со словом «конкретно» — не просьба о фактах объекта; «есть 3 комнатные?» — факт объекта и «подберёт другие»", () => {
    const c = ctx({ channel: "INSTAGRAM", phoneKnown: false, ad: { topic: "property", propertyId: PROPERTY_214 }, focus: focus214 });
    const [own] = dialog(c, ["мне нужна конкретно 3-комнатная в Сино"]);
    expect(own!.u.propertyFacts).not.toBe("all");
    expect(own!.keys.some(key => key.startsWith("property_details"))).toBe(false);
    const [search] = dialog(c, ["У вас есть 3 комнатные?"]);
    expect(search!.u.propertyFacts).toBe("search");
    expect(search!.keys[0]).toBe("property_details_other");
    expect(search!.text).toMatch(/^У объекта №214 комнат: 3, другие варианты подберёт агент\./u);
    // Цену не называли — объект «названным» не помечен.
    expect(search!.d.state.flags.propertyLineFor).toBeNull();
  });

  it("цена — по словам о цене, а не по «сколько / чанд» вообще", () => {
    const fb = (text: string) => understandFallback({ current: text }, initialOperatorState(), ctx({ focus: focus214 }));
    expect(fb("Сколько стоит?").priceAsked).toBe(true);
    expect(fb("нархаш чанд").priceAsked).toBe(true);
    expect(fb("Сколько комнат?").priceAsked).toBe(false);
    expect(fb("чанд ошёна?").priceAsked).toBe(false);
  });

  it("факты карточки — без адреса: место только районом и городом отдельной фразой; посреди строки с маленькой буквы", () => {
    expect(operatorPropertyFactsText({ characteristics: null }, "ru")).toBeNull();
    const text = operatorPropertyFactsText({ characteristics: { type: "APARTMENT", rooms: null, areaSqm: null, landAreaSotka: null, floor: null,
      totalFloors: null, condition: "NEW_BUILDING", marketType: "NEW", stage: "UNDER_CONSTRUCTION" } }, "ru");
    expect(text).toMatch(/^состояние: [а-яё]/u);
  });
});
