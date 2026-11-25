/**
 * СЛЕПОЕ РЕВЬЮ #345 (21.11.2026): классы, найденные ревьюером без контекста автора, — многоходовые случаи и спор модели с кодом.
 *  1. продавец с вопросом о цене / комиссии на рекламе «для собственников» в WhatsApp становился покупателем;
 *  2. покупатель с вопросом о статусе объекта («фурӯхта шуд?», «бо савдо?») становился продавцом; слабая догадка кода
 *     перебивала модель — теперь поверх модели только сильные слова, при споре вопрос «купить или продать?»;
 *  3. цепочка вопросов на рекламе объекта (цена → место → этаж → документы → ремонт) шла без номера, заявки и сигнала;
 *  4. «хона харидор / реклама / иҷора даркор» читались покупателем;
 *  5. «Да нет, пока не надо» после предложения звонка считалось согласием;
 *  7. явная роль без номера: тёплый ответ и один вопрос по делу, номер — следующим ходом; в WhatsApp заявка сразу;
 *  8. продавцу номер — «оценит и обсудит»; место объекта — район и город с сайта, «Рудаки» вслух не называем.
 * Без модели и без базы: понимание — запасные правила (или подставленный ответ модели), решение — чистая функция.
 */
import { describe, expect, it, vi } from "vitest";

// Счётчик сторожей пишет в базу «в отрыве» (ai/guardMetrics.ts::guardFired): без базы запись падает ПОСЛЕ конца теста, и её лог
// застаёт закрытый канал воркера («Closing rpc while onUserConsoleLog was pending», третий круг ревью #345). Экзамен роли счётчик
// не проверяет — подменяем только его.
vi.mock("../src/ai/guardMetrics.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/guardMetrics.js")>()), guardFired: vi.fn() }));
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { understandFallback, understandingFromModel } from "../src/ai/operator/understand.js";
import { renderOperatorReply } from "../src/ai/operator/phrases.js";
import type { OperatorContext, OperatorState } from "../src/ai/operator/types.js";

const PROPERTY_ID = "5b7c1a2e-4d3f-4e6a-9b8c-0d1e2f3a4b5c";
const focus = { propertyId: PROPERTY_ID, shortId: 205, priceText: { ru: "520 000 сомони", tg: "520 000 сомонӣ" }, sold: false, place: "Сино, Душанбе" };
const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "INSTAGRAM", phoneKnown: false, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: true, ad: { topic: null, propertyId: null }, focus: null,
  callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});
const IG_AD = () => ctx({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus });
const WA_AD = () => ctx({ channel: "WHATSAPP", phoneKnown: true, ad: { topic: "property", propertyId: PROPERTY_ID }, focus });
const WA_OWNERS = () => ctx({ channel: "WHATSAPP", phoneKnown: true, ad: { topic: "seller", propertyId: null } });
const PHONE_ASK = (key: string) => key === "ask_phone" || key === "ask_phone_seller";

/** Диалог: заявка, однажды принятая, остаётся «в очереди» (иначе память сбросит её как удалённую карточку). */
function dialog(c: OperatorContext, texts: string[]) {
  let state: OperatorState = initialOperatorState();
  let accepted = false;
  return texts.map(text => {
    const turnCtx = accepted ? { ...c, leadPending: true } : c;
    const u = understandFallback({ current: text }, state, turnCtx);
    const d = decide(state, u, turnCtx);
    state = d.state;
    if (d.actions.some(action => action.type === "accept_lead")) accepted = true;
    return { u, d, keys: d.steps.map(step => step.key), text: renderOperatorReply(d.steps, d.language) };
  });
}
const leadsOf = (turns: ReturnType<typeof dialog>) => turns.flatMap(t => t.d.actions.filter(action => action.type === "accept_lead"));

describe("1. продавец с вопросом о своём — продавец (реклама «для собственников», WhatsApp)", () => {
  it.each([
    "Хонаи худамро мефурушам, комиссия чанд пул аст",
    "Хонаамро мефурушам, нархаш чанд мешавад?",
    "Хона дорам фурушам, дихед нархашро гуед",
    "Хонаамро мефурушам, офисатон кучост?",
  ])("«%s» → продавец: сначала вопрос по сути, заявка продавца следующим ходом (владелец 22.11.2026)", text => {
    const [t, next] = dialog(WA_OWNERS(), [text, "Сино, 2 хона"]);
    expect(t!.d.state.role).toBe("seller");
    expect(leadsOf([t!])).toEqual([]);
    expect(leadsOf([next!])).toMatchObject([{ type: "accept_lead", role: "seller" }]);
  });
});

