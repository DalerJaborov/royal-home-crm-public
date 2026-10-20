import { describe, expect, it } from "vitest";
import { parseTelegramChatIds, TELEGRAM_EXTRA_CHATS_MAX } from "../src/lib/telegramChats.js";

/**
 * ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ TELEGRAM (26.09.2026, «ролик уходит в несколько
 * Telegram-групп и каналов, а не в один») — разбор текстового поля
 * `Settings.telegramExtraChatIds` в список chat_id/@username.
 *
 * Чистая функция, без БД и без побочных эффектов — сама публикация и запись
 * результатов живут в lib/socialPublish.ts (см. social-publish-telegram.test.ts).
 */
describe("parseTelegramChatIds", () => {
  it("разбирает список через запятую, пробел и перевод строки", () => {
    expect(parseTelegramChatIds("-1001111111111, -1002222222222\n@realty_group_one @realty_group_two")).toEqual([
      "-1001111111111",
      "-1002222222222",
      "@realty_group_one",
      "@realty_group_two",
    ]);
  });

  it("обрезает пробелы и убирает пустые строки", () => {
    expect(parseTelegramChatIds("  -1001111111111  \n\n  \n@realty_group  ")).toEqual(["-1001111111111", "@realty_group"]);
  });

  it("убирает повторы без учёта регистра", () => {
    expect(parseTelegramChatIds("@Realty_Group, @realty_group, -1001111111111, -1001111111111")).toEqual([
      "@Realty_Group",
      "-1001111111111",
    ]);
  });

  it("допускает @username от 5 до 32 символов из [A-Za-z0-9_]", () => {
    expect(parseTelegramChatIds("@abcde")).toEqual(["@abcde"]);
    expect(parseTelegramChatIds(`@${"a".repeat(32)}`)).toEqual([`@${"a".repeat(32)}`]);
    // короче 5 символов — невалидно, отбрасывается молча.
    expect(parseTelegramChatIds("@abcd")).toEqual([]);
    // длиннее 32 — тоже отбрасывается.
    expect(parseTelegramChatIds(`@${"a".repeat(33)}`)).toEqual([]);
    // запрещённый символ (дефис) в имени — отбрасывается.
    expect(parseTelegramChatIds("@bad-name")).toEqual([]);
  });

  it("допускает числовой chat_id, включая отрицательный -100…", () => {
    expect(parseTelegramChatIds("-1001234567890")).toEqual(["-1001234567890"]);
    expect(parseTelegramChatIds("123456789")).toEqual(["123456789"]);
    expect(parseTelegramChatIds("-42")).toEqual(["-42"]);
  });

  it("отбрасывает то, что не похоже ни на chat_id, ни на @username", () => {
    expect(parseTelegramChatIds("не-число, http://t.me/realty, 12ab34")).toEqual([]);
  });

  it("исключает адрес, совпадающий с основным каналом (второй аргумент)", () => {
    expect(parseTelegramChatIds("-1001111111111, -1002222222222", "-1001111111111")).toEqual(["-1002222222222"]);
    // сравнение без учёта регистра для @username
    expect(parseTelegramChatIds("@Main_Channel, @other_group", "@main_channel")).toEqual(["@other_group"]);
  });

  it(`ограничивает результат ${TELEGRAM_EXTRA_CHATS_MAX} записями`, () => {
    const many = Array.from({ length: TELEGRAM_EXTRA_CHATS_MAX + 10 }, (_, i) => `-100000000000${i}`).join(",");
    const result = parseTelegramChatIds(many);
    expect(result).toHaveLength(TELEGRAM_EXTRA_CHATS_MAX);
  });

  it("пусто/null/undefined — пустой список", () => {
    expect(parseTelegramChatIds(null)).toEqual([]);
    expect(parseTelegramChatIds(undefined)).toEqual([]);
    expect(parseTelegramChatIds("")).toEqual([]);
    expect(parseTelegramChatIds("   ")).toEqual([]);
  });
});
