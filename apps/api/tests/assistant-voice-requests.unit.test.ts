import { beforeEach, describe, expect, it, vi } from "vitest";
const { html, plain, voice, buttons } = vi.hoisted(() => ({ html: vi.fn(), plain: vi.fn(), voice: vi.fn(), buttons: vi.fn() }));
vi.mock("../src/telegram/api.js", () => ({ sendHtmlMessage: html, sendMessage: plain, sendMessageWithButtons: buttons,
  TelegramApiError: class extends Error {
    constructor(public errorCode: number, method: string, message: string) { super(`${method}: ${message}`); }
  },
}));
vi.mock("../src/telegram/assistantVoice.js", () => ({ sendAssistantVoiceReply: voice, speechTextFromReply: (text: string) => text }));
import { sendAssistantReply } from "../src/telegram/assistantDelivery.js";
import { requestedAssistantReplyPreference } from "../src/telegram/assistantReply.js";

beforeEach(() => {
  vi.clearAllMocks();
  html.mockReset().mockResolvedValue({}); plain.mockReset().mockResolvedValue({}); voice.mockReset().mockResolvedValue(true);
  vi.stubEnv("CRM_PUBLIC_URL", "https://crm.test");
});

/** Жалоба владельца 24.11.2026: «голосовые вообще не отправляет». Просьба о голосе узнаётся обычными словами. */
describe("просьба о голосе: обычные слова владельца (24.11.2026)", () => {
  it.each([
    ["Сабнам отправь свой личный голос", "ru"],
    ["Шабнам, отправь свой голос", "ru"],
    ["отправь мне свой голос", "ru"],
    ["пришли свой живой голос", "ru"],
    ["Скажи что-нибудь голосом", "ru"],
    ["Расскажи про район голосом", "ru"],
    ["Ответь голосовым сообщением", "ru"],
    ["пришли голосовое сообщение", "ru"],
    ["Ответь галасом", "ru"],
    ["Отправь свой голос?", "ru"],
    ["Можешь отправить свой голос?", "ru"],
    ["Овози шахсиатро фирист", "tg"],
    ["Шабнам, овози худатро фирист", "tg"],
    ["Бо овози худат гап зан", "tg"],
    ["Сабнам овоз фирист", "tg"],
  ])("%s -> голос", (phrase, language) => {
    expect(requestedAssistantReplyPreference(phrase)).toEqual({ mode: "voice", voiceLanguage: language });
  });
  it.each([
    "Клиент ответил голосом",
    "Голос не работает?",
    "Отправь голосовое клиенту",
    "Расскажи про голос клиента",
    "Овоз нафирист",
  ])("%s -> не просьба о голосе", phrase => {
    expect(requestedAssistantReplyPreference(phrase).mode).not.toBe("voice");
  });
});

