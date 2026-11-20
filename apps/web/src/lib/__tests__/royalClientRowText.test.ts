import { describe, expect, it } from "vitest";
import { clientDisplayName, clientNameParts } from "@royal-home/shared";
import { royalClientRowText } from "../royalClientRowText";

/**
 * Строка клиента «Нового вида» берёт имя и якорь из общего правила (ревью PR 331):
 * раньше имя собиралось из сырого fullName — у продавца стояло «Продавец ПР-000388»,
 * а вторая строка «Запрос пока не заполнен» вместо адреса объекта (решение владельца
 * 21.09: «Джахонгир · Маяковский»).
 */
describe("строка клиента нового вида: имя и якорь", () => {
  it("продавец: имя без заглушки, второй строкой — адрес объекта с сервера", () => {
    const seller = { kind: "SELLER" as const, fullName: "Джахонгир", source: "WHATSAPP" as const,
      displayNameParts: { name: "Джахонгир", anchor: "Маяковский 45" } };
    expect(royalClientRowText(seller, "Запрос пока не заполнен")).toEqual({ name: "Джахонгир", request: "Маяковский 45" });
  });
  it("продавец с заглушкой вместо имени: «Продавец из WhatsApp», а не «Продавец ПР-000388»", () => {
    const row = royalClientRowText({ kind: "SELLER", fullName: "Продавец ПР-000388", source: "WHATSAPP", address: "ул. Айни, 12" }, "Запрос пока не заполнен");
    expect(row.name).toBe("Продавец из WhatsApp");
    expect(row.request).toBe("ул. Айни, 12");
  });
  it("покупатель-заглушка «Клиент Instagram»: имя по правилу, вторая строка — запрос", () => {
    const row = royalClientRowText({ kind: "BUYER", fullName: "Клиент Instagram", source: "INSTAGRAM", desiredRooms: 2 }, "2 комн · Сино");
    expect(row).toEqual({ name: "Покупатель из Instagram", request: "2 комн · Сино" });
  });
  it("продавец без адреса — честная строка, а не «Запрос пока не заполнен»", () => {
    expect(royalClientRowText({ kind: "SELLER", fullName: "Зарина" }, "Запрос пока не заполнен").request).toBe("Адрес объекта не указан");
  });
  it("части и склейка — одно правило: clientDisplayName = name · anchor", () => {
    const input = { kind: "SELLER" as const, fullName: "Зоир", address: "стадион Спартак" };
    const { name, anchor } = clientNameParts(input);
    expect(clientDisplayName(input)).toBe(`${name} · ${anchor}`);
    expect(clientNameParts({ kind: "SELLER", fullName: "Зоир стадион Спартак", address: "стадион Спартак" }).anchor).toBeNull();
  });
});