describe("2. покупатель о статусе объекта и торге — не продавец; спор модели и слабого кода — вопрос о роли", () => {
  it.each(["Ин хона фурухта шуд?", "Хона фурухта мешавад?", "Хонаатон фурухта шуд?", "бо савдо мешавад?", "нархаш бо савдо"])(
    "«%s» на рекламе объекта: не продавец, комиссии нет", text => {
      for (const c of [IG_AD(), WA_AD()]) {
        const [t] = dialog(c, [text]);
        expect(t!.d.state.role, text).not.toBe("seller");
        expect(t!.text, text).not.toMatch(/2%|комисси/iu);
        expect(leadsOf([t!]).filter(lead => lead.type === "accept_lead" && lead.role === "seller"), text).toEqual([]);
      }
    });

  const answer = (over: Record<string, unknown>) => ({ role: "none", roleQuote: "", question: "none", aboutThisProperty: false,
    rooms: "", district: "", budget: "", area: "", floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "",
    textOnly: false, noCall: false, language: "tg", bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false,
    jobPosition: "", outsidePlace: "", ...over });

  it("сильные слова кода — поверх модели: «мефурӯшам, нархаш чанд?» продавец, даже если модель сказала «покупатель»", () => {
    const text = "Хонаамро мефурушам, нархаш чанд мешавад?";
    const got = understandingFromModel(answer({ role: "buyer", roleQuote: "нархаш чанд" }), { current: text }, initialOperatorState(), WA_OWNERS())!;
    expect(got.understanding.role).toBe("seller");
    expect(got.rejected).toContain("role");
  });

  it("слабая находка кода против модели — роль не ставим, бот спрашивает «купить или продать?», заявки нет даже в WhatsApp", () => {
    // Код: «нархаш чанд» — слабый покупатель; модель: продавец. Ни одна сторона не доказана сильными словами.
    const text = "Хонаи 3 хучрага, нархаш чанд мешавад?";
    const got = understandingFromModel(answer({ role: "seller", roleQuote: "Хонаи 3 хучрага" }), { current: text }, initialOperatorState(), WA_OWNERS())!;
    expect(got.understanding.role).toBeNull();
    expect(got.understanding.roleConflict).toBe(true);
    const d = decide(initialOperatorState(), got.understanding, WA_OWNERS());
    expect(d.steps.map(step => step.key)).toContain("ask_role");
    expect(d.actions.filter(action => action.type === "accept_lead")).toEqual([]);
  });

  it("модель молчит — слабая находка кода остаётся подсказкой", () => {
    const got = understandingFromModel(answer({}), { current: "Ин хона фурухта шуд?" }, initialOperatorState(), IG_AD())!;
    expect(got.understanding.role).toBe("buyer");
  });
});

describe("3. цепочка вопросов на рекламе объекта — второй вопрос после предложения звонка = интерес", () => {
  const QUESTIONS = ["Салом нархаш чанд?", "Кучост?", "Этажаш чандум?", "Документаш тайёр?", "Ремонт дорад?"];

  it("Instagram: цена и предложение звонка; на второй вопрос — ответ и номер с объяснением; не больше двух просьб; потом номер офиса", () => {
    const turns = dialog(IG_AD(), QUESTIONS);
    expect(turns[0]!.keys).toEqual(["greet", "property_price", "offer_call"]);
    expect(turns[1]!.keys).toEqual(["property_place_price", "ask_phone"]);
    expect(turns[1]!.text).toMatch(/агент занг зада|агент худаш занг мезанад/u);
    expect(turns.filter(t => t.keys.some(PHONE_ASK))).toHaveLength(2);
    // Ни одного хода «скажет агент» без пути к агенту: номер просили, а в конце — номер офиса.
    expect(turns.at(-1)!.keys).toContain("office_phone");
    for (const t of turns) expect(t.keys.filter(key => key !== "greet")).not.toEqual(["ask_phone"]);
  });

  it("WhatsApp (номер известен): заявка на втором вопросе, вслух номер не просим", () => {
    const turns = dialog(WA_AD(), QUESTIONS);
    expect(leadsOf(turns.slice(0, 1))).toEqual([]);
    expect(leadsOf(turns.slice(1, 2))).toMatchObject([{ type: "accept_lead", role: "buyer", propertyId: PROPERTY_ID }]);
    expect(leadsOf(turns)).toHaveLength(1);
    expect(turns.map(t => t.text).join(" ")).not.toMatch(/рақами телефон|номер телефона/iu);
  });
});

