import { expect, it } from "vitest";
import { customerAgentVerifiedContextSchema } from "@royal-home/shared";
import { customerAgentPropertyQuestionText } from "../src/ai/customerAgentRenderer.js";
import { customerBarePropertyAnswer, customerBarePropertyNumber } from "../src/lib/customerBarePropertyAnswer.js";

function context(text: string, role = "assistant", topic = "unknown") {
  return customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64),
    turns: [{ role, text }], publicState: { language: "unknown", topic, openQuestion: "none" } });
}
it.each(["ru", "tg"] as const)("interprets the bare public number only after the actual %s property question", language => {
  expect(customerBarePropertyAnswer("172", context(customerAgentPropertyQuestionText(language)))).toBe(172);
});
it.each(["Какой у вас бюджет?", "Сколько вам лет?", "Какой номер телефона?", "Выберите вариант: 1 или 2", "Понял."])(
  "does not reinterpret numbers after another question: %s", question => {
    expect(customerBarePropertyAnswer("172", context(question))).toBeNull();
  });
it.each(["936501414", "+992936501414", "0936501414", "992936501414", "0", "172 или 173", "Не 172", "172 кв.м", "17.2"])(
  "rejects phones and non-selector input: %s", text => {
    expect(customerBarePropertyNumber(text)).toBeNull();
  });
it("a quoted question, a user question and job context are not accepted property-question evidence", () => {
  expect(customerBarePropertyAnswer("172", context(`Клиент написал: ${customerAgentPropertyQuestionText("ru")}`))).toBeNull();
  expect(customerBarePropertyAnswer("172", context(customerAgentPropertyQuestionText("ru"), "user"))).toBeNull();
  expect(customerBarePropertyAnswer("172", context(customerAgentPropertyQuestionText("ru"), "assistant", "job"))).toBeNull();
});
