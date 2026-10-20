import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { dushanbeStartOfToday } from "../src/lib/dushanbeTime.js";

/**
 * GET /clients?noFirstContactYesterday=1 — срез «Вчера остались без ответа».
 *
 * Зачем на сервере. Число на плитке директора (мобильная главная) считается в
 * lib/morningNumbers.ts по всей базе, а список сначала отбирал уже загруженную
 * страницу из двадцати. На длинном дне числа расходились — а директор сверяет
 * их глазами, одно под другим.
 *
 * Проверяем то, что ничем другим не ловится:
 *  1) в срез попадает вчерашняя карточка без первого касания;
 *  2) не попадает вчерашняя, с которой УЖЕ связались (firstContactAt задан);
 *  3) не попадает позавчерашняя без касания — «вчера» это ровно одни сутки;
 *  4) границы суток считаются по Душанбе (UTC+5), а не по часам контейнера:
 *     карточка, созданная в 21:00 UTC вчера, по Душанбе относится уже к
 *     сегодняшним суткам и в срез не идёт.
 */

const runId = Date.now();
const password = "testpass123";
let agentId: string;
let agentPhone = "";
const clientIds: string[] = [];

async function makeClient(createdAt: Date, firstContactAt: Date | null): Promise<string> {
  const c = await prisma.client.create({
    data: {
      fullName: `Без ответа ${runId}-${clientIds.length}`,
      phone: `+9929${String(runId).slice(-6)}${clientIds.length}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      assignedAgentId: agentId,
    },
  });
  // createdAt проставляется схемой, поэтому переносим отдельным update — так же,
  // как properties-summary.test.ts двигает stageEnteredAt.
  await prisma.client.update({ where: { id: c.id }, data: { createdAt, firstContactAt } });
  clientIds.push(c.id);
  return c.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentPhone = `+992954${String(runId).slice(-7)}`;
  const agent = await prisma.agent.create({
    data: { fullName: `Без Ответа Директор ${runId}`, phone: agentPhone, role: "DIRECTOR", passwordHash },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { phone: agentPhone } });
});

describe("GET /clients?noFirstContactYesterday=1", () => {
  it("отдаёт вчерашние карточки без первого касания и считает сутки по Душанбе", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ phone: agentPhone, password });
    expect(login.status).toBe(200);
    const token = login.body.accessToken ?? login.body.token;

    const startOfToday = dushanbeStartOfToday();
    const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
    const midYesterday = new Date(startOfYesterday.getTime() + 12 * 60 * 60 * 1000);

    const waiting = await makeClient(midYesterday, null);
    const answered = await makeClient(midYesterday, new Date(midYesterday.getTime() + 30 * 60 * 1000));
    const dayBefore = await makeClient(new Date(startOfYesterday.getTime() - 12 * 60 * 60 * 1000), null);
    // Сегодняшняя по Душанбе, но «вчерашняя» по UTC: ровно на час позже начала
    // сегодняшних суток. Если границы однажды посчитают через setHours, эта
    // карточка провалится в срез и тест это поймает.
    const todayDushanbe = await makeClient(new Date(startOfToday.getTime() + 60 * 60 * 1000), null);

    const res = await request(app)
      .get("/api/v1/clients?noFirstContactYesterday=1&pageSize=200")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const ids: string[] = res.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(waiting);
    expect(ids).not.toContain(answered);
    expect(ids).not.toContain(dayBefore);
    expect(ids).not.toContain(todayDushanbe);
  });
});
