import { describe, expect, it } from "vitest";
import { propertyCreateSchema } from "@royal-home/shared";

/**
 * Обязательные поля объекта при создании (спецификация владельца, Этап 4):
 * комнаты, этаж, этажность, окна, контакт собственника. Раньше все были
 * необязательны — карточка сохранялась пустой, и агент забывал дозаполнить.
 *
 * Комнаты/этаж/этажность/окна намеренно НЕ требуются для участка (LAND) — у
 * земли их не бывает, и заставлять вписывать выдуманное число хуже, чем
 * оставить поле пустым. Отступление от буквы спецификации ради здравого смысла.
 */

const BASE = {
  type: "APARTMENT" as const,
  areaSqm: 60,
  price: 400000,
  currency: "TJS" as const,
  districtId: "00000000-0000-0000-0000-000000000000",
  address: "Тестовая, 1",
  condition: "GOOD" as const,
  // НЕ +992900000000 (17.09.2026): это номер сидового директора — в тестах
  // объектов такой контакт больше не годится (lib/staffPhoneGuard.ts).
  ownerContact: "+992937000001",
  rooms: 2,
  floor: 3,
  totalFloors: 9,
  windowCount: 4,
};

describe("Обязательные поля при создании объекта", () => {
  it("полный набор проходит", () => {
    expect(propertyCreateSchema.safeParse(BASE).success).toBe(true);
  });

  it("без комнат/этажа/этажности/окон — отклоняется для квартиры", () => {
    const { rooms, floor, totalFloors, windowCount, ...rest } = BASE;
    const parsed = propertyCreateSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path[0]);
      expect(paths).toEqual(expect.arrayContaining(["rooms", "floor", "totalFloors", "windowCount"]));
    }
  });

  it("без контакта собственника — отклоняется для любого типа", () => {
    const { ownerContact: _omit, ...rest } = BASE;
    const parsed = propertyCreateSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((i) => i.path[0] === "ownerContact")).toBe(true);
  });

  it("пустая строка контакта считается отсутствием, а не значением", () => {
    const parsed = propertyCreateSchema.safeParse({ ...BASE, ownerContact: "   " });
    expect(parsed.success).toBe(false);
  });

  it("участок (LAND) не требует комнат/этажа/этажности/окон", () => {
    const { rooms, floor, totalFloors, windowCount, ...rest } = BASE;
    const parsed = propertyCreateSchema.safeParse({ ...rest, type: "LAND" });
    expect(parsed.success).toBe(true);
  });

  it("участок с этими полями не отклоняется — лишние поля просто отбрасываются (property-type-fields.test.ts)", () => {
    const parsed = propertyCreateSchema.safeParse({ ...BASE, type: "LAND" });
    expect(parsed.success).toBe(true);
  });

  it("описание НЕ требуется в схеме — сервер генерирует его сам (SEO)", () => {
    const { ...rest } = BASE;
    expect(propertyCreateSchema.safeParse(rest).success).toBe(true);
    expect("description" in BASE).toBe(false);
  });

  // Владелец 14.09.2026: закрытый объект («только для своих», offSite) требует
  // ровно цену и продавца — район/адрес мастер больше не спрашивает, сервер
  // достраивает их сам по координатам (см. property-closed-geo-fallback.test.ts).
  it("закрытый объект (offSite) не требует района/адреса", () => {
    const { districtId, address, ...rest } = BASE;
    const parsed = propertyCreateSchema.safeParse({ ...rest, offSite: true });
    expect(parsed.success).toBe(true);
  });

  it("обычный объект (не offSite) всё ещё требует район и адрес", () => {
    const { districtId, address, ...rest } = BASE;
    const parsed = propertyCreateSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path[0]);
      expect(paths).toEqual(expect.arrayContaining(["districtId", "address"]));
    }
  });
});
