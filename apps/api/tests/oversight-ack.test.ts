import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * «Принято» по красным флагам «Контроля» (23.10.2026): POST/DELETE /oversight/ack,
 * лента GET /oversight/flags и пометка `acked` в срезе. Права: ack и лента —
 * DIRECTOR/ADMIN; менеджер (dashboard.analytics) срезы читает, но принять не может.
 */

const runId = Date.now();
const password = "testpass123";
const DAY = 24 * 60 * 60 * 1000;

let directorToken = "";
let managerToken = "";
let agentToken = "";
let hotClientId = "";
let savedThreshold: number | null = null;
const agentIds: string[] = [];

async function mk(role: "DIRECTOR" | "MANAGER" | "AGENT", suffix: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  const phone = `+99296${suffix}${runId}`;
  const a = await prisma.agent.create({ data: { fullName: `Ack ${role} ${runId}`, phone, role, passwordHash } });
  agentIds.push(a.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return { id: a.id, token: res.body.accessToken as string };
}

const hot = () => ({ sliceKey: "stalled-clients", subjectId: hotClientId });

beforeAll(async () => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  savedThreshold = s?.hotScoreThreshold ?? null;
  await prisma.settings.update({ where: { id: "singleton" }, data: { hotScoreThreshold: 70 } });
  directorToken = (await mk("DIRECTOR", "1")).token;
  managerToken = (await mk("MANAGER", "2")).token;
  agentToken = (await mk("AGENT", "3")).token;
  const owner = agentIds[2];
  const c = await prisma.client.create({
    data: {
      fullName: `Горячий для ack ${runId}`,
      phone: `+99297${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: owner,
      status: "NEW",
      aiScore: 95,
      // Заведомо старше любых остатков чужих тестов — лента отдаёт давнее выше.
      lastContactAt: new Date(Date.now() - 9000 * DAY),
    },
  });
  hotClientId = c.id;
});

afterAll(async () => {
  await prisma.oversightAck.deleteMany({ where: { ackedById: { in: agentIds } } });
  await prisma.client.deleteMany({ where: { id: hotClientId } });
  if (savedThreshold !== null) await prisma.settings.update({ where: { id: "singleton" }, data: { hotScoreThreshold: savedThreshold } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("OversightAck", () => {
  it("лента показывает флаг, в срезе acked нет", async () => {
    const flags = await request(app).get("/api/v1/oversight/flags").set("Authorization", `Bearer ${directorToken}`);
    expect(flags.status).toBe(200);
    expect(flags.body.items.length).toBeLessThanOrEqual(20);
    const mine = flags.body.items.find((f: { subjectId: string }) => f.subjectId === hotClientId);
    expect(mine).toMatchObject({ sliceKey: "stalled-clients", href: "/oversight#slice-stalled-clients" });
    expect(mine.title).toContain("горячий клиент без контакта");

    const slice = await request(app).get("/api/v1/oversight/stalled-clients?pageSize=50").set("Authorization", `Bearer ${directorToken}`);
    const row = slice.body.items.find((i: { id: string }) => i.id === hotClientId);
    expect(row).toBeTruthy();
    expect(row.acked).toBeUndefined();
  });

  it("права: менеджер и агент не принимают и не читают ленту", async () => {
    for (const token of [managerToken, agentToken]) {
      const ack = await request(app).post("/api/v1/oversight/ack").set("Authorization", `Bearer ${token}`).send(hot());
      expect(ack.status).toBe(403);
      const del = await request(app).delete("/api/v1/oversight/ack").set("Authorization", `Bearer ${token}`).send(hot());
      expect(del.status).toBe(403);
      const feed = await request(app).get("/api/v1/oversight/flags").set("Authorization", `Bearer ${token}`);
      expect(feed.status).toBe(403);
    }
    expect(await prisma.oversightAck.count({ where: { subjectId: hotClientId } })).toBe(0);
  });

  it("валидация: неизвестный срез и слишком длинная заметка — 400", async () => {
    const auth = { Authorization: `Bearer ${directorToken}` };
    expect((await request(app).post("/api/v1/oversight/ack").set(auth).send({ sliceKey: "nope", subjectId: "x" })).status).toBe(400);
    expect((await request(app).post("/api/v1/oversight/ack").set(auth).send({ ...hot(), note: "я".repeat(501) })).status).toBe(400);
  });

  it("принято: идемпотентно, флаг уходит из ленты, в срезе acked=true", async () => {
    const auth = { Authorization: `Bearer ${directorToken}` };
    const first = await request(app).post("/api/v1/oversight/ack").set(auth).send({ ...hot(), note: "вижу, разберусь" });
    expect(first.status).toBe(200);
    const again = await request(app).post("/api/v1/oversight/ack").set(auth).send({ ...hot(), note: "другая заметка" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.note).toBe("вижу, разберусь");
    expect(await prisma.oversightAck.count({ where: { sliceKey: "stalled-clients", subjectId: hotClientId } })).toBe(1);

    const flags = await request(app).get("/api/v1/oversight/flags").set(auth);
    expect(flags.body.items.some((f: { subjectId: string }) => f.subjectId === hotClientId)).toBe(false);

    const slice = await request(app).get("/api/v1/oversight/stalled-clients?pageSize=50").set(auth);
    const row = slice.body.items.find((i: { id: string }) => i.id === hotClientId);
    expect(row?.acked).toBe(true);
  });

  it("снять: флаг возвращается, повторное снятие не падает", async () => {
    const auth = { Authorization: `Bearer ${directorToken}` };
    const del = await request(app).delete("/api/v1/oversight/ack").set(auth).send(hot());
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(1);
    const delAgain = await request(app).delete("/api/v1/oversight/ack").set(auth).send(hot());
    expect(delAgain.body.removed).toBe(0);
    const flags = await request(app).get("/api/v1/oversight/flags").set(auth);
    expect(flags.body.items.some((f: { subjectId: string }) => f.subjectId === hotClientId)).toBe(true);
  });
});
