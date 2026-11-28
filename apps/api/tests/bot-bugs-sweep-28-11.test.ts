import { describe, expect, it, vi } from "vitest";

// Живых вызовов модели нет: транспорт режима (callAiText) подменён, остальное в модуле — настоящее (audit:mocks).
const callAiText = vi.fn(async (): Promise<unknown> => { throw new Error("нет ключа на стенде"); });
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText }));

const { runOperatorTurn } = await import("../src/ai/operator/index.js");
const { operatorStickerOnly } = await import("../src/ai/operator/understand.js");
const { OPERATOR_PHRASES } = await import("../src/ai/operator/phrases.js");
const { AUTOMATION_SWITCH_DEFAULT_OFF, AUTOMATION_SWITCH_KEYS, AUTOMATION_SWITCH_LABELS } = await import("@royal-home/shared");
type Ctx = import("../src/ai/operator/types.js").OperatorContext;

/**
 * РАЗБОР БАГОВ БОТА 28.11.2026 (задача A, корпус регрессии из живых диалогов прода за 7 дней, без личных данных).
 * Модель понимания выключена (`model: async () => null`) — ход решают запасные правила кода, как при сбое модели на проде.
 *  1. Текст продавцу дословно от коллег (владелец 28.11): тадж. «Дар фурӯш кӯмак мекунем, комиссияи агентӣ 2%. Нависед, чӣ
 *     мефурӯшед ва дар кадом ноҳия, ҳамаашро мегӯем.»; рус. «Поможем с продажей, комиссия агентства 2%. Напишите, что продаёте
 *     и в каком районе, всё расскажем.» (живой 1251e2dc, FACEBOOK; рус. вариант до правки был другим — 10 раз за неделю).
 *  2. Лайк 👍 Messenger — стикер, а не фото (живой 1251e2dc: ответ «акс ва видеоро агент худаш мегирад»).
 *  3. «Вне Душанбе» — за рубильником, умолчание = решение владельца 19.11 (не отказываем).
 */
const SELLER_TG = "Дар фурӯш кӯмак мекунем, комиссияи агентӣ 2%. Нависед, чӣ мефурӯшед ва дар кадом ноҳия, ҳамаашро мегӯем.";
const SELLER_RU = "Поможем с продажей, комиссия агентства 2%. Напишите, что продаёте и в каком районе, всё расскажем.";

const ctx = (over: Partial<Ctx> = {}): Ctx => ({ channel: "FACEBOOK", phoneKnown: false, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: true, ad: { topic: null, propertyId: null },
  focus: null, callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2,
  vacancies: { open: [], contactPhone: "+992 00 000 00 01" }, brandName: "Royal Home", officePhone: "+992 00 000 00 02",
  sellerCommissionPercent: 2, outOfArea: false, ...over });
const noModel = async () => null;
const turn = (current: string, stored: unknown = null, c: Ctx = ctx()) =>
  runOperatorTurn({ storedState: stored === null ? null : JSON.parse(JSON.stringify(stored)), input: { current }, ctx: c, model: noModel });

describe("1. текст продавцу — дословно, на обоих языках", () => {
  it("таджикский продавец (живой 1251e2dc): ровно текст коллег", async () => {
    const r = await turn("Мехоҳам хонаамро фурӯшам");
    expect(r.text).toBe(SELLER_TG);
    expect(r.actions.some(action => action.type === "accept_lead")).toBe(false);
  });

  it("русский продавец (живой 017f4313): ровно перевод, одобренный владельцем", async () => {
    const r = await turn("Хочу продать квартиру");
    expect(r.text).toBe(SELLER_RU);
  });

  it("обе фразы держат текст на любом варианте (вариант не уводит от слов коллег)", () => {
    for (const variant of OPERATOR_PHRASES.seller_intro.tg) expect(variant).toBe("Дар фурӯш кӯмак мекунем, комиссияи агентӣ {percent}%.");
    for (const variant of OPERATOR_PHRASES.role_details_seller.tg) expect(variant).toBe("Нависед, чӣ мефурӯшед ва дар кадом ноҳия, ҳамаашро мегӯем.");
    for (const variant of OPERATOR_PHRASES.seller_intro.ru) expect(variant).toBe("Поможем с продажей, комиссия агентства {percent}%.");
    for (const variant of OPERATOR_PHRASES.role_details_seller.ru) expect(variant).toBe("Напишите, что продаёте и в каком районе, всё расскажем.");
  });
});

