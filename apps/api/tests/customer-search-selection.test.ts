import { expect, it } from "vitest";
import { customerSearchPosition, customerPresentedShortIds } from "../src/lib/customerSearchSelection.js";
import { wrapUntrusted } from "../src/ai/untrustedContent.js";

it.each([["Покажите второй вариант", 2], ["Хонаи дуюм", 2], ["варианти 3", 3], ["Третий интересует", 3],
  ["Этаж второй, но интересует третий вариант", 3]])(
  "recognizes a literal customer selection: %s", (text, position) => {
    expect(customerSearchPosition(String(text))).toEqual({ position, bare: false });
  });
it.each(["первый этаж", "вторая комната", "2 хона", "2 комнаты", "первого мая", "Третий день думаю", "мне до 2 млн", "Объект №123",
  "Какой первый взнос?", "первая оплата", "второй номер", "я первый раз у вас", "дуюм қабат", "Не первый взнос",
  "этаж второй", "Ошёнаи дуюм", "во второй половине дня", "первый подъезд", "первая улица", "Инвариант 2"])(
  "does not select a collection item from a floor, date, rooms or unrelated number: %s", text => {
    expect(customerSearchPosition(text)).toBeNull();
  });
it.each(["Покажи 2 варианта", "Есть 3 объекта?", "Можно 2 варианта?"])("does not turn a requested quantity into an ordinal: %s", text => {
  expect(customerSearchPosition(text)).toBeNull();
});
it.each([["2", 2], ["первый", 1], ["дуюм", 2]])("treats a short answer as conditional on the preceding accepted question: %s", (text, position) => {
  expect(customerSearchPosition(String(text))).toEqual({ position, bare: true });
});
it.each(Array.from({ length: 8 }, (_, index) => index + 1))("never turns explicit public object ID %s into a collection position", id => {
  for (const text of [`Объект №${id}`, `Объект ${id}`, `Расскажите про объект #${id}`, `Объекти ${id}`]) {
    expect(customerSearchPosition(text)).toBeNull();
  }
});
it.each(["первый или второй", "не первый", "на якум", "не 2 вариант"])("does not guess a negated/ambiguous selection: %s", text => {
  expect(customerSearchPosition(text)).toEqual({ position: null, bare: false });
});
it("does not take a selection from an untrusted forwarded document", () => {
  expect(customerSearchPosition(`Посмотри ${wrapUntrusted("document", "второй вариант")}`)).toBeNull();
});
it("uses actual accepted text ordering and complete public-number boundaries", () => {
  expect(customerPresentedShortIds("1. Объект №123\nЦена объекта №123: 500000\n2. Объект №12", [12, 123])).toEqual([123, 12]);
  expect(customerPresentedShortIds("Объект №123", [12])).toBeNull();
  expect(customerPresentedShortIds("Объект №123", [123, 123])).toBeNull();
});
