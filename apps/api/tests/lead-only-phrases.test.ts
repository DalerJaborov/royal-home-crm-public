import { describe, expect, it } from "vitest";
import { LEAD_ONLY_CALLBACK_WINDOW_MS, LEAD_ONLY_DEFAULTS, leadOnlyCallbackTime, leadOnlyCallDeclined, leadOnlyCallRequested, leadOnlyHotIntent,
  leadOnlyNoCallNotedLine, leadOnlyPhoneRefused, leadOnlyRecentCallbackTime, leadOnlyServerLine, leadOnlyStripPhoneAsk } from "../src/ai/leadOnlyMode.js";
import { legacyLeadOnlyDraftForPhone } from "../src/messengers/leadOnlyLegacy.js";
import { leadOnlyIntentFallback } from "../src/ai/leadOnlyIntent.js";

/**
 * ТАБЛИЦА ФРАЗ РЕЖИМА «ТОЛЬКО ЗАЯВКИ» (четвёртое ревью 13.11.2026). Одна таблица на все слова, по которым режим решает:
 * отказ от звонка / номера, время звонка, горячее, не горячее. Новая правка регулярок в ai/leadOnlyMode.ts обязана
 * пройти её целиком; новую живую фразу, на которой бот ошибся, дописывать СЮДА строкой, а не отдельным тестом.
 *
 * Виды строк:
 *  - refusal  — отказ: номер больше не просим, звонок не обещаем; времени звонка нет;
 *  - time     — просьба позвонить в названное время: не отказ, время уходит агенту;
 *  - neither  — ни отказ, ни время («нет номера квартиры», «позвоните мне»);
 *  - hot      — готов ехать / смотреть: агенту сразу;
 *  - cool     — не горячее (вопрос, откладывает, просит фото или другие варианты).
 */
type Row = [kind: "refusal" | "time" | "neither" | "hot" | "cool", lang: "ru" | "tg", text: string];
const PHRASES: Row[] = [
  // ── отказ (№1 четвёртого ревью: слово времени рядом с «не звоните» отказ не снимает) ──
  ["refusal", "ru", "Не звоните мне, я сейчас на работе, пишите здесь"],
  ["refusal", "ru", "Звонить не надо, пишите потом"],
  ["refusal", "ru", "Не надо звонить, я сейчас занят"],
  ["refusal", "ru", "Сейчас не звоните, пишите в чат"],
  ["refusal", "ru", "Можно без звонков? Сейчас неудобно"],
  ["refusal", "ru", "Не звоните, пишите сюда"],
  ["refusal", "ru", "Пишите здесь, звонить не нужно"],
  ["refusal", "ru", "Не хочу давать номер"],
  ["refusal", "ru", "Номер не дам"],
  ["refusal", "ru", "У меня нет номера для вас, пишите здесь"],
  ["refusal", "tg", "Занг назанед, ҳозир кор дорам"],
  ["refusal", "tg", "Ҳозир занг назанед"],
  ["refusal", "tg", "Занг назанед, ҳамин ҷо нависед"],
  ["refusal", "tg", "Рақам намедиҳам"],
  ["refusal", "tg", "Рақамамро намедиҳам"],
  // ── время звонка (просьба позвонить без отрицания) ──
  ["time", "ru", "Не звоните сейчас, позвоните завтра"],
  ["time", "ru", "Сейчас не звоните, я на работе, звоните после 6"],
  ["time", "ru", "Позвоните 93 555 12 34 завтра"],
  ["time", "ru", "Звоните после 18:00"],
  ["time", "ru", "Перезвоните вечером"],
  ["time", "ru", "Можно позвонить в субботу?"],
  ["time", "ru", "Наберите меня завтра утром"],
  ["time", "ru", "Не могли бы позвонить завтра?"],
  ["time", "tg", "Ҳозир занг назанед, пагоҳ занг занед"],
  ["time", "tg", "Пагоҳ саҳар занг занед"],
  ["time", "tg", "Бегоҳ занг занед"],
  // ── ни отказ, ни время ──
  ["neither", "ru", "Не дам номер своей квартиры"],
  ["neither", "ru", "Не скажу номер этой квартиры"],
  ["neither", "ru", "У меня нет номера объекта"],
  ["neither", "ru", "Номер квартиры не знаю"],
  ["neither", "ru", "Позвоните мне"],
  ["neither", "tg", "Рақами хонаро намедонам"],
  // ── горячее ──
  ["hot", "ru", "Хочу посмотреть квартиру. Завтра можно? Сегодня не могу"],
  ["hot", "ru", "Хочу посмотреть, скиньте адрес, я не могу говорить"],
  ["hot", "ru", "Хотим посмотреть, сегодня не можем, завтра можно?"],
  ["hot", "ru", "Можно посмотреть в субботу? В пятницу не могу"],
  ["hot", "ru", "Не могу найти, куда ехать?"],
  ["hot", "ru", "Какой адрес? Хотим завтра приехать"],
  ["hot", "ru", "Куда ехать? Сейчас не могу разговаривать"],
  ["hot", "ru", "Мы реальные покупатели, когда можно посмотреть?"],
  ["hot", "tg", "Дидан мехоҳем, ҳозир гап зада наметавонам"],
  ["hot", "tg", "Кай омада метавонем?"],
  ["hot", "tg", "Куҷо биёем?"],
  // ── не горячее ──
  ["cool", "ru", "Какой адрес? Сегодня не могу, напишу позже"],
  ["cool", "ru", "Хотим посмотреть, но не сейчас"],
  ["cool", "ru", "Хочу посмотреть, но завтра не могу, напишу позже"],
  ["cool", "ru", "Можно посмотреть фото?"],
  ["cool", "ru", "Можно посмотреть другие варианты?"],
  ["cool", "ru", "Какой адрес?"],
  ["cool", "ru", "Пока не готовы купить"],
  ["cool", "tg", "Дидан мехоҳем, вале имрӯз наметавонем"],
  ["cool", "tg", "Дидан мехоҳем, пагоҳ наметавонем, баъдтар менависем"],
];

