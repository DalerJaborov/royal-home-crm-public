import { describe, expect, it } from "vitest";
import { interactionCreateSchema, propertyUpdateSchema, showingRescheduleSchema } from "@royal-home/shared";

/**
 * Очистка полей карточки объекта.
 *
 * Форма отправляет пустое поле как null — но принять его должна ещё и схема. Пока
 * часть полей была объявлена просто optional, отправленный null отвергался, а
 * отправленный undefined выпадал из JSON, и PATCH приходил вообще без ключа: агент
 * стирал контакт владельца или этаж, видел «Сохранено» и находил старое значение.
 *
 * Тест держит ровно эту границу: что очищать МОЖНО, а что нельзя.
 */

describe("Какие поля объекта можно очистить", () => {
  it("контакт владельца, комнаты, этаж, этажность, документы", () => {
    const parsed = propertyUpdateSchema.safeParse({
      ownerContact: null,
      rooms: null,
      floor: null,
      totalFloors: null,
      documents: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("стадия строительства и «новостройка/вторичка» — в форме есть «не указано»", () => {
    const parsed = propertyUpdateSchema.safeParse({ stage: null, marketType: null });
    expect(parsed.success).toBe(true);
  });

  it("дату приёма объекта очистить НЕЛЬЗЯ — в базе поле обязательное", () => {
    // Здесь null обязан отвергаться: иначе форма отправила бы его и получила отказ
    // уже от базы, а человек увидел бы непонятную ошибку вместо подсказки.
    expect(propertyUpdateSchema.safeParse({ listingAcceptedAt: null }).success).toBe(false);
  });

  it("проверки значений от .nullish() не ослабли", () => {
    // Возможность очистить поле не должна превращаться в право положить в него что угодно.
    expect(propertyUpdateSchema.safeParse({ rooms: -3 }).success).toBe(false);
    expect(propertyUpdateSchema.safeParse({ totalFloors: 0 }).success).toBe(false);
    expect(propertyUpdateSchema.safeParse({ stage: "ЧТО-ТО" }).success).toBe(false);
  });
});

/**
 * `z.coerce.date()` прогоняет значение через `new Date(...)`, а `new Date(null)` —
 * это 1 января 1970 года. То есть присланный null не отвергался, а МОЛЧА ставил
 * дату из прошлого века: объект «принят в 1970-м», показ «назначен в 1970-м».
 * Заметить это можно было только глазами в карточке.
 */
describe("null в датах не превращается в 1970 год", () => {
  it("дата приёма объекта", () => {
    expect(propertyUpdateSchema.safeParse({ listingAcceptedAt: null }).success).toBe(false);
  });

  it("дата следующего шага во взаимодействии", () => {
    expect(interactionCreateSchema.safeParse({ type: "CALL", notes: "звонил", nextActionDate: null }).success).toBe(
      false
    );
  });

  it("перенос показа", () => {
    expect(showingRescheduleSchema.safeParse({ at: null }).success).toBe(false);
  });

  it("настоящая дата по-прежнему принимается строкой", () => {
    const parsed = propertyUpdateSchema.safeParse({ listingAcceptedAt: "2026-07-25" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.listingAcceptedAt).toBeInstanceOf(Date);
  });
});
