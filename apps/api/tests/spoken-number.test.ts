import { describe, expect, it } from "vitest";
import { numberToWords, spokenArea, spokenFloor, spokenPrice } from "@royal-home/shared";

/**
 * Числа словами для голоса (packages/shared/src/spokenNumber.ts, 03.10.2026):
 * синтезатор читает «62.5» и «45 000» по цифре, поэтому цену, площадь и этаж в
 * словах собирает код, на русском и на таджикском.
 */
describe("spokenNumber", () => {
  it("целые числа по-русски: род, миллионы, минус, ноль", () => {
    expect(numberToWords(0, "ru")).toBe("ноль");
    expect(numberToWords(21, "ru")).toBe("двадцать один");
    expect(numberToWords(2000, "ru", { feminine: true })).toBe("две тысячи");
    expect(numberToWords(1_250_000, "ru")).toBe("один миллион двести пятьдесят тысяч");
    expect(numberToWords(-5, "ru")).toBe("минус пять");
    expect(numberToWords(Number.NaN, "ru")).toBe("");
  });

  it("целые числа по-таджикски — разговорно, части через пробел", () => {
    expect(numberToWords(45_000, "tg")).toBe("чил панҷ ҳазор");
    expect(numberToWords(60, "tg")).toBe("шаст");
    expect(numberToWords(35, "tg")).toBe("сӣ панҷ");
  });

  it("цена: валюта склоняется, на таджикском — доллар/сомонӣ", () => {
    expect(spokenPrice(45_000, "USD", "ru")).toBe("сорок пять тысяч долларов");
    expect(spokenPrice(500_000, "TJS", "ru")).toBe("пятьсот тысяч сомони");
    expect(spokenPrice(45_000, "USD", "tg")).toBe("чил панҷ ҳазор доллар");
  });

  it("площадь: «с половиной», десятые не называются", () => {
    expect(spokenArea(62.5, "ru")).toBe("шестьдесят два с половиной квадрата");
    expect(spokenArea(62.4, "ru")).toBe("шестьдесят два с половиной квадрата");
    expect(spokenArea(61, "ru")).toBe("шестьдесят один квадрат");
    expect(spokenArea(62.5, "tg")).toBe("шаст ду ним метр");
    expect(spokenArea(60, "tg")).toBe("шаст метр");
  });

  it("этаж: порядковое и «из N», цоколь", () => {
    expect(spokenFloor(5, 9, "ru")).toBe("пятый этаж из девяти");
    expect(spokenFloor(21, 25, "ru")).toBe("двадцать первый этаж из двадцати пяти");
    expect(spokenFloor(0, null, "ru")).toBe("цокольный этаж");
    expect(spokenFloor(5, 9, "tg")).toBe("қабати панҷум аз нӯҳ");
  });
});
