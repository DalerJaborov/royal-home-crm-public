import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Отозванная сессия не оживает при новом входе с того же устройства (G1, 02.10.2026).
 *
 * Так было: `createOrRefreshSession` при отозванной строке того же устройства
 * делал upsert с `revokedAt: null` — та же строка, тот же `id`, то есть тот же
 * `sid` в refresh-токене. Украденная cookie (подписана на 30 дней) после
 * «Выйти», смены пароля или сброса пароля руководителем снова начинала
 * обновлять доступ, как только хозяин входил на том же устройстве.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+992907${String(runId).slice(-7)}`;
const UA = "RevivedSessionAgent/1.0";
let agentId: string;

function refreshCookieFrom(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((c) => c.startsWith("refreshToken="))?.split(";")[0];
}

async function login(pw: string) {
  const res = await request(app).post("/api/v1/auth/login").set("User-Agent", UA).send({ phone, password: pw });
  expect(res.status).toBe(200);
  return { cookie: refreshCookieFrom(res)!, access: res.body.accessToken as string };
}

async function refresh(cookie: string) {
  return request(app).post("/api/v1/auth/refresh").set("User-Agent", UA).set("Cookie", cookie);
}

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone } });
  const agent = await prisma.agent.create({
    data: { fullName: "Тест Ожившей Сессии", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { agentId } });
  await prisma.auditLog.deleteMany({ where: { entityId: agentId } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Отозванный refresh-токен не оживает", () => {
  it("«Выйти» и новый вход на том же устройстве — старая cookie больше не работает", async () => {
    const first = await login(password);
    expect((await refresh(first.cookie)).status).toBe(200);

    // Выход: строка сессии отозвана.
    const out = await request(app).post("/api/v1/auth/logout").set("User-Agent", UA).set("Cookie", first.cookie);
    expect(out.status).toBeLessThan(300);
    expect((await refresh(first.cookie)).status).toBe(401);

    // Хозяин входит снова с того же устройства.
    const second = await login(password);
    expect((await refresh(second.cookie)).status).toBe(200);

    // Украденная прежняя cookie обязана остаться мёртвой.
    expect((await refresh(first.cookie)).status).toBe(401);
  });

  it("пять одновременных входов после выхода — все 200, ни одного 500", async () => {
    const cur = await login(password);
    await request(app).post("/api/v1/auth/logout").set("User-Agent", UA).set("Cookie", cur.cookie);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/v1/auth/login").set("User-Agent", UA).send({ phone, password }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200), `Ответы: ${statuses.join(", ")}`).toBe(true);
  });

  it("на устройство по-прежнему одна строка сессии", async () => {
    const rows = await prisma.session.findMany({ where: { agentId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
  });
});
