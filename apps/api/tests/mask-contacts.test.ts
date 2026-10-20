import { describe, expect, it } from "vitest";
import { hasMaskablePhone, maskPhones } from "@royal-home/shared";

/**
 * Скрытие телефонов в исходящих сообщениях агента.
 *
 * Смысл проверок не в том, что маска ловит номера, а в том, что она НЕ ловит
 * лишнее. Ложное срабатывание тут дороже пропуска: если агенту замажут цену или
 * сломают ссылку на объект, он решит, что CRM неисправна, и уйдёт писать клиенту
 * из личного WhatsApp — то есть ровно туда, откуда маска его и уводит.
 */

describe("maskPhones — ловит телефоны", () => {
  it("международный формат с кодом Таджикистана", () => {
    const { text, masked } = maskPhones("Звоните на +992 77 777 6001");
    expect(masked).toBe(true);
    expect(text).toBe("Звоните на ****");
  });

  it("иностранный код страны", () => {
    expect(maskPhones("мой второй +7 495 123 45 67").text).toBe("мой второй ****");
  });

  it("местные девять цифр без кода страны", () => {
    expect(maskPhones("пишите 777776001").text).toBe("пишите ****");
  });

  it("девять цифр с разделителями", () => {
    expect(maskPhones("900-10-28-95 — это я").text).toBe("**** — это я");
  });

  it("несколько номеров в одном сообщении", () => {
    const { text } = maskPhones("+992 55 555 5555 или 900001030");
    expect(text).toBe("**** или ****");
  });
});

describe("maskPhones — не портит остальное", () => {
  it("ссылку на объект с длинным идентификатором оставляет целой", () => {
    const link = "https://royalhome.tj/property/123456789";
    const { text, masked } = maskPhones(`Смотрите ${link}`);
    expect(text).toBe(`Смотрите ${link}`);
    expect(masked).toBe(false);
  });

  it("несколько ссылок подряд не задевает", () => {
        const msg = "Варианты: https://royalhome.tj/p/900001030 и www.royalhome.tj/p/777776001";
    expect(maskPhones(msg).text).toBe(msg);
  });

  it("адрес почты не трогает", () => {
    expect(maskPhones("пишите на agent123456789@royalhome.tj").masked).toBe(false);
  });

  it("цену рядом с валютой не считает телефоном", () => {
    expect(maskPhones("Цена 900 000 000 сомони").masked).toBe(false);
    expect(maskPhones("стоит 630000000 сомон").masked).toBe(false);
  });

  it("число длиннее девяти цифр телефоном не считает", () => {
    expect(maskPhones("площадь по кадастру 12345678901").masked).toBe(false);
  });

  it("короткие числа не задевает", () => {
    expect(maskPhones("3 комнаты, 5 этаж, 78 кв.м, 2019 год").masked).toBe(false);
  });

  it("пустой текст и текст без цифр проходят как есть", () => {
    expect(maskPhones("").masked).toBe(false);
    expect(maskPhones("Здравствуйте, когда удобно посмотреть?").masked).toBe(false);
  });
});

describe("hasMaskablePhone — предупреждение перед отправкой", () => {
  it("совпадает с результатом маскировки", () => {
    expect(hasMaskablePhone("мой номер 777776001")).toBe(true);
    expect(hasMaskablePhone("Цена 900 000 сомони")).toBe(false);
  });
});
