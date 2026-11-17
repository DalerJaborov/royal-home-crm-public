import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { logSystemError } from "../src/lib/systemError.js";

/**
 * НОМЕРА КЛИЕНТОВ НЕ ПОПАДАЮТ В ЖУРНАЛ ОШИБОК (аудит безопасности 17.11.2026, S3).
 *
 * Журнал читают все с auditLog.view. Маска стоит в одной двери — logSystemError,
 * а не в каждом из ~150 вызовов: номер кандидата, комментарий клиента с сайта,
 * присланная ссылка — всё проходит через неё.
 */
const marker = `phone-mask-${Date.now()}`;

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { message: { contains: marker } } });
  await prisma.$disconnect();
});

describe("logSystemError маскирует номера", () => {
  it("номер в тексте ошибки уходит в журнал маской", async () => {
    await logSystemError("api", `${marker}: Кандидат по звонку (+992 93 700 11 22) не принят`);
    const row = await prisma.errorLog.findFirst({ where: { message: { contains: marker } }, select: { message: true } });
    expect(row).not.toBeNull();
    expect(row!.message.replace(/\D/g, "")).not.toContain("937001122");
    expect(row!.message).toContain("•");
  });
});
