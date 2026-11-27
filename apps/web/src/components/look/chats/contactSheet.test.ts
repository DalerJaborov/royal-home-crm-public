import { describe, expect, it } from "vitest";
import { contactDetailRows, contactPrimaryAction, contactSecondaryActions, type ContactActionInput, type ContactDetailsInput } from "./contactSheet";

const base: ContactActionInput = { clientId: "c1", clientShortId: "KL-1", pendingAcceptance: false, canAccept: false };

describe("contactPrimaryAction — одна главная кнопка по состоянию заявки", () => {
  it("заявка ждёт принятия и принять может смотрящий: «Принять заявку»", () => {
    expect(contactPrimaryAction({ ...base, pendingAcceptance: true, canAccept: true })).toEqual({ kind: "accept", label: "Принять заявку" });
  });
  it("заявка ждёт, но принять может не он (руководитель, чужая заявка): открыть карточку, не «Принять»", () => {
    expect(contactPrimaryAction({ ...base, pendingAcceptance: true, canAccept: false })).toMatchObject({ kind: "card", shortId: "KL-1" });
  });
  it("заявка уже принята: «Открыть карточку клиента»", () => {
    expect(contactPrimaryAction(base)).toEqual({ kind: "card", label: "Открыть карточку клиента", shortId: "KL-1" });
  });
  it("карточки нет: главной кнопки нет (не выдумываем «Принять» без клиента)", () => {
    expect(contactPrimaryAction({ clientId: null, clientShortId: null, pendingAcceptance: true, canAccept: true })).toBeNull();
  });
});

describe("contactSecondaryActions — «Позвонить» и «Карточка клиента» без повторов главной", () => {
  const phone = { hasPhone: true, readOnly: false };
  it("главная — «Принять»: рядом и «Позвонить», и «Карточка клиента»", () => {
    expect(contactSecondaryActions({ ...base, pendingAcceptance: true, canAccept: true, ...phone })).toEqual({ call: true, card: true });
  });
  it("главная — карточка: вторая «Карточка клиента» не дублируется", () => {
    expect(contactSecondaryActions({ ...base, ...phone })).toEqual({ call: true, card: false });
  });
  it("нет номера или режим «только чтение»: «Позвонить» нет", () => {
    expect(contactSecondaryActions({ ...base, hasPhone: false, readOnly: false }).call).toBe(false);
    expect(contactSecondaryActions({ ...base, hasPhone: true, readOnly: true }).call).toBe(false);
  });
});

describe("contactDetailRows — каждое значение один раз", () => {
  const input: ContactDetailsInput = {
    code: "ПР-000894", profileName: "Алишер", phone: "+992900000099", firstContact: "2 дня назад", messagesCount: 7,
    subscriberId: "peer-1", hasDossier: false, isGroupedEntry: false,
  };
  const keys = (i: ContactDetailsInput) => contactDetailRows(i).map((r) => r.key);

  it("без досье: все прежние данные на месте, канала в строках нет (он под именем)", () => {
    expect(keys(input)).toEqual(["code", "phone", "profile", "first", "count", "subscriber"]);
  });
  it("с досье «первое обращение» и «сообщений» не повторяются: их говорит «Что знает бот»", () => {
    expect(keys({ ...input, hasDossier: true })).toEqual(["code", "phone", "profile", "subscriber"]);
  });
  it("общий чат клиента: служебного идентификатора канала нет; пустое — словами, а не пустотой", () => {
    const rows = contactDetailRows({ ...input, isGroupedEntry: true, phone: null, profileName: null, code: null });
    expect(rows.map((r) => r.key)).not.toContain("subscriber");
    expect(rows.find((r) => r.key === "phone")?.value).toBe("Номер пока не указан");
    expect(rows.find((r) => r.key === "profile")?.value).toBe("Не указано");
  });
  it("в строках нет одинаковых подписей", () => {
    const labels = contactDetailRows(input).map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
