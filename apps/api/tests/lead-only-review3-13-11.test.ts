import { describe, expect, it } from "vitest";
import { leadOnlyCallbackNotedLine, leadOnlyCallbackTime, leadOnlyHotIntent, leadOnlyNoteWithCallbackTime, leadOnlyPhoneAskHistory,
  leadOnlyPhoneRefused, leadOnlyServerLine, leadOnlyStripPhoneAsk, LEAD_ONLY_DEFAULTS } from "../src/ai/leadOnlyMode.js";
import { LEAD_ONLY_PENDING_TTL_MS, leadOnlyPendingOf, leadOnlyPendingOfRow, parseLeadOnlyPending } from "../src/lib/leadOnlyPending.js";
import { legacyLeadOnlyDraftForPhone } from "../src/messengers/leadOnlyLegacy.js";
import { leadOnlyIntentFallback } from "../src/ai/leadOnlyIntent.js";

/**
 * Третье ревью режима «только заявки» (13.11.2026): чистые решения. Стык с базой и маршрутами —
 * lead-only-mode-legacy-postgres.test.ts и lead-only-review-13-11-postgres.test.ts (разделы «третье ревью»).
 * Номер находки — в имени теста; каждый проверен внесённой поломкой (журнал docs/journal/2026-11-13-bot-lead-only-mode.md).
 */
const config = { ...LEAD_ONLY_DEFAULTS, enabled: true };
const A = "6f1c1e51-4b0a-4c55-9d43-1f2f7e1e0a21", B = "6f1c1e51-4b0a-4c55-9d43-1f2f7e1e0a22";

describe("№1: тема и объект ЭТОГО сообщения сильнее памяти просьбы (старый путь, ветка номера)", () => {
  const pendingA = leadOnlyPendingOf("property", A);
  const history = [{ role: "user" as const, content: "Здравствуйте" },
    { role: "assistant" as const, content: "Это объект №1, цена 400 000 сомони. Оставьте, пожалуйста, номер телефона, агент перезвонит." }];
  // Решения кода: дверь намерения без модели (запасной путь) — ai/leadOnlyIntent.ts.
  const base = { config, history, draft: { stage: "chatting" as const }, carriedPropertyId: null, classifyIntent: async (text: string) => leadOnlyIntentFallback(text) };
  it("через три дня после поста A «хочу продать свою квартиру, 93…» — продавец без объекта A", async () => {
    const draft = await legacyLeadOnlyDraftForPhone({ ...base, text: "Хочу продать свою квартиру, 93 123 45 67", freshPropertyId: null, pending: pendingA });
    expect(draft.intent).toBe("sell");
    expect(draft.requestedPropertyId).toBeUndefined();
  });
  it("пост объекта B с номером — заявка по B, а не по запомненному A", async () => {
    const draft = await legacyLeadOnlyDraftForPhone({ ...base, text: "93 123 45 67", freshPropertyId: B, pending: pendingA });
    expect(draft.requestedPropertyId).toBe(B);
  });
  it("голый номер в ответ на просьбу — по-прежнему объект A из памяти", async () => {
    expect((await legacyLeadOnlyDraftForPhone({ ...base, text: "93 123 45 67", freshPropertyId: null, pending: pendingA })).requestedPropertyId).toBe(A);
  });
  it("продавец не уезжает агенту чужого объекта, оставшегося в черновике", async () => {
    const draft = await legacyLeadOnlyDraftForPhone({ ...base, draft: { stage: "chatting", requestedPropertyId: A }, carriedPropertyId: A,
      text: "Хочу продать свою квартиру, 93 123 45 67", freshPropertyId: null, pending: null });
    expect(draft.requestedPropertyId).toBeUndefined();
  });
});

