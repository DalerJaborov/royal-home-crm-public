import { afterAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { runVideoHandoffStaleAlarmTick } from "../src/lib/videoHandoffStaleAlarm.js";

/**
 * Регрессионный тест аларма «монтаж завис» (найдено 16.09.2026 на проде: объект
 * №96 провисел в SENT_TO_EDITOR пять дней, следующие объекты (№99, №102) тихо
 * копились в QUEUED и ни разу не ушли монтажёру — ни одной строки в ErrorLog).
 * Проверяет детектор через дедуп-тег в Notification, тот же приём, что у
 * seller-no-property-alarm.test.ts.
 */

const runId = Date.now();
// Тот же фиксированный вторник 12:00 по Душанбе, что у seller-no-property-alarm —
// тик молчит вне часов алармов.
const NOW = new Date("2026-09-01T07:00:00Z");
const HOUR_MS = 3_600_000;

let districtId: string;
let montajerId: string;
let directorId: string;
const propertyIds: string[] = [];

async function alarmSentFor(propertyId: string): Promise<boolean> {
  const n = await prisma.notification.findFirst({ where: { tag: `video-handoff-stale-${propertyId}` } });
  return n !== null;
}

async function seedProperty(opts: { status: "SENT_TO_EDITOR" | "QUEUED"; hoursAgo: number }) {
  const property = await prisma.property.create({
    data: {
      title: `Аларм монтажа-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 48,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 11",
      condition: "GOOD",
      videoHandoffStatus: opts.status,
      videoHandoffSentAt: new Date(NOW.getTime() - opts.hoursAgo * HOUR_MS),
    },
  });
  propertyIds.push(property.id);
  return property;
}

beforeEach(async () => {
  if (!districtId) {
    const district = await prisma.district.create({ data: { name: `Аларм монтажа-${runId}` } });
    districtId = district.id;
  }
  if (!montajerId) {
    const agent = await prisma.agent.create({
      data: { fullName: "Монтажёр теста аларма", phone: `+99296${runId}`, role: "AGENT", passwordHash: await bcrypt.hash("x", 10) },
    });
    montajerId = agent.id;
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { videoMontajerAgentId: montajerId },
      create: { id: "singleton", videoMontajerAgentId: montajerId },
    });
  }
  if (!directorId) {
    const director = await prisma.agent.create({
      data: { fullName: "Директор теста аларма", phone: `+99298${runId}`, role: "DIRECTOR", passwordHash: await bcrypt.hash("x", 10) },
    });
    directorId = director.id;
  }
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "video-handoff-stale-" }, agentId: directorId } });
  if (propertyIds.length) await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  if (montajerId) await prisma.agent.delete({ where: { id: montajerId } }).catch(() => {});
  if (directorId) await prisma.agent.delete({ where: { id: directorId } }).catch(() => {});
  if (districtId) await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
});

describe("аларм «монтаж завис»", () => {
  it("SENT_TO_EDITOR дольше порога (24ч) — тревога уходит директору", async () => {
    const property = await seedProperty({ status: "SENT_TO_EDITOR", hoursAgo: 30 });
    const { alerted } = await runVideoHandoffStaleAlarmTick(NOW);
    expect(alerted).toBeGreaterThanOrEqual(1);
    expect(await alarmSentFor(property.id)).toBe(true);
  });

  it("SENT_TO_EDITOR меньше порога — тишина", async () => {
    const property = await seedProperty({ status: "SENT_TO_EDITOR", hoursAgo: 2 });
    await runVideoHandoffStaleAlarmTick(NOW);
    expect(await alarmSentFor(property.id)).toBe(false);
  });

  it("QUEUED — не собственная тревога (это не он завис, а тот, что перед ним)", async () => {
    const property = await seedProperty({ status: "QUEUED", hoursAgo: 30 });
    await runVideoHandoffStaleAlarmTick(NOW);
    expect(await alarmSentFor(property.id)).toBe(false);
  });

  it("повторный тик в пределах суток не дублирует запись — дедуп по tag", async () => {
    // count по (tag, agentId), не по всему tag: этот дев-стенд общий, в нём уже
    // живут другие DIRECTOR/ADMIN — createNotifications пишет каждому по строке,
    // дедуп проверяется НА ОДНОГО получателя, а не на общее число строк.
    const property = await seedProperty({ status: "SENT_TO_EDITOR", hoursAgo: 30 });
    await runVideoHandoffStaleAlarmTick(NOW);
    await runVideoHandoffStaleAlarmTick(new Date(NOW.getTime() + 60_000));
    const count = await prisma.notification.count({
      where: { tag: `video-handoff-stale-${property.id}`, agentId: directorId },
    });
    expect(count).toBe(1);
  });
});