describe("таблица фраз: отказ / время / горячее", () => {
  it("в таблице не меньше 40 строк и есть оба языка у каждого вида", () => {
    expect(PHRASES.length).toBeGreaterThanOrEqual(40);
    for (const kind of ["refusal", "time", "neither", "hot", "cool"] as const) {
      for (const lang of ["ru", "tg"] as const) expect(PHRASES.some(([k, l]) => k === kind && l === lang), `${kind}/${lang}`).toBe(true);
    }
  });
  it.each(PHRASES.filter(([kind]) => kind === "refusal"))("отказ (%s, %s): «%s»", (_kind, _lang, text) => {
    expect(leadOnlyPhoneRefused(text)).toBe(true);
    expect(leadOnlyCallbackTime(text)).toBeNull();
    expect(leadOnlyCallRequested(text)).toBe(false);
  });
  it.each(PHRASES.filter(([kind]) => kind === "time"))("время звонка (%s, %s): «%s»", (_kind, _lang, text) => {
    expect(leadOnlyCallbackTime(text)).toBeTruthy();
    expect(leadOnlyPhoneRefused(text)).toBe(false);
    expect(leadOnlyCallRequested(text)).toBe(true);
  });
  it.each(PHRASES.filter(([kind]) => kind === "neither"))("ни отказ, ни время (%s, %s): «%s»", (_kind, _lang, text) => {
    expect(leadOnlyPhoneRefused(text)).toBe(false);
    expect(leadOnlyCallbackTime(text)).toBeNull();
  });
  it.each(PHRASES.filter(([kind]) => kind === "hot"))("горячее (%s, %s): «%s»", (_kind, _lang, text) => {
    expect(leadOnlyHotIntent(text)).toBe(true);
  });
  it.each(PHRASES.filter(([kind]) => kind === "cool"))("не горячее (%s, %s): «%s»", (_kind, _lang, text) => {
    expect(leadOnlyHotIntent(text)).toBe(false);
  });
});

describe("№1: отказ от звонка держится, пока клиент сам не попросит позвонить", () => {
  it("прежний отказ действует; «позвоните мне» сейчас его снимает; новый отказ — снова отказ", () => {
    const earlier = ["Не звоните мне, пишите здесь"];
    expect(leadOnlyCallDeclined("Хочу посмотреть", earlier)).toBe(true);
    expect(leadOnlyCallDeclined("Хорошо, позвоните мне завтра", earlier)).toBe(false);
    expect(leadOnlyCallDeclined("Звонить не надо", [])).toBe(true);
  });
  it("ответ клиенту с карточкой — без обещания звонка, текст сервера, без дословного повтора", () => {
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) sent.push(leadOnlyNoCallNotedLine("ru", sent));
    expect(new Set(sent).size).toBe(3);
    for (const line of [...sent, leadOnlyNoCallNotedLine("tg")]) {
      expect(line).not.toMatch(/позвон|занг мезанад/iu);
      expect(leadOnlyServerLine(line), line).toBe(true);
    }
  });
});

