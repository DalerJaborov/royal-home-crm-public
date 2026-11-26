/**
 * «ОК / СПАСИБО / ПОКА» — РЕАКЦИЯ, А НЕ ТЕКСТ, ВО ВСЕХ ПУТЯХ ХОДА (владелец 26.11.2026).
 *
 * Живой случай (Instagram, ядро, режим «только заявки»):
 *   бот:    Спасибо, номер получил, агент вам позвонит.
 *   клиент: Ок
 *   бот:    Ваша заявка у агента, он с вами свяжется.   ← оператор ответил текстом, хотя отвечать было нечего
 *
 * Здесь — таблица фраз одной двери (ai/ackTurnDoor.ts) и сторож порядка: в каждом пути хода клиента дверь стоит ДО
 * оператора «только заявки» и до модели. НОВУЮ ЖИВУЮ ФРАЗУ — строкой в таблицу ниже (и словом в ai/ackOnly.ts).
 * Чистые функции и чтение исходников, база не нужна.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ackReactionTurn, lastBotSpeech, WAIT_CLOSES_WITHIN_MS } from "../src/ai/ackTurnDoor.js";
import { botAwaitsAnswer, isAckOnlyMessage, isClosingOnlyMessage, isThanksOnlyMessage } from "../src/ai/ackOnly.js";
import { silentTurnReason } from "../src/messengers/silentTurn.js";
import { buildInstagramReactionRequest, GRAPH_VERSION } from "../src/messengers/meta.js";
import { customerTurnSilenceIsIntended } from "../src/lib/customerIntendedSilence.js";

const PROMISE = "Спасибо, номер получил, агент вам позвонит.";
const PROMISE_TG = "Ташаккур, рақамро қабул кардем. Агенти мо ба зудӣ бо шумо тамос мегирад.";
const QUESTION = "Хотите посмотреть квартиру?";
const OFFER = "Если хотите, агент позвонит, всё подробно расскажет и покажет.";
const OFFER_TG = "Агар хоҳед, агенти мо занг мезанад, ҳамаашро мегӯяд ва нишон медиҳад.";
const PHONE_ASK = "Напишите, пожалуйста, ваш номер телефона, агент позвонит, всё подробно расскажет и покажет.";
const PHONE_ASK_TG = "Рақами телефонатонро нависед, агент занг зада, ҳамаашро мегӯяд ва нишон медиҳад.";
const CLOSING_BOT = "Саломат бошед! Агар савол бошад, нависед";

/** Реакция вместо текста: 0 текстов, 0 вызовов модели. */
const REACT: Array<[string, string]> = [
  ["Ок", PROMISE], ["ок", PROMISE], ["Ok", PROMISE], ["окей", PROMISE], ["Оккк", PROMISE], ["Хорошо", PROMISE],
  ["Спасибо", PROMISE], ["Спасибооо", PROMISE], ["Благодарю", PROMISE], ["Спасибо большое!", PROMISE],
  ["Пока", PROMISE], ["До свидания", PROMISE], ["До связи", PROMISE], ["Всего доброго", PROMISE], ["Хорошего дня!", PROMISE],
  ["Хорошо, жду", PROMISE], ["Спасибо, жду звонка", PROMISE], ["Ладно, буду ждать", PROMISE],
  ["Ок спасибо брат", PROMISE], ["Ок, договорились", PROMISE], ["Спасибо за информацию", PROMISE], ["Ну ок тогда", PROMISE],
  ["👍", PROMISE], ["❤️", PROMISE], ["👌🙏❤️🔥", PROMISE], ["Ок 👍", PROMISE],
  // таджикский
  ["Рахмат", PROMISE_TG], ["Раҳмат ака", PROMISE_TG], ["Рахмат брат", PROMISE_TG], ["Ташаккур", PROMISE_TG], ["Ташаккури зиёд", PROMISE_TG],
  ["Хоп", PROMISE_TG], ["Хуб шуд", PROMISE_TG], ["Майлаш", PROMISE_TG], ["Хайр", PROMISE_TG], ["Худо ҳофиз", PROMISE_TG],
  ["Худо хофиз", PROMISE_TG], ["То дидор", PROMISE_TG], ["Хуш", PROMISE_TG], ["Саломат бошед", PROMISE_TG],
  ["Хоп, интизор мешавам", PROMISE_TG], ["Рахмат, мунтазирам", PROMISE_TG], ["Барака ёбед", PROMISE_TG],
  // латиница
  ["Rahmat", PROMISE_TG], ["rahmat aka", PROMISE_TG], ["Xop", PROMISE_TG], ["Tashakkur", PROMISE_TG], ["Spasibo", PROMISE], ["Poka", PROMISE],
  ["Xayr", PROMISE_TG], ["Thanks", PROMISE],
  // закрывающая реплика бота «пишите, если будут вопросы» — ответа не ждёт
  ["Ок", CLOSING_BOT], ["Ок", "Номер получил, напишите, если будут вопросы."], ["Ок", "Агент может позвонить вам в течение дня."],
  // закрытие — не ответ даже на вопрос или предложение бота
  ["Пока", QUESTION], ["Рахмат, худо ҳофиз", OFFER_TG], ["Спасибо, до свидания", OFFER], ["Хайр", PHONE_ASK_TG],
];

