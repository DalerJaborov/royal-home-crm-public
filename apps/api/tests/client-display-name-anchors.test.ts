import { describe, expect, it } from "vitest";
import { clientDisplayName, clientNameParts, propertyAnchorText } from "@royal-home/shared";

/**
 * «Имя · объект/ориентир» (владелец 22.11.2026: «клиенты назывались автоматически, а
 * теперь все «Покупатель ПК-000925» / «Покупатель из WhatsApp»»). Чистая функция.
 * Порядок: имя есть → оно; имени нет, но есть объект/ориентир/запрос → «Роль · якорь»;
 * ничего → роль из канала, и номер карточки только мелкой строкой.
 */
describe("имя + якорь: четыре случая владельца", () => {
  it("имя есть: «Имя · ориентир»", () => {
    expect(clientDisplayName({ kind: "SELLER", fullName: "Зоир", address: "стадион Спартак" })).toBe("Зоир · стадион Спартак");
    expect(clientDisplayName({ kind: "SELLER", fullName: "Зоир" }, { propertyAddress: "Шохмансур, ул. Айни 12" })).toBe("Зоир · Шохмансур, ул. Айни 12");
  });

  it("имени нет, но есть объект интереса: «Покупатель из WhatsApp · Сино, 2к»", () => {
    const input = { kind: "BUYER" as const, fullName: "Покупатель ПК-000925", source: "WHATSAPP" as const, shortId: 925 };
    expect(clientDisplayName(input, { interestAnchor: propertyAnchorText({ districtName: "Сино", rooms: 2 }) })).toBe("Покупатель из WhatsApp · Сино, 2к");
  });

  it("имени нет, но заполнен запрос: якорь — «ищет …»", () => {
    expect(clientDisplayName({ kind: "BUYER", fullName: "Покупатель ПК-000925", source: "WHATSAPP", desiredRooms: 2, desiredDistrict: { name: "Сино" } }))
      .toBe("Покупатель из WhatsApp · ищет 2к Сино");
  });

  it("продавец без имени: «Продавец из WhatsApp · ориентир объекта»", () => {
    expect(clientDisplayName({ kind: "SELLER", fullName: "Продавец ПР-000388", source: "WHATSAPP" }, { propertyAddress: "Шохмансур, ул. Айни 12" }))
      .toBe("Продавец из WhatsApp · Шохмансур, ул. Айни 12");
  });

  it("ничего не известно: роль и канал, а к строке — номер карточки (не вместо имени)", () => {
    const input = { kind: "BUYER" as const, fullName: "Покупатель ПК-000925", source: "WHATSAPP" as const, shortId: 925 };
    expect(clientDisplayName(input)).toBe("Покупатель из WhatsApp · ПК-000925");
    expect(clientNameParts(input)).toMatchObject({ name: "Покупатель из WhatsApp", anchor: null, code: "ПК-000925", nameIsStub: true });
  });

  it("настоящее имя без якоря номером не дополняется", () => {
    expect(clientDisplayName({ kind: "BUYER", fullName: "Далер", shortId: 7 })).toBe("Далер");
    expect(clientNameParts({ kind: "BUYER", fullName: "Далер", shortId: 7 }).code).toBe("ПК-000007");
  });
});

describe("краткая ссылка без kind и «Клиент ПК-0021»", () => {
  it("роль читается из самой заглушки, номер не теряется", () => {
    expect(clientDisplayName({ fullName: "Покупатель ПК-000925", shortId: 925 })).toBe("Покупатель · ПК-000925");
    expect(clientDisplayName({ fullName: "Продавец ПР-000388", shortId: 388 })).toBe("Продавец · ПР-000388");
  });
  it("«Клиент ПК-0021» и маска ника — заглушки, а не имя", () => {
    expect(clientDisplayName({ fullName: "Клиент ПК-0021", shortId: 21 })).toBe("Клиент · ПК-000021");
    expect(clientDisplayName({ fullName: "@•••••" })).toBe("Клиент");
  });
});

describe("якорь объекта: ориентир → адрес → «Район, Nк»", () => {
  it("порядок приоритета и пустота", () => {
    expect(propertyAnchorText({ landmark: "Маяковский 45", address: "ул. Х", districtName: "Сино", rooms: 3 })).toBe("Маяковский 45");
    expect(propertyAnchorText({ address: "ул. Х", districtName: "Сино", rooms: 3 })).toBe("ул. Х");
    expect(propertyAnchorText({ districtName: "Сино", rooms: 3 })).toBe("Сино, 3к");
    expect(propertyAnchorText({})).toBeNull();
  });
});
