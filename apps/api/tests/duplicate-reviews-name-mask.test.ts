import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ИМЯ КАРТОЧКИ В «ПРОВЕРКЕ ДУБЛЯ» НЕ НЕСЁТ НОМЕР БЕЗ clients.viewPhone
 * (аудит Codex 04.10.2026, ACCESS-01, расширение «имена в дубль-проверках»).
 *
 * Так было: поле phone маскировалось, а fullName («Входящий +992…» у карточек
 * незнакомых звонивших) уходило сырым и у самой карточки, и у её кандидата.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const DIGITS = "900001122";
const agentIds: string[] = [];
const clientIds: string[] = [];
let token = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: `Проверяющий дубль ${runId}`,
      phone: `+99221${tail}`,
      role: "AGENT",
      passwordHash: "x",
      permissions: { granted: [], revoked: ["clients.viewPhone"] } as never,
    },
  });
  agentIds.push(agent.id);
  token = signAccessToken({ sub: agent.id, role: "AGENT" });
  const candidate = await prisma.client.create({
    data: { fullName: `Входящий +992${DIGITS}`, phone: `+99222${tail}1`, kind: "BUYER", source: "TELEGRAM", assignedAgentId: agent.id, acceptedAt: new Date() } as never,
  });
  const pending = await prisma.client.create({
    data: {
      fullName: `Входящий +992${DIGITS}`,
      phone: `+99223${tail}1`,
      kind: "BUYER",
      source: "TELEGRAM",
      duplicateReviewOfClientId: candidate.id,
      duplicateReviewAskedAgentId: agent.id,
      duplicateReviewAskedAt: new Date(),
    } as never,
  });
  clientIds.push(pending.id, candidate.id);
});

afterAll(async () => {
  await prisma.client.updateMany({ where: { id: { in: clientIds } }, data: { duplicateReviewOfClientId: null } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("GET /clients/duplicate-reviews без clients.viewPhone", () => {
  it("номер не виден ни в имени, ни в имени кандидата", async () => {
    const res = await request(app).get("/api/v1/clients/duplicate-reviews").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain(DIGITS);
  });
});
