import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { callAiText } from "../src/ai/client.js";

vi.mock("../src/ai/client.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/ai/client.js")>(), callAiText: vi.fn() }));
const tag = randomUUID();
let agentId: string;
let otherId: string;
let districtId: string;
let buyerId: string;
let sellerId: string;
let bestId: string;
let ownId: string;
let token: string;
let ids: string[] = [];

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "test-matching-agent", phone: `test-match-agent-${tag}`, role: "AGENT", passwordHash: "test-not-a-login" } })).id;
  otherId = (await prisma.agent.create({ data: { fullName: "test-matching-other", phone: `test-match-other-${tag}`, role: "AGENT", passwordHash: "test-not-a-login" } })).id;
  token = signAccessToken({ sub: agentId, role: "AGENT" });
  districtId = (await prisma.district.create({ data: { name: `test-match-${tag}` } })).id;
  const common = { source: "PHONE_CALL" as const, currency: "TJS" as const, assignedAgentId: agentId, acceptedAt: new Date(), desiredType: "APARTMENT" as const,
    desiredDistrictId: districtId, desiredRooms: 3, budgetMax: 600000 };
  buyerId = (await prisma.client.create({ data: { ...common, fullName: "test-match-buyer", phone: `test-match-buyer-${tag}`, kind: "BUYER" } })).id;
  sellerId = (await prisma.client.create({ data: { ...common, fullName: "test-match-seller", phone: `test-match-seller-${tag}`, kind: "SELLER", dualIntent: true } })).id;
  const base = { type: "APARTMENT" as const, condition: "GOOD" as const, areaSqm: 60, rooms: 2, price: 550000, currency: "TJS" as const,
    address: "test-address", status: "AVAILABLE" as const, districtId, intakeAgentId: otherId };
  const best = await prisma.property.create({ data: { ...base, title: "test-best-old", rooms: 3, offSite: true, createdAt: new Date("2020-01-01T00:00:00Z") } });
  bestId = best.id;
  const own = await prisma.property.create({ data: { ...base, title: "test-own-alternative", intakeAgentId: agentId } });
  ownId = own.id;
  ids = [bestId, ownId];
  const others = await prisma.property.createManyAndReturn({ data: Array.from({ length: 65 }, (_, i) => ({ ...base, title: `test-new-alternative-${i}` })) });
  ids.push(...others.map(p => p.id));
  await prisma.propertyExposure.createMany({ data: [
    { clientId: buyerId, propertyId: bestId, shortId: best.shortId, channel: "WHATSAPP", recipientId: `test-peer-${tag}`, kind: "LINK", sentAt: new Date("2026-01-01T00:00:00Z") },
    { clientId: buyerId, propertyId: bestId, shortId: best.shortId, channel: "SMS", recipientId: buyerId, kind: "LINK", sentAt: new Date("2026-01-02T00:00:00Z") },
  ] });
  await prisma.interaction.create({ data: { clientId: buyerId, agentId, propertyId: ownId, type: "SHOWING", notes: "test-only-showing-no-send" } });
});
afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: [buyerId, sellerId] } } });
  await prisma.propertyExposure.deleteMany({ where: { clientId: { in: [buyerId, sellerId] } } });
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherId] } } });
});

function match(id = buyerId, query = "") {
  return request(app).get(`/api/v1/clients/${id}/match${query}`).set("Authorization", `Bearer ${token}`);
}

