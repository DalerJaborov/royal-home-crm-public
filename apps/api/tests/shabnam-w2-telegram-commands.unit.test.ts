import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteSentReply, deleteSentScope, isDeleteSentRequest, isVoiceReplayRequest, normalizeChatCommand,
} from "../src/telegram/assistantChatCommands.js";
import {
  deletableSentMessages, forgetSentMessages, mergeSentEntries, noteSentResult, resetSentMessageLogForTests, TELEGRAM_DELETE_WINDOW_MS,
} from "../src/telegram/sentMessageLog.js";
import { looksLikeNarrationDictation, narrationDictationReply, parseFreeNarrationTrigger } from "../src/telegram/assistantFreeNarration.js";

/**
 * ЛИЧКА ШАБНАМ: ТАДЖИКСКИЙ ГОЛОС И «УДАЛИ ПРИСЛАННОЕ» (журнал прода 10–17.11.2026).
 * Фразы — нейтральные команды той же формы, что на проде; слова сотрудников в git не кладутся.
 */
describe("«повтори голосом» по-таджикски — там же, где по-русски", () => {
  it.each([
    "Овоз барор", "овоз барор!", "Овозатро равон кун", "овозатро фирист", "бо овоз гӯ", "Бо овоз хон",
    "ҷавобро бо овоз фиристед", "такрор кун бо овоз", "овоз кун", "овозонӣ кунед", "хонда деҳ",
    "Ки хомуш кард", "Ки хомӯш кард?", "ки овозро хомуш кард", "овозат куҷост",
    // без спецбукв и латиницей
    "javobro bo ovoz firist", "ovoz baror", "Ovozatro ravon kun", "Шабнам, овоз барор", "лутфан бо овоз гуед",
    // русские — прежние и новые
    "озвучь", "Пришли голосом", "ответь голосом", "повтори голосом", "Скажи вслух", "кто выключил голос",
  ])("«%s» — озвучить последний ответ", (text) => {
    expect(isVoiceReplayRequest(text)).toBe(true);
  });

  it.each([
    "овоз нафирист", "бе овоз", "клиент ответил голосом", "голос не работает?", "ки омад", "овоз барор нархи ОБ-12 чанд",
    "найди квартиру в Сино", "кто выключил уведомления о заявках", "ovoz kerak emas",
  ])("«%s» — не просьба озвучить", (text) => {
    expect(isVoiceReplayRequest(text)).toBe(false);
  });

  it("нормализация: спецбуквы, латиница и обращение сводятся к одной форме", () => {
    expect(normalizeChatCommand("Шабнам, Ҷавобатро бо овоз гӯед!")).toBe("чавобатро бо овоз гуед");
    expect(normalizeChatCommand("ovozatro ravon kun")).toBe("овозатро равон кун");
  });
});

describe("«удали присланное» — только просьба о своих сообщениях чата", () => {
  it.each([
    "удалить кун ҳамаи равон кардагиатро", "удалить кун хамаи равон кардагиатро", "паёмҳоятро нест кун",
    "Удали всё, что ты прислала", "удали свои сообщения", "сотри свои ответы", "очисти чат", "ҳамаи фиристодагиҳоятро тоза кунед",
    "udalit kun hamai ravon kardagiatro",
  ])("«%s»", (text) => {
    expect(isDeleteSentRequest(text)).toBe(true);
  });

  it.each([
    "удали клиента ПК-12", "удали объект 164", "удали заметку", "удали расход за интернет", "нест кун", "сообщения клиентов покажи",
    "удали сообщение клиенту", "паёми мизоҷро нест кун", "что ты прислала вчера?",
  ])("«%s» — не чистка чата", (text) => {
    expect(isDeleteSentRequest(text)).toBe(false);
  });

  it("«последнее» — только самое свежее, иначе всё", () => {
    expect(deleteSentScope("удали последнее сообщение")).toBe("last");
    expect(deleteSentScope("паёми охиринатро нест кун")).toBe("last");
    expect(deleteSentScope("удали все свои сообщения")).toBe("all");
    // Неясное — не «всё»: спрашиваем (ревью волны 2).
    expect(deleteSentScope("убери голосовые ответы")).toBe("ask");
    expect(deleteSentScope("удали сообщение для Нозы")).toBe("ask");
    expect(deleteSentScope("удали все голосовые")).toBe("ask");
    expect(deleteSentScope("удали всё, что прислала")).toBe("all");
    expect(deleteSentScope("очисти весь чат")).toBe("all");
    expect(deleteSentScope("удали сообщение")).toBe("last");
  });

  it("честный ответ числом, на языке просьбы", () => {
    expect(deleteSentReply("ru", 3, 3)).toBe("Удалила свои сообщения: 3.");
    expect(deleteSentReply("ru", 2, 3)).toBe("Удалила 2 из 3, остальные Telegram удалить не дал.");
    expect(deleteSentReply("tg", 4, 4)).toBe("Паёмҳои худро нест кардам: 4.");
    expect(deleteSentReply("ru", 0, 0)).toMatch(/^Удалять нечего/u);
    expect(deleteSentReply("tg", 0, 0)).not.toMatch(/лутфан/iu);
  });
});

