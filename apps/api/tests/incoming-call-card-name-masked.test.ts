import { afterAll, describe, expect, it } from "vitest";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { createClientForCall } from "../src/lib/telephony/qualifyIncoming.js";

/**
 * B16 глубокой проверки 02.10.2026: карточка, заведённая разбором входящего
 * звонка, называлась «Входящий +992…» с открытым номером — имя видно в списках,
 * уведомлениях и ленте даже тем, кому номер закрыт. Соседние пути
 * (incomingCalls.ts, voicemailIngest.ts) номер в имени уже маскируют.
 */

const ids: string[] = [];

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("имя карточки входящего звонка", () => {
  it("не содержит открытого номера", async () => {
    const digits = String(randomInt(1_000_000, 9_999_999));
    const phone = `+99293${digits}`;
    const id = await createClientForCall(phone);
    expect(id).not.toBeNull();
    ids.push(id!);
    const c = await prisma.client.findUniqueOrThrow({ where: { id: id! } });
    expect(c.phone).toBe(phone);
    expect(c.fullName).not.toContain(digits);
    expect(c.fullName.startsWith("Входящий ")).toBe(true);
  });
});
