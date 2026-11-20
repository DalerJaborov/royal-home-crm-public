import { describe, expect, it, vi } from "vitest";
import type { RecruitmentPosition } from "@royal-home/shared";

// Живых вызовов модели нет: транспорт режима (callAiText) подменён, остальное в модуле — настоящее (audit:mocks).
const callAiText = vi.fn(async (): Promise<unknown> => { throw new Error("нет ключа на стенде"); });
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText }));

const { understandTurn, understandingFromModel } = await import("../src/ai/operator/understand.js");
const { decide, initialOperatorState } = await import("../src/ai/operator/decide.js");
const { runOperatorTurn } = await import("../src/ai/operator/index.js");
type Ctx = import("../src/ai/operator/types.js").OperatorContext;

/**
 * РАСХОЖДЕНИЯ С SPEC.md ПОСЛЕ ВЫКАТА #311 (проверка 10 живых диалогов 19.11.2026, починка 20.11). Фразы клиентов — из живых
 * диалогов без личных данных; модель понимания подменена так, как она ответила на проде (ОЦЕНКА по итогу хода: роль
 * «покупатель» на кнопке рекламы, русский язык у таджикской фразы).
 *  1. Кнопка рекламы «Привет! Можно узнать об этом подробнее?» → модель «покупатель» с цитатой из самой кнопки → заявка
 *     покупателя и обещание звонка соискателю (SPEC, строка 12: без метки рекламы кнопка — роль «непонятно»).
 *  4. «телефон номера нависед» (таджикский с русскими словами) → модель «русский» → ответ по-русски (SPEC «Язык»).
 */
const MANAGER: RecruitmentPosition = { key: "sales-manager", revision: 1, titleRu: "менеджер по продажам", titleTg: "менеҷери фурӯш",
  detailsRu: "", detailsTg: "", isOpen: true, keywords: ["менеджер"], postCodes: [] };
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ channel: "WHATSAPP", phoneKnown: true, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: true, ad: { topic: null, propertyId: null },
  focus: null, callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2,
  vacancies: { open: [MANAGER], contactPhone: "+992 00 000 00 01" }, brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over });
const answer = (over: Record<string, unknown> = {}) => ({ role: "none", roleQuote: "", question: "none", aboutThisProperty: false,
  rooms: "", district: "", budget: "", area: "", floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "",
  textOnly: false, noCall: false, language: "none", bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false,
  jobPosition: "", outsidePlace: "", ...over });

const AD_BUTTON = "Привет! Можно узнать об этом подробнее?";
/** Так модель ответила на кнопку на проде: «покупатель» с цитатой из самой кнопки (цитата находится в словах — проверка её пропускала). */
const buyerFromButton = async () => answer({ role: "buyer", roleQuote: "Можно узнать об этом подробнее", question: "property_other", language: "ru" });

describe("1. кнопка рекламы — не слова клиента: ни роли, ни заявки", () => {
  it("ответ модели на кнопку не даёт роли (даже с цитатой из самой кнопки)", () => {
    const checked = understandingFromModel(answer({ role: "buyer", roleQuote: "узнать об этом подробнее", question: "property_other" }),
      { current: AD_BUTTON }, initialOperatorState(), ctx())!;
    expect(checked.understanding).toMatchObject({ role: null, adOpener: true, language: null, question: "none" });
  });

  it("на кнопку модель не зовётся вовсе", async () => {
    const model = vi.fn(buyerFromButton);
    await expect(understandTurn({ current: AD_BUTTON }, initialOperatorState(), ctx(), model)).resolves.toMatchObject({ role: null, adOpener: true });
    expect(model).not.toHaveBeenCalled();
  });

  it("WhatsApp без метки рекламы: «Здравствуйте! Вы хотите купить или продать недвижимость?», заявки нет", async () => {
    const result = await runOperatorTurn({ storedState: null, input: { current: AD_BUTTON }, ctx: ctx(), model: buyerFromButton });
    expect(result.text).toBe("Здравствуйте! Вы хотите купить или продать недвижимость?");
    expect(result.actions).toEqual([]);
    expect(result.state.role).toBe("unknown");
  });

  it("реклама самого агентства (тема не «объект», lib/adAttribution.ts): тоже вопрос о роли; ход о работе — пути рекрутёра", async () => {
    // У рекламы агентства (Ad.brand) темы нет: оператор видит её как рекламу без темы (resolveAdTopic → undefined).
    const result = await runOperatorTurn({ storedState: null, input: { current: AD_BUTTON }, ctx: ctx({ ad: { topic: null, propertyId: null } }),
      model: buyerFromButton });
    expect(result.text).toBe("Здравствуйте! Вы хотите купить или продать недвижимость?");
    expect(result.actions).toEqual([]);
    const next = await runOperatorTurn({ storedState: JSON.parse(JSON.stringify(result.stored)), input: { current: "Я по вакансии менеджера по продажам" },
      ctx: ctx(), model: async () => null });
    expect(next.handoff).toBe("recruiter");
    expect(next.actions).toEqual([]);
  });

  it("реклама объекта с известным объектом — как раньше: строка объекта и заявка агенту объекта", () => {
    const focus = { propertyId: "6f1c2d3e-0000-4000-8000-000000000164", shortId: 164, priceText: { ru: "520 000 сомони", tg: "520 000 сомонӣ" }, sold: false };
    const c = ctx({ ad: { topic: "property", propertyId: focus.propertyId }, focus });
    const d = decide(initialOperatorState(), { ...emptyUnderstanding(), adOpener: true, languageHint: "ru" }, c);
    expect(d.steps.map(step => step.key)).toEqual(["property_price", "lead_known_phone"]);
    expect(d.actions).toMatchObject([{ type: "accept_lead", role: "buyer", propertyId: focus.propertyId }]);
  });

  it("настоящая реклама объекта, объект не распознался (Meta не ответила, карусель): по SPEC — покупатель объекта, заявка с пометкой", () => {
    const d = decide(initialOperatorState(), { ...emptyUnderstanding(), adOpener: true, languageHint: "ru" }, ctx({ ad: { topic: "property", propertyId: null } }));
    expect(d.state.role).toBe("buyer_property");
    expect(d.actions).toMatchObject([{ type: "accept_lead", role: "buyer", propertyId: null }]);
    expect((d.actions[0] as { note: string }).note).toContain("Спрашивал объект с рекламы, объект не определён");
    // Instagram: номера нет — просьба номера, а не вопрос о роли.
    const ig = decide(initialOperatorState(), { ...emptyUnderstanding(), adOpener: true, languageHint: "ru" },
      ctx({ channel: "INSTAGRAM", phoneKnown: false, ad: { topic: "property", propertyId: null } }));
    expect(ig.steps.map(step => step.key)).toEqual(["ask_phone"]);
  });
});