describe("№4: цифры номера не мешают найти время и не попадают в пометку", () => {
  it("«Позвоните 93 555 12 34 завтра» — время «завтра», без цифр номера", () => {
    const time = leadOnlyCallbackTime("Позвоните 93 555 12 34 завтра");
    expect(time).toMatch(/завтра/u);
    expect(time).not.toMatch(/555/u);
    expect(leadOnlyCallbackTime("Звоните после 18:00")).toBe("Звоните после 18:00");
  });
});

describe("№5: время звонка — только из сообщений за сутки", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it("вчерашнее «позвоните вечером» в пределах суток берётся, трёхдневное — нет, без отметки времени — нет", () => {
    expect(leadOnlyRecentCallbackTime("93 555 12 34", [{ text: "Позвоните вечером", at: at(LEAD_ONLY_CALLBACK_WINDOW_MS - 60_000) }], now)).toBe("Позвоните вечером");
    expect(leadOnlyRecentCallbackTime("93 555 12 34", [{ text: "Позвоните завтра", at: at(3 * LEAD_ONLY_CALLBACK_WINDOW_MS) }], now)).toBeNull();
    expect(leadOnlyRecentCallbackTime("93 555 12 34", [{ text: "Позвоните завтра" }], now)).toBeNull();
    expect(leadOnlyRecentCallbackTime("Звоните после 6", [{ text: "Позвоните завтра", at: at(1000) }], now)).toBe("Звоните после 6");
  });
});

describe("№5: тема этого сообщения важнее старой темы черновика модели", () => {
  const config = { ...LEAD_ONLY_DEFAULTS, enabled: true };
  // Решения кода: дверь намерения без модели (запасной путь) — ai/leadOnlyIntent.ts.
  const noModel = async (text: string) => leadOnlyIntentFallback(text);
  it("продавец с номером — пометка о продаже, а не прежнее «ищет 2-комнатную» из черновика", async () => {
    const draft = await legacyLeadOnlyDraftForPhone({ config, classifyIntent: noModel, history: [], text: "Хочу продать свою квартиру, 93 123 45 67",
      draft: { stage: "chatting", callbackTopic: "Ищет 2-комнатную в Сино" }, freshPropertyId: null, carriedPropertyId: null, pending: null });
    expect(draft.intent).toBe("sell");
    expect(draft.callbackTopic).toMatch(/продать/u);
    expect(draft.callbackTopic).not.toMatch(/Сино/u);
  });
  it("голый номер — тема по-прежнему из черновика", async () => {
    const draft = await legacyLeadOnlyDraftForPhone({ config, classifyIntent: noModel, history: [{ role: "user", content: "Ищу 2-комнатную в Сино" }], text: "93 123 45 67",
      draft: { stage: "chatting", callbackTopic: "Ищет 2-комнатную в Сино" }, freshPropertyId: null, carriedPropertyId: null, pending: null });
    expect(draft.callbackTopic).toMatch(/Сино/u);
  });
});

describe("№5: WhatsApp — режется только просьба телефона, а не весь вопрос", () => {
  it.each([
    ["Скиньте номер квартиры и ваш номер.", "Скиньте номер квартиры."],
    ["Скиньте ваш номер и номер квартиры.", "Скиньте номер квартиры."],
    ["Подскажите номер дома, а также ваш номер телефона?", "Подскажите номер дома?"],
  ])("«%s» → «%s»", (text, expected) => {
    expect(leadOnlyStripPhoneAsk(text)).toEqual({ text: expected, changed: true });
  });
  it("просьба одного телефона по-прежнему режется целиком; номер объекта — не трогается", () => {
    expect(leadOnlyStripPhoneAsk("Понял. Оставьте ваш номер телефона.")).toEqual({ text: "Понял.", changed: true });
    expect(leadOnlyStripPhoneAsk("Скиньте номер своей квартиры.")).toEqual({ text: "Скиньте номер своей квартиры.", changed: false });
  });
});