describe("4. «… даркор»: покупатель только когда нужно жильё", () => {
  it("«Хона харидор даркор» — продавец; «Хона реклама даркор» — не покупатель; «хона иҷора даркор» — аренда, отказ", () => {
    expect(dialog(ctx(), ["Хона харидор даркор"])[0]!.d.state.role).toBe("seller");
    expect(dialog(ctx(), ["Хона реклама даркор"])[0]!.d.state.role).not.toBe("buyer");
    const rent = dialog(WA_OWNERS(), ["хона ичора даркор"])[0]!;
    expect(rent.keys).toEqual(["rent_refusal"]);
    expect(leadsOf([rent])).toEqual([]);
    expect(dialog(ctx(), ["Да ма 2хонага даркор"])[0]!.d.state.role).toBe("buyer");
  });
});

describe("5. отказ после предложения звонка — номер не просим", () => {
  it.each(["Да нет, пока не надо", "нет, просто узнать", "Холо не, рахмат", "лозим нест"])("«%s» → «пишите, когда удобно», без номера", text => {
    const turns = dialog(IG_AD(), ["Нархаш чанд?", text]);
    expect(turns[1]!.keys.some(PHONE_ASK), text).toBe(false);
    expect(turns[1]!.u.agrees, text).toBe(false);
    expect(leadsOf(turns)).toEqual([]);
  });
  it("после отказа новый вопрос по делу — снова интерес: ответ и номер", () => {
    const turns = dialog(IG_AD(), ["Нархаш чанд?", "Да нет, пока не надо", "Кучост?"]);
    expect(turns[1]!.keys).toEqual(["no_call_ack"]);
    expect(turns[2]!.keys).toEqual(["property_place_price", "ask_phone"]);
  });
  it("вопрос, начинающийся с «на / не / нет», — не отказ, а интерес: «На каком этаже?», «Нет, а где он?»", () => {
    for (const text of ["На каком этаже?", "Не далеко от центра?", "Нет, а где он находится?"]) {
      const turns = dialog(IG_AD(), ["Нархаш чанд?", text]);
      expect(turns[1]!.u.declines, text).toBe(false);
      expect(turns[1]!.keys.some(PHONE_ASK), text).toBe(true);
    }
  });
  it("«Интересует эта квартира» в WhatsApp — роль словами, заявка сразу", () => {
    expect(leadsOf(dialog(WA_AD(), ["Интересует эта квартира"]))).toHaveLength(1);
  });
  it("«да» после предложения — согласие: номер (Instagram) или заявка (WhatsApp)", () => {
    expect(dialog(IG_AD(), ["Нархаш чанд?", "Ха"])[1]!.keys).toEqual(["ask_phone"]);
    expect(leadsOf(dialog(WA_AD(), ["Нархаш чанд?", "Ха"]))).toHaveLength(1);
  });
});