describe("журнал своих сообщений: только личка, только 48 часов", () => {
  beforeEach(() => resetSentMessageLogForTests());

  it("пишет личку (в том числе альбом), не пишет группу, канал и не-отправку", () => {
    const now = 1_800_000_000_000;
    noteSentResult("sendMessage", 555, { message_id: 10 }, now);
    noteSentResult("sendMediaGroup", "555", [{ message_id: 11 }, { message_id: 12 }], now);
    noteSentResult("sendVoice", "555", { message_id: 10 }, now); // повтор не дублируется
    noteSentResult("sendMessage", -100123, { message_id: 99 }, now);
    noteSentResult("sendMessage", "-555", { message_id: 98 }, now);
    noteSentResult("editMessageText", 555, { message_id: 97 }, now);
    noteSentResult("deleteMessage", 555, true, now);
    expect(deletableSentMessages("555", now).map((e) => e.id)).toEqual([10, 11, 12]);
    expect(deletableSentMessages("-100123", now)).toEqual([]);
  });

  it("старше 48 часов не предлагается; сохранённое после перезапуска сливается с проверкой формы", () => {
    const now = 1_800_000_000_000;
    noteSentResult("sendMessage", 777, { message_id: 1 }, now - TELEGRAM_DELETE_WINDOW_MS - 1);
    noteSentResult("sendMessage", 777, { message_id: 2 }, now);
    mergeSentEntries("777", [{ id: 3, at: now - 1000 }, { id: "x", at: now }, { id: 4 }, null], now);
    expect(deletableSentMessages("777", now).map((e) => e.id)).toEqual([3, 2]);
    forgetSentMessages("777", [3], now);
    expect(deletableSentMessages("777", now).map((e) => e.id)).toEqual([2]);
  });
});

describe("длинный текст для озвучки — подсказка, а не ход модели", () => {
  const body = "Квартира в Сино, три комнаты, евроремонт, восьмой этаж из двенадцати, окна во двор, рядом школа, садик и остановка, цена договорная";

  it.each([
    `Озвучь, пожалуйста, вот этот текст для ролика. ${body}`,
    `Шабнам, нужно озвучить: ${body}`.replace(":", " —"),
    `Вот текст для озвучки ролика по объекту. ${body}`,
    `Ин матнро овоз кун барои ролик. ${body}`,
  ])("«%s»", (text) => {
    expect(looksLikeNarrationDictation(text)).toBe(true);
  });

  it.each([
    "озвучь", "Озвучь последний ответ", `Почему озвучка не пришла? ${body}`, `${body}. Озвучь потом.`, "сколько стоит озвучка",
  ])("«%s» — не диктовка", (text) => {
    expect(looksLikeNarrationDictation(text)).toBe(false);
  });

  it("правильная форма «Озвучь текст:» по-прежнему уходит в озвучку раньше, чем сюда", () => {
    expect(parseFreeNarrationTrigger(`Озвучь текст: ${body}`)).toEqual({ kind: "text", text: body });
  });

  it("подсказка учит правильной форме; голосом — обещает прислать расшифровку", () => {
    expect(narrationDictationReply("ru", false)).toContain("«Озвучь текст:»");
    expect(narrationDictationReply("ru", true)).toContain("не голосом");
    expect(narrationDictationReply("tg", false)).toContain("«Матнро овоз кун:»");
    expect(narrationDictationReply("tg", true)).not.toMatch(/лутфан/iu);
  });
});
