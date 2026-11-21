import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Звонок с номера СОТРУДНИКА в журнале звонков (21.11.2026, жалоба владельца).
 *
 * Агент перезвонила в офис со своего мобильного — строка читалась как
 * «Пропущенный · до оператора не дозвонился · в базе нет · никто не
 * перезвонил» с кнопкой «Больше не звонить», будто потеряли клиента. Теперь
 * сервер помечает такую строку полем `staff` (имя сотрудника), а бейдж
 * «без перезвона» на ней не загорается. Номер в журнале записан в другой форме,
 * чем в карточке сотрудника, — сравнение по хвосту, как везде.
 */

const runId = Date.now();
const tail7 = String(runId).slice(-7);
const ext = `s${tail7}`;
let adminToken = "";
const agentIds: string[] = [];
const incomingIds: string[] = [];
let staffCallId = "";
let strangerCallId = "";
let staffFeedId = "";

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Админ журнала ${runId}`, phone: `+99274${tail7}`, role: "ADMIN", passwordHash: "x" },
  });
  agentIds.push(admin.id);
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  const staff = await prisma.agent.create({
    data: { fullName: `Агент Сотрудница ${runId}`, phone: `+99277${tail7}`, role: "AGENT", passwordHash: "x" },
  });
  agentIds.push(staff.id);

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  // answeredBy — только чтобы отфильтровать журнал до двух своих строк
  // (фильтр «оператор»); на смысл строки не влияет.
  const staffCall = await prisma.incomingCall.create({
    data: { channelId: `staff-caller-${runId}-1`, phone: `99277${tail7}`, startedAt: threeDaysAgo, answered: false, answeredBy: ext },
  });
  const stranger = await prisma.incomingCall.create({
    data: { channelId: `staff-caller-${runId}-2`, phone: `+99278${tail7}`, startedAt: threeDaysAgo, answered: false, answeredBy: ext },
  });
  const feedRow = await prisma.incomingCall.create({
    data: { channelId: `staff-caller-${runId}-3`, phone: `+99277${tail7}`, startedAt: new Date("2097-05-01T10:00:00.000Z") },
  });
  staffCallId = staffCall.id;
  strangerCallId = stranger.id;
  staffFeedId = feedRow.id;
  incomingIds.push(staffCall.id, stranger.id, feedRow.id);
});

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { id: { in: incomingIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("журнал звонков: номер сотрудника — не клиент", () => {
  it("GET /calls/incoming помечает строку сотрудника и не ставит ей «без перезвона»", async () => {
    const res = await request(app)
      .get("/api/v1/calls/incoming")
      .query({ operator: ext })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.items.map((i: { id: string }) => [i.id, i]));
    const staffRow = byId.get(staffCallId) as { staff: { fullName: string } | null; missingCallback: boolean };
    const strangerRow = byId.get(strangerCallId) as { staff: unknown; missingCallback: boolean };
    expect(staffRow.staff?.fullName).toBe(`Агент Сотрудница ${runId}`);
    expect(staffRow.missingCallback).toBe(false);
    // Контроль: незнакомый номер — по-прежнему потерянный звонок.
    expect(strangerRow.staff).toBeNull();
    expect(strangerRow.missingCallback).toBe(true);
  });

  it("GET /calls/feed отдаёт то же поле staff у входящего с номера сотрудника", async () => {
    const res = await request(app)
      .get("/api/v1/calls/feed")
      .query({ limit: 5, before: "2097-06-01T00:00:00.000Z" })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { id: string }) => i.id === staffFeedId);
    expect(row?.staff?.fullName).toBe(`Агент Сотрудница ${runId}`);
  });
});
