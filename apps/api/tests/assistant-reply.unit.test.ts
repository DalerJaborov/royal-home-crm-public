import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { html, plain, voice } = vi.hoisted(() => ({ html: vi.fn(), plain: vi.fn(), voice: vi.fn() }));
vi.mock("../src/telegram/api.js", () => ({ sendHtmlMessage: html, sendMessage: plain,
  TelegramApiError: class extends Error {
    constructor(public errorCode: number, method: string, message: string) { super(`${method}: ${message}`); }
  },
}));
vi.mock("../src/telegram/assistantVoice.js", () => ({ sendAssistantVoiceReply: voice, speechTextFromReply: (text: string) => text }));
import { TelegramApiError } from "../src/telegram/api.js";
import { sendAssistantReply } from "../src/telegram/assistantDelivery.js";
import { decorateHtml, prepareAssistantReply, renderAssistantHtml, sanitizeAssistantReply, splitHumanMessages, splitReaction } from "../src/telegram/assistantReply.js";
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { vi.clearAllMocks(); html.mockReset().mockResolvedValue({}); plain.mockReset().mockResolvedValue({}); voice.mockReset().mockResolvedValue(true); vi.stubEnv("CRM_PUBLIC_URL", "https://crm.test"); });
const ctx = { scope: "private" as const, fromVoice: true, written: [] };
describe("privacy and content", () => {
  it.each(["992.90.123.45.67", "+992901234567", "90 123 45 67", "@example_contact", "https://t.me/example_contact"])("masks %s before speech and HTML", (contact) => {
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
  it("retains authorised private text, never recites contact", () => {
    const p = prepareAssistantReply('Телефон +992901234567');
    expect(p.text).toContain('+992901234567');
    expect(p.speech).not.toContain('901234567');
    expect(p.needsText).toBe(true);
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
  it('successful HTML never falls back', async () => { await sendAssistantReply('test', 'Нашла.', { ...ctx, fromVoice: false }); expect(html).toHaveBeenCalledTimes(1); expect(plain).not.toHaveBeenCalled(); expect(voice).not.toHaveBeenCalled(); });
  it('short voice only', async () => { await sendAssistantReply('test', 'Готово.', ctx); expect(voice).toHaveBeenCalledWith('test', 'Готово.', undefined); expect(html).not.toHaveBeenCalled(); });
  it.each(['Источник https://example.com', 'Нашла [Клиента](/clients/112)', 'Ответ ' + 'а'.repeat(334), 'Подробности пришлю текстом.'])('voice plus full text: %s', async (text) => { await sendAssistantReply('test', text, ctx); expect(voice).toHaveBeenCalled(); expect(html).toHaveBeenCalled(); });
  it('done action has receipt', async () => { await sendAssistantReply('test', 'Готово.', { ...ctx, written: ['Записано: заметка'] }); expect(html.mock.calls[0][1]).toContain('Записано: заметка'); });
  it('unconfigured Tajik voice leaves text', async () => { voice.mockResolvedValue(false); await sendAssistantReply('test', 'Салом, ман ёфтам.', ctx); expect(voice).toHaveBeenCalled(); expect(html).toHaveBeenCalled(); });
  it('unknown language stays text', async () => { await sendAssistantReply('test', 'Unknown words', ctx); expect(voice).not.toHaveBeenCalled(); expect(html).toHaveBeenCalled(); });
  it('stops further voice spending after a failure', async () => { voice.mockResolvedValue(false); await sendAssistantReply('test', 'Готово. ||| Нашла.', ctx); expect(voice).toHaveBeenCalledTimes(1); expect(html).toHaveBeenCalledTimes(2); });
  it('group speech has no contacts', async () => { await sendAssistantReply('test', 'Контакт: 992.90.123.45.67 @example_contact', { ...ctx, scope: 'group' }); expect(JSON.stringify(voice.mock.calls)).not.toMatch(/992\.90|example_contact/); });
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
