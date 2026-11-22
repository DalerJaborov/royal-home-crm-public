import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * КАРТОЧКА СОТРУДНИКА «ОДНИМ ВЗГЛЯДОМ» (lib/agentGlance.ts, 22.11.2026).
 * Главное обещание: цифра на плитке равна числу строк в списке за ней — обе берут
 * одно окно и одни условия. Плюс права: рядовой агент чужую карточку не открывает.
 */
const tail = String(Date.now()).slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
const clientIds: string[] = [];
let target: string;
let tokenDirector = "";
let tokenAgent = "";

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  const agent = await prisma.agent.findUnique({ where: { phone }, select: { id: true } });
  if (agent) grantElevation(agent.id);
  return res.body.accessToken as string;
}

const get = (path: string, token: string) => request(app).get(`/api/v1/agents/${path}`).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const make = async (n: string, role: "AGENT" | "DIRECTOR") => {
    const phone = `+99296${n}${tail}`;
    const a = await prisma.agent.create({ data: { fullName: `Взгляд ${n} ${tail}`, phone, role, passwordHash } });
    agentIds.push(a.id);
    return { id: a.id, phone };
  };
  const agent = await make("1", "AGENT");
  const other = await make("2", "AGENT");
  const director = await make("3", "DIRECTOR");
  target = agent.id;
  tokenDirector = await login(director.phone);
  tokenAgent = await login(other.phone);

  const mk = async (n: number, kind: "BUYER" | "SELLER") => {
    const c = await prisma.client.create({
      data: {
        fullName: `Клиент взгляда ${n}`, phone: `+99295${n}${tail}`, source: "WEBSITE", kind,
        assignedAgentId: agent.id, acceptedAt: new Date(), assignedAt: new Date(),
      },
    });
    clientIds.push(c.id);
    return c;
  };
  const b1 = await mk(1, "BUYER");
  await mk(2, "BUYER");
  await mk(3, "SELLER");
  await prisma.interaction.create({ data: { clientId: b1.id, agentId: agent.id, type: "CALL", callAttempt: "TALKED", notes: "поговорили" } });
  await prisma.interaction.create({ data: { clientId: b1.id, agentId: agent.id, type: "CALL", callAttempt: "NO_ANSWER", notes: "не взял" } });
  await prisma.interaction.create({ data: { clientId: b1.id, agentId: agent.id, type: "SHOWING", notes: "показ" } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("GET /agents/:id/glance", () => {
  it("плитки считают работу агента за неделю, график даёт 7 дней", async () => {
    const res = await get(`${target}/glance?period=week`, tokenDirector);
    expect(res.status).toBe(200);
    expect(res.body.buyersInWork).toBe(2);
    expect(res.body.sellersInWork).toBe(1);
    expect(res.body.calls.total).toBe(2);
    expect(res.body.calls.talked).toBe(1);
    expect(res.body.showings).toBe(1);
    expect(res.body.series).toHaveLength(7);
    expect(typeof res.body.commission).toBe("number");
  });

  it("месяц — 30 дней графика; неверный период — 400", async () => {
    const month = await get(`${target}/glance?period=month`, tokenDirector);
    expect(month.status).toBe(200);
    expect(month.body.series).toHaveLength(30);
    expect((await get(`${target}/glance?period=year`, tokenDirector)).status).toBe(400);
  });

  it("число на плитке равно числу строк списка за ней", async () => {
    const glance = (await get(`${target}/glance?period=week`, tokenDirector)).body;
    const tiles: [string, number][] = [
      ["buyers", glance.buyersInWork], ["sellers", glance.sellersInWork], ["calls", glance.calls.total],
      ["showings", glance.showings], ["overdue", glance.overdueTasks], ["waiting", glance.waitingForReply],
    ];
    for (const [key, value] of tiles) {
      const drill = await get(`${target}/glance/drill?key=${key}&period=week`, tokenDirector);
      expect(drill.status, key).toBe(200);
      expect(drill.body.total, key).toBe(value);
      expect(drill.body.items.length, key).toBe(Math.min(value, 50));
    }
  });

  it("неизвестный сотрудник — 404, неизвестная плитка — 400", async () => {
    expect((await get("00000000-0000-0000-0000-000000000000/glance", tokenDirector)).status).toBe(404);
    expect((await get(`${target}/glance/drill?key=nope`, tokenDirector)).status).toBe(400);
  });

  it("рядовой агент чужую карточку «одним взглядом» не открывает", async () => {
    expect((await get(`${target}/glance`, tokenAgent)).status).toBe(403);
    expect((await get(`${target}/glance/drill?key=calls`, tokenAgent)).status).toBe(403);
  });
});
