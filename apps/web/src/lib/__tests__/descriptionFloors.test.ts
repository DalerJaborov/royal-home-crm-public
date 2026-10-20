import { describe, expect, it } from "vitest";
import { floorsMentionedInText, floorsMismatch } from "../descriptionFloors";

describe("этажность в тексте описания", () => {
  it.each([
    ["на шестом этаже двадцатидвухэтажной новостройки", 22],
    ["в девятнадцатиэтажном доме", 19],
    ["в 16-этажном доме", 16],
    ["дом 12 этажей", 12],
    ["пятиэтажный дом", 5],
    ["в тридцатитрёхэтажной башне", 33],
  ])("«%s» → %s", (text, n) => {
    expect(floorsMentionedInText(text)).toBe(n);
  });

  it("нет упоминания — null", () => {
    expect(floorsMentionedInText("Отличная квартира с ремонтом")).toBeNull();
    expect(floorsMentionedInText(null)).toBeNull();
  });

  it("расхождение с параметром возвращает число из текста", () => {
    expect(floorsMismatch("двадцатидвухэтажной новостройки", 19)).toBe(22);
    expect(floorsMismatch("девятнадцатиэтажной новостройки", 19)).toBeNull();
    expect(floorsMismatch("двадцатидвухэтажной новостройки", null)).toBeNull();
  });
});