/** Обычный ход: в сообщении есть содержание, или бот ждал ответа, или бот ещё ничего не говорил. */
const TURN: Array<[string, string | null, string]> = [
  ["Ок, а цена?", PROMISE, "вопрос"],
  ["Ок, а сколько стоит", PROMISE, "вопрос без знака — слово «сколько» не вежливость"],
  ["Ок 918000000", PROMISE, "номер"],
  ["Жду звонка завтра в 10", PROMISE, "время звонка — содержание (leadOnlyCallbackTime)"],
  ["Жду звонка завтра", PROMISE, "день звонка — содержание"],
  ["Жду звонка", PROMISE, "голое «жду звонка» — так клиент и напоминает о себе (жалоба, ai/complaintGuard.ts)"],
  ["Мунтазирам", PROMISE_TG, "то же по-таджикски"],
  ["Жду", PROMISE, "одно ожидание без «спасибо/хорошо» — напоминание (ревью 26.11.2026)"],
  ["Буду ждать", PROMISE, "то же"],
  ["Жду вашего звонка", PROMISE, "то же"],
  ["Ждём звонка", PROMISE, "то же"],
  ["Ваалейкум ассалом", PROMISE_TG, "ответ на приветствие — приветствие для оператора, не «ок»"],
  ["Рахмат", OFFER_TG, "«спасибо» на предложение звонка — согласие, оператор оформит заявку (ревью 26.11.2026)"],
  ["Спасибо", QUESTION, "«спасибо» на вопрос бота — обычный ход (не разговор о вакансии)"],
  ["Ташаккур", PHONE_ASK_TG, "«спасибо» на просьбу номера — обычный ход"],
  ["Да", "Можете оставить номер, агент перезвонит.", "просьба номера словом «оставить»"],
  ["Ок", "Можете написать свой номер телефона.", "просьба номера словом «написать»"],
  ["Ок", "Пришлите номер, агент позвонит.", "«пришлите номер»"],
  ["Да", "Если нужно, агент позвонит и всё расскажет.", "предложение «если нужно»"],
  ["Хорошо, 5 этаж", PROMISE, "деталь"],
  ["Хочу двушку в Сино", PROMISE, "заявка"],
  ["Салом", PROMISE, "приветствие — не прощание"],
  ["Добрый день", PROMISE, "приветствие"],
  ["Ок", QUESTION, "«ок» на вопрос бота — ответ"],
  ["Да", QUESTION, "«да» на вопрос — ответ"],
  ["Хорошо", OFFER, "«хорошо» на предложение звонка — согласие (заявка)"],
  ["Хоп", OFFER_TG, "то же по-таджикски"],
  ["Ок", PHONE_ASK, "«ок» на просьбу номера — согласие, бот спросит «куда позвонить»"],
  ["Майлаш", PHONE_ASK_TG, "то же по-таджикски"],
  ["Ваалейкум ассалом", "Ассалому алейкум! Чем могу помочь?", "ответ на приветствие с вопросом"],
  ["Ок", null, "бот ещё ничего не говорил"],
  ["🖕", PROMISE, "грубый смайлик — не согласие"],
  ["👎", PROMISE, "несогласие"],
];

