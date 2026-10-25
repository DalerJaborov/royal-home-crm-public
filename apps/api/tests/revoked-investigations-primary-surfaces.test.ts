import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { investigationRecipients, filterInvestigationRecipients } from "../src/lib/investigationNotifications.js";

const run = randomUUID();
const secret = `private-sentinel-${run}`;
const ordinary = `ordinary-sentinel-${run}`;
const ids: string[] = [];
const tokens: string[] = [];
const privateNotices: string[] = [];
let clientId: string;
let publicId: string;
let privateId: string;
beforeAll(async () => {
  for (const role of ["ADMIN", "HEAD_OF_SALES"] as const) {
    const agent = await prisma.agent.create({ data: { fullName: `Projection test ${role} ${run}`, phone: randomUUID(),
      passwordHash: "synthetic-unused", role, permissions: { granted: ["clients.securityReview", "reports.view", "clients.viewAll"], revoked: [] } } });
    ids.push(agent.id);
    tokens.push(signAccessToken({ sub: agent.id, role }));
    for (const hidden of [false, true]) {
      const notice = await prisma.notification.create({ data: { agentId: agent.id, kind: "insight", level: hidden ? "CRITICAL" : "OTHER",
        title: hidden ? secret : ordinary, body: hidden ? secret : ordinary,
        tag: `${hidden ? "investigation-" : "ordinary-"}${run}-${agent.id}` } });
      if (hidden) privateNotices.push(notice.id);
    }
  }
  const client = await prisma.client.create({ data: { fullName: `Projection client ${run}`, phone: randomUUID(),
    source: "PHONE_CALL", kind: "BUYER", assignedAgentId: ids[0], acceptedAt: new Date(), securityReview: "PENDING", securityNote: secret } });
  clientId = client.id;
  for (const hidden of [false, true]) {
    const row = await prisma.interaction.create({ data: { clientId, agentId: ids[0], type: "SHOWING", investigationOnly: hidden,
      notes: hidden ? secret : ordinary, nextAction: hidden ? secret : ordinary, nextActionDate: new Date(Date.now() + 3_600_000) } });
    if (hidden) privateId = row.id; else publicId = row.id;
  }
});
afterAll(async () => {
  if (clientId) {
    await prisma.interaction.deleteMany({ where: { clientId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
  }
  await prisma.notification.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});
const get = (path: string, token: string) => request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);

describe("effective investigation permission across persisted primary projections", () => {
  it.each(["approved-admin", "revoked-admin", "granted-rop"] as const)("%s sees the correct projection, counters and direct-ID boundary", async mode => {
    const allowed = mode === "approved-admin";
    const index = mode === "granted-rop" ? 1 : 0;
    // Same JWT remains in use: revocation must be evaluated from current access.
    await prisma.agent.update({ where: { id: ids[0] }, data: { permissions: {
      granted: [], revoked: mode === "revoked-admin" ? ["clients.securityReview"] : [],
    } } });
    invalidateAgentAccess(ids[0]);
    invalidateAgentAccess(ids[1]);
    const token = tokens[index];
    expect((await investigationRecipients()).includes(ids[index])).toBe(allowed);
    expect((await filterInvestigationRecipients([ids[index]], { tag: `investigation-${run}` })).includes(ids[index])).toBe(allowed);
    expect(await filterInvestigationRecipients([ids[index]], { tag: `ordinary-${run}` })).toEqual([ids[index]]);
    const list = await get(`/clients?search=${encodeURIComponent(run)}`, token);
    expect(list.status).toBe(200);
    const listed = list.body.items.find((row: { id: string }) => row.id === clientId);
    expect(listed).toBeDefined();
    if (allowed) expect(listed.securityReview).toBe("PENDING");
    else { expect(listed).not.toHaveProperty("securityReview"); expect(listed).not.toHaveProperty("securityNote"); }
    for (const path of [`/clients/${clientId}`, `/clients/${clientId}/timeline`, "/calendar/tasks"]) {
      const response = await get(path, token);
      expect(response.status, path).toBe(200);
      expect(JSON.stringify(response.body), path).toContain(ordinary);
      expect(JSON.stringify(response.body).includes(secret), path).toBe(allowed);
      expect(JSON.stringify(response.body).includes(privateId), path).toBe(allowed);
      expect(JSON.stringify(response.body), path).toContain(publicId);
    }
    const history = await get(`/clients/${clientId}/timeline`, token);
    expect(history.body.total).toBe(allowed ? 2 : 1);
    const report = await get("/reports/agents", token);
    expect(report.status).toBe(200);
    expect(report.body.find((row: { agentId: string }) => row.agentId === ids[0]).showings).toBe(allowed ? 2 : 1);
    const privateReport = await get("/reports/security-review-digest", token);
    expect(privateReport.status).toBe(allowed ? 200 : 403);
    const notices = await get("/me/notifications", token);
    expect(notices.status).toBe(200);
    expect(JSON.stringify(notices.body)).toContain(ordinary);
    expect(JSON.stringify(notices.body).includes(secret)).toBe(allowed);
    expect(notices.body.unreadCount).toBe(allowed ? 2 : 1);
    expect(notices.body.criticalCount).toBe(allowed ? 1 : 0);
    if (!allowed) {
      const read = await request(app).post(`/api/v1/me/notifications/${privateNotices[index]}/read`).set("Authorization", `Bearer ${token}`);
      expect(read.status).toBe(404);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: privateNotices[index] } })).read).toBe(false);
    }
  });
});
