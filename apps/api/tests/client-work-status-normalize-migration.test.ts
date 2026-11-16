import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";

/**
 * Миграция 20261116150000_client_work_status_normalize (владелец 16.11.2026:
 * «Неактивных» и «Отложенных» больше нет). Проверяем саму SQL-миграцию на живой
 * базе: она возвращает INACTIVE/DEFERRED в ACTIVE, пишет журнал переходов,
 * не трогает карточку с нерешённым предложением прежнему агенту и при повторном
 * запуске ничего не делает.
 *
 * База тестов общая для параллельных файлов, поэтому выборка миграции здесь
 * сужена до своих карточек (scoped): логика та же, чужие фикстуры не трогаем.
 */

const SQL = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../prisma/migrations/20261116150000_client_work_status_normalize/migration.sql"
  ),
  "utf8"
);

const runId = Date.now();
const ids: Record<string, string> = {};
let agentId = "";

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: {
        fullName: `Миграция статусов ${runId}`,
        phone: `+992951${String(runId).slice(-7)}`,
        role: "AGENT",
        passwordHash: await bcrypt.hash("x", 4),
      },
    })
  ).id;
  const make = async (key: string, n: number, data: Record<string, unknown>) => {
    const c = await prisma.client.create({
      data: {
        fullName: `Миграция ${key} ${runId}`,
        phone: `+99295${n}${String(runId).slice(-7)}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        ...data,
      },
    });
    ids[key] = c.id;
  };
  await make("inactive", 2, { workStatus: "INACTIVE", inactiveLevel: "RED" });
  await make("deferred", 3, { workStatus: "DEFERRED", deferredReason: "EXPENSIVE" });
  await make("offer", 4, { workStatus: "INACTIVE", reactivationOfferedToAgentId: agentId, reactivationOfferedAt: new Date() });
  await make("active", 5, { workStatus: "ACTIVE" });
});

afterAll(async () => {
  await prisma.stageEvent.deleteMany({ where: { entityId: { in: Object.values(ids) } } });
  await prisma.client.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

/** Та же миграция, но только по карточкам этого файла. */
function scoped(): string {
  const marker = `AND "reactivationOfferedToAgentId" IS NULL`;
  if (!SQL.includes(marker)) throw new Error("миграция изменилась — обновите тест");
  const list = Object.values(ids).map((id) => `'${id}'`).join(", ");
  return SQL.replace(marker, `${marker} AND "id" IN (${list})`);
}

const statusOf = async (key: string) =>
  (await prisma.client.findUniqueOrThrow({ where: { id: ids[key] }, select: { workStatus: true } })).workStatus;
const migrationEvents = () =>
  prisma.stageEvent.findMany({
    where: { entityId: { in: Object.values(ids) }, field: "workStatus", to: "ACTIVE", agentId: null },
    select: { entityId: true, from: true },
  });

describe("миграция: «Неактивные» и «Отложенные» → обычная работа", () => {
  it("INACTIVE и DEFERRED становятся ACTIVE, журнал хранит прежнее значение", async () => {
    await prisma.$executeRawUnsafe(scoped());
    expect(await statusOf("inactive")).toBe("ACTIVE");
    expect(await statusOf("deferred")).toBe("ACTIVE");
    expect(await statusOf("active")).toBe("ACTIVE");
    const events = await migrationEvents();
    expect(events).toEqual(
      expect.arrayContaining([
        { entityId: ids.inactive, from: "INACTIVE" },
        { entityId: ids.deferred, from: "DEFERRED" },
      ])
    );
    // Прочие поля не тронуты: миграция меняет только workStatus.
    const inactive = await prisma.client.findUniqueOrThrow({ where: { id: ids.inactive } });
    expect(inactive.inactiveLevel).toBe("RED");
  });

  it("нерешённое предложение прежнему агенту не снимается", async () => {
    expect(await statusOf("offer")).toBe("INACTIVE");
    expect((await migrationEvents()).some((e) => e.entityId === ids.offer)).toBe(false);
  });

  it("повторный запуск ничего не делает", async () => {
    const before = (await migrationEvents()).length;
    await prisma.$executeRawUnsafe(scoped());
    expect((await migrationEvents()).length).toBe(before);
  });
});

/**
 * Миграция 20261116160000_client_lost_back_to_work (владелец 16.11.2026, вечер):
 * старые LOST — обратно в обычный список (с контактом — CONTACTED, без — NEW),
 * ARCHIVED не трогаем, журнал пишется, повтор ничего не делает.
 */
describe("миграция: старые «Потерянные» → обычная работа", () => {
  const LOST_SQL = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations/20261116160000_client_lost_back_to_work/migration.sql"),
    "utf8"
  );
  const lostIds: Record<string, string> = {};
  const scopedLost = () => {
    const marker = `WHERE "status" = 'LOST'`;
    if (!LOST_SQL.includes(marker)) throw new Error("миграция изменилась — обновите тест");
    return LOST_SQL.replace(marker, `${marker} AND "id" IN (${Object.values(lostIds).map((id) => `'${id}'`).join(", ")})`);
  };

  beforeAll(async () => {
    const mk = async (key: string, n: number, data: Record<string, unknown>) => {
      const c = await prisma.client.create({
        data: {
          fullName: `Миграция LOST ${key} ${runId}`,
          phone: `+99295${n}${String(runId).slice(-6)}9`,
          source: "PHONE_CALL",
          kind: "BUYER",
          assignedAgentId: agentId,
          ...data,
        },
      });
      lostIds[key] = c.id;
    };
    await mk("lostContacted", 6, { status: "LOST", lostAt: new Date(), firstContactAt: new Date() });
    await mk("lostNew", 7, { status: "LOST", lostAt: new Date() });
    await mk("archived", 8, { status: "ARCHIVED" });
  });

  afterAll(async () => {
    await prisma.stageEvent.deleteMany({ where: { entityId: { in: Object.values(lostIds) } } });
    await prisma.client.deleteMany({ where: { id: { in: Object.values(lostIds) } } });
  });

  const st = (key: string) =>
    prisma.client.findUniqueOrThrow({ where: { id: lostIds[key] }, select: { status: true, lostAt: true } });

  it("LOST → CONTACTED/NEW, ARCHIVED не тронут, история и журнал на месте, повтор — без изменений", async () => {
    await prisma.$executeRawUnsafe(scopedLost());
    expect((await st("lostContacted")).status).toBe("CONTACTED");
    expect((await st("lostNew")).status).toBe("NEW");
    expect((await st("lostNew")).lostAt).not.toBeNull();
    expect((await st("archived")).status).toBe("ARCHIVED");
    const events = () =>
      prisma.stageEvent.count({ where: { entityId: { in: Object.values(lostIds) }, field: "status", from: "LOST" } });
    expect(await events()).toBe(2);
    await prisma.$executeRawUnsafe(scopedLost());
    expect(await events()).toBe(2);
  });
});
