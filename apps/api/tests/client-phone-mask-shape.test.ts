import { describe, expect, it } from "vitest";
import { CLIENT_PHONE_MASK_CHAR, isForeignPhone, isMaskedClientPhone } from "@royal-home/shared";
import { maskClientPhone, maskPhonesInText } from "../src/lib/clientPhone.js";
import { maskOwnerContact } from "../src/lib/ownerContact.js";

/**
 * ФОРМА МАСКИ НОМЕРА: «видно всё, кроме середины» (владелец 19.11.2026).
 * Скрыто четыре знака в середине, три последних видны. Номера в тестах выдуманные.
 */
const DOTS = CLIENT_PHONE_MASK_CHAR.repeat(4);

describe("maskClientPhone — форма", () => {
  it("таджикский номер с плюсом: начало и хвост видны, середина закрыта", () => {
    expect(maskClientPhone("+992931234456")).toBe(`+99293${DOTS}456`);
  });
  it("иностранный номер: голова остаётся, код страны читается", () => {
    expect(maskClientPhone("+79161234567")).toBe(`+7916${DOTS}567`);
    expect(isForeignPhone(maskClientPhone("+79161234567"))).toBe(true);
    expect(isForeignPhone(maskClientPhone("+992931234456"))).toBe(false);
  });
  it("номер без плюса и местные девять цифр", () => {
    expect(maskClientPhone("992931234456")).toBe(`99293${DOTS}456`);
    expect(maskClientPhone("931234456")).toBe(`93${DOTS}456`);
  });
  it("короткие номера 7–9 знаков", () => {
    expect(maskClientPhone("1234567")).toBe(`${DOTS}567`);
    expect(maskClientPhone("12345678")).toBe(`1${DOTS}678`);
    expect(maskClientPhone("123456789")).toBe(`12${DOTS}789`);
  });
  it("граница: до шести знаков включительно номер возвращается как есть", () => {
    // Внутренние номера (1006) и служебные коды — не личные данные клиента.
    expect(maskClientPhone("123456")).toBe("123456");
    expect(maskClientPhone("1006")).toBe("1006");
    expect(maskClientPhone("1234567")).not.toBe("1234567");
  });
  it("инвариант: открыто не больше, чем длина минус четыре знака", () => {
    for (const phone of ["+992931234456", "+79161234567", "992931234456", "931234456", "0931234456", "1234567", "12345678", "+12025550123", "+4915112345678"]) {
      const masked = maskClientPhone(phone);
      expect(masked.length).toBe(phone.length);
      const visible = [...masked].filter((c) => c !== CLIENT_PHONE_MASK_CHAR).length;
      expect(visible).toBeLessThanOrEqual(phone.length - 4);
      // ни один показанный знак не стоит не на своём месте
      [...masked].forEach((c, i) => { if (c !== CLIENT_PHONE_MASK_CHAR) expect(c).toBe(phone[i]); });
    }
  });
  it("закрытый номер распознаётся как маска и не набирается", () => {
    const masked = maskClientPhone("+992931234456");
    expect(isMaskedClientPhone(masked)).toBe(true);
    expect(isMaskedClientPhone("+992931234456")).toBe(false);
  });
});

describe("одна форма во всех местах", () => {
  it("номер в тексте и контакт собственника маскируются той же функцией", () => {
    expect(maskPhonesInText("звоните +992931234456 вечером")).toBe(`звоните ${maskClientPhone("+992931234456")} вечером`);
    expect(maskOwnerContact("931234456")).toBe(maskClientPhone("+992931234456"));
    expect(maskOwnerContact("+992 93 123 44 56, +992 90 765 43 21")).toBe(`${maskClientPhone("+992931234456")}, ${maskClientPhone("+992907654321")}`);
  });
});