describe("одна дверь: «ок / спасибо / пока» → реакция", () => {
  it.each(REACT)("«%s» после «%s» → реакция", (text, lastBot) => {
    expect(ackReactionTurn({ text, hasMedia: false, lastBotText: lastBot })).toBe(true);
  });
  it.each(TURN)("«%s» после «%s» → обычный ход (%s)", (text, lastBot) => {
    expect(ackReactionTurn({ text, hasMedia: false, lastBotText: lastBot })).toBe(false);
  });
  it("разговор о вакансии: «спасибо» на вопрос бота — реакция (бот слал блок вакансии заново, 11.11.2026)", () => {
    expect(ackReactionTurn({ text: "Спасибо", hasMedia: false, lastBotText: QUESTION, jobTopic: true })).toBe(true);
    expect(ackReactionTurn({ text: "Ок", hasMedia: false, lastBotText: QUESTION, jobTopic: true })).toBe(false);
  });
  it("«Жду» сразу после обещания бота — реакция; через часы — напоминание, обычный ход; на вопрос бота — ответ", () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    for (const text of ["Жду", "Буду ждать", "Жду вашего звонка", "Мунтазирам", "Интизор мешавам"]) {
      expect(ackReactionTurn({ text, hasMedia: false, lastBotText: PROMISE, lastBotAt: now - 60_000, now }), text).toBe(true);
      expect(ackReactionTurn({ text, hasMedia: false, lastBotText: PROMISE, lastBotAt: now - WAIT_CLOSES_WITHIN_MS - 60_000, now }), text).toBe(false);
      expect(ackReactionTurn({ text, hasMedia: false, lastBotText: QUESTION, lastBotAt: now - 60_000, now }), text).toBe(false);
    }
    expect(ackReactionTurn({ text: "Жду звонка завтра в 10", hasMedia: false, lastBotText: PROMISE, lastBotAt: now - 60_000, now })).toBe(false);
  });
  it("последние слова бота: фото, ссылка, геометка и неотправленное пропускаются (одна функция на все пути)", () => {
    const history = [
      { role: "assistant", content: QUESTION, at: "2026-11-26T09:00:00Z" },
      { role: "assistant", content: "[📷 фото объекта]", at: "2026-11-26T09:00:01Z" },
      { role: "assistant", content: "", attachments: [{ kind: "image" }], at: "2026-11-26T09:00:02Z" },
      { role: "assistant", content: "📍 https://maps.example/x", at: "2026-11-26T09:00:03Z" },
      { role: "assistant", content: "Ещё один вариант", deliveryStatus: "failed", at: "2026-11-26T09:00:04Z" },
    ];
    expect(lastBotSpeech(history)?.text).toBe(QUESTION);
    expect(ackReactionTurn({ text: "Да", hasMedia: false, lastBotText: lastBotSpeech(history)?.text })).toBe(false);
    expect(lastBotSpeech([{ role: "user", content: "Ок" }])).toBeNull();
    expect(lastBotSpeech([{ role: "assistant", content: PROMISE, at: "2026-11-26T11:00:00Z" }], Date.parse("2026-11-26T10:00:00Z"))).toBeNull();
  });
  it("вложение — всегда обычный ход, даже с подписью «Ок»", () => {
    expect(ackReactionTurn({ text: "Ок", hasMedia: true, lastBotText: PROMISE })).toBe(false);
  });
  it("Telegram и Direct Messages решают той же дверью (silentTurnReason)", () => {
    const history = [{ role: "assistant" as const, content: PROMISE }];
    expect(silentTurnReason({ text: "До свидания", hasMedia: false, history })).toBe("ack_only");
    expect(silentTurnReason({ text: "Ок, а цена?", hasMedia: false, history })).toBeNull();
    expect(silentTurnReason({ text: "Ок", hasMedia: false, history: [{ role: "assistant", content: OFFER }] })).toBeNull();
  });
  it("классы фраз: благодарность, закрытие, ожидание предложения", () => {
    expect(isThanksOnlyMessage("Рахмат брат")).toBe(true);
    expect(isThanksOnlyMessage("Ок спасибо")).toBe(false);
    expect(isClosingOnlyMessage("Спасибо, до свидания")).toBe(true);
    expect(isClosingOnlyMessage("Хорошо, пока")).toBe(false);
    expect(isAckOnlyMessage("жду звонка")).toBe(false);
    expect(botAwaitsAnswer(PROMISE)).toBe(false);
    expect(botAwaitsAnswer(CLOSING_BOT)).toBe(false);
    expect(botAwaitsAnswer(OFFER)).toBe(true);
    expect(botAwaitsAnswer(PHONE_ASK_TG)).toBe(true);
  });
  it("молчание ядра с реакцией — намеренное: человека не зовут", () => {
    expect(customerTurnSilenceIsIntended("ack_only_reaction")).toBe(true);
  });
});

