import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * CHANNEL-NEW-21 (аудит Codex, 04.10.2026): автостатус читает клиента, собирает факты
 * (несколько запросов) и пишет `update where id`. Пока он собирал факты, оператор мог
 * поставить LOST и отметить ручную правку: запись по старому снимку затирала её, а
 * защита FROZEN и семидневной ручной блокировки сработала только на снимке.
 */
const { prisma } = await import("../src/db.js");
const { refreshClientStatus } = await import("../src/lib/clientAutoStatus.js");

const runId = Date.now();
const clientIds: string[] = [];

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
});

describe("Автостатус не затирает ручной статус, поставленный во время сбора фактов", () => {
  it("оператор поставил LOST между чтением снимка и записью: статус остаётся LOST, записи в хронологии нет", async () => {
    const client = await prisma.client.create({
      data: { fullName: `Автостатус гонка ${runId}`, phone: `+992970${String(runId).slice(-7)}`, kind: "BUYER", source: "WEBSITE", status: "CONTACTED" },
    });
    clientIds.push(client.id);

    // Управляемая задержка: сразу после сбора фактов оператор меняет статус руками.
    const realFindMany = prisma.interaction.findMany.bind(prisma.interaction);
    const spy = vi.spyOn(prisma.interaction, "findMany").mockImplementation((async (args: never) => {
      const rows = await realFindMany(args);
      await prisma.client.update({ where: { id: client.id }, data: { status: "LOST", statusSetManuallyAt: new Date() } });
      return rows;
    }) as never);
    let result;
    try {
      // Без событий вообще движок решил бы ARCHIVED (тишина дольше порога).
      result = await refreshClientStatus(client.id);
    } finally {
      spy.mockRestore();
    }

    expect(result).toBeNull();
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.status).toBe("LOST");
    expect(await prisma.interaction.findFirst({ where: { clientId: client.id, type: "STATUS_CHANGE" } })).toBeNull();
  });
});
