import { expect, it } from "vitest";
import { currentInputVolunteersCustomerContact } from "../src/lib/customerContactIntent.js";

const phone = "+992901234567", contact = { name: "save_contact", args: { phone } };
it.each([
  "+992 90 123 45 67", "901234567", "Мой номер: +992 90 123 45 67", "Запишите +992901234567",
  "Рақами ман +992901234567", "Телефони ман +992901234567", "Сабт кунед +992901234567",
])("accepts a literal volunteered contact: %s", text => {
  expect(currentInputVolunteersCustomerContact(text, contact)).toBe(true);
});
it.each([
  "Это не мой номер +992901234567", "Мой номер не +992901234567", "Мне прислали номер +992901234567",
  "Мой агент прислал +992901234567", "Запишите номер собственника +992901234567", "Его телефон +992901234567",
  "Он написал: «мой номер +992901234567»", '"мой номер +992901234567"',
  "Ин рақами ман нест +992901234567", "Рақами соҳиби хона +992901234567", "Ба ман фиристоданд +992901234567",
  "Фиристод: рақами ман +992901234567", "Рақами дигар +992901234567", "Нависед +992901234567", // unsupported cue stays clarification
  "Мой номер +992901234567 или +992907654321", "Квартира 901234567 сомони", "Мой номер +992907654321",
])("rejects negated/reported/foreign/ambiguous or unsupported contact: %s", text => {
  expect(currentInputVolunteersCustomerContact(text, contact)).toBe(false);
});
it.each([
  ["Меня зовут Али.", "Али"], ["Номи ман Фаррух.", "Фаррух"],
])("accepts an explicit name without phone: %s", (text, name) => {
  expect(currentInputVolunteersCustomerContact(text, { name: "save_contact", args: { name } })).toBe(true);
});
it.each([
  ["Али", "Али"], ["Хочу квартиру", "квартиру"], ["Он сказал: Меня зовут Али.", "Али"],
  ['"Меня зовут Али."', "Али"], ["Номи ман Фаррух нест.", "Фаррух"],
])("does not infer a bare/reported/negated name: %s", (text, name) => {
  expect(currentInputVolunteersCustomerContact(text, { name: "save_contact", args: { name } })).toBe(false);
});