describe("реакция Instagram/Messenger — запрос по документации Meta", () => {
  it("Instagram: /me/messages, sender_action react, payload love", () => {
    const req = buildInstagramReactionRequest("INSTAGRAM", {}, "igsid-1", "mid.abc");
    expect(req.url).toContain(`/${GRAPH_VERSION}/me/messages`);
    expect(req.body).toEqual({ recipient: { id: "igsid-1" }, sender_action: "react", payload: { message_id: "mid.abc", reaction: "love" } });
  });
  it("Messenger: через Страницу; без Страницы — явная ошибка", () => {
    const req = buildInstagramReactionRequest("FACEBOOK", { pageId: "page-1" }, "psid-1", "m_1");
    expect(req.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/page-1/messages`);
    expect(() => buildInstagramReactionRequest("FACEBOOK", {}, "psid-1", "m_1")).toThrow(/Страницы/);
  });
  it("снять реакцию — unreact", () => {
    expect((buildInstagramReactionRequest("INSTAGRAM", {}, "igsid-1", "mid.abc", "unreact").body as { sender_action: string }).sender_action).toBe("unreact");
  });
});

/**
 * СТОРОЖ ПОРЯДКА. Каждый путь хода клиента зовёт дверь раньше оператора «только заявки» и модели. Новый путь без
 * двери или дверь, переехавшая ниже модели, — красный тест (так «Ок» и дошёл до оператора ядра 26.11.2026).
 */
const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const before = (file: string, door: string, later: string[]) => {
  const text = src(file), at = text.indexOf(door);
  expect(at, `${file}: нет двери ${door}`).toBeGreaterThan(0);
  for (const name of later) expect(text.indexOf(name), `${file}: ${name} раньше двери или его нет`).toBeGreaterThan(at);
};
describe("сторож: дверь стоит до оператора и модели во всех путях", () => {
  it("старый путь Meta (messengers/conversation.ts)", () => {
    const text = src("messengers/conversation.ts");
    const door = text.indexOf("ackReactionTurn({");
    expect(door).toBeGreaterThan(0);
    expect(text.indexOf("await runOperatorTurn(")).toBeGreaterThan(door);
    expect(text.indexOf("await runLegacyQualifyTurn(")).toBeGreaterThan(door);
  });
  it("ядро (lib/customerDmAgentTurn.ts)", () => {
    before("lib/customerDmAgentTurn.ts", "ackReactionTurn({", ["planCustomerLeadOnlyTurn({", "perceiveCustomerMediaSafely(", "spendTurnBudget(wait)"]);
  });
  it("узкий путь (messengers/customerQualifierTurn.ts)", () => {
    before("messengers/customerQualifierTurn.ts", "ackReactionTurn({", ["await runLegacyQualifyTurn(", "spendAiTurns("]);
  });
  it("Telegram и Direct Messages — silentTurnReason до модели, а он — через дверь", () => {
    expect(src("messengers/silentTurn.ts")).toContain("ackReactionTurn(");
    for (const file of ["telegram/bot.ts", "messengers/telegramDirectMessages.ts"]) {
      expect(src(file), file).toContain("silentTurnReason({");
    }
  });
  it("ни один путь хода не решает «ок» своей копией правила", () => {
    for (const file of ["messengers/conversation.ts", "lib/customerDmAgentTurn.ts", "messengers/customerQualifierTurn.ts",
      "messengers/silentTurn.ts", "telegram/bot.ts", "messengers/telegramDirectMessages.ts"]) {
      expect(src(file), file).not.toMatch(/isAckOnlyMessage\(|botAskedQuestion\(/);
    }
  });
  it("в вебхуке Meta нет отправки смайлика отдельным сообщением", () => {
    const text = src("routes/webhooks.ts");
    expect(text).not.toContain("emojiThanksReply(");
    expect(text).toContain("sendCustomerReaction(");
  });
});
