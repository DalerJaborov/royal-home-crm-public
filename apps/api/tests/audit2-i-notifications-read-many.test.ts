import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ПОМЕТКА ПРОЧИТАННЫМ ТОЛЬКО ПЕРЕЧИСЛЕННЫХ ЗАПИСЕЙ (аудит WEB-PAGES16, 04.10.2026).
 *
 * Автопрочтение ленты больше не шлёт read-all: оно присылает id показанных записей
 * без «Ждёт решения»/«Критичное». Сервер обязан тронуть только их и только свои, а
 * нерешённый APPROVAL должен остаться в закрепе (read=false).
 */

const runId = Date.now();
const password = "testpass123";
let agentId = "";
let otherAgentId = "";
let token = "";

async function note(agent: string, title: string, level: string) {
  return prisma.notification.create({ data: { agentId: agent, kind: "lead", level, title, body: "", read: false } });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент read-many ${runId}`, phone: `+992981${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: `Чужой read-many ${runId}`, phone: `+992982${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.$disconnect();
});

const post = (body: unknown) =>
  request(app).post("/api/v1/me/notifications/read-many").set("Authorization", `Bearer ${token}`).send(body as object);

describe("POST /me/notifications/read-many", () => {
  it("помечает только перечисленные, APPROVAL остаётся непрочитанным и закреплённым", async () => {
    const info = await note(agentId, "обычное", "NORMAL");
    const other = await note(agentId, "не показано", "NORMAL");
    const approval = await note(agentId, "ждёт решения", "APPROVAL");

    const res = await post({ ids: [info.id] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);

    const rows = await prisma.notification.findMany({ where: { id: { in: [info.id, other.id, approval.id] } } });
    const read = Object.fromEntries(rows.map((r) => [r.id, r.read]));
    expect(read[info.id]).toBe(true);
    expect(read[other.id]).toBe(false);
    expect(read[approval.id]).toBe(false);

    const feed = await request(app).get("/api/v1/me/notifications").set("Authorization", `Bearer ${token}`);
    expect(feed.status).toBe(200);
    expect(feed.body.pinned.map((n: { id: string }) => n.id)).toContain(approval.id);
  });

  it("чужую запись не трогает", async () => {
    const foreign = await note(otherAgentId, "чужое", "NORMAL");
    const res = await post({ ids: [foreign.id] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: foreign.id } })).read).toBe(false);
  });

  it("пустой список и не-uuid отклоняются 400", async () => {
    expect((await post({ ids: [] })).status).toBe(400);
    expect((await post({ ids: ["не-uuid"] })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });
});
