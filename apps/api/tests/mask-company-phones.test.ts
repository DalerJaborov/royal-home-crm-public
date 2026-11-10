import { describe, expect, it } from "vitest";
import { maskPhones, hasMaskablePhone, COMPANY_PHONE_DIGITS } from "@royal-home/shared";
import { PUBLIC_AGENCY_CONTACT } from "../src/lib/publicAgencyContact.js";

/**
 * Номера компании в ответах сотрудников не прячутся (владелец 10.11.2026).
 * Живой случай: «позвоните Нозе: 777 070 100» ушёл бы клиенту как «****».
 * Личные номера маска прячет по-прежнему — ради этого она и существует.
 */
describe("маска телефонов: номера компании проходят", () => {
  it("номер Нозы в любом написании не прячется", () => {
    for (const phone of ["777 070 100", "777070100", "+992 777 070 100", "992777070100", "777-070-100"]) {
      const text = `Позвоните, пожалуйста, Нозе: ${phone}.`;
      expect(maskPhones(text).text, phone).toBe(text);
      expect(hasMaskablePhone(text), phone).toBe(false);
    }
  });

  it("публичный телефон агентства из publicAgencyContact — в том же списке", () => {
    expect(COMPANY_PHONE_DIGITS).toContain(PUBLIC_AGENCY_CONTACT.digits.slice(-9));
    const text = `Наш телефон: ${PUBLIC_AGENCY_CONTACT.phone}`;
    expect(maskPhones(text).text).toBe(text);
  });

  it("личный номер агента рядом с номером компании по-прежнему прячется", () => {
    const result = maskPhones("Звоните Нозе 777 070 100 или мне на 93 555 12 34");
    expect(result.masked).toBe(true);
    expect(result.text).toBe("Звоните Нозе 777 070 100 или мне на ****");
    expect(maskPhones("+992 93 555 12 34").text).toBe("****");
  });

  it("номер, лишь оканчивающийся похоже, не проходит", () => {
    expect(maskPhones("+7 999 777 070 101").masked).toBe(true);
  });
});
