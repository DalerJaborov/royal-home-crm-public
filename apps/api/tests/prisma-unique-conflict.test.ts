import { describe, expect, it } from "vitest";
import { matchesUniqueConstraint } from "../src/lib/prismaUniqueConflict.js";

/**
 * РЕГРЕССИЯ НА ФОРМАТ P2002 (15.09.2026, см. память
 * royalhome-prisma7-p2002-target-changed-15-09).
 *
 * С драйверным адаптером (`@prisma/adapter-pg`, см. db.ts) Prisma вообще не
 * кладёт `meta.target` в ошибку P2002 — только `meta.driverAdapterError` и имя
 * ограничения в тексте `message` («Unique constraint failed on the constraint:
 * `Client_phone_key`»). Проверено прогоном напрямую против живой Postgres
 * (реальная форма ошибки ниже — не придумана, а списана 1:1).
 */
const REAL_DRIVER_ADAPTER_ERROR = {
  code: "P2002",
  meta: {
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23505",
        originalMessage: 'duplicate key value violates unique constraint "Client_phone_key"',
        kind: "UniqueConstraintViolation",
        constraint: { index: "Client_phone_key" },
      },
    },
    modelName: "Client",
  },
  message:
    "Invalid `prisma.client.create()` invocation\nUnique constraint failed on the constraint: `Client_phone_key`",
};

describe("matchesUniqueConstraint", () => {
  it("узнаёт конфликт по реальной форме ошибки драйверного адаптера (без meta.target)", () => {
    expect(matchesUniqueConstraint(REAL_DRIVER_ADAPTER_ERROR, "phone")).toBe(true);
  });

  it("не путает phone с другим полем той же ошибки", () => {
    expect(matchesUniqueConstraint(REAL_DRIVER_ADAPTER_ERROR, "telegramChatId")).toBe(false);
  });

  it("узнаёт конфликт telegramChatId по имени ограничения в message", () => {
    const err = {
      code: "P2002",
      meta: { modelName: "Client" },
      message: "Unique constraint failed on the constraint: `Client_telegramChatId_key`",
    };
    expect(matchesUniqueConstraint(err, "telegramChatId")).toBe(true);
  });

  it("узнаёт конфликт siteListingId по имени ограничения в message (Property)", () => {
    const err = {
      code: "P2002",
      message: "Unique constraint failed on the constraint: `Property_siteListingId_key`",
    };
    expect(matchesUniqueConstraint(err, "siteListingId")).toBe(true);
  });

  it("узнаёт конфликт по старому виду meta.target — массив имён полей", () => {
    const err = { code: "P2002", meta: { target: ["phone"] } };
    expect(matchesUniqueConstraint(err, "phone")).toBe(true);
  });

  it("узнаёт конфликт по старому виду meta.target — строка", () => {
    const err = { code: "P2002", meta: { target: "phone" } };
    expect(matchesUniqueConstraint(err, "phone")).toBe(true);
  });

  it("не срабатывает на других кодах ошибок Prisma", () => {
    const err = { code: "P2025", meta: { target: ["phone"] } };
    expect(matchesUniqueConstraint(err, "phone")).toBe(false);
  });

  it("не срабатывает на не-Prisma ошибках", () => {
    expect(matchesUniqueConstraint(new Error("что-то сломалось"), "phone")).toBe(false);
    expect(matchesUniqueConstraint(null, "phone")).toBe(false);
    expect(matchesUniqueConstraint("строка", "phone")).toBe(false);
  });
});