describe("client recommendation catalogue before pagination", () => {
  it("compares an old best property beyond 60 new ones, including off-site", async () => {
    const res = await match(); expect(res.status).toBe(200);
    expect(res.body.properties[0].id).toBe(bestId);
    expect(res.body.scanned).toBeGreaterThanOrEqual(67);
    expect(res.body.eligible).toBe(67);
    expect(res.body.total).toBe(67);
    expect(res.body.properties).toHaveLength(12);
    expect(res.body.hasMore).toBe(true);
    expect(callAiText).not.toHaveBeenCalled();
  });
  it("paginates the whole ranked set without duplicates", async () => {
    const first = await match(buyerId, "?pageSize=30");
    const second = await match(buyerId, "?pageSize=30&page=2");
    expect(new Set([...first.body.properties, ...second.body.properties].map(p => p.id)).size).toBe(60);
    expect(second.body.total).toBe(67);
  });
  it("filters mine only after global ranking, and does not invent a send from a showing", async () => {
    const res = await match(buyerId, "?scope=mine"); expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(67); expect(res.body.total).toBe(1); expect(res.body.mineTotal).toBe(1);
    expect(res.body.properties[0].id).toBe(ownId);
    expect(res.body.properties[0].match).toMatchObject({ isMine: true, lastSentAt: null, sentCount: 0 });
  });
  it("uses complete structured exposure history rather than interactions", async () => {
    const res = await match();
    expect(res.body.properties[0].match).toMatchObject({ lastSentAt: "2026-01-02T00:00:00.000Z", sentCount: 2 });
    expect(res.body.properties[0]).not.toHaveProperty("ownerContact");
    expect(res.body.properties[0]).not.toHaveProperty("embedding");
  });
  it("raw dualIntent on a seller is not a confirmed purchase request", async () => {
    const res = await match(sellerId); expect(res.status).toBe(200);
    expect(res.body.reason).toBe("not_buyer"); expect(res.body.properties).toEqual([]);
  });
  it("explicitly confirmed second role enables recommendations for a seller", async () => {
    await prisma.client.update({ where: { id: sellerId }, data: { dualIntentConfirmedAt: new Date(), dualIntentConfirmedById: agentId } });
    await prisma.property.update({ where: { id: bestId }, data: { sellerClientId: sellerId } });
    try {
      const res = await match(sellerId); expect(res.status).toBe(200);
      expect(res.body.reason).toBeNull(); expect(res.body.total).toBe(66);
      expect(res.body.properties.some((p: { id: string }) => p.id === bestId)).toBe(false);
    } finally {
      await prisma.client.update({ where: { id: sellerId }, data: { dualIntentConfirmedAt: null, dualIntentConfirmedById: null } });
      await prisma.property.update({ where: { id: bestId }, data: { sellerClientId: null } });
    }
  });
  it("does not apply a previous seller budget to a new buyer request", async () => {
    await prisma.client.update({ where: { id: buyerId }, data: { requirementsFieldsKind: "SELLER", budgetMax: 1 } });
    try {
      const res = await match(buyerId, "?scope=mine"); expect(res.status).toBe(200);
      expect(res.body.unfiltered).toBe(true); expect(res.body.reason).toBe("needs_requirements");
      expect(res.body.properties.some((p: { id: string }) => p.id === ownId)).toBe(true);
      expect(res.body.properties[0].match.reasons).not.toContain("В бюджете");
    } finally {
      await prisma.client.update({ where: { id: buyerId }, data: { requirementsFieldsKind: null, budgetMax: 600000 } });
    }
  });
  it("respects the catalogue pending-deletion hiding rule before counting and ranking", async () => {
    const deletion = await prisma.propertyDeleteRequest.create({ data: { propertyId: bestId, requestedById: agentId, reason: "test-request" } });
    try {
      const res = await match(); expect(res.status).toBe(200);
      expect(res.body.properties.some((p: { id: string }) => p.id === bestId)).toBe(false);
      expect(res.body.eligible).toBe(66);
    } finally { await prisma.propertyDeleteRequest.delete({ where: { id: deletion.id } }); }
  });
  it("validates query boundaries", async () => {
    expect((await match(buyerId, "?page=0")).status).toBe(400);
    expect((await match(buyerId, "?scope=unknown")).status).toBe(400);
    expect((await match("invalid-id")).status).toBe(400);
  });
});
