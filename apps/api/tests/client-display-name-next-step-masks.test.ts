import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ОТОБРАЖАЕМОЕ ИМЯ И БЛИЖАЙШИЙ ШАГ НЕ ОБХОДЯТ clients.viewPhone И ПРИЁМ ЛИДА
 * (аудит Codex 04.10.2026, ACCESS-01, расширения).
 *
 * Так было: presentClient закрывал fullName, а displayName считался тут же из
 * СЫРОГО имени («Входящий +992…» заглушкой не считается и проходил насквозь);
 * nextStep.nextAction брался из хронологии как есть, в обход и маски номера, и
 * гейта «до приёма лида».
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const PHONE_DIGITS = "900001122";
const RAW_NAME = `Входящий +992${PHONE_DIGITS}`;
const RAW_STEP = `Позвонить +992${PHONE_DIGITS} завтра`;
const agentIds: string[] = [];
const clientIds: string[] = [];
let token = "";
let acceptedId = "";
let acceptedShortId = 0;
let unacceptedId = "";

async function mkClient(acceptedAt: Date | null, assignedAgentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: RAW_NAME,
      phone: `+9929${acceptedAt ? "7" : "6"}${tail}1`,
      kind: "BUYER",
      source: "INSTAGRAM",
      assignedAgentId,
      acceptedAt,
    } as never,
  });
  clientIds.push(c.id);
  await prisma.interaction.create({
    data: {
      clientId: c.id,
      agentId: assignedAgentId,
      type: "MESSAGE",
      notes: "шаг",
      nextAction: RAW_STEP,
      nextActionDate: new Date(Date.now() + 86_400_000),
    } as never,
  });
  return c;
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент без номеров ${runId}`,
      phone: `+99298${tail}`,
      role: "AGENT",
      passwordHash: "x",
      permissions: { granted: [], revoked: ["clients.viewPhone"] } as never,
    },
  });
  agentIds.push(agent.id);
  token = signAccessToken({ sub: agent.id, role: "AGENT" });
  const accepted = await mkClient(new Date(), agent.id);
  acceptedId = accepted.id;
  acceptedShortId = accepted.shortId;
  unacceptedId = (await mkClient(null, agent.id)).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("список клиентов без clients.viewPhone", () => {
  it("displayName и nextStep не содержат номер, а у непринятого лида шаг не отдаётся", async () => {
    const res = await request(app).get("/api/v1/clients?limit=50").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const mine = (res.body.items as Array<Record<string, any>>).filter((c) => clientIds.includes(c.id));
    expect(mine.length).toBe(2);
    for (const c of mine) {
      expect(c.displayName).not.toContain(PHONE_DIGITS);
      expect(JSON.stringify(c.nextStep ?? null)).not.toContain(PHONE_DIGITS);
    }
    const unaccepted = mine.find((c) => c.id === unacceptedId)!;
    expect(unaccepted.nextStep).toBeNull();
    const accepted = mine.find((c) => c.id === acceptedId)!;
    expect(accepted.nextStep?.nextAction).toBeTruthy();
  });
});

describe("карточка клиента без clients.viewPhone", () => {
  it("displayName шапки не содержит номер", async () => {
    const res = await request(app).get(`/api/v1/clients/${acceptedId}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.displayName).not.toContain(PHONE_DIGITS);
    expect(acceptedShortId).toBeGreaterThan(0);
  });
});
