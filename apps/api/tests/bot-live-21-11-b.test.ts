/**
 * ЧАСОВАЯ СВЕРКА ПРОДА 21.11.2026 ПОСЛЕ ВЫКАТА #345 (только чтение, без личных данных):
 *  1. «Ход бота клиента остановлен: customer_core_unavailable (RangeError)» + «RangeError в managedGeminiMediaFeatures
 *     (dist/ai/geminiManagedMedia.js:35:76)» — диалог Instagram, вложение без текста; место — проверка base64 регулярным
 *     выражением. Теперь — один проход по кодам символов (lib/base64Text.ts), и сбой разбора вложения не роняет ход;
 *  2. b16a44b4: таджикский разговор, клиент прислал перечень «ш.Ваҳдат… квартира 8 этаж, комната-2, цена…» — ответ ушёл
 *     по-русски; язык переходит на русский только по русской фразе;
 *  3. da83282b: «…хонаҳои бо таъмир ипотека медиҳад ё на» — «Инро аниқ агенти мо мегӯяд» и сразу просьба номера; теперь
 *     честно «об этом подробно расскажет агент» и предложение звонка (или вопрос о роли), номер — по правилу интереса.
 * Без модели и без базы: понимание — запасные правила (или подставленный ответ модели), решение — чистая функция.
 */
import { describe, expect, it, vi } from "vitest";

// Счётчик сторожей пишет в базу «в отрыве»: без базы его лог приходит после конца теста (как в экзамене роли) — подменяем его одного.
vi.mock("../src/ai/guardMetrics.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/guardMetrics.js")>()), guardFired: vi.fn() }));
const logSystemError = vi.fn();
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError }));

const { isStrictBase64, isLooseBase64 } = await import("../src/lib/base64Text.js");
const { managedGeminiMediaFeatures } = await import("../src/ai/geminiManagedMedia.js");
const { perceiveCustomerMediaSafely } = await import("../src/lib/customerMediaPerceptionSafe.js");
const { decide, initialOperatorState } = await import("../src/ai/operator/decide.js");
const { understandFallback, understandingFromModel } = await import("../src/ai/operator/understand.js");
const { renderOperatorReply } = await import("../src/ai/operator/phrases.js");
type Ctx = import("../src/ai/operator/types.js").OperatorContext;
type State = import("../src/ai/operator/types.js").OperatorState;

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  channel: "INSTAGRAM", phoneKnown: false, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: true, ad: { topic: null, propertyId: null }, focus: null,
  callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});
function dialog(c: Ctx, texts: string[]) {
  let state: State = initialOperatorState();
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
const PHONE_ASK = (key: string) => key === "ask_phone" || key === "ask_phone_seller";
const OLD_RE = /^[A-Za-z0-9+/]+={0,2}$/;

describe("1. RangeError в проверке вложения: base64 одним проходом, разбор вложения не роняет ход", () => {
  it("строгий base64 — те же ответы, что прежнее выражение (+ длина кратна 4), на краевых строках", () => {
    for (const value of ["", "A", "AA==", "AAA=", "AAAA", "A===", "====", "AA=A", "AB+/", "AB-_", "AB\n=", "QUJD", "QUI=", "QQ==", "QQ=", "Q Q=", "Ж==="]) {
      expect(isStrictBase64(value), JSON.stringify(value)).toBe(value.length % 4 === 0 && OLD_RE.test(value));
      expect(isLooseBase64(value), JSON.stringify(value)).toBe(/^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 !== 1);
    }
  });

  it("вложение на пределе (≈ 20 МБ) проверяется без регулярного выражения и без RangeError; тот же класс — повтор группы — падает", () => {
    const big = Buffer.alloc(14_900_000, 7).toString("base64");
    expect(big.length).toBeGreaterThan(19_800_000);
    expect(isStrictBase64(big)).toBe(true);
    expect(managedGeminiMediaFeatures([{ inline_data: { mime_type: "video/mp4", data: big } }])).toMatchObject({ modalities: ["video"] });
    expect(isStrictBase64(`${big.slice(0, -4)}AA!=`)).toBe(false);
    // Воспроизведение класса: проверка base64 регулярным выражением с откатом на таком размере падает «Maximum call stack size
    // exceeded» (было в telegram/assistantVoiceCache.ts) — поэтому одна дверь без регулярных выражений.
    expect(() => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(big)).toThrow(RangeError);
  });

  it("сбой разбора вложения (RangeError) — ход идёт дальше без разбора, причина в журнал; отмена и смена контекста — наверх", async () => {
    logSystemError.mockClear();
    const live = { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 };
    const failing = async () => { throw new RangeError("Maximum call stack size exceeded"); };
    expect(await perceiveCustomerMediaSafely({ perceive: failing, wait: live, current: async () => true })).toBeUndefined();
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringMatching(/Разбор вложения не удался, ход без разбора: RangeError «Maximum call stack size exceeded»/u),
      expect.objectContaining({ dedupKey: expect.stringMatching(/^customer-media-perception:RangeError:/u) }));
    await expect(perceiveCustomerMediaSafely({ perceive: failing, wait: live, current: async () => false })).rejects.toThrow(RangeError);
    const aborted = new AbortController(); aborted.abort();
    await expect(perceiveCustomerMediaSafely({ perceive: failing, wait: { signal: aborted.signal, deadlineAt: Date.now() + 60_000 }, current: async () => true }))
      .rejects.toThrow(RangeError);
    expect(await perceiveCustomerMediaSafely({ perceive: async () => "ok", wait: live, current: async () => true })).toBe("ok");
  });
});

