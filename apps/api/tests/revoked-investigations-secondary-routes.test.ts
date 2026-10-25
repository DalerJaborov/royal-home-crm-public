import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
vi.mock("../src/lib/settingsSideEffects.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/settingsSideEffects.js")>(), applySettingsSideEffects: vi.fn() }));
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { grantElevation, revokeElevation } from "../src/lib/stepUp.js";

const marker = `revoked-private-${randomUUID()}`;
const actors: string[] = [], findings: string[] = [], lessons: string[] = [];
let allowed: string, revoked: string, clientId: string, digestId: string, caseId: string, snapshotId: string;
beforeAll(async () => {
  for (const denied of [false, true]) {
    const agent = await prisma.agent.create({ data: { fullName: marker, phone: `test-${randomUUID()}`, passwordHash: "x", role: "ADMIN",
      permissions: { granted: [], revoked: denied ? ["clients.securityReview"] : [] } } });
    actors.push(agent.id); grantElevation(agent.id);
    const token = signAccessToken({ sub: agent.id, role: "ADMIN" });
    if (denied) revoked = token; else allowed = token;
  }
  const client = await prisma.client.create({ data: { fullName: marker, phone: `test-${randomUUID()}`, source: "WALK_IN" } }); clientId = client.id;
  for (const privateRow of [true, false]) {
    const finding = await prisma.botAuditFinding.create({ data: { conversationId: marker, channel: "WHATSAPP", type: privateRow ? "agent_bypassed_crm" : "links_phone", quote: marker, why: `${marker}-${privateRow}`, severity: "high" } }); findings.push(finding.id);
    const lesson = await prisma.botLesson.create({ data: { kind: "audit_finding", channel: "WHATSAPP", botMessage: marker, humanMessage: marker, lesson: `${marker}-${privateRow}`, active: false, investigationOnly: privateRow } }); lessons.push(lesson.id);
  }
  const digest = await prisma.insightDigest.create({ data: { periodStart: new Date(), periodEnd: new Date(), meetingAt: new Date(), status: "READY", coverage: { sentinel: marker } } }); digestId = digest.id;
  for (const privateRow of [true, false]) {
    const row = await prisma.insightCase.create({ data: { digestId, clientId, agentId: actors[0], kind: privateRow ? "agent_bypass" : "call_low_score", severity: 3, sourceKey: `${marker}-${privateRow}`, timeline: { text: marker }, verdict: {} } });
    if (privateRow) caseId = row.id;
  }
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  const snapshot = await prisma.settingsSnapshot.create({ data: { payload: { sellerControlConfig: { sentinel: marker } }, agentId: actors[0], agentName: "Synthetic administrator", reason: "update", changedFields: ["sellerControlConfig"], keyFingerprint: "synthetic-no-secret" } }); snapshotId = snapshot.id;
});
afterAll(async () => {
  if (snapshotId) await prisma.settingsSnapshot.deleteMany({ where: { id: snapshotId } });
  if (digestId) { await prisma.insightCase.deleteMany({ where: { digestId } }); await prisma.insightDigest.deleteMany({ where: { id: digestId } }); }
  await prisma.botAuditFinding.deleteMany({ where: { id: { in: findings } } });
  await prisma.botLesson.deleteMany({ where: { id: { in: lessons } } });
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
  for (const id of actors) revokeElevation(id);
  await prisma.auditLog.deleteMany({ where: { agentId: { in: actors } } });
  await prisma.agent.deleteMany({ where: { id: { in: actors } } });
});
const get = (path: string, token = revoked) => request(app).get(`/api/v1/${path}`).set("Authorization", `Bearer ${token}`);
describe("ADMIN role cannot bypass revoked investigation access", () => {
  it("filters audit findings/counts and denies private detail/mutation while retaining ordinary findings", async () => {
    const no = await get("bot-audit"), yes = await get("bot-audit", allowed);
    expect(no.status).toBe(200); expect(yes.status).toBe(200);
    expect(JSON.stringify(no.body)).not.toContain(findings[0]); expect(JSON.stringify(no.body)).toContain(findings[1]);
    expect(JSON.stringify(yes.body)).toContain(findings[0]); expect(yes.body.unresolvedTotal).toBeGreaterThan(no.body.unresolvedTotal);
    expect((await get(`bot-audit/group-examples?type=agent_bypassed_crm&why=${marker}-true`)).status).toBe(404);
    expect((await request(app).post(`/api/v1/bot-audit/${findings[0]}/resolve`).set("Authorization", `Bearer ${revoked}`).send({ verdict: "bot_right" })).status).toBe(404);
    expect((await prisma.botAuditFinding.findUniqueOrThrow({ where: { id: findings[0] } })).resolvedAt).toBeNull();
  });
  it("filters quarantined lessons without removing ordinary training", async () => {
    const no = await get("bot-learning"), yes = await get("bot-learning", allowed);
    expect(no.status).toBe(200); expect(yes.status).toBe(200);
    expect(JSON.stringify(no.body)).not.toContain(`${marker}-true`); expect(JSON.stringify(no.body)).toContain(`${marker}-false`);
    expect(JSON.stringify(yes.body)).toContain(`${marker}-true`); expect(yes.body.rulesTotal).toBeGreaterThan(no.body.rulesTotal);
  });
  it("filters insight cases, coverage, counts and rejects private review", async () => {
    const no = await get(`insights/${digestId}`), yes = await get(`insights/${digestId}`, allowed);
    expect(no.status).toBe(200); expect(no.body).toHaveLength(1); expect(yes.body).toHaveLength(2);
    const list = await get("insights"); const item = list.body.find((r: { id: string }) => r.id === digestId);
    expect(item.coverage).toBeNull();
    expect((await request(app).patch(`/api/v1/insights/cases/${caseId}`).set("Authorization", `Bearer ${revoked}`).send({ meetingNote: "must not persist" })).status).toBe(404);
    expect((await prisma.insightCase.findUniqueOrThrow({ where: { id: caseId } })).meetingNote).toBeNull();
  });
  it("redacts restore-point private fields and cannot restore them even with elevation", async () => {
    const no = await get("settings/restore-points"), yes = await get("settings/restore-points", allowed);
    expect(no.status).toBe(200); expect(yes.status).toBe(200);
    const row = no.body.items.find((r: { id: string }) => r.id === snapshotId);
    expect(row.changedFields).toEqual([]); expect(row.changes).toEqual([]);
    expect(yes.body.items.find((r: { id: string }) => r.id === snapshotId).changedFields).toContain("sellerControlConfig");
    const before = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
    const result = await request(app).post(`/api/v1/settings/restore-points/${snapshotId}/restore`).set("Authorization", `Bearer ${revoked}`);
    expect(result.status).toBe(409);
    expect((await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).sellerControlConfig).toEqual(before.sellerControlConfig);
  });
});
