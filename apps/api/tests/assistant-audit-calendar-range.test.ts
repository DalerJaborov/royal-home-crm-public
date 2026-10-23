import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

// Real HTTP app + isolated test PostgreSQL; no assistant/provider calls.
const runId = randomUUID();
const day = "2040-02-29";
const agentIds: string[] = [];
let adminId = "", otherId = "", token = "", ordinaryToken = "";
const fixture = [
  ["before", "2040-02-28T23:59:59.999+05:00"],
  ["start", `${day}T00:00:00.000+05:00`],
  ["early", `${day}T04:59:59.999+05:00`],
  ["utc-midnight", `${day}T05:00:00.000+05:00`],
  ["after-cutoff", `${day}T05:00:00.001+05:00`],
  ["noon", `${day}T12:00:00.000+05:00`],
  ["last", `${day}T23:59:59.999+05:00`],
  ["after", "2040-03-01T00:00:00.000+05:00"],
] as const;
const inDay = ["start", "early", "utc-midnight", "after-cutoff", "noon", "last"];
const tool = (label: string) => `audit-calendar-${runId}-${label}`;

beforeAll(async () => {
  for (const [label, role] of [["admin", "ADMIN"], ["other", "ADMIN"], ["ordinary", "AGENT"]] as const) {
    const agent = await prisma.agent.create({ data: {
      fullName: `Synthetic audit calendar ${label}`, phone: `test-audit-${label}-${runId}`, role, passwordHash: "test-only",
    } });
    agentIds.push(agent.id);
  }
  [adminId, otherId] = agentIds;
  token = signAccessToken({ sub: adminId, role: "ADMIN" });
  ordinaryToken = signAccessToken({ sub: agentIds[2], role: "AGENT" });
  await prisma.aiAssistantAuditLog.createMany({ data: fixture.map(([label, at]) => ({
    agentId: adminId, tool: tool(label), createdAt: new Date(at), resultCount: 0,
  })) });
  await prisma.aiAssistantAuditLog.create({ data: { agentId: otherId, tool: tool("other"), createdAt: new Date(`${day}T12:00:00+05:00`) } });
});

afterAll(async () => {
  await prisma.aiAssistantAuditLog.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

function feed(query: Record<string, string> = {}, accessToken = token) {
  return request(app).get("/api/v1/ai/assistant-audit").query({ agentId: adminId, ...query })
    .set("Authorization", `Bearer ${accessToken}`);
}
function toolsOf(body: { items: { tool: string }[] }) { return body.items.map(item => item.tool).sort(); }
function expected(labels: readonly string[]) { return labels.map(tool).sort(); }

describe("assistant audit uses inclusive Dushanbe calendar dates", () => {
  it("same-day filter includes midnight, first five hours, noon and final millisecond", async () => {
    const res = await feed({ from: day, to: day });
    expect(res.status).toBe(200);
    expect(toolsOf(res.body)).toEqual(expected(inDay));
    expect(res.body.total).toBe(inDay.length);
  });

  it("from-only starts at Dushanbe midnight, retaining the first five hours", async () => {
    const res = await feed({ from: day });
    expect(res.status).toBe(200);
    expect(toolsOf(res.body)).toEqual(expected([...inDay, "after"]));
    expect(res.body.total).toBe(7);
  });

  it("to-only includes the entire last day and excludes the following midnight", async () => {
    const res = await feed({ to: day });
    expect(res.status).toBe(200);
    expect(toolsOf(res.body)).toEqual(expected(["before", ...inDay]));
    expect(res.body.total).toBe(7);
  });

  it("clearing both dates retains all owned synthetic rows", async () => {
    const res = await feed();
    expect(res.status).toBe(200);
    expect(toolsOf(res.body)).toEqual(expected(fixture.map(([label]) => label)));
    expect(res.body.total).toBe(8);
  });

  it("keeps the selected agent filter for list and count", async () => {
    const res = await feed({ agentId: otherId });
    expect(res.status).toBe(200);
    expect(toolsOf(res.body)).toEqual(expected(["other"]));
    expect(res.body.total).toBe(1);
  });

  it.each([{ from: "not-a-date" }, { to: "2040-99-99" }, { agentId: "not-a-uuid" }, { page: "0" }])(
    "rejects invalid filter %j", async query => { expect((await feed(query)).status).toBe(400); }
  );

  it("keeps auditLog.view enforcement for an ordinary agent", async () => {
    expect((await feed({}, ordinaryToken)).status).toBe(403);
  });

  it("keeps stable page size, total and nonoverlapping page rows", async () => {
    const ids = Array.from({ length: 52 }, () => randomUUID());
    await prisma.aiAssistantAuditLog.createMany({ data: ids.map((id, index) => ({
      id, agentId: otherId, tool: tool(`page-${index}`), createdAt: new Date(Date.UTC(2040, 1, 29, 7, index)),
    })) });
    try {
      const first = await feed({ agentId: otherId, page: "1" });
      const second = await feed({ agentId: otherId, page: "2" });
      expect(first.status).toBe(200); expect(second.status).toBe(200);
      expect(first.body).toMatchObject({ page: 1, pageSize: 50, total: 53 });
      expect(second.body).toMatchObject({ page: 2, pageSize: 50, total: 53 });
      expect(first.body.items).toHaveLength(50); expect(second.body.items).toHaveLength(3);
      expect(new Set([...first.body.items, ...second.body.items].map(item => item.id)).size).toBe(53);
    } finally {
      await prisma.aiAssistantAuditLog.deleteMany({ where: { id: { in: ids } } });
    }
  });
});
