import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { clientPropertyActivitySchema, ROLES, resolvePermissions } from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";

const tag = randomUUID().slice(0, 8);
const agents: string[] = [];
const tokens: Record<string, string> = {};
const clients: string[] = [];
let buyer = "", pending = "", property = "", showing = "";
const past = new Date(Date.now() - 10 * 86_400_000);

beforeAll(async () => {
  for (const role of ["AGENT", "SECURITY", "ADMIN", "SHAREHOLDER", "DIRECTOR", "MANAGER", "HEAD_OF_SALES", "MARKETING", "EDITOR"] as const) {
    const a = await prisma.agent.create({ data: { fullName: `test-card-${role}-${tag}`, phone: `test-${role}-${tag}`, passwordHash: "test-unused", role } });
    agents.push(a.id); tokens[role] = signAccessToken({ sub: a.id, role });
  }
  const foreign = await prisma.agent.create({ data: { fullName: `test-foreign-${tag}`, phone: `test-foreign-${tag}`, passwordHash: "test-unused", role: "AGENT" } });
  agents.push(foreign.id); tokens.FOREIGN = signAccessToken({ sub: foreign.id, role: "AGENT" });
  for (const accepted of [true, false]) {
    const c = await prisma.client.create({ data: { fullName: `test-card-${tag}`, phone: `test-client-${accepted}-${tag}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agents[0], acceptedAt: accepted ? new Date() : null } });
    clients.push(c.id); if (accepted) buyer = c.id; else pending = c.id;
  }
  const p = await prisma.property.create({ data: { title: "test-property +992900001234", type: "APARTMENT", condition: "GOOD", areaSqm: 50, price: 500000, currency: "TJS", address: "test-address", createdById: agents[0], intakeAgentId: agents[0] } });
  property = p.id;
  await prisma.propertyExposure.createMany({ data: Array.from({ length: 23 }, (_, i) => ({ clientId: buyer, propertyId: property, shortId: p.shortId, channel: "WHATSAPP", recipientId: `test-peer-${tag}`, kind: i % 2 ? "PHOTO" : "LINK", sentAt: new Date(past.getTime() + i) })) });
  await prisma.interaction.createMany({ data: Array.from({ length: 210 }, (_, i) => ({ clientId: buyer, agentId: agents[0], type: "SYSTEM" as const, notes: `test-event-${i}` })) });
  const s = await prisma.interaction.create({ data: { clientId: buyer, agentId: agents[0], type: "SHOWING", propertyId: property, notes: "test-showing", nextAction: "test-callback +992900001234", nextActionDate: new Date(Date.now() + 86_400_000) } });
  showing = s.id;
});

afterAll(async () => {
  await prisma.propertyExposure.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.property.deleteMany({ where: { id: property } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
});

function activity(role: string, id = buyer, query = "") {
  return request(app).get(`/api/v1/clients/${id}/property-activity${query}`).set("Authorization", `Bearer ${tokens[role]}`);
}

describe("client property workspace data and access", () => {
  it.each(ROLES)("%s reads property activity according to its effective client scope", async role => {
    const allowed = role === "AGENT" || resolvePermissions(role, null).has("clients.viewAll");
    expect((await activity(role)).status).toBe(allowed ? 200 : 403);
  });
  it.each(ROLES)("%s cannot use card messaging to bypass write access", async role => {
    const allowed = role !== "SHAREHOLDER" && (role === "AGENT" || resolvePermissions(role, null).has("clients.assign"));
    const res = await request(app).post(`/api/v1/clients/${buyer}/message`)
      .set("Authorization", `Bearer ${tokens[role]}`).send({ text: "test-message-never-delivered" });
    // No messenger exists on this synthetic card; writers get a clear 409, readers a 403.
    expect(res.status).toBe(allowed ? 409 : 403);
  });
  it("keeps structured sends beyond the last 200 timeline entries, with pagination", async () => {
    const first = await activity("AGENT"); expect(first.status).toBe(200);
    const body = clientPropertyActivitySchema.parse(first.body);
    expect(body.total).toBe(23); expect(body.items).toHaveLength(20);
    expect(body.items[0].state).toBe("sent");
    const second = await activity("AGENT", buyer, "?page=2");
    expect(second.body.items).toHaveLength(3);
    expect(new Set([...body.items, ...second.body.items].map(i => i.id)).size).toBe(23);
  });
  it("masks phones in property titles and respects independent origin visibility", async () => {
    const res = await activity("AGENT");
    expect(JSON.stringify(res.body)).not.toContain("900001234");
    const admin = await activity("ADMIN");
    expect(JSON.stringify(admin.body)).toContain("900001234");
  });
  it("phone permission never grants origin visibility, or vice versa", async () => {
    try {
      await prisma.agent.update({ where: { id: agents[0] }, data: { permissions: { granted: ["clients.viewPhone"], revoked: ["clients.viewOrigin"] } } });
      invalidateAgentAccess(agents[0]);
      const res = await activity("AGENT");
      expect(res.body.items[0].channel).toBeNull();
      expect(res.body.items[0].property.title).toContain("900001234");
      await prisma.agent.update({ where: { id: agents[0] }, data: { permissions: { granted: ["clients.viewOrigin"], revoked: ["clients.viewPhone"] } } });
      invalidateAgentAccess(agents[0]);
      const reverse = await activity("AGENT");
      expect(reverse.body.items[0].channel).toBe("WHATSAPP");
      expect(reverse.body.items[0].property.title).not.toContain("900001234");
    } finally {
      await prisma.agent.update({ where: { id: agents[0] }, data: { permissions: { granted: [], revoked: [] } } });
      invalidateAgentAccess(agents[0]);
    }
  });
  it("does not reveal a pending lead's objects", async () => {
    expect((await activity("AGENT", pending)).status).toBe(403);
  });
  it("denies a foreign agent while allowing authorized read-only reviewers", async () => {
    expect((await activity("FOREIGN")).status).toBe(403);
    expect((await activity("SECURITY")).status).toBe(200);
    expect((await activity("SHAREHOLDER")).status).toBe(200);
  });
  it("returns complete summary and next step with privacy masking on the card", async () => {
    const res = await request(app).get(`/api/v1/clients/${buyer}`).set("Authorization", `Bearer ${tokens.AGENT}`);
    expect(res.status).toBe(200); expect(res.body.interactions).toHaveLength(200);
    expect(res.body.propertyActivitySummary.sentCount).toBe(23);
    expect(res.body.propertyActivitySummary.lastSentAt).not.toBeNull();
    expect(res.body.nextStep.nextAction).not.toContain("900001234");
    const gated = await request(app).get(`/api/v1/clients/${pending}`).set("Authorization", `Bearer ${tokens.AGENT}`);
    expect(gated.body.propertyActivitySummary).toBeNull(); expect(gated.body.nextStep).toBeNull();
  });
  it("names a scheduled showing correctly even without a manually entered next action", async () => {
    try {
      await prisma.interaction.update({ where: { id: showing }, data: { nextAction: null } });
      const res = await request(app).get(`/api/v1/clients/${buyer}`).set("Authorization", `Bearer ${tokens.AGENT}`);
      expect(res.body.nextStep.nextAction).toBe("Провести показ");
      expect(res.body.nextStep.nextActionDate).not.toBeNull();
    } finally { await prisma.interaction.update({ where: { id: showing }, data: { nextAction: "test-callback" } }); }
  });
  it("distinguishes scheduled, cancelled and completed showings", async () => {
    const own = (await activity("AGENT", buyer, "?section=showings")).body.items[0];
    expect(own.state).toBe("scheduled"); expect(own.canManage).toBe(true);
    expect((await activity("SECURITY", buyer, "?section=showings")).body.items[0].canManage).toBe(false);
    expect((await activity("SHAREHOLDER", buyer, "?section=showings")).body.items[0].canManage).toBe(false);
    await prisma.interaction.update({ where: { id: showing }, data: { declinedAt: new Date() } });
    expect((await activity("AGENT", buyer, "?section=showings")).body.items[0].state).toBe("cancelled");
    await prisma.interaction.update({ where: { id: showing }, data: { declinedAt: null, completedAt: new Date() } });
    expect((await activity("AGENT", buyer, "?section=showings")).body.items[0].state).toBe("completed");
  });
  it("allows a former assigned agent to inspect without granting mutation access", async () => {
    try {
      await prisma.client.update({ where: { id: buyer }, data: { lastAgentId: agents.at(-1) } });
      expect((await activity("FOREIGN")).status).toBe(200);
      expect((await activity("FOREIGN", buyer, "?section=showings")).body.items[0].canManage).toBe(false);
    } finally { await prisma.client.update({ where: { id: buyer }, data: { lastAgentId: null } }); }
  });
  it("keeps a send receipt when its property has been removed", async () => {
    try {
      await prisma.property.update({ where: { id: property }, data: { deletedAt: new Date() } });
      const res = await activity("AGENT");
      expect(res.body.total).toBe(23); expect(res.body.items[0].property).toBeNull();
      expect(res.body.items[0].shortId).toBeTypeOf("number");
    } finally { await prisma.property.update({ where: { id: property }, data: { deletedAt: null } }); }
  });
  it("mirrors catalogue hiding for the author of a pending property deletion", async () => {
    const deletion = await prisma.propertyDeleteRequest.create({ data: { propertyId: property, requestedById: agents[0], reason: "test-request" } });
    try {
      expect((await activity("AGENT")).body.items[0].property).toBeNull();
      expect((await activity("ADMIN")).body.items[0].property).not.toBeNull();
    } finally { await prisma.propertyDeleteRequest.delete({ where: { id: deletion.id } }); }
  });
  it("rejects invalid boundaries and unauthenticated access", async () => {
    expect((await activity("AGENT", buyer, "?page=0")).status).toBe(400);
    expect((await activity("AGENT", buyer, "?section=other")).status).toBe(400);
    expect((await activity("AGENT", "not-a-guid")).status).toBe(400);
    expect((await request(app).get(`/api/v1/clients/${buyer}/property-activity`)).status).toBe(401);
  });
});
