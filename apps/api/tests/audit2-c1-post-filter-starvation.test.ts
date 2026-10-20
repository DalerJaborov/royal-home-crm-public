import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { findSellerPropertyMissing } from "../src/lib/sellerPropertyMissingAntifraud.js";
import { runRefusedHighScoreAlarmTick } from "../src/lib/buyerNoCallAlarm.js";

/**
 * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-06 (родственные места): ЛИМИТ ВЫБОРКИ СЧИТАЛСЯ ДО ФИЛЬТРА.
 *
 * sellerPropertyMissingAntifraud: take 500 по propertyAcceptedAt asc, а «у продавца есть объект»
 * отсеивалось ПОСЛЕ — 500 самых давних здоровых продавцов с объектами навсегда занимали выборку,
 * и продавец без объекта за ними никогда не эскалировался. buyerNoCallAlarm: take 200 по отметке
 * «отказ при высоком скоринге», уведомлённые отсеивались после — свежий отказ не доходил до тика.
 * Теперь фильтр стоит в самом SQL, до LIMIT.
 */
const runId = Date.now();
const OLD = new Date("2001-01-01T00:00:00Z");
let districtId = "";
let agentId = "";
let directorId = "";
let savedAlarmHours: { alarmHoursStart: string; alarmHoursEnd: string } | null = null;
const clientIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-starvation-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент starvation", phone: `+992959${String(runId).slice(-9)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  // Тик молча выходит, если нет ни одного активного директора или окно алармов закрыто, —
  // на чистой базе (ship --clean-db) директора может не быть, а окно правят соседние тесты.
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор starvation", phone: `+992958${String(runId).slice(-9)}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  savedAlarmHours = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { alarmHoursStart: true, alarmHoursEnd: true },
  });
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { alarmHoursStart: "00:00", alarmHoursEnd: "23:59" },
    create: { id: "singleton", alarmHoursStart: "00:00", alarmHoursEnd: "23:59" },
  });
});

afterAll(async () => {
  if (savedAlarmHours) await prisma.settings.update({ where: { id: "singleton" }, data: savedAlarmHours });
  await prisma.notification.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
  await prisma.property.deleteMany({ where: { sellerClientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("findSellerPropertyMissing: здоровые продавцы не занимают выборку", () => {
  it("500 давних продавцов с объектами и один позже без объекта: тот, что без объекта, виден", async () => {
    const healthy = Array.from({ length: 500 }, (_, i) => ({ id: randomUUID(), i }));
    await prisma.client.createMany({
      data: healthy.map(({ id, i }) => ({
        id,
        fullName: `Здоровый продавец ${runId}-${i}`,
        phone: `+9929${String(runId).slice(-5)}${String(i).padStart(4, "0")}`,
        source: "PHONE_CALL" as const,
        kind: "SELLER" as const,
        assignedAgentId: agentId,
        propertyAcceptedAt: OLD,
      })),
    });
    clientIds.push(...healthy.map((h) => h.id));
    await prisma.property.createMany({
      data: healthy.map(({ id, i }) => ({
        title: `Объект здорового ${runId}-${i}`,
        type: "APARTMENT" as const,
        areaSqm: 50,
        price: 40000,
        currency: "USD" as const,
        districtId,
        address: "Тестовая",
        condition: "GOOD" as const,
        sellerClientId: id,
      })),
    });
    const missing = await prisma.client.create({
      data: {
        fullName: `Продавец без объекта ${runId}`,
        phone: `+9929${String(runId).slice(-5)}9999`,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: agentId,
        // Старше порога, но позже всех здоровых по очереди «asc».
        propertyAcceptedAt: new Date("2001-02-01T00:00:00Z"),
      },
    });
    clientIds.push(missing.id);

    const { items } = await findSellerPropertyMissing(new Date());
    expect(items.some((i) => i.id === missing.id)).toBe(true);
    expect(items.some((i) => healthy.some((h) => h.id === i.id))).toBe(false);
  }, 60_000);
});

describe("runRefusedHighScoreAlarmTick: уже уведомлённые не занимают выборку", () => {
  it("2000 уже уведомлённых отказов и один новый: новый доходит до уведомления", async () => {
    const flaggedBefore = new Date("2001-03-01T00:00:00Z");
    // Много больше предела выборки (200): без ORDER BY порядок строк физический, и один новый
    // отказ среди двух тысяч уведомлённых попадает в первые 200 лишь с вероятностью 10%.
    const notified = Array.from({ length: 2000 }, (_, i) => ({ id: randomUUID(), i }));
    await prisma.client.createMany({
      data: notified.map(({ id, i }) => ({
        id,
        fullName: `Уведомлённый отказ ${runId}-${i}`,
        phone: `+9928${String(runId).slice(-5)}${String(i).padStart(4, "0")}`,
        source: "PHONE_CALL" as const,
        kind: "BUYER" as const,
        assignedAgentId: agentId,
        refusedHighScoreFlaggedAt: flaggedBefore,
        refusedHighScoreNotifiedAt: new Date(flaggedBefore.getTime() + 60_000),
      })),
    });
    clientIds.push(...notified.map((n) => n.id));
    const fresh = await prisma.client.create({
      data: {
        fullName: `Новый отказ ${runId}`,
        phone: `+9929${String(runId).slice(-5)}8888`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        // Самый ранний флаг в базе: ORDER BY flaggedAt ASC LIMIT 200 берёт его первым, даже
        // если соседние тесты оставили свои неуведомлённые отказы.
        refusedHighScoreFlaggedAt: new Date("1970-01-02T00:00:00Z"),
      },
    });
    clientIds.push(fresh.id);

    // 12:00 по Душанбе во вторник — внутри часов алармов.
    await runRefusedHighScoreAlarmTick(new Date("2026-09-01T07:00:00Z"));
    const after = await prisma.client.findUniqueOrThrow({
      where: { id: fresh.id },
      select: { refusedHighScoreNotifiedAt: true },
    });
    expect(after.refusedHighScoreNotifiedAt).not.toBeNull();
  }, 60_000);
});
