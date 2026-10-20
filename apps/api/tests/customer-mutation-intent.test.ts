import { describe, expect, it } from "vitest";
import { customerMutationCommandSchema, customerMutationReceiptSchema } from "@royal-home/shared";
import { currentInputAuthorizesCustomerCommand } from "../src/lib/customerMutationIntent.js";
import { customerMutationDigest } from "../src/lib/customerActionCommand.js";

describe("customer action proposal is not approval", () => {
  const book = { name: "book_showing", args: { propertyShortId: 123, at: "2026-10-20T15:00:00+05:00" } } as const;
  it.each(["Запишите на просмотр 20.10.2026 в 15:00", "Тамошо 20.10.2026 соати 15:00"])("accepts one fully stated current date/time: %s", text => {
    expect(currentInputAuthorizesCustomerCommand(text, book)).toBe(true);
  });
  it.each(["Можно посмотреть 20.10.2026 в 15:00?", "Запишите завтра в 15:00", "Не надо записывать на просмотр 20.10.2026 в 15:00",
    "Он сказал: «запишите на просмотр 20.10.2026 в 15:00»", "Запишите на просмотр 20.10.2026 в 16:00",
    "Запишите на просмотр 20.10.2026 в 15:00 или 21.10.2026 в 15:00"])("clarifies ambiguous/negated/reported slot: %s", text => {
    expect(currentInputAuthorizesCustomerCommand(text, book)).toBe(false);
  });
  it("does not turn a cancellation question into cancellation", () => {
    const cancel = { name: "cancel_showing", args: { bookingRef: "00000000-0000-4000-8000-000000000001", expectedRevision: "1" } } as const;
    expect(currentInputAuthorizesCustomerCommand("Как отменить показ?", cancel)).toBe(false);
    expect(currentInputAuthorizesCustomerCommand("Отмените показ", cancel)).toBe(true);
    expect(currentInputAuthorizesCustomerCommand("Не отменяйте показ", cancel)).toBe(false);
  });
  it("escalates a stated no-call complaint without inventing its topic", () => {
    const text = "Мне так и не звонили";
    expect(currentInputAuthorizesCustomerCommand(text, { name: "request_handover", args: { topic: text } })).toBe(true);
    expect(currentInputAuthorizesCustomerCommand(text, { name: "request_handover", args: { topic: "Сотрудник уже звонит" } })).toBe(false);
  });
  it.each(["Не нужен оператор", "Мне не нужен сотрудник", "Кто такой оператор?", "Вам нужен оператор?", "Вакансия: нужен ли оператор?", "Корманд лозим нест"])("mention or rejection is not a handover request: %s", text => {
    expect(currentInputAuthorizesCustomerCommand(text, { name: "request_handover", args: { topic: text } })).toBe(false);
  });
  it.each(["Соедините меня с оператором", "Мне нужен сотрудник", "Прошу оператора", "Можно поговорить с оператором?", "Бо корманд суҳбат кардан мехоҳам"])("retains an explicit human request: %s", text => {
    expect(currentInputAuthorizesCustomerCommand(text, { name: "request_handover", args: { topic: text } })).toBe(true);
  });
  it.each(["Не спрашивайте у собственника", "Не спрашивай собственника?", "Не передавайте мой вопрос собственнику?", "Напурсед", "Хорошо"])("does not turn an owner refusal or acknowledgement into a new question: %s", text => {
    expect(currentInputAuthorizesCustomerCommand(text, { name: "ask_owner", args: { question: text } })).toBe(false);
  });
  it("strict proposal never accepts actor/client/grant fields or missing optimistic revision", () => {
    expect(customerMutationCommandSchema.safeParse({ ...book, args: { ...book.args, clientId: "foreign" } }).success).toBe(false);
    expect(customerMutationCommandSchema.safeParse({ name: "cancel_showing", args: { bookingRef: "00000000-0000-4000-8000-000000000001" } }).success).toBe(false);
    expect(customerMutationDigest(book)).not.toBe(customerMutationDigest({ ...book, args: { ...book.args, at: "2026-10-20T16:00:00+05:00" } }));
  });
  it("managed receipts require the right resource and positive persisted resource revision", () => {
    const receipt = { version: 2, actionId: "00000000-0000-4000-8000-000000000001", inquiryId: "00000000-0000-4000-8000-000000000002",
      kind: "handover", generation: "1", outcome: "handover_requested", resourceType: "CallbackRequest",
      resourceId: "00000000-0000-4000-8000-000000000003", publicRef: "00000000-0000-4000-8000-000000000004",
      resourceRevision: "1", committedAt: "2026-10-20T10:00:00.000Z" };
    expect(customerMutationReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(customerMutationReceiptSchema.safeParse({ ...receipt, resourceType: "Client" }).success).toBe(false);
    expect(customerMutationReceiptSchema.safeParse({ ...receipt, resourceRevision: "0" }).success).toBe(false);
  });
});
