import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Отложенный выход А не гасит сессию Б (аудит Codex 04.10.2026, №3).
 *
 * /auth/logout отзывает сессию по refresh-cookie ЗАПРОСА. Клиент шлёт его не
 * сразу (до трёх ожиданий по 3 с на снятие push), и если за это время вошёл Б,
 * запрос нёс cookie Б: сервер отзывал сессию Б и стирал её cookie. Теперь клиент
 * сообщает `agentId` вышедшего, сервер сверяет его с владельцем cookie.
 */
const runId = Date.now();
const password = "testpass123";
const phoneB = `+992908${String(runId).slice(-7)}`;
const UA = "ForeignLogoutAgent/1.0";
let agentBId: string;

function refreshCookieFrom(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((c) => c.startsWith("refreshToken="))?.split(";")[0];
}

async function loginB() {
  const res = await request(app).post("/api/v1/auth/login").set("User-Agent", UA).send({ phone: phoneB, password });
  expect(res.status).toBe(200);
  return refreshCookieFrom(res)!;
}

const refresh = (cookie: string) =>
  request(app).post("/api/v1/auth/refresh").set("User-Agent", UA).set("Cookie", cookie);

/** Стирание cookie: Set-Cookie refreshToken с пустым значением/прошедшим сроком. */
function clearsRefreshCookie(res: request.Response): boolean {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.some((c) => c.startsWith("refreshToken=;") || /refreshToken=;/.test(c));
}

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: phoneB } });
  const b = await prisma.agent.create({
    data: { fullName: "Тест Выход Б", phone: phoneB, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
  });
  agentBId = b.id;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { agentId: agentBId } });
  await prisma.auditLog.deleteMany({ where: { entityId: agentBId } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: agentBId } });
  await prisma.$disconnect();
});

describe("POST /auth/logout с agentId", () => {
  it("cookie Б, agentId чужой (А): 204, сессия Б жива, cookie не стёрта", async () => {
    const cookieB = await loginB();
    const out = await request(app)
      .post("/api/v1/auth/logout")
      .set("User-Agent", UA)
      .set("Cookie", cookieB)
      .send({ agentId: "agent-A-who-logged-out" });
    expect(out.status).toBe(204);
    expect(clearsRefreshCookie(out), "cookie Б не должна стираться").toBe(false);
    expect((await refresh(cookieB)).status).toBe(200);
  });

  it("cookie Б, agentId = Б: сессия отзывается, cookie стирается", async () => {
    const cookieB = await loginB();
    const out = await request(app)
      .post("/api/v1/auth/logout")
      .set("User-Agent", UA)
      .set("Cookie", cookieB)
      .send({ agentId: agentBId });
    expect(out.status).toBe(204);
    expect(clearsRefreshCookie(out)).toBe(true);
    expect((await refresh(cookieB)).status).toBe(401);
  });

  it("старый клиент без agentId ведёт себя как раньше: сессия отзывается", async () => {
    const cookieB = await loginB();
    const out = await request(app).post("/api/v1/auth/logout").set("User-Agent", UA).set("Cookie", cookieB).send({});
    expect(out.status).toBe(204);
    expect((await refresh(cookieB)).status).toBe(401);
  });
});