describe("№2: память просьбы живёт трое суток и не читается у диалога с карточкой", () => {
  it("срок — трое суток", () => {
    const now = new Date("2026-11-13T10:00:00Z");
    expect(LEAD_ONLY_PENDING_TTL_MS).toBe(3 * 24 * 60 * 60_000);
    const pending = leadOnlyPendingOf("property", A, now);
    expect(parseLeadOnlyPending(pending, new Date("2026-11-16T09:59:59Z"))?.propertyId).toBe(A);
    expect(parseLeadOnlyPending(pending, new Date("2026-11-16T10:00:01Z"))).toBeNull();
  });
  it("у диалога с карточкой памяти нет", () => {
    const pending = leadOnlyPendingOf("property", A);
    expect(leadOnlyPendingOfRow({ clientId: null, leadOnlyPending: pending })?.propertyId).toBe(A);
    expect(leadOnlyPendingOfRow({ clientId: "c", leadOnlyPending: pending })).toBeNull();
  });
});

describe("№3: «номер объекта / квартиры» — не телефон", () => {
  it.each(["Напишите номер объекта, который вам понравился.", "Подскажите номер квартиры, пожалуйста.", "Рақами объектро нависед, лутфан."])(
    "«%s» в WhatsApp не вырезается и не считается просьбой номера", text => {
      expect(leadOnlyStripPhoneAsk(text)).toEqual({ text, changed: false });
      expect(leadOnlyPhoneAskHistory([text]).asksSoFar).toBe(0);
    });
  it("просьба телефона рядом с номером объекта по-прежнему вырезается", () => {
    expect(leadOnlyStripPhoneAsk("Напишите номер объекта. Оставьте ваш номер телефона.")).toEqual({ text: "Напишите номер объекта.", changed: true });
    expect(leadOnlyPhoneAskHistory(["Напишите ваш номер, агент позвонит."]).asksSoFar).toBe(1);
  });
});

describe("№4: отказ — только явный отказ дать свой телефон; «позвоните завтра» — согласие со временем", () => {
  it.each(["У меня нет номера объекта", "Номер квартиры не знаю", "Не звоните сейчас, позвоните завтра", "Сейчас не звоните, я на работе, звоните после 6",
    "Ҳозир занг назанед, пагоҳ занг занед"])("«%s» — не отказ", text => expect(leadOnlyPhoneRefused(text)).toBe(false));
  it.each(["Не хочу давать номер", "У меня нет номера для вас, пишите здесь", "Звонить не надо", "Рақам намедиҳам"])("«%s» — отказ", text =>
    expect(leadOnlyPhoneRefused(text)).toBe(true));
  it("время звонка берётся словами клиента и уходит в пометку заявки", () => {
    expect(leadOnlyCallbackTime("Не звоните сейчас, позвоните завтра")).toBe("Не звоните сейчас, позвоните завтра");
    expect(leadOnlyCallbackTime("Хорошо. Звоните после 18:00")).toBe("Звоните после 18:00");
    expect(leadOnlyCallbackTime("Пагоҳ саҳар занг занед")).toBeTruthy();
    for (const text of ["Нет, звоните на 900 11 22 33", "Сколько стоит?", "Позвоните мне"]) expect(leadOnlyCallbackTime(text), text).toBeNull();
    expect(leadOnlyNoteWithCallbackTime("Хочет продать", "позвоните завтра")).toBe("Хочет продать. Когда звонить: «позвоните завтра»");
  });
  it("ответ «передам агенту» — текст сервера (память ядра его узнаёт) и не повторяется дословно", () => {
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) sent.push(leadOnlyCallbackNotedLine("ru", sent));
    expect(new Set(sent).size).toBe(3);
    for (const line of [...sent, leadOnlyCallbackNotedLine("tg")]) expect(leadOnlyServerLine(line), line).toBe(true);
  });
});

describe("№5: «не могу / напишу позже» гасит горячее", () => {
  it.each(["Какой адрес? Сегодня не могу, напишу позже", "Хотим посмотреть, но не сейчас", "Можно посмотреть? Позже напишу",
    "Дидан мехоҳем, вале имрӯз наметавонем"])("«%s» — не горячие", text => expect(leadOnlyHotIntent(text)).toBe(false));
  it.each(["Хотим посмотреть, сегодня не можем, завтра можно?", "Не могу найти, куда ехать?", "Какой адрес? Хотим завтра приехать"])(
    "«%s» — горячие", text => expect(leadOnlyHotIntent(text)).toBe(true));
});
