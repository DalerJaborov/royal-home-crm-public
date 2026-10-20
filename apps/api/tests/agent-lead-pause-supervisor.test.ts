import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import request from "supertest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Дополняем модуль, а не заменяем целиком — см. agent-freeze-delete-reactivation.test.ts.
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { pauseUntilLabel } = await import("../src/lib/agentLeadPause.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

/**
 * Пауза приёма лидов от руководителя (24.09.2026, владелец: «админу и директору
 * тоже кнопку внутри профиля работников… чтобы отдохнуть в тот день»), и то,
 * что изменилось в своей паузе агента заодно:
 *  - включение паузы (любой) возвращает непринятые лиды в раздачу, кроме лидов
 *    по своему объекту;
 *  - паузу руководителя агент снять сам не может;
 *  - пауза руководителя не запускает агенту «остыть» перед своей паузой.
 */

const password = "testpass123";
const agentIds: string[] = [];
const clientIds: string[] = [];
const tokens = new Map<string, string>();

function phone(): string {
  return `+99293${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
}

async function makeStaff(role: "AGENT" | "DIRECTOR" | "MANAGER", name: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  const a = await prisma.agent.create({ data: { fullName: `${name} пауза-лидов`, phone: phone(), role, passwordHash } });
  agentIds.push(a.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password });
  expect(res.status).toBe(200);
  tokens.set(a.id, res.body.accessToken);
  return a;
}

async function makeLead(agentId: string, extra: { acceptedAt?: Date; ownPropertyLead?: boolean } = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Лид паузы ${clientIds.length}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "NEW",
      assignedAgentId: agentId,
      assignedAt: new Date(),
      acceptedAt: extra.acceptedAt ?? null,
      ownPropertyLead: extra.ownPropertyLead ?? false,
    },
  });
  clientIds.push(c.id);
  return c;
}

const auth = (id: string) => ({ Authorization: `Bearer ${tokens.get(id)}` });

let director: Awaited<ReturnType<typeof makeStaff>>;
let manager: Awaited<ReturnType<typeof makeStaff>>;

beforeAll(async () => {
  director = await makeStaff("DIRECTOR", "Директор");
  manager = await makeStaff("MANAGER", "Руководитель");
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("POST /agents/:id/lead-pause — пауза от руководителя", () => {
  it("ставит паузу с причиной, снимает непринятые лиды, оставляет свой объект и принятых клиентов", async () => {
    const agent = await makeStaff("AGENT", "Агент А");
    const fresh = await makeLead(agent.id);
    const own = await makeLead(agent.id, { ownPropertyLead: true });
    const accepted = await makeLead(agent.id, { acceptedAt: new Date() });
    sendPushToAgent.mockClear();

    const res = await request(app)
      .post(`/api/v1/agents/${agent.id}/lead-pause`)
      .set(auth(director.id))
      .send({ hours: 24, reason: "выходной" });
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(1);

    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.leadsPausedById).toBe(director.id);
    expect(row.leadsPausedReason).toBe("выходной");
    const hoursLeft = (row.leadsPausedUntil!.getTime() - Date.now()) / 3600_000;
    expect(hoursLeft).toBeGreaterThan(23.9);
    expect(hoursLeft).toBeLessThanOrEqual(24);

    const after = await prisma.client.findMany({ where: { id: { in: [fresh.id, own.id, accepted.id] } } });
    const byId = new Map(after.map((c) => [c.id, c.assignedAgentId]));
    expect(byId.get(fresh.id)).not.toBe(agent.id);
    expect(byId.get(own.id)).toBe(agent.id);
    expect(byId.get(accepted.id)).toBe(agent.id);

    // Агенту сказано, кто и до какого момента.
    expect(sendPushToAgent).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({ body: expect.stringContaining("выходной") })
    );

    // В профиле агента видно, кто поставил паузу.
    const me = await request(app).get("/api/v1/me").set(auth(agent.id));
    expect(me.body.leadsPausedBy?.fullName).toBe(director.fullName);
    expect(me.body.leadsPausedReason).toBe("выходной");

    // В списке команды — тоже.
    const team = await request(app).get("/api/v1/team").set(auth(director.id));
    expect(team.status).toBe(200);
    const member = (team.body as Array<{ id: string; leadsPausedByName: string | null; leadsPausedUntil: string | null }>).find(
      (m) => m.id === agent.id
    );
    expect(member?.leadsPausedByName).toBe(director.fullName);
    expect(member?.leadsPausedUntil).not.toBeNull();
  });

  it("агент не может снять паузу руководителя сам; руководитель снимает, и «остыть» у агента не начинается", async () => {
    const agent = await makeStaff("AGENT", "Агент Б");
    const paused = await request(app)
      .post(`/api/v1/agents/${agent.id}/lead-pause`)
      .set(auth(director.id))
      .send({ hours: 8 });
    expect(paused.status).toBe(200);

    const selfResume = await request(app).delete("/api/v1/me/lead-pause").set(auth(agent.id));
    expect(selfResume.status).toBe(403);

    const resume = await request(app).delete(`/api/v1/agents/${agent.id}/lead-pause`).set(auth(director.id));
    expect(resume.status).toBe(200);
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.leadsPausedUntil).toBeNull();
    expect(row.leadsPausedById).toBeNull();
    expect(row.leadsPausedEndedAt).toBeNull();

    // Своя пауза сразу после снятия паузы руководителя — разрешена.
    const own = await request(app).post("/api/v1/me/lead-pause").set(auth(agent.id)).send({ hours: 4 });
    expect(own.status).toBe(200);
  });

  it("руководитель заменяет паузу, которую агент включил себе сам", async () => {
    const agent = await makeStaff("AGENT", "Агент В");
    expect((await request(app).post("/api/v1/me/lead-pause").set(auth(agent.id)).send({ hours: 4 })).status).toBe(200);
    const res = await request(app)
      .post(`/api/v1/agents/${agent.id}/lead-pause`)
      .set(auth(director.id))
      .send({ hours: 48 });
    expect(res.status).toBe(200);
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.leadsPausedById).toBe(director.id);
    expect((row.leadsPausedUntil!.getTime() - Date.now()) / 3600_000).toBeGreaterThan(47);
  });

  it("без права управлять сотрудниками — 403; не агенту и замороженному — отказ", async () => {
    const agent = await makeStaff("AGENT", "Агент Г");
    const byManager = await request(app)
      .post(`/api/v1/agents/${agent.id}/lead-pause`)
      .set(auth(manager.id))
      .send({ hours: 4 });
    expect(byManager.status).toBe(403);

    const toManager = await request(app)
      .post(`/api/v1/agents/${manager.id}/lead-pause`)
      .set(auth(director.id))
      .send({ hours: 4 });
    expect(toManager.status).toBe(400);

    await prisma.agent.update({ where: { id: agent.id }, data: { frozenAt: new Date(), frozenReason: "тест" } });
    const toFrozen = await request(app)
      .post(`/api/v1/agents/${agent.id}/lead-pause`)
      .set(auth(director.id))
      .send({ hours: 4 });
    expect(toFrozen.status).toBe(409);

    const badHours = await request(app)
      .post(`/api/v1/agents/${agent.id}/lead-pause`)
      .set(auth(director.id))
      .send({ hours: 0 });
    expect(badHours.status).toBe(400);
  });
});

describe("POST /me/lead-pause — своя пауза агента", () => {
  it("возвращает непринятые лиды в раздачу, свой объект оставляет, и агент снимает её сам", async () => {
    const agent = await makeStaff("AGENT", "Агент Д");
    const fresh = await makeLead(agent.id);
    const own = await makeLead(agent.id, { ownPropertyLead: true });

    const res = await request(app).post("/api/v1/me/lead-pause").set(auth(agent.id)).send({ hours: 24 });
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(1);

    const [f, o] = await Promise.all([
      prisma.client.findUniqueOrThrow({ where: { id: fresh.id } }),
      prisma.client.findUniqueOrThrow({ where: { id: own.id } }),
    ]);
    expect(f.assignedAgentId).not.toBe(agent.id);
    expect(o.assignedAgentId).toBe(agent.id);

    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.leadsPausedById).toBeNull();

    const resume = await request(app).delete("/api/v1/me/lead-pause").set(auth(agent.id));
    expect(resume.status).toBe(200);
    const after = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    // Своя пауза, в отличие от паузы руководителя, запускает «остыть».
    expect(after.leadsPausedEndedAt).not.toBeNull();
  });
});

describe("pauseUntilLabel", () => {
  it("год пишется, только если он не текущий", () => {
    const now = new Date("2026-09-24T06:00:00Z");
    expect(pauseUntilLabel(new Date("2026-09-25T13:00:00Z"), now)).toBe("25.09 в 18:00");
    expect(pauseUntilLabel(new Date("2027-01-01T00:00:00Z"), now)).toBe("01.01.2027 в 05:00");
  });
});