describe("4. язык решает код, модель — только когда код не решил", () => {
  it("«телефон номера нависед»: модель сказала «русский» — понимание «таджикский»", () => {
    const checked = understandingFromModel(answer({ language: "ru" }), { current: "телефон номера нависед" }, initialOperatorState(), ctx())!;
    expect(checked.understanding.language).toBe("tg");
  });

  it("Facebook, первый ход: ответ по-таджикски «Шумо хона мехаред ё мефурӯшед?»", async () => {
    const result = await runOperatorTurn({ storedState: null, input: { current: "телефон номера нависед" },
      ctx: ctx({ channel: "FACEBOOK", phoneKnown: false }), model: async () => answer({ language: "ru" }) });
    expect(result.language).toBe("tg");
    expect(result.text).toBe("Шумо хона мехаред ё мефурӯшед?");
  });

  it("класс: кириллица с признаками языка — по коду, модель не перекрашивает ни в одну сторону", () => {
    const tajik = ["Мебиёен имруз барои видео снимать кадан?", "Ман квартира мехарам", "Привет хона дорам"];
    for (const text of tajik) expect(understandingFromModel(answer({ language: "ru" }), { current: text }, initialOperatorState(), ctx())!.understanding.language, text).toBe("tg");
    for (const text of ["Квартира в Сино, 3 комнаты", "Салом, хочу купить квартиру"]) {
      expect(understandingFromModel(answer({ language: "tg" }), { current: text }, initialOperatorState(), ctx())!.understanding.language, text).toBe("ru");
    }
  });

  it("латиница — решает модель: русский транслит остаётся русским, таджикский латиницей — как скажет модель (ревью #327)", () => {
    for (const text of ["Skolko stoit kvartira?", "Kvartira nujna 2 komnatnaya"]) {
      expect(understandingFromModel(answer({ language: "ru" }), { current: text }, initialOperatorState(), ctx())!.understanding.language, text).toBe("ru");
    }
    // Таджикский латиницей: у кода тут нет основания (детектор называет таджикским любую латиницу) — слово за моделью.
    expect(understandingFromModel(answer({ language: "tg" }), { current: "Mo 3 xonai furuwi dorem. Narxi reklama?" }, initialOperatorState(), ctx())!
      .understanding.language).toBe("tg");
    expect(understandingFromModel(answer({ language: "ru" }), { current: "Mo 3 xonai furuwi dorem. Narxi reklama?" }, initialOperatorState(), ctx())!
      .understanding.language).toBe("ru");
  });

  it("модель промолчала о языке — прежнее слово кода", () => {
    expect(understandingFromModel(answer({ language: "none" }), { current: "Skolko stoit kvartira?" }, initialOperatorState(), ctx())!.understanding.language).toBe("tg");
  });

  it("реальные кнопки Meta с прода, которых не было в списке, — тоже кнопки (без модели, без роли)", async () => {
    for (const text of ["Hello! Can I get more info on this?", "Здравствуйте! Можно ли узнать об этом больше?"]) {
      const model = vi.fn(buyerFromButton);
      await expect(understandTurn({ current: text }, initialOperatorState(), ctx(), model)).resolves.toMatchObject({ role: null, adOpener: true });
      expect(model, text).not.toHaveBeenCalled();
    }
  });

  it("код не решил — слово модели остаётся (её прежняя работа не потеряна)", () => {
    expect(understandingFromModel(answer({ language: "tg" }), { current: "номер телефон дорен?" }, initialOperatorState(), ctx())!.understanding.language).toBe("tg");
  });
});

function emptyUnderstanding() {
  return { source: "fallback" as const, role: null, question: "none" as const, aboutThisProperty: false, details: {}, hasDetails: false, phone: null,
    callback: { when: null, textOnly: false, noCall: false }, language: null, languageHint: null, greeting: null, greetingOnly: false,
    ackOnly: false, thanksOnly: false, adOpener: false, bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false,
    job: { asked: null, openKey: null }, attachments: { voice: "none" as const, ownPost: false, foreignPost: false, media: false }, hasText: true,
    outsidePlace: null, quote: "" };
}
