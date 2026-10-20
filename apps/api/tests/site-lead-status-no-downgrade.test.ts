import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * САЙТ НЕ ЗАТИРАЕТ СТАТУС КЛИЕНТА ВСЛЕПУЮ (аудит 23.09.2026, №48).
 *
 * Админка сайта знает три слова: новый, на связи, закрыт. Раньше «горячий»
 * клиент агента становился «новым», а закрытая сделка — «на связи».
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const API_KEY = `test-site-status-${runId}`;
const clientIds: string[] = [];

async function client(suffix: string, data: Record<string, unknown>) {
  const phone = `+9929${suffix}${tail}`;
  await prisma.client.deleteMany({ where: { phone } });
  const c = await prisma.client.create({
    data: { fullName: `Клиент сайта ${suffix} ${runId}`, phone, source: "WEBSITE", ...data } as never,
  });
  clientIds.push(c.id);
  return c.id;
}

function send(clientId: string, status: "new" | "contacted" | "closed") {
  return request(app).post("/api/v1/webhooks/site-lead-status").set("X-Api-Key", API_KEY).send({ clientId, status });
}

beforeAll(() => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
});

describe("Статус с сайта", () => {
  it("горячий клиент не становится новым", async () => {
    const id = await client("1", { status: "HOT" });
    expect((await send(id, "new")).status).toBe(200);
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).status).toBe("HOT");
  });

  it("закрытая сделка не становится «на связи»", async () => {
    const id = await client("2", { status: "DEAL_CLOSED" });
    await send(id, "contacted");
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).status).toBe("DEAL_CLOSED");
  });

  it("карточку из Корзины сайт не трогает", async () => {
    const id = await client("3", { status: "NEW", deletedAt: new Date() });
    await send(id, "closed");
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).status).toBe("NEW");
  });

  it("новый становится «на связи», и это видно в истории", async () => {
    const id = await client("4", { status: "NEW" });
    await send(id, "contacted");
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).status).toBe("CONTACTED");
    const log = await prisma.interaction.findFirst({ where: { clientId: id, type: "STATUS_CHANGE" } });
    expect(log?.notes).toContain("с сайта");
  });

  it("SYNC-03: агент перевёл клиента в HOT между чтением и записью: вебхук не затирает, applied=false, истории нет", async () => {
    const id = await client("5", { status: "NEW" });
    const realFindUnique = prisma.client.findUnique.bind(prisma.client);
    // Управляемая задержка: сразу после чтения снимка (NEW) агент меняет статус.
    const spy = vi.spyOn(prisma.client, "findUnique").mockImplementation((async (args: never) => {
      const row = await realFindUnique(args);
      await prisma.client.update({ where: { id }, data: { status: "HOT" } });
      return row;
    }) as never);
    let res;
    try {
      res = await send(id, "contacted");
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect((await prisma.client.findUniqueOrThrow({ where: { id } })).status).toBe("HOT");
    expect(await prisma.interaction.findFirst({ where: { clientId: id, type: "STATUS_CHANGE" } })).toBeNull();
  });
});