import { describe, expect, it } from "vitest";
import { CLIENT_PHONE_MASK_CHAR, isDialableTajikNumber, isForeignPhone, isMaskedClientPhone, tajikNationalNumber } from "@royal-home/shared";
import { maskClientPhone, maskPhonesInFreeText, maskPhonesInText } from "../src/lib/clientPhone.js";
import { maskOwnerContact } from "../src/lib/ownerContact.js";

/**
 * ФОРМА МАСКИ НОМЕРА: «видно всё, кроме середины» (владелец 19.11.2026).
 * Скрыто два знака в середине («Сделать 2», владелец 19.11.2026), три последних видны. Номера в тестах выдуманные.
 */
const DOTS = CLIENT_PHONE_MASK_CHAR.repeat(2);

describe("maskClientPhone — форма", () => {
  it("таджикский номер с плюсом: начало и хвост видны, середина закрыта", () => {
    expect(maskClientPhone("+992931234456")).toBe(`+9929312${DOTS}456`);
  });
  it("иностранный номер: голова остаётся, код страны читается", () => {
    expect(maskClientPhone("+79161234567")).toBe(`+791612${DOTS}567`);
    expect(isForeignPhone(maskClientPhone("+79161234567"))).toBe(true);
    expect(isForeignPhone(maskClientPhone("+992931234456"))).toBe(false);
  });
  it("номер без плюса и местные девять цифр", () => {
    expect(maskClientPhone("992931234456")).toBe(`9929312${DOTS}456`);
    expect(maskClientPhone("931234456")).toBe(`9312${DOTS}456`);
  });
  it("короткие номера 7–9 знаков", () => {
    expect(maskClientPhone("1234567")).toBe(`12${DOTS}567`);
    expect(maskClientPhone("12345678")).toBe(`123${DOTS}678`);
    expect(maskClientPhone("123456789")).toBe(`1234${DOTS}789`);
  });
  it("граница: до шести знаков включительно номер возвращается как есть", () => {
    // Внутренние номера (1006) и служебные коды — не личные данные клиента.
    expect(maskClientPhone("123456")).toBe("123456");
    expect(maskClientPhone("1006")).toBe("1006");
    expect(maskClientPhone("1234567")).not.toBe("1234567");
  });
  it("инвариант: открыто не больше, чем длина минус два знака", () => {
    for (const phone of ["+992931234456", "+79161234567", "992931234456", "931234456", "0931234456", "1234567", "12345678", "+12025550123", "+4915112345678"]) {
      const masked = maskClientPhone(phone);
      expect(masked.length).toBe(phone.length);
      const visible = [...masked].filter((c) => c !== CLIENT_PHONE_MASK_CHAR).length;
      expect(visible).toBeLessThanOrEqual(phone.length - 2);
      // ни один показанный знак не стоит не на своём месте
      [...masked].forEach((c, i) => { if (c !== CLIENT_PHONE_MASK_CHAR) expect(c).toBe(phone[i]); });
    }
  });
  it("позиции считаются по цифрам: пробелы, скобки и подпись после номера не съедают маску (ревью 19.11.2026)", () => {
    // Счёт по знакам закрывал здесь пробел и одну цифру, а у номера с подписью — буквы имени.
    expect(maskClientPhone("+992 931 234 567")).toBe(`+992 931 2${DOTS} 567`);
    expect(maskClientPhone("+992931234456 Мадина")).toBe(`+9929312${DOTS}456 Мадина`);
    expect(maskClientPhone("(93) 123-44-56")).toBe(`(93) 12${CLIENT_PHONE_MASK_CHAR}-${CLIENT_PHONE_MASK_CHAR}4-56`);
    expect(maskClientPhone("12 34 56")).toBe("12 34 56");
  });
  it("в любой записи закрыты ровно две цифры, и это одни и те же две цифры", () => {
    const onlySlots = (s: string) => [...s].filter((c) => /\d/.test(c) || c === CLIENT_PHONE_MASK_CHAR).join("");
    for (const phone of ["+992 931 234 567", "+992 (93) 123-45-67", "992 93 1234567 жена", "+7 916 123 45 67", "8 (916) 123-45-67 Иван"]) {
      const masked = maskClientPhone(phone);
      expect([...masked].filter((c) => c === CLIENT_PHONE_MASK_CHAR).length).toBe(2);
      // та же запись без разделителей (так номер маскируется в тексте) закрывает те же позиции
      expect(onlySlots(masked)).toBe(maskClientPhone(phone.replace(/\D/g, "")));
      // всё, что не цифра, осталось на месте
      [...masked].forEach((c, i) => { if (c !== CLIENT_PHONE_MASK_CHAR) expect(c).toBe(phone[i]); });
    }
  });
  it("повторная маска ничего не меняет", () => {
    for (const phone of ["+992931234456", "+992 931 234 567", "+79161234567", "1234567"]) {
      expect(maskClientPhone(maskClientPhone(phone))).toBe(maskClientPhone(phone));
    }
  });
  it("закрытый номер распознаётся как маска и не набирается", () => {
    const masked = maskClientPhone("+992931234456");
    expect(isMaskedClientPhone(masked)).toBe(true);
    expect(isMaskedClientPhone("+992931234456")).toBe(false);
  });
  it("закрытый номер не сходит за набираемый местный, сколько бы цифр ни осталось", () => {
    // `+791612••567` — девять видимых цифр: без запрета маски это «местный номер».
    for (const phone of ["+79161234567", "+992931234456", "992931234456", "931234456", "0931234456", "+12025550123", "+4915112345678", "12345678901"]) {
      const masked = maskClientPhone(phone);
      expect(isDialableTajikNumber(masked)).toBe(false);
      expect(tajikNationalNumber(masked)).toBeNull();
    }
    expect(isDialableTajikNumber("+992931234456")).toBe(true);
    expect(tajikNationalNumber("+992931234456")).toBe("931234456");
  });
});

