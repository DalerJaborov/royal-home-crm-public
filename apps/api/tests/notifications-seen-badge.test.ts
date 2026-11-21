import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { sendPushToAgent } from "../src/push.js";

/**
 * «ПРОСМОТРЕНО» ОТДЕЛЬНО ОТ «СДЕЛАНО» (владелец 21.11.2026: «открыл список, а метка
 * на колокольчике не гаснет»). Открытие списка ставит seenAt и гасит метку
 * (unseenCount), но строка «Ждёт решения» остаётся непрочитанной и закреплённой.
 */

const runId = Date.now();
const password = "testpass123";
let agentId = "";
let otherAgentId = "";
let token = "";

const note = (agent: string, title: string, level: string, tag?: string) =>
  prisma.notification.create({ data: { agentId: agent, kind: "lead", level, title, body: "", read: false, tag } });
const feed = () => request(app).get("/api/v1/me/notifications").set("Authorization", `Bearer ${token}`);
const seen = (body?: unknown) =>
  request(app).post("/api/v1/me/notifications/seen").set("Authorization", `Bearer ${token}`).send((body ?? {}) as object);

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент seen ${runId}`, phone: `+992983${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: `Чужой seen ${runId}`, phone: `+992984${runId}`, role: "AGENT", passwordHash },
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

describe("POST /me/notifications/seen", () => {
  it("открытие списка гасит метку, а «Ждёт решения» остаётся непрочитанным и закреплённым", async () => {
    await prisma.notification.deleteMany({ where: { agentId } });
    const info = await note(agentId, "обычное", "OTHER");
    const approval = await note(agentId, "заявка на удаление", "APPROVAL");
    const critical = await note(agentId, "не отвечает", "CRITICAL");

    const before = await feed();
    expect(before.body.unseenCount).toBe(3);

    const res = await seen({ ids: [info.id, approval.id, critical.id] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);

    const after = await feed();
    expect(after.body.unseenCount).toBe(0);
    // Сделанным ничего не стало: непрочитанное и срочное остаётся в ленте.
    expect(after.body.unreadCount).toBe(3);
    expect(after.body.approvalCount).toBe(1);
    expect(after.body.criticalCount).toBe(1);
    expect(after.body.pinned.map((n: { id: string }) => n.id)).toEqual(expect.arrayContaining([approval.id, critical.id]));
    const row = after.body.items.find((n: { id: string }) => n.id === approval.id);
    expect(row.read).toBe(false);
    expect(row.seenAt).toBeTruthy();
  });

  it("новое уведомление после открытия снова даёт метку; повтор по тому же поводу тоже", async () => {
    await prisma.notification.deleteMany({ where: { agentId } });
    const first = await note(agentId, "старое", "OTHER");
    expect((await seen()).body.count).toBe(1);
    expect((await feed()).body.unseenCount).toBe(0);

    await note(agentId, "свежее", "OTHER");
    expect((await feed()).body.unseenCount).toBe(1);

    // Тот же tag, что у уже просмотренной строки: событие повторилось — метка снова горит.
    await prisma.notification.update({ where: { id: first.id }, data: { tag: `seen-${runId}`, seenAt: new Date() } });
    await seen();
    expect((await feed()).body.unseenCount).toBe(0);
    await sendPushToAgent(agentId, { title: "повтор", body: "", kind: "lead", tag: `seen-${runId}` });
    await new Promise((r) => setTimeout(r, 300));
    const repeated = await prisma.notification.findUniqueOrThrow({ where: { id: first.id } });
    expect(repeated.seenAt).toBeNull();
    expect((await feed()).body.unseenCount).toBeGreaterThanOrEqual(1);
  });

  it("без ids отмечает всё своё непросмотренное, но не чужое", async () => {
    await prisma.notification.deleteMany({ where: { agentId } });
    await note(agentId, "своё 1", "OTHER");
    await note(agentId, "своё 2", "APPROVAL");
    const foreign = await note(otherAgentId, "чужое", "OTHER");

    const res = await seen();
    expect(res.body.count).toBe(2);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: foreign.id } })).seenAt).toBeNull();
  });

  it("чужой id молча не затрагивается; пустой список и не-uuid — 400; без входа — 401", async () => {
    const foreign = await note(otherAgentId, "чужое 2", "OTHER");
    const res = await seen({ ids: [foreign.id] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: foreign.id } })).seenAt).toBeNull();

    expect((await seen({ ids: [] })).status).toBe(400);
    expect((await seen({ ids: ["x"] })).status).toBe(400);
    expect((await request(app).post("/api/v1/me/notifications/seen").send({})).status).toBe(401);
  });
});
