/**
 * Ревизия бота 02.10.2026 — комментарии и отправка. Отсечки кодом под нашими
 * постами не трогают живых покупателей, а отправка после таймаута не дублируется.
 * Разбор — docs/journal/2026-10-02-kommentarii-pokupateli-i-facebook.md.
 */
import { describe, expect, it } from "vitest";
import { detectAgencyAd, detectListingAd } from "../src/lib/listingAd.js";
import { detectSpam } from "../src/lib/incomingSpam.js";
import { isRetrySafe } from "../src/messengers/meta.js";

describe("реклама агентства — покупатель, вопрос и похвала не удаляются", () => {
  it.each([
    "Риелтор позвоните мне 935551122, интересует эта квартира",
    "Риелтор лозим, 935551122",
    "Сколько стоят услуги риелтора? пишите в ватсап",
    "Хизматрасонии шумо чанд пул аст? Нависед",
    "Хорошее агентство, рекомендую! Пишите им",
    "Хорошее агентство, подписывайтесь @royal.home.tj",
  ])("«%s» — не реклама", (text) => {
    expect(detectAgencyAd(text)).toBeNull();
  });

  it.each([
    "Агентство недвижимости Сомон, большой выбор квартир, звоните 918123456",
    "Агентство недвижимости, большой выбор квартир во всех районах, подписывайтесь @dom_dushanbe",
  ])("«%s» — реклама, как и раньше", (text) => {
    expect(detectAgencyAd(text)).not.toBeNull();
  });
});

describe("объявление собственника — вопрос покупателя с номером им не считается", () => {
  it.each([
    "Есть 2 комнатные до 50 000$? мой номер 935551122",
    "Ин хона 60000$ мешавад? 3 хонагӣ? 935551122 занг занед",
    "Бюджет 50 000$, 2 комнаты, 5 этаж, номер 935551122",
  ])("«%s» — не объявление", (text) => {
    expect(detectListingAd(text)).toBeNull();
  });

  it("настоящее объявление по-прежнему узнаётся", () => {
    expect(
      detectListingAd("Хона дорем да Маладёжний. Хона 58квадрат да 15 этаж доми 19 этажа. Нарх 580. Хазор сомон номер 980001010 занг занед")
    ).not.toBeNull();
  });
});

describe("спам-словарь под нашим постом", () => {
  it("похвала и вопрос покупателя — не спам", () => {
    expect(detectSpam("Лайк и подписка, классно снимаете! Цена?", { comment: true })).toBeNull();
    expect(detectSpam("Можно оплатить криптой или USDT?", { comment: true })).toBeNull();
  });
  it("реклама со ссылкой — спам и под постом", () => {
    expect(detectSpam("Заработок на крипте, пиши https://example.com", { comment: true })).not.toBeNull();
  });
  it("в личке прежние правила", () => {
    expect(detectSpam("Можно оплатить криптой или USDT?")).not.toBeNull();
  });
});

describe("повтор запроса к Meta", () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  it("отправку после таймаута не повторяем — Meta могла её уже принять", () => {
    expect(isRetrySafe("POST", timeout)).toBe(false);
  });
  it("отказ в соединении повторяем — запрос точно не ушёл", () => {
    expect(isRetrySafe("POST", refused)).toBe(true);
  });
  it("чтение и удаление повторяем всегда", () => {
    expect(isRetrySafe(undefined, timeout)).toBe(true);
    expect(isRetrySafe("DELETE", timeout)).toBe(true);
  });
});
