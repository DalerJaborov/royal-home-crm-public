import { describe, expect, it } from "vitest";
import { clampMaxPhoneAsks, LEAD_ONLY_OFFICE_PHONE_TEXT, leadOnlyCallbackTime, leadOnlyCallbackWhen, leadOnlyEscalateLine, leadOnlyFilterReply,
  leadOnlyHotIntent, leadOnlyNoteWithCallbackTime, leadOnlyOutgoing, leadOnlyPhoneRefused, leadOnlyStripPhoneAsk,
  leadOnlyWithholdsCustomerWrite } from "../src/ai/leadOnlyMode.js";

/*
 * ЧТО ОСТАЛОСЬ У РЕЖИМА «ТОЛЬКО ЗАЯВКИ» ПОСЛЕ ОПЕРАТОРА (этап 1.2, 19.11.2026). Шаблоны и сценарии режима удалены вместе с
 * их тестами (lead-only-mode, lead-only-phrases, lead-only-review*-13-11, lead-only-wording-guard); здесь — случаи ревью 13.11
 * для общих частей, которые живут дальше: горячие слова, отказ от звонка и время звонка (запасные правила оператора),
 * фильтры чужого текста, последняя дверь текста, рабочие часы. Перенесены дословно, без изменения ожиданий.
 */
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
  it.each(PHRASES.filter(([kind]) => kind === "refusal"))("отказ (%s, %s): «%s»", (_kind, _lang, text) => {
    expect(leadOnlyPhoneRefused(text)).toBe(true);
    expect(leadOnlyCallbackTime(text)).toBeNull();
  });
  it.each(PHRASES.filter(([kind]) => kind === "time"))("время звонка (%s, %s): «%s»", (_kind, _lang, text) => {
    expect(leadOnlyCallbackTime(text)).toBeTruthy();
    expect(leadOnlyPhoneRefused(text)).toBe(false);
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

describe("горячие слова (ревью 13.11: отрицание, «фото», адрес без намерения, «не могу»)", () => {
  it.each(["Хотим посмотреть квартиру", "Куда ехать?", "Скажите адрес, хотим завтра приехать", "Когда можно приехать?", "готовы купить",
    "Дидан мехоҳем", "Куҷо биёем?", "Кай омада метавонем?", "Мо харидори воқеӣ ҳастем", "Готовы купить, куда ехать?",
    "Какой адрес? Хотим завтра приехать", "Хотим посмотреть, сегодня не можем, завтра можно?", "Не могу найти, куда ехать?"])(
    "«%s» — горячие", text => expect(leadOnlyHotIntent(text)).toBe(true));
  it.each(["Здравствуйте", "Сколько стоит?", "Адрес вашего офиса?", "Какой адрес?", "Суроғаш куҷо аст?", "Можно посмотреть другие варианты?",
    "Мы пока не готовы купить", "Можно посмотреть фото?", "Какой адрес? Сегодня не могу, напишу позже", "Дидан мехоҳем, вале имрӯз наметавонем"])(
    "«%s» — не горячие", text => expect(leadOnlyHotIntent(text)).toBe(false));
});

describe("отказ от звонка и время звонка", () => {
  it.each(["Не хочу давать номер", "номер не дам", "Пишите здесь, звонить не надо", "без звонков пожалуйста", "Рақам намедиҳам", "занг назанед",
    "У меня нет номера для вас, пишите здесь", "Звонить не надо"])("«%s» — отказ", text => expect(leadOnlyPhoneRefused(text)).toBe(true));
  it.each(["Нет, звоните на 900 11 22 33", "Сколько стоит?", "Хочу посмотреть", "У меня нет номера объекта", "Номер квартиры не знаю",
    "Не звоните сейчас, позвоните завтра", "Ҳозир занг назанед, пагоҳ занг занед"])("«%s» — не отказ", text => expect(leadOnlyPhoneRefused(text)).toBe(false));
  it("время звонка — словами клиента, без цифр номера; пометка для агента", () => {
    expect(leadOnlyCallbackTime("Не звоните сейчас, позвоните завтра")).toBe("Не звоните сейчас, позвоните завтра");
    expect(leadOnlyCallbackTime("Хорошо. Звоните после 18:00")).toBe("Звоните после 18:00");
    expect(leadOnlyCallbackTime("Пагоҳ саҳар занг занед")).toBeTruthy();
    for (const text of ["Нет, звоните на 900 11 22 33", "Сколько стоит?", "Позвоните мне"]) expect(leadOnlyCallbackTime(text), text).toBeNull();
    const time = leadOnlyCallbackTime("Позвоните 93 555 12 34 завтра");
    expect(time).toMatch(/завтра/u);
    expect(time).not.toMatch(/555/u);
    expect(leadOnlyNoteWithCallbackTime("Хочет продать", "позвоните завтра")).toBe("Хочет продать. Когда звонить: «позвоните завтра»");
  });
  it("рабочие часы: вне окна честно «утром с <начала>»; предел просьб номера 1..3", () => {
    expect(leadOnlyCallbackWhen({ now: "20:15", workHoursStart: "09:30", workHoursEnd: "18:00" })).toEqual({ kind: "tomorrow_from", from: "09:30" });
    expect(leadOnlyCallbackWhen({ now: "07:00", workHoursStart: "09:30", workHoursEnd: "18:00" })).toEqual({ kind: "today_from", from: "09:30" });
    expect(leadOnlyCallbackWhen({ now: "12:00", workHoursStart: "09:30", workHoursEnd: "18:00" })).toEqual({ kind: "soon" });
    expect(clampMaxPhoneAsks(0)).toBe(1); expect(clampMaxPhoneAsks(9)).toBe(3); expect(clampMaxPhoneAsks(undefined)).toBe(2);
  });
});

describe("фильтры чужого текста", () => {
  it("подборка и ссылки вырезаются; один объект по вопросу и пустые строки — нет", () => {
    const out = leadOnlyFilterReply("Вот варианты:\n1. №12 Сино, 45 000 USD\n2. №15 Шохмансур, 50 000 USD\nhttps://royalhome.tj/listing/12\nАгент расскажет подробнее.");
    expect(out.changed).toBe(true);
    expect(out.text).not.toMatch(/№12|№15|https/u);
    expect(leadOnlyFilterReply("Цена объекта №12: 45 000 USD.")).toEqual({ text: "Цена объекта №12: 45 000 USD.", changed: false });
    expect(leadOnlyFilterReply("Здравствуйте!\n\n\n\nЧем помочь?").changed).toBe(false);
  });
  it("WhatsApp: режется только просьба телефона, номер объекта и номер офиса — нет", () => {
    expect(leadOnlyStripPhoneAsk("Да, такие квартиры есть. Оставьте, пожалуйста, ваш номер телефона.")).toEqual({ text: "Да, такие квартиры есть.", changed: true });
    expect(leadOnlyStripPhoneAsk("Рақами телефонатонро нависед.").text).toBe("");
    expect(leadOnlyStripPhoneAsk(`Позвоните нам: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`).changed).toBe(false);
    for (const text of ["Напишите номер объекта, который вам понравился.", "Подскажите номер квартиры, пожалуйста.", "Скиньте номер своей квартиры."]) {
      expect(leadOnlyStripPhoneAsk(text)).toEqual({ text, changed: false });
    }
    expect(leadOnlyStripPhoneAsk("Скиньте номер квартиры и ваш номер.")).toEqual({ text: "Скиньте номер квартиры.", changed: true });
    expect(leadOnlyStripPhoneAsk("Подскажите номер дома, а также ваш номер телефона?")).toEqual({ text: "Подскажите номер дома?", changed: true });
  });
});

describe("последняя дверь текста и запасная строка", () => {
  it("начало-согласие вырезается, пустой ответ — нейтральная благодарность", () => {
    expect(leadOnlyOutgoing("Хорошо, передаю агенту.", "ru")).toBe("Передаю агенту.");
    expect(leadOnlyOutgoing("Хуб, ба агент мерасонам.", "tg")).toBe("Ба агент мерасонам.");
    expect(leadOnlyOutgoing("Конечно.", "ru")).toBe("Спасибо за ваше сообщение.");
  });
  it("запасная строка не повторяется дословно; людей зовущие действия в режиме удержаны", () => {
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) sent.push(leadOnlyEscalateLine("tg", false, sent));
    expect(new Set(sent).size).toBe(3);
    for (const name of ["request_handover", "request_callback", "ask_owner", "book_showing"]) expect(leadOnlyWithholdsCustomerWrite(name)).toBe(true);
    expect(leadOnlyWithholdsCustomerWrite("save_contact")).toBe(false);
  });
});