describe("2. стикер (лайк Messenger, стикер WhatsApp) — реакция, а не фото и не текст", () => {
  it("пометка «[вложение: sticker]» — не слова клиента", () => {
    expect(operatorStickerOnly("[вложение: sticker]")).toEqual({ sticker: true, rest: "" });
    expect(operatorStickerOnly("[вложение: Sticker] спасибо")).toEqual({ sticker: true, rest: "спасибо" });
    expect(operatorStickerOnly("Хочу продать")).toEqual({ sticker: false, rest: "Хочу продать" });
  });

  it("лайк после разговора с продавцом: ни «акс ва видеоро…», ни «получил», бот молчит", async () => {
    const first = await turn("Мехоҳам хонаамро фурӯшам");
    const like = await turn("[вложение: sticker]", first.stored);
    expect(like.text).toBeNull();
    expect(like.steps.map(step => step.key)).not.toContain("photo_ack");
    expect(like.steps.map(step => step.key)).not.toContain("media_received");
    expect(like.understanding.reaction).toBe(true);
    expect(like.understanding.hasText).toBe(false);
  });

  it("стикер первым словом: короткое спасибо и приглашение, как на «😍», а не «файл получил»", async () => {
    const r = await turn("[вложение: sticker]");
    expect(r.steps.map(step => step.key)).toEqual(["reaction_thanks", "reaction_invite"]);
  });
});

describe("3. вне Душанбе — рубильник «Бот отказывает, если объект не в Душанбе»", () => {
  it("рубильник есть в реестре, по умолчанию ВЫКЛ (решение владельца 19.11), с подписью", () => {
    expect(AUTOMATION_SWITCH_KEYS).toContain("botOutOfAreaRefusalEnabled");
    expect(AUTOMATION_SWITCH_DEFAULT_OFF.has("botOutOfAreaRefusalEnabled")).toBe(true);
    expect(AUTOMATION_SWITCH_LABELS.botOutOfAreaRefusalEnabled.title).toBeTruthy();
  });

  it("ВКЛ: продавец из Худжанда — один раз существующая фраза «работаем по Душанбе», без заявки и без просьбы номера", async () => {
    const c = ctx({ outOfAreaRefusal: true });
    const first = await turn("Мехоҳам хонаамро фурӯшам", null, c);
    const outside = await turn("Мо дар Хуҷанд хона дорем", first.stored, c);
    expect(outside.state.outOfArea).toBe(true);
    expect(outside.steps.map(step => step.key)).toEqual(["where_work"]);
    expect(OPERATOR_PHRASES.where_work.tg).toContain(outside.text);
    expect(outside.actions).toEqual([]);
    // Повтор — тишина без сигнала людям.
    const again = await turn("Дар Хуҷанд намояндагӣ доред?", outside.stored, c);
    expect(again.text).toBeNull();
    expect(again.actions).toEqual([]);
  });

  it("ВКЛ, но клиент сам написал номер: заявка всё равно, с пометкой «не в Душанбе» (номер — заявка всегда, 20.11)", async () => {
    const c = ctx({ outOfAreaRefusal: true });
    const first = await turn("Мехоҳам хонаамро фурӯшам", null, c);
    const outside = await turn("Мо дар Хуҷанд хона дорем", first.stored, c);
    const phone = await turn("Рақамам 918 12 34 56", outside.stored, c);
    expect(phone.actions).toMatchObject([{ type: "accept_lead", outOfArea: true }]);
  });

  it("ВЫКЛ (умолчание): отказа нет — разговор идёт к заявке с пометкой, как решено 19.11", async () => {
    const first = await turn("Мехоҳам хонаамро фурӯшам");
    const outside = await turn("Мо дар Хуҷанд хона дорем", first.stored);
    expect(outside.state.outOfArea).toBe(true);
    expect(outside.steps.map(step => step.key)).not.toEqual(["where_work"]);
    const phone = await turn("Рақамам 918 12 34 56", outside.stored);
    expect(phone.actions).toMatchObject([{ type: "accept_lead", outOfArea: true }]);
    expect(phone.steps.map(step => step.key)).toContain("out_of_area_accepted");
  });
});