describe("7. явная роль без номера: тёплый ответ и один вопрос по делу, номер — следующим ходом", () => {
  it("Instagram, покупатель: «Мне нужна квартира» → вопрос о районе, комнатах, бюджете; ответ → номер с объяснением", () => {
    const turns = dialog(ctx(), ["Мне нужна квартира", "3 комнаты в Сино, до 500 тысяч"]);
    expect(turns[0]!.keys).toEqual(["role_details_buyer"]);
    expect(turns[0]!.text).not.toMatch(/номер|рақам/iu);
    expect(turns[1]!.keys).toEqual(["ask_phone"]);
  });
  it("Instagram, продавец: «Хочу продать квартиру» → условия и вопрос «что и где»; ответ → номер, «оценит и всё обсудит»", () => {
    const turns = dialog(ctx(), ["Хочу продать квартиру", "3 комнаты в Сино"]);
    expect(turns[0]!.keys).toEqual(["seller_intro", "role_details_seller"]);
    expect(turns[1]!.keys).toEqual(["ask_phone_seller"]);
    expect(turns[1]!.text).toMatch(/оценит и всё обсудит/u);
    expect(turns[1]!.text).not.toMatch(/покажет/u);
  });
  it("WhatsApp: голая роль — сначала один вопрос по сути, вслух номер не просим; заявка — следующим ходом (владелец 22.11.2026)", () => {
    for (const [text, role] of [["Мне нужна квартира", "buyer"], ["Хочу продать квартиру", "seller"]] as const) {
      const [t, next] = dialog(ctx({ channel: "WHATSAPP", phoneKnown: true }), [text, "ок"]);
      expect(leadsOf([t!]), text).toEqual([]);
      expect(t!.text, text).not.toMatch(/номер|рақам/iu);
      expect(leadsOf([next!]), text).toMatchObject([{ type: "accept_lead", role }]);
      expect(next!.keys, text).toEqual(["lead_known_phone"]);
      expect(next!.text, text).toMatch(/WhatsApp/u);
    }
  });
});

describe("8. место объекта — только район и город с сайта; «Рудаки» вслух не называем", () => {
  it("место из карточки с Рудаки — «место скажет агент», а не район", () => {
    const rudaki = ctx({ ad: { topic: "property", propertyId: PROPERTY_ID }, focus: { ...focus, place: "Рудаки, Душанбе" } });
    const [t] = dialog(rudaki, ["Кучост?"]);
    expect(t!.text).not.toMatch(/Рудаки|Рӯдакӣ/u);
    expect(t!.keys).toContain("place_by_agent");
    const [ok] = dialog(IG_AD(), ["Кучост?"]);
    expect(ok!.text).toContain("Сино, Душанбе");
  });
});

