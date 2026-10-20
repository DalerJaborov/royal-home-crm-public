import { describe, expect, it } from "vitest";
import { extractTypedPhone, extractVolunteeredPhone } from "../src/ai/leadQualifier.js";

/**
 * 13.10.2026, Instagram: клиентка прислала номер «908,88,94,27 акаи тохир» —
 * запятые рвали разбор, карточка не создалась, бот ответил «Раҳмат». Владелец:
 * «номера в любом формате должны быть». Номер ниже вымышленный.
 */
describe("номер в любом написании", () => {
  const formats = [
    "900,11,22,33",
    "900,11,22,33 акаи тохир",
    "900, 11, 22, 33",
    "900/11/22/33",
    "900_11_22_33",
    "900–11–22–33",
    "900—11—22—33",
    "900.11.22.33",
    "900 11 22 33",
    "900-11-22-33",
    "(90) 011-22-33".replace("(90) 0", "(900) "),
    "+992 900 11 22 33",
    "992,900,11,22,33",
  ];
  it.each(formats)("«%s» — номер", (text) => {
    expect(extractTypedPhone(text)).toBe("+992900112233");
    expect(extractVolunteeredPhone(text)).toBe("+992900112233");
  });

  it("цены и площади через запятую номером не становятся", () => {
    expect(extractVolunteeredPhone("цена 1,415,000 сомони")).toBeNull();
    expect(extractVolunteeredPhone("75,5 кв, 10 этаж")).toBeNull();
    expect(extractVolunteeredPhone("бюджет 850,000 долларов")).toBeNull();
  });
});
