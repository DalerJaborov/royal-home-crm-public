import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ЦИТАТЫ АУДИТА БОТА НЕ ОТДАЮТ НОМЕР БЕЗ clients.viewPhone
 * (аудит Codex 04.10.2026, ACCESS-03).
 *
 * Так было: GET /bot-audit и GET /bot-audit/group-examples отдавали quote и why
 * дословно — а нарушение links_phone по определению несёт номер из переписки.
 * Право auditLog.view обходило clients.viewPhone.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const DIGITS = "900001122";
const TYPE = `links_phone`;
const WHY = `Бот продиктовал номер клиенту ${runId}`;
const agentIds: string[] = [];
const findingIds: string[] = [];
let blindToken = "";
let seeingToken = "";

beforeAll(async () => {
  const mk = async (phone: string, permissions: unknown) =>
    (await prisma.agent.create({
      data: { fullName: `Аудит бота ${phone}`, phone, role: "MANAGER", passwordHash: "x", permissions: permissions as never },
    })).id;
  const blind = await mk(`+99281${tail}`, { granted: ["auditLog.view"], revoked: ["clients.viewPhone"] });
  const seeing = await mk(`+99282${tail}`, { granted: ["auditLog.view", "clients.viewPhone"], revoked: [] });
  agentIds.push(blind, seeing);
  blindToken = signAccessToken({ sub: blind, role: "MANAGER" });
  seeingToken = signAccessToken({ sub: seeing, role: "MANAGER" });
  for (let i = 0; i < 5; i++) {
    const row = await prisma.botAuditFinding.create({
      data: {
        conversationId: `conv-${runId}-${i}`,
        channel: "WHATSAPP",
        type: TYPE,
        quote: `Звоните мне на +992${DIGITS}, обсудим ${i}`,
        why: WHY,
        severity: "high",
      },
    });
    findingIds.push(row.id);
  }
});

afterAll(async () => {
  await prisma.botAuditFinding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

async function ourGroup(token: string) {
  let offset = 0;
  for (let guard = 0; guard < 50; guard++) {
    const res = await request(app).get(`/api/v1/bot-audit?groupsOffset=${offset}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const found = (res.body.groups as Array<{ why: string; examples: Array<{ quote: string }> }>).find((g) =>
      g.examples.some((e) => e.quote.includes("обсудим"))
    );
    if (found) return found;
    if (res.body.groupsNextOffset == null) break;
    offset = res.body.groupsNextOffset;
  }
  throw new Error("группа не найдена");
}

describe("GET /bot-audit и /group-examples без clients.viewPhone", () => {
  it("список групп: номер в цитате скрыт, остальной текст цел", async () => {
    const group = await ourGroup(blindToken);
    const text = JSON.stringify(group);
    expect(text).not.toContain(DIGITS);
    expect(group.examples[0].quote).toContain("Звоните мне на");
  });

  it("ещё цитаты группы: номер скрыт", async () => {
    const res = await request(app)
      .get(`/api/v1/bot-audit/group-examples?type=${TYPE}&why=${encodeURIComponent(WHY)}`)
      .set("Authorization", `Bearer ${blindToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(5);
    expect(JSON.stringify(res.body)).not.toContain(DIGITS);
  });

  it("с clients.viewPhone цитата дословная", async () => {
    const res = await request(app)
      .get(`/api/v1/bot-audit/group-examples?type=${TYPE}&why=${encodeURIComponent(WHY)}`)
      .set("Authorization", `Bearer ${seeingToken}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(DIGITS);
    const group = await ourGroup(seeingToken);
    expect(JSON.stringify(group)).toContain(DIGITS);
  });
});