describe("голосовой вопрос в личке получает голос (24.11.2026)", () => {
  const ctx = { scope: "private" as const, fromVoice: true, written: [] as string[] };
  const longRu = "Хорошо, давайте разберёмся спокойно. Сначала посмотрим, что вы уже сделали по этому клиенту, потом решим, когда ему лучше позвонить. Так будет проще не упустить договорённость и не потерять нить разговора. Если что-то изменится, просто скажите мне об этом.";

  it("длинный ответ на голосовой: короткая озвучка начала и полный текст", async () => {
    await sendAssistantReply("test", longRu, ctx);
    expect(voice).toHaveBeenCalledTimes(1);
    const spoken = voice.mock.calls[0][1] as string;
    expect(spoken.length).toBeLessThanOrEqual(180);
    expect(longRu.startsWith(spoken)).toBe(true);
    expect(html).toHaveBeenCalledTimes(1);
    expect(html.mock.calls[0][1]).toContain("Если что-то изменится");
  });
  it("короткий ответ с цифрой: цифры словами в голосе, цифры в тексте", async () => {
    await sendAssistantReply("test", "На сегодня 3 показа.", { ...ctx, requestLanguage: "ru" });
    expect(voice).toHaveBeenCalledTimes(1);
    expect(voice.mock.calls[0][1]).toBe("На сегодня три показа.");
    expect(html.mock.calls[0][1]).toContain("3 показа");
  });
  it("таджикский длинный ответ: тоже голос начала и текст", async () => {
    const tg = "Хуб, биёед оромона гап занем ва фаҳмем, ки аз куҷо сар кардан осонтар аст. Ҳамин тавр гапи ҳамдигарро беҳтар мефаҳмем. Баъд ҳамаашро оҳиста дида мебароем, то ягон гап аз хотир наравад. Агар савол монад, боз ба ҳамон гап бармегардем.";
    await sendAssistantReply("test", tg, ctx);
    expect(voice).toHaveBeenCalledTimes(1);
    expect(html).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["ссылка на карточку", "Нашла клиента [Алишер](/clients/12) и вот что известно по нему сейчас.", false],
    ["итог инструмента (structured)", "Вариантов не нашла, давайте уточним район и бюджет и попробуем снова.", true],
  ])("не озвучивает: %s", async (_name, reply, structured) => {
    await sendAssistantReply("test", reply, { ...ctx, structured });
    expect(voice).not.toHaveBeenCalled();
    expect(html).toHaveBeenCalled();
  });
  it("напечатанный вопрос остаётся текстом", async () => {
    await sendAssistantReply("test", longRu, { ...ctx, fromVoice: false });
    expect(voice).not.toHaveBeenCalled();
  });
  it("«ответь текстом» важнее голосового вопроса", async () => {
    await sendAssistantReply("test", longRu, { ...ctx, mode: "text" });
    expect(voice).not.toHaveBeenCalled();
  });
});

describe("группа: голосом не спамим (24.11.2026)", () => {
  const group = { scope: "group" as const, fromVoice: true, written: [] as string[] };
  const longRu = "Хорошо, давайте разберёмся спокойно. Сначала посмотрим, что вы уже сделали по этому клиенту, потом решим, когда ему лучше позвонить. Так будет проще не упустить договорённость и не потерять нить разговора.";
  it("длинный ответ на обращённое голосовое — без озвучки", async () => {
    await sendAssistantReply("-100", longRu, { ...group, addressedGroupVoice: true });
    expect(voice).not.toHaveBeenCalled();
    expect(html).toHaveBeenCalled();
  });
  it("голосовое без обращения — без озвучки", async () => {
    await sendAssistantReply("-100", "Готово.", group);
    expect(voice).not.toHaveBeenCalled();
  });
  it("прямая просьба «ответь голосом» в группе — голос", async () => {
    await sendAssistantReply("-100", "Готово.", { ...group, fromVoice: false, mode: "voice" });
    expect(voice).toHaveBeenCalledTimes(1);
  });
});

describe("не вышло озвучить: честно текстом", () => {
  it("явная просьба о голосе: текст и строка, что голосом не вышло", async () => {
    voice.mockResolvedValue(false);
    await sendAssistantReply("test", "Готово.", { scope: "private", mode: "voice", written: [] });
    expect(html).toHaveBeenCalledTimes(1);
    expect(html.mock.calls[0][1]).toBe("Голосом сейчас не вышло, пишу текстом.\nГотово.");
  });
  it("таджикский собеседник: строка по-таджикски", async () => {
    voice.mockResolvedValue(false);
    await sendAssistantReply("test", "Хуб, ман ёфтам.", { scope: "private", mode: "voice", requestLanguage: "tg", written: [] });
    expect(html.mock.calls[0][1]).toMatch(/^Бо овоз нашуд, матнӣ менависам\.\n/u);
  });
  it("ответ на голосовой без явной просьбы: просто текст, без извинений", async () => {
    voice.mockResolvedValue(false);
    await sendAssistantReply("test", "Готово.", { scope: "private", fromVoice: true, written: [] });
    expect(html.mock.calls[0][1]).toBe("Готово.");
  });
});