describe("номер внутри текста: за ним идут другие цифры", () => {
  // Облачный прогон 19.11.2026: имя карточки с цифрами после номера отдавало номер целиком —
  // маска «две цифры перед тремя последними» закрывала цифры хвоста, а не номера.
  const phone = "+992900112233";
  it("хвост из цифр после номера не сдвигает маску и не открывает номер", () => {
    for (const tail of ["7", "12", "2 комнаты", "1794955089320", "5 этаж 9"]) {
      for (const mask of [maskPhonesInText, maskPhonesInFreeText]) {
        const out = mask(`Иван ${phone} ${tail}`);
        expect(out).not.toContain("900112233");
        // закрыты именно те две цифры, что и в поле «Телефон»
        expect(out.startsWith(`Иван ${maskClientPhone(phone)}`)).toBe(true);
      }
    }
  });
  it("местная запись и запись без плюса с приписанными цифрами — закрыта осторожно", () => {
    for (const text of ["900112233 7", "900 11 22 33 12345", "8 900 112 23 31", "12 992900112233"]) {
      const out = maskPhonesInFreeText(`тел ${text}`);
      expect(out).not.toContain("0112233");
      expect(out.replace(/\D/g, "").length).toBeLessThanOrEqual(text.replace(/\D/g, "").length - 2);
    }
  });
  it("второй номер, приклеенный к первому, закрыт целиком", () => {
    const out = maskPhonesInText("+992900112233 992935551234");
    expect(out).not.toContain("935551234");
    expect(out).not.toContain("900112233");
  });
  it("контакт собственника: номер с приписанной цифрой не открывается сдвигом маски", () => {
    const out = maskOwnerContact("93 555 12 34 2")!;
    expect(out).not.toContain("5551234");
    expect([...out].filter((c) => c === CLIENT_PHONE_MASK_CHAR).length).toBeGreaterThanOrEqual(5);
  });
  it("чистый номер в тексте выглядит так же, как в поле", () => {
    expect(maskPhonesInText(`звоните ${phone}`)).toBe(`звоните ${maskClientPhone(phone)}`);
    expect(maskPhonesInFreeText("900112233")).toBe(maskClientPhone("900112233"));
    expect(maskPhonesInText("+7 916 123 45 67")).toBe(maskClientPhone("+79161234567"));
  });
});

describe("одна форма во всех местах", () => {
  it("номер в тексте и контакт собственника маскируются той же функцией", () => {
    expect(maskPhonesInText("звоните +992931234456 вечером")).toBe(`звоните ${maskClientPhone("+992931234456")} вечером`);
    expect(maskOwnerContact("931234456")).toBe(maskClientPhone("+992931234456"));
    expect(maskOwnerContact("+992 93 123 44 56, +992 90 765 43 21")).toBe(`${maskClientPhone("+992931234456")}, ${maskClientPhone("+992907654321")}`);
  });
});
