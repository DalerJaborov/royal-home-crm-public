import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { html, plain, voice, buttons } = vi.hoisted(() => ({ html: vi.fn(), plain: vi.fn(), voice: vi.fn(), buttons: vi.fn() }));
vi.mock("../src/telegram/api.js", () => ({ sendHtmlMessage: html, sendMessage: plain, sendMessageWithButtons: buttons,
  TelegramApiError: class extends Error {
    constructor(public errorCode: number, method: string, message: string) { super(`${method}: ${message}`); }
  },
}));
vi.mock("../src/telegram/assistantVoice.js", () => ({ sendAssistantVoiceReply: voice, speechTextFromReply: (text: string) => text }));
import { TelegramApiError } from "../src/telegram/api.js";
import { sendAssistantReply } from "../src/telegram/assistantDelivery.js";
import { decorateHtml, prepareAssistantReply, renderAssistantHtml, requestedAssistantReplyMode, sanitizeAssistantReply, splitHumanMessages, splitReaction } from "../src/telegram/assistantReply.js";
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { vi.clearAllMocks(); html.mockReset().mockResolvedValue({}); plain.mockReset().mockResolvedValue({}); voice.mockReset().mockResolvedValue(true); vi.stubEnv("CRM_PUBLIC_URL", "https://crm.test"); });
const ctx = { scope: "private" as const, fromVoice: true, written: [] };
describe("privacy and content", () => {
  it.each(["992.90.123.45.67", "+992901234567", "+992‑90‑123‑45‑67", "+۹۹۲۹۰۱۲۳۴۵۶۷", "90/123/45/67", "90 123 45 67", "@example_contact", "https://t.me/example_contact"])("masks %s before speech and HTML", (contact) => {
    const p = prepareAssistantReply(`Контакт: ${contact}`, true);
    expect(p.text).not.toContain(contact);
    expect(p.speech).not.toContain(contact);
    expect(renderAssistantHtml(p.text, { maskPhones: true })).not.toContain(contact);
  });
  it.each(["1 200 000 сомони", "120000000 сомони", "03-11-2026"])("preserves %s", (value) => {
    const p = prepareAssistantReply(`Данные: ${value}`, true);
    expect(p.text).toContain(value);
    expect(p.speech).toContain(value);
    expect(renderAssistantHtml(p.text, { maskPhones: true })).toContain(value);
  });
  it("strips link parameters, rejects non-card paths and escapes markup", () => {
    expect(renderAssistantHtml('[<b>Имя</b>](/clients/112?phone=992901234567#x)', { maskPhones: true })).toBe('<a href="https://crm.test/clients/112">&lt;b&gt;Имя&lt;/b&gt;</a>');
    for (const path of ['/admin', '//evil.test', '/clients/112/extra', '/clients/x"onclick="x'])
      expect(renderAssistantHtml(`[Имя](${path})`, { maskPhones: true })).toBe('Имя');
    expect(sanitizeAssistantReply('[Объект](/properties/112)', true)).toBe('[Объект](/properties/112)');
  });
  it("puts the property number in its only link and hides temperature labels", () => {
    const html = renderAssistantHtml("[2-комн · ОВИР](/properties/104) (`ОБ-000104`) — статус HOT.", { maskPhones: true });
    expect(html).toBe('<a href="https://crm.test/properties/104">ОБ-000104 · 2-комн · ОВИР</a>.');
    expect(sanitizeAssistantReply("Агент: Маъруф, статус: холодный", true)).toBe("Агент: Маъруф");
  });
  it.each(["60-70 метри мураббаъ", "60–70 м²"])("reads a Tajik area range aloud: %s", async area => {
    const text = `Квартираи «коробка» меҷӯянд. Майдонаш ${area}, тирезаҳои зиёд.`;
    const speech = "Квартираи «коробка» меҷӯянд. Майдонаш аз шаст то ҳафтод метри мураббаъ, тирезаҳои зиёд.";
    expect(prepareAssistantReply(text)).toMatchObject({ text, speech, language: "tg", needsText: false });
    await sendAssistantReply("test", text, { ...ctx, mode: "voice" });
    expect(voice).toHaveBeenCalledWith("test", speech, undefined);
    expect(html.mock.calls[0][1]).toContain(area);
  });
  it("keeps a decimal area and ambiguous number ranges in text", () => {
    for (const text of ["Ҳоло майдонаш 68,5 м².", "Рақами объект 60-70."]) {
      expect(prepareAssistantReply(text)).toMatchObject({ text, speech: "", language: "tg", needsText: true });
    }
  });
  it("retains authorised private text, never recites contact", () => {
    const p = prepareAssistantReply('Телефон +992901234567');
    expect(p.text).toContain('+992901234567');
    expect(p.speech).not.toContain('901234567');
    expect(p.needsText).toBe(true);
  });
  it("preserves the written price and expands it only for Tajik speech", () => {
    const text = "Нархаш 120 000 000 сомонӣ.";
    expect(prepareAssistantReply(text, true)).toMatchObject({
      text, speech: "Нархаш саду бист миллион сомонӣ.", language: "tg",
    });
  });
  it("retains a dollar-prefixed amount in text and Tajik speech", () => {
    const text = "Салом, нарх $120000000.";
    expect(prepareAssistantReply(text, true)).toMatchObject({
      text, speech: "Салом, нарх саду бист миллион доллар.", language: "tg",
    });
  });
  it.each(["99,5 сомонӣ", "03.11.2026", "2026-11-03 09:30", "ОБ-000123", "соати 25:90"])("keeps ambiguous %s as text", async (value) => {
    const text = `Салом, ${value}.`;
    await sendAssistantReply("test", text, { ...ctx, scope: "group" });
    expect(voice).not.toHaveBeenCalled();
    expect(html.mock.calls[0][1]).toContain(value);
  });
  it("does not cut an expanded amount into a different value", () => {
    const text = `Нархаш ${"а".repeat(294)} 630000 сомонӣ.`;
    expect(prepareAssistantReply(text)).toMatchObject({ text, speech: "", needsText: true, truncated: true });
  });
  it("caps speech with ellipsis and retains 340-char text", () => {
    const text = 'Ответ ' + 'а'.repeat(334), p = prepareAssistantReply(text);
    expect(p.text).toBe(text);
    expect(p.speech.length).toBeLessThanOrEqual(320);
    expect(p.truncated).toBe(true);
    expect(p.needsText).toBe(true);
  });
  it.each(['Салом, ман ёфтам.', 'Ташаккур!', 'Маълумотро санҷед.', 'Омода шуд.', 'Мизочро ёфтам.', 'Интихоб кунед.'])('detects Tajik: %s', text => expect(prepareAssistantReply(text).language).toBe('tg'));
  it('reaction whitelist and VS16', () => {
    expect(splitReaction('[реакция: ❤️] Спасибо')).toEqual({ reaction: '❤', text: 'Спасибо' });
    expect(splitReaction('[реакция: 💩] Ответ')).toEqual({ reaction: null, text: 'Ответ' });
    expect(splitReaction('[реакция: 👍abc] Ответ').reaction).toBeNull();
  });
  it('one, two and five messages retain content', () => {
    expect(splitHumanMessages('Одна')).toEqual(['Одна']);
    expect(splitHumanMessages('Одна ||| Две')).toEqual(['Одна', 'Две']);
    expect(splitHumanMessages('1 ||| 2 ||| 3 ||| 4 ||| 5')).toEqual(['1', '2', '3', '4\n5']);
  });
  it('decorates phone, card and sum, preserves masked phone', () => expect(decorateHtml('+992901234567 ОБ-123 1 200 000 сомони +992•••••3726')).toBe('<code>+992901234567</code> <code>ОБ-123</code> <b>1 200 000 сомони</b> +992•••••3726'));
});
describe('delivery', () => {
  const longVoice = [
    "Хорошо, давайте спокойно разберёмся и договоримся, с чего удобнее начать. Так будет проще понять друг друга и не запутаться по дороге.",
    "Потом я помогу разобрать всё по шагам и отвечу на ваши вопросы. Если что-то покажется непонятным, можем спокойно к этому вернуться.",
    "Когда станет ясно, как действовать дальше, подведём итог. Так у всех останется одно понятное решение, которое легко обсудить вместе.",
  ];
  const longTajikVoice = [
    "Хуб, биёед оромона гап занем ва фаҳмем, ки аз куҷо сар кардан осонтар аст. Ҳамин тавр гапи ҳамдигарро беҳтар мефаҳмем.",
    "Баъд ҳамаашро оҳиста дида мебароем, то ягон гап аз хотир наравад. Агар савол монад, боз ба ҳамон гап бармегардем.",
    "Дар охир гапамонро ҷамъ мекунем, то ҳама фаҳманд, ки баъд чӣ кор кардан лозим. Агар хоҳед, якҷоя боз месанҷем.",
  ];
  it.each([longVoice, longTajikVoice])("splits an explicit long voice reply and sends no duplicate text", async (...sentences) => {
    await sendAssistantReply("test", sentences.join(" "), { ...ctx, mode: "voice", replyTo: 42 });
    expect(voice.mock.calls.length).toBeGreaterThan(1);
    expect(voice.mock.calls.length).toBeLessThanOrEqual(4);
    expect(voice.mock.calls.map(([, words]) => words).join(" ")).toBe(sentences.join(" "));
    expect(voice.mock.calls.map(([, , replyTo]) => replyTo)).toEqual([42, ...Array(voice.mock.calls.length - 1).fill(undefined)]);
    expect(html).not.toHaveBeenCalled();
  });
  it.each([
    ["ru", "Сначала проверь карточку."],
    ["tg", "Як дам."],
  ] as const)("uses the known %s request language for otherwise unclassified conversation", async (language, reply) => {
    await sendAssistantReply("test", reply, { ...ctx, mode: "voice", requestLanguage: language });
    expect(voice).toHaveBeenCalledExactlyOnceWith("test", reply, undefined, language);
    expect(html).not.toHaveBeenCalled();
  });
  it.each([
    ["mixed", "Сначала проверь карточку.", false],
    ["unknown", "Сначала проверь карточку.", false],
    ["ru", "Где вы, шумо дар кор?", false],
    ["ru", "Some words. Сначала проверь карточку.", false],
    ["ru", "Прывітанне.", false],
    ["ru", "Сначала проверь карточку.", true],
  ] as const)("keeps an unsafe language fallback or structured result in text: %s %s", async (requestLanguage, reply, structured) => {
    await sendAssistantReply("test", reply, { ...ctx, mode: "voice", requestLanguage, structured });
    expect(voice).not.toHaveBeenCalled();
    expect(html).toHaveBeenCalledOnce();
  });
  it("does not repeat successfully spoken parts after a later voice failure", async () => {
    voice.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await sendAssistantReply("test", longVoice.join(" "), { ...ctx, mode: "voice" });
    expect(voice).toHaveBeenCalledTimes(2);
    const spoken = voice.mock.calls[0][1] as string;
    const written = html.mock.calls.map(([, content]) => content).join(" ");
    expect(`${spoken} ${written}`).toBe(longVoice.join(" "));
  });
  it("anchors all parts of an explicit group voice reply to the original message", async () => {
    await sendAssistantReply("-100", longTajikVoice.join(" "), { ...ctx, scope: "group", mode: "voice", replyTo: 42 });
    expect(voice.mock.calls.length).toBeGreaterThan(1);
    expect(voice.mock.calls.every(([, , replyTo]) => replyTo === 42)).toBe(true);
  });
  it('successful HTML never falls back', async () => { await sendAssistantReply('test', 'Нашла.', { ...ctx, fromVoice: false }); expect(html).toHaveBeenCalledTimes(1); expect(plain).not.toHaveBeenCalled(); expect(voice).not.toHaveBeenCalled(); });
  it('short voice only', async () => { await sendAssistantReply('test', 'Готово.', ctx); expect(voice).toHaveBeenCalledWith('test', 'Готово.', undefined); expect(html).not.toHaveBeenCalled(); });
  it.each(['Источник https://example.com', 'Нашла [Клиента](/clients/112)', 'Ответ ' + 'а'.repeat(334), 'Подробности пришлю текстом.', 'На сегодня 3 показа.'])('uses text for reference material: %s', async (text) => {
    await sendAssistantReply('test', text, ctx);
    expect(voice).not.toHaveBeenCalled();
    expect(html).toHaveBeenCalled();
  });
  it("uses text for a short data result and follows an explicit voice request", async () => {
    await sendAssistantReply("test", "Вариантов не нашла.", { ...ctx, structured: true });
    expect(voice).not.toHaveBeenCalled();
    await sendAssistantReply("test", "Нашла [квартиру](/properties/112).", { ...ctx, mode: "voice" });
    expect(voice).toHaveBeenCalledWith("test", "Нашла квартиру.", undefined);
    expect(html.mock.calls.at(-1)?.[3]).toEqual([[{ text: "квартиру", url: "https://crm.test/properties/112" }]]);
  });
  it("keeps the list buttons when Telegram rejects HTML markup", async () => {
    html.mockRejectedValue(new TelegramApiError(400, "sendMessage", "can't parse entities"));
    await sendAssistantReply("test", "Нашла [квартиру](/properties/112).", ctx);
    expect(buttons).toHaveBeenCalledWith("test", expect.stringContaining("квартиру"),
      [[{ text: "квартиру", url: "https://crm.test/properties/112" }]], undefined);
  });
  it("reads a direct reply preference but ignores an indirect reference", () => {
    expect(requestedAssistantReplyMode("Проверь, ответь текстом.")).toBe("text");
    expect(requestedAssistantReplyMode("Проверь и ответь голосом")).toBe("voice");
    expect(requestedAssistantReplyMode("Санҷед, бо овоз ҷавоб деҳ")).toBe("voice");
    expect(requestedAssistantReplyMode("Клиент ответил голосом")).toBe("auto");
  });
  it('done action has receipt', async () => { await sendAssistantReply('test', 'Готово.', { ...ctx, written: ['Записано: заметка'] }); expect(html.mock.calls[0][1]).toContain('Записано: заметка'); });
  it('unconfigured Tajik voice leaves text', async () => { voice.mockResolvedValue(false); await sendAssistantReply('test', 'Салом, ман ёфтам.', ctx); expect(voice).toHaveBeenCalled(); expect(html).toHaveBeenCalled(); });
  it('unknown language stays text', async () => { await sendAssistantReply('test', 'Unknown words', ctx); expect(voice).not.toHaveBeenCalled(); expect(html).toHaveBeenCalled(); });
  it('stops further voice spending after a failure', async () => { voice.mockResolvedValue(false); await sendAssistantReply('test', 'Готово. ||| Нашла.', ctx); expect(voice).toHaveBeenCalledTimes(1); expect(html).toHaveBeenCalledTimes(2); });
  it("only sends the missing reply as text after the second voice fails", async () => {
    voice.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await sendAssistantReply("test", "Готово. ||| Нашла.", ctx);
    expect(voice).toHaveBeenCalledTimes(2);
    expect(html).toHaveBeenCalledTimes(1);
    expect(html.mock.calls[0][1]).toBe("Нашла.");
  });
  it("masks a contact inside a group write receipt", async () => {
    const phone = "+992‑90‑123‑45‑67";
    await sendAssistantReply("test", "Готово.", { ...ctx, scope: "group", written: [`Записано: ${phone}`] });
    expect(html.mock.calls[0][1]).not.toContain(phone);
    expect(html.mock.calls[0][1]).toContain("•••••");
  });
  it('group speech has no contacts', async () => { await sendAssistantReply('test', 'Контакт: 992.90.123.45.67 @example_contact', { ...ctx, scope: 'group', mode: 'voice' }); expect(voice).toHaveBeenCalled(); expect(JSON.stringify(voice.mock.calls)).not.toMatch(/992\.90|example_contact/); });
  it('failed voice leaves text', async () => { voice.mockResolvedValue(false); await sendAssistantReply('test', 'Готово.', ctx); expect(html).toHaveBeenCalledTimes(1); });
  it('short replies remain ordered', async () => { await sendAssistantReply('test', 'Здравствуйте. ||| Чем помочь?', ctx); expect(voice.mock.calls.map(c => c[1])).toEqual(['Здравствуйте.', 'Чем помочь?']); });
  it('explicit parse error alone uses plain', async () => { html.mockRejectedValue(new TelegramApiError(400, 'sendMessage', "Bad Request: can't parse entities")); await sendAssistantReply('test', 'Ответ', { ...ctx, fromVoice: false }); expect(plain).toHaveBeenCalledTimes(1); });
  it.each([new Error('timeout'), new TelegramApiError(400, 'sendMessage', 'chat not found'), new TelegramApiError(429, 'sendMessage', 'Too Many Requests')])('does not retry other errors', async (err) => { html.mockRejectedValue(err); await sendAssistantReply('test', 'Ответ', { ...ctx, fromVoice: false }); expect(plain).not.toHaveBeenCalled(); });
});

it("invalid reaction payload is removed, never sent to Telegram", () => {
  expect(splitReaction("[реакция: 👍 чужой текст] Ответ")).toEqual({ reaction: null, text: "Ответ" });
});
it("blank split parts never produce extra messages", () => {
  expect(splitHumanMessages(" ||| ")).toEqual([]);
  expect(splitHumanMessages(" ||| Ответ ||| ")).toEqual(["Ответ"]);
});
it("empty reply still produces a text acknowledgement", async () => {
  await sendAssistantReply("test", " ||| ", ctx);
  expect(voice).not.toHaveBeenCalled();
  expect(plain).toHaveBeenCalledWith("test", "Готово.", undefined);
});
