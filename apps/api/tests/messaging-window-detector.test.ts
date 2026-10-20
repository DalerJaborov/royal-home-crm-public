import { describe, expect, it } from "vitest";
import { isMessagingWindowClosedError } from "../src/lib/messagingWindow.js";

/**
 * ЗАКРЫТОЕ 24-ЧАСОВОЕ ОКНО META — ПРОВЕРКА ПО ЖИВЫМ ОТВЕТАМ ПРОДА.
 *
 * Зачем файл появился (07.09.2026). Агенты сообщили «сообщение не отправляется».
 * Разбор показал: понятная подсказка агенту («клиент не писал 24 часа — позвоните»)
 * в коде есть с 22.08.2026 и доходит до экрана. Но опознаётся закрытое окно по
 * ТЕКСТУ ошибки Graph API, а единственная проверка этой логики жила в моке теста
 * доставки — то есть проверялась КОПИЯ функции, всегда согласная сама с собой.
 * Настоящую не проверял никто: поменяй Meta формулировку — подсказка тихо
 * превратилась бы в общее «Не удалось отправить», и никакой тест не упал бы.
 *
 * Поэтому здесь дословные ответы с прода. Их менять только вместе с проверкой
 * живого случая, а не «чтобы позеленело».
 */

/** Instagram, 06.09.2026, диалог cb809836 — HTTP 403 при ответе через сутки после клиента. */
const INSTAGRAM_403 =
  'Graph API HTTP 403: {"error":{"message":"This message is sent outside of allowed window.",' +
  '"type":"IGApiException","code":10,"error_subcode":2534022,"fbtrace_id":"ALMmD_iEkggJpUksS_o0Jbg"}}';

/** WhatsApp Cloud API — задокументированный Meta код именно для этого случая. */
const WHATSAPP_131047 =
  'Graph API HTTP 400: {"error":{"message":"(#131047) Re-engagement message",' +
  '"type":"OAuthException","code":131047,"error_subcode":2655003}}';

describe("закрытое окно переписки опознаётся по ответу Meta", () => {
  it("Instagram: «outside of allowed window» — тот самый отказ с прода", () => {
    expect(isMessagingWindowClosedError(INSTAGRAM_403)).toBe(true);
  });

  it("WhatsApp: код 131047 и формулировка про повторное обращение", () => {
    expect(isMessagingWindowClosedError(WHATSAPP_131047)).toBe(true);
    expect(isMessagingWindowClosedError("Re-engagement message")).toBe(true);
    expect(isMessagingWindowClosedError("More than 24 hours have passed since the last message")).toBe(true);
  });

  it("Messenger: «(#470) …outside of allowed window» — канал FACEBOOK, добавлено 12.09.2026", () => {
    const MESSENGER_470 =
      'Graph API HTTP 400: {"error":{"message":"(#470) This message is sent outside of allowed window.",' +
      '"type":"OAuthException","code":10,"error_subcode":2018278}}';
    expect(isMessagingWindowClosedError(MESSENGER_470)).toBe(true);
  });

  it("НЕ окно: «message undeliverable» и «(#551) person isn't available» — другие отказы", () => {
    // 131026 у WhatsApp — чаще «у номера нет WhatsApp», а не закрытое окно.
    // Подсказка «дождитесь сообщения клиента» здесь была бы вредной: ждать нечего.
    expect(
      isMessagingWindowClosedError(
        'Graph API HTTP 400: {"error":{"message":"(#131026) Message undeliverable","code":131026}}'
      )
    ).toBe(false);
    expect(
      isMessagingWindowClosedError(
        `Graph API HTTP 400: {"error":{"message":"(#551) This person isn't available right now.","code":551}}`
      )
    ).toBe(false);
  });

  // Прод 28.09.2026: маркер Страницы с русским языком владельца — текст
  // ошибки по-русски и экранирован \uXXXX, а subcode срезан обрезкой тела.
  it("русская формулировка Meta, экранированная \\uXXXX, узнаётся", () => {
    const escaped = "Это сообщение отправлено вне разрешенного окна. Под"
      .split("")
      .map((ch) => (ch.charCodeAt(0) > 127 ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}` : ch))
      .join("");
    expect(isMessagingWindowClosedError(`Graph API HTTP 400: {"error":{"message":"(#10) ${escaped}`)).toBe(true);
    expect(isMessagingWindowClosedError("(#10) Это сообщение отправлено вне разрешённого окна.")).toBe(true);
    expect(isMessagingWindowClosedError('{"error":{"code":10,"error_subcode":2534022}}')).toBe(true);
  });

  /**
   * Обратная половина обязательна: проверка, отвечающая «да» на всё, так же
   * бесполезна, как отвечающая «нет». Ошибка доступа или сети — это поломка,
   * её агенту показывать нельзя как «клиент не писал 24 часа», иначе он будет
   * спокойно ждать сообщения клиента вместо того, чтобы позвать за помощью.
   */
  it("обычные отказы закрытым окном НЕ считаются", () => {
    for (const other of [
      'Graph API HTTP 400: {"error":{"message":"Invalid OAuth access token","code":190}}',
      'Graph API HTTP 400: {"error":{"message":"Object does not exist","code":100,"error_subcode":33}}',
      "fetch failed (UND_ERR_CONNECT_TIMEOUT)",
      "Graph API HTTP 500: Internal Server Error",
      "",
    ]) {
      expect(isMessagingWindowClosedError(other)).toBe(false);
    }
  });
});