describe("2. язык: таджикский разговор не переходит на русский от перечня «этаж, комната, цена»", () => {
  it("b16a44b4: таджикский продавец в WhatsApp, затем перечень по-русски с «Ваҳдат» — ответ по-таджикски", () => {
    const turns = dialog(ctx({ channel: "WHATSAPP", phoneKnown: true }),
      ["Салом алекум хона дорем фурухтан даркор шумо условиётон чихел ?", "ш.Ваҳдат. Доми 9 этажа \nквартира 8 этаж\nкомната-2\nцена-500000 сом"]);
    expect(turns[0]!.d.language).toBe("tg");
    expect(turns[1]!.d.language).toBe("tg");
    expect(turns[1]!.text).not.toMatch(/Спасибо|передаю|свяжутся/u);
  });
  it.each(["3 комнаты, 5 этаж, цена 80000$", "квартира 2 комнаты Сино", "Доми 9 этажа, 70 кв"])("перечень «%s» после таджикского — язык прежний", text => {
    const turns = dialog(ctx(), ["Салом, хона мехарам", text]);
    expect(turns[1]!.d.language, text).toBe("tg");
  });
  it.each(["Здравствуйте, можно по-русски? Я ищу квартиру", "Хочу квартиру в Сино, сколько стоит?", "Я продаю дом"])("русская фраза «%s» — язык меняется", text => {
    const turns = dialog(ctx(), ["Салом, хона мехарам", text]);
    expect(turns[1]!.d.language, text).toBe("ru");
  });
  it("и при ответе модели: «код ручается за русский», но в тексте таджикские буквы и нет русской фразы — язык прежний", () => {
    const answer = { role: "none", roleQuote: "", question: "none", aboutThisProperty: false, rooms: "", district: "", budget: "", area: "", floor: "",
      renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "ru", bargain: false, rude: false,
      botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" };
    const state = { ...initialOperatorState(), language: "tg" as const, role: "seller" as const };
    const text = "ш.Ваҳдат. Доми 9 этажа квартира 8 этаж комната-2";
    const got = understandingFromModel(answer, { current: text }, state, ctx())!;
    expect(decide(state, got.understanding, ctx()).language).toBe("tg");
  });
});

describe("3. вопрос, на который знает только агент (ипотека, рассрочка, документы): ответ, а не просьба номера", () => {
  it("da83282b: «…ипотека медиҳад ё на» — честный ответ по-таджикски, без просьбы номера в этом ходе", () => {
    const [t] = dialog(ctx(), ["Асалом мехостем фахмем ,ки ширкати шумо хам хонахои бо таьмир ипотека медихад ё на"]);
    expect(t!.keys).toContain("topic_by_agent");
    expect(t!.keys.some(PHONE_ASK)).toBe(false);
    expect(t!.text).toMatch(/^Ваалайкум ассалом! Дар ин бора агенти мо ҳамаи тафсилотро ба шумо мегӯяд\./u);
  });
  it("тот же вопрос, когда модель назвала покупателя: ответ и предложение звонка, номер — не в этом ходе", () => {
    const answer = { role: "buyer", roleQuote: "хонахои бо таьмир", question: "other", aboutThisProperty: false, rooms: "", district: "", budget: "", area: "",
      floor: "", renovation: "бо таьмир", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "tg", bargain: false,
      rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" };
    const text = "Асалом мехостем фахмем ,ки ширкати шумо хам хонахои бо таьмир ипотека медихад ё на";
    const got = understandingFromModel(answer, { current: text }, initialOperatorState(), ctx())!;
    const d = decide(initialOperatorState(), got.understanding, ctx());
    const keys = d.steps.map(step => step.key);
    expect(keys).toEqual(["greet_assalom", "topic_by_agent", "offer_call"]);
    // WhatsApp: заявку по номеру тоже не заводим на первый вопрос — сначала ответ и предложение.
    const wa = ctx({ channel: "WHATSAPP", phoneKnown: true });
    expect(decide(initialOperatorState(), understandingFromModel(answer, { current: text }, initialOperatorState(), wa)!.understanding, wa).actions
      .filter(action => action.type === "accept_lead")).toEqual([]);
  });
  it("язык ответа — по последнему ясному сообщению клиента: русский вопрос об ипотеке после таджикского — по-русски, и наоборот", () => {
    const ruAfterTg = dialog(ctx(), ["Салом", "Здравствуйте, у вас есть ипотека?"]);
    expect(ruAfterTg[1]!.d.language).toBe("ru");
    expect(ruAfterTg[1]!.text).toMatch(/Об этом подробно расскажет агент|Это агент подробно объяснит/u);
    expect(ruAfterTg[1]!.keys.some(PHONE_ASK)).toBe(false);
    const tgAfterRu = dialog(ctx(), ["Здравствуйте", "Ипотека медихед ё на?"]);
    expect(tgAfterRu[1]!.d.language).toBe("tg");
    expect(tgAfterRu[1]!.keys.some(PHONE_ASK)).toBe(false);
    // da83282b дословно — это таджикский (латинскими буквами без ӯ/ҳ): ответ по-таджикски верен.
    expect(dialog(ctx(), ["Асалом мехостем фахмем ,ки ширкати шумо хам хонахои бо таьмир ипотека медихад ё на"])[0]!.d.language).toBe("tg");
  });
  it("WhatsApp, после заявки продавца: перечень по-русски с таджикскими буквами — пометка «вне Душанбе» по-таджикски", () => {
    const turns = dialog(ctx({ channel: "WHATSAPP", phoneKnown: true }), ["Мехохам хонаамро фурушам", "ш.Ваҳдат, квартира 8 этаж, комната 2"]);
    expect(turns[1]!.d.language).toBe("tg");
    expect(turns[1]!.text).not.toMatch(/Спасибо|специалисту|свяжутся/u);
  });
  it.each(["У вас есть ипотека?", "Рассрочка есть?", "Бо кисм мешавад?", "Какие документы нужны?", "Хуччатхояш тайёр хаст?", "Кредит медихед ё на"])(
    "«%s» — честный ответ, без просьбы номера", text => {
      const [t] = dialog(ctx(), [text]);
      expect(t!.keys, text).toContain("topic_by_agent");
      expect(t!.keys.some(PHONE_ASK), text).toBe(false);
    });
  it("«документы готовы» продавца без вопроса — не вопрос агенту (экзамен роли не трогаем)", () => {
    const [t] = dialog(ctx(), ["Хонаи фуруши дорем 4хонага 9этажа, ҳуҷҷатҳо тайёр"]);
    expect(t!.keys).not.toContain("topic_by_agent");
  });
  it("КЛАСС: первый вопрос по делу (с деталями внутри или без) никогда не получает просьбу номера в том же ходе", () => {
    const questions = ["Сколько стоит 2 комнатная в Сино?", "Хонаи 3 хучрага бо таъмир хаст?", "Есть квартиры с ремонтом до 50 тысяч?", "Где находится?",
      "Документы готовы?", "Ипотека есть?", "Нархаш чанд?", "Ин хона кучост?"];
    for (const c of [ctx(), ctx({ channel: "WHATSAPP", phoneKnown: true }), ctx({ ad: { topic: "seller", propertyId: null } })]) for (const text of questions) {
      const [t] = dialog(c, [text]);
      expect(t!.keys.some(PHONE_ASK), `${c.channel}: ${text}`).toBe(false);
    }
  });
});