describe("второй круг слепого ревью #345", () => {
  const answer = (over: Record<string, unknown>) => ({ role: "none", roleQuote: "", question: "none", aboutThisProperty: false,
    rooms: "", district: "", budget: "", area: "", floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "",
    textOnly: false, noCall: false, language: "tg", bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false,
    jobPosition: "", outsidePlace: "", ...over });

  it.each(["Ин хона фурухта аст?", "Фурухта?", "алакай фурухта?", "Хона хануз фурухта нест?", "in xona furuxta?"])(
    "«%s» на рекламе объекта в WhatsApp — покупатель объекта: цена и предложение звонка, без комиссии и заявки продавца", text => {
      const [t] = dialog(WA_AD(), [text]);
      expect(t!.d.state.role, text).toBe("buyer_property");
      expect(t!.text, text).not.toMatch(/2%|комисси/iu);
      expect(leadsOf([t!]).filter(lead => lead.type === "accept_lead" && lead.role === "seller"), text).toEqual([]);
    });

  it("«Хонаи худам нест, барои писарам мехарам» — покупатель; «Хонаи маро мефурушед?» — продавец", () => {
    expect(dialog(ctx(), ["Хонаи худам нест, барои писарам мехарам"])[0]!.d.state.role).toBe("buyer");
    expect(dialog(ctx(), ["Хонаи маро мефурушед?"])[0]!.d.state.role).toBe("seller");
  });

  it.each(["сколько стоит ваша квартира", "Квартира продается?", "Хона дорам, иваз мекунед?"])(
    "«%s» на рекламе известного объекта в WhatsApp — вопрос об этом объекте: цена и предложение звонка, не общая заявка", text => {
      const [t] = dialog(WA_AD(), [text]);
      expect(t!.u.aboutThisProperty, text).toBe(true);
      expect(t!.d.state.role, text).toBe("buyer_property");
      expect(t!.keys, text).toContain("property_price");
    });

  it("«бо савдо мешавад?» первым сообщением на рекламе известного объекта в WhatsApp — заявка агенту ЭТОГО объекта", () => {
    const [t] = dialog(WA_AD(), ["бо савдо мешавад?"]);
    expect(t!.u.aboutThisProperty).toBe(true);
    expect(leadsOf([t!])).toMatchObject([{ type: "accept_lead", role: "buyer", propertyId: PROPERTY_ID }]);
  });

  it("модель назвала «продавца» на рекламе объекта, а слов продажи нет — спор: вопрос «купить или продать?», без комиссии и заявки продавца", () => {
    // Третий круг: не отбрасываем молча и не угадываем покупателя — продавец мог написать словами, которых нет в словаре.
    for (const text of ["Ин хона фурухта шуд?", "бо савдо мешавад?", "Сколько стоит?"]) {
      const got = understandingFromModel(answer({ role: "seller", roleQuote: text }), { current: text }, initialOperatorState(), WA_AD())!;
      expect(got.understanding.role, text).toBeNull();
      expect(got.understanding.roleConflict, text).toBe(true);
      const d = decide(initialOperatorState(), got.understanding, WA_AD());
      expect(d.steps.map(step => step.key), text).toContain("ask_role");
      expect(d.actions.filter(action => action.type === "accept_lead"), text).toEqual([]);
    }
  });

  it("вопрос по делу до номера — без обещания «агент с вами свяжется»", () => {
    for (const text of ["Мне нужна квартира", "Хочу продать квартиру"]) {
      expect(dialog(ctx(), [text])[0]!.text, text).not.toMatch(/свяжется|тамос мегирад/u);
    }
  });

  it("Instagram: «хорошо / ладно / хоп» сразу на просьбу номера — одна короткая просьба «куда позвонить», дальше по правилу", () => {
    for (const ok of ["хорошо", "ладно", "хоп", "Ок", "давайте", "давай", "майлаш", "хуб"]) {
      const turns = dialog(ctx(), ["Мне нужна квартира", "3 комнаты в Сино", ok, ok]);
      expect(turns[1]!.keys, ok).toEqual(["ask_phone"]);
      expect(turns[2]!.keys, ok).toEqual(["phone_where"]);
      expect(turns[3]!.keys.some(key => key === "phone_where" || PHONE_ASK(key)), ok).toBe(false);
      expect(turns[2]!.d.state.asked.phone, ok).toBe(1);
    }
  });

  it("отказ после предложения звонка (разные формы) против вопросов на «на / не / нет»", () => {
    for (const text of ["не", "нет", "Нет спасибо", "лозим нест", "холо не", "даркор не", "Не надо", "пока не нужно", "намехохам"]) {
      const turns = dialog(IG_AD(), ["Нархаш чанд?", text]);
      expect(turns[1]!.keys.some(PHONE_ASK), text).toBe(false);
      expect(turns[1]!.u.agrees, text).toBe(false);
    }
    for (const text of ["На каком этаже?", "На сколько комнат?", "Не далеко от центра?", "Нет, а цена окончательная?", "Не дорого?"]) {
      const turns = dialog(IG_AD(), ["Нархаш чанд?", text]);
      expect(turns[1]!.u.declines, text).toBe(false);
      expect(turns[1]!.keys.some(PHONE_ASK), text).toBe(true);
    }
  });
});

describe("третий круг ревью #345: продавец рядом с нашим объектом — не покупатель объекта", () => {
  it.each(["Ман хам дар хамин бино хона дорам, фурухта метавонед?", "Хонаи мани хам дар хамин чо, шумо хам мефурушед?", "моя тоже продаётся, интересно?",
    "А мою квартиру купите?", "Xonamro furoxtan mexoham", "Ман фурушанда"])("«%s» на рекламе объекта в WhatsApp — заявка продавца без объекта (после вопроса по сути)", text => {
    const [t, next] = dialog(WA_AD(), [text, "ок"]);
    expect(t!.d.state.role, text).toBe("seller");
    expect(leadsOf([next!]), text).toMatchObject([{ type: "accept_lead", role: "seller", propertyId: null }]);
  });
  it.each(["Ман хам хона дорам, нархаш чанд мешавад?", "У меня в этом же доме квартира, сколько она может стоить?"])(
    "«%s» — своё жильё без слов продажи: вопрос «купить или продать?», заявки нет", text => {
      const [t] = dialog(WA_AD(), [text]);
      expect(t!.keys, text).toContain("ask_role");
      expect(leadsOf([t!]), text).toEqual([]);
    });
  it.each(["ин хона фурухта", "ака ин хона фурухта ё не", "хонаи 2 хучрага фурухта шуд ми"])("«%s» без «?» — вопрос о статусе объекта, не продавец", text => {
    const [t] = dialog(WA_AD(), [text]);
    expect(t!.d.state.role, text).toBe("buyer_property");
    expect(t!.text, text).not.toMatch(/2%|комисси/iu);
  });
});
