import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

const hooks = vi.hoisted(() => ({ afterStaffCheck: null as null | (() => Promise<void>) }));
vi.mock("../src/lib/staffPhoneGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/staffPhoneGuard.js")>();
  return { ...actual, findStaffPhone: vi.fn(async (...args: Parameters<typeof actual.findStaffPhone>) => {
    const result = await actual.findStaffPhone(...args);
    const hook = hooks.afterStaffCheck;
    hooks.afterStaffCheck = null;
    if (hook) await hook();
    return result;
  }) };
});
vi.mock("../src/ai/seoGenerator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/seoGenerator.js")>()),
  generateSeoFields: vi.fn(async () => ({ description: "Synthetic", metaTitle: "Synthetic", metaDescription: "Synthetic", h1: "Synthetic", seoDesc: "Synthetic" })),
}));
vi.mock("../src/ai/reelsCaptionAi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/reelsCaptionAi.js")>()),
  generateReelsCaptionWithAi: vi.fn(async () => "Synthetic caption"),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 0), sendPushToAgents: vi.fn(async () => 0),
  closeLeadPushNotification: vi.fn(async () => undefined), closeLeadPushNotifications: vi.fn(async () => undefined),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { PrismaClient } = await import("../src/generated/prisma/client.js");
const { makePrismaAdapter } = await import("../src/lib/prismaAdapter.js");
const concurrentWriter = new PrismaClient({ adapter: makePrismaAdapter(process.env.DATABASE_URL!) });
const agents: string[] = [];
const phones: string[] = [];
let sequence = 0;
const phonePrefix = `+9920${String(Date.now()).slice(-6)}`;
function phone() { const value = `${phonePrefix}${String(++sequence).padStart(2, "0")}`; phones.push(value); return value; }
async function actor() {
  const row = await prisma.agent.create({ data: { fullName: "Synthetic atomic seller", phone: `test-${randomUUID()}`, role: "AGENT", passwordHash: "unused-test-hash" } });
  agents.push(row.id);
  return { id: row.id, auth: `Bearer ${signAccessToken({ sub: row.id, role: "AGENT" })}` };
}
async function start(auth: string) {
  const response = await request(app).post("/api/v1/properties/drafts/current/start").set("Authorization", auth).send({ sessionId: randomUUID(), revision: 0 });
  expect(response.status).toBe(200);
  return response.body.draft;
}
function body(ownerContact: string, extra: Record<string, unknown> = {}) {
  return { type: "APARTMENT", areaSqm: 50, price: 100, currency: "TJS", condition: "GOOD", rooms: 2,
    floor: 3, totalFloors: 5, windowCount: 2, ownerContact, sellerName: "Synthetic owner", offSite: true, ...extra };
}
function create(auth: string, payload: Record<string, unknown>) {
  return request(app).post("/api/v1/properties").set("Authorization", auth).send(payload);
}
async function close(auth: string, draft: { id: string; revision: number }) {
  const response = await request(app).delete("/api/v1/properties/drafts/current").set("Authorization", auth).send({ draftId: draft.id, revision: draft.revision });
  expect(response.status).toBe(200);
}
afterEach(() => { hooks.afterStaffCheck = null; vi.restoreAllMocks(); });
afterAll(async () => {
  const propertyIds = (await prisma.property.findMany({ where: { createdById: { in: agents } }, select: { id: true } })).map(p => p.id);
  if (propertyIds.length) await prisma.backgroundJob.deleteMany({ where: { OR: propertyIds.map(id => ({ payload: { path: ["propertyId"], equals: id } })) } });
  await prisma.propertyDraft.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  const clientIds = (await prisma.client.findMany({ where: { phone: { in: phones } }, select: { id: true } })).map(c => c.id);
  await prisma.stageEvent.deleteMany({ where: { entityType: "CLIENT", entityId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
  await concurrentWriter.$disconnect();
  await prisma.$disconnect();
});

describe("property and auto-created seller commit together (real HTTP/PostgreSQL)", () => {
  it("does not create a seller if the draft closes after its initial preflight", async () => {
    const a = await actor(); const draft = await start(a.auth); const ownerContact = phone();
    let closed = false;
    hooks.afterStaffCheck = async () => { await close(a.auth, draft); closed = true; };
    const response = await create(a.auth, body(ownerContact, { draftId: draft.id, draftRevision: draft.revision }));
    expect(closed).toBe(true);
    expect(response.status).toBe(409); expect(response.body.code).toBe("DRAFT_CONFLICT");
    expect(await prisma.property.count({ where: { createdById: a.id } })).toBe(0);
    expect(await prisma.client.findUnique({ where: { phone: ownerContact } })).toBeNull();
  });

  it("rejects an already closed draft before any seller write", async () => {
    const a = await actor(); const draft = await start(a.auth); const ownerContact = phone(); await close(a.auth, draft);
    const response = await create(a.auth, body(ownerContact, { draftId: draft.id, draftRevision: draft.revision }));
    expect(response.status).toBe(409);
    expect(await prisma.client.findUnique({ where: { phone: ownerContact } })).toBeNull();
  });

  it("creates an accepted, assigned seller with a successful current draft", async () => {
    const a = await actor(); const draft = await start(a.auth); const ownerContact = phone();
    const response = await create(a.auth, body(ownerContact, { draftId: draft.id, draftRevision: draft.revision }));
    expect(response.status).toBe(201);
    const seller = await prisma.client.findUniqueOrThrow({ where: { phone: ownerContact } });
    expect(seller).toMatchObject({ kind: "SELLER", assignedAgentId: a.id, fullName: "Synthetic owner" });
    expect(seller.acceptedAt).not.toBeNull();
    await vi.waitFor(async () => expect(await prisma.stageEvent.count({ where: { entityType: "CLIENT", entityId: seller.id, field: "status", from: null, to: "NEW", agentId: a.id } })).toBe(1));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: response.body.id } })).sellerClientId).toBe(seller.id);
    expect((await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId: a.id } })).closedAt).not.toBeNull();
  });

  it.each([false, true])("reuses an existing buyer without a draft (trashed=%s)", async (trashed) => {
    const a = await actor(); const ownerContact = phone();
    const seller = await prisma.client.create({ data: { fullName: "Existing synthetic buyer", phone: ownerContact, kind: "BUYER", source: "WALK_IN", assignedAgentId: a.id, deletedAt: trashed ? new Date() : null } });
    const response = await create(a.auth, body(ownerContact));
    expect(response.status).toBe(201);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: response.body.id } })).sellerClientId).toBe(seller.id);
    expect(await prisma.client.count({ where: { phone: ownerContact } })).toBe(1);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: seller.id } })).deletedAt !== null).toBe(trashed);
  });

  it("keeps a foreign seller refusal and creates neither a property nor another client", async () => {
    const a = await actor(); const foreign = await actor(); const ownerContact = phone();
    const seller = await prisma.client.create({ data: { fullName: "Other synthetic seller", phone: ownerContact, source: "WALK_IN", kind: "SELLER", assignedAgentId: foreign.id } });
    const response = await create(a.auth, body(ownerContact));
    expect(response.status).toBe(403);
    expect(await prisma.property.count({ where: { createdById: a.id } })).toBe(0);
    expect((await prisma.client.findUniqueOrThrow({ where: { phone: ownerContact } })).id).toBe(seller.id);
  });

  it.each([false, true])("resolves a real unique-phone insertion race and checks its winner (foreign=%s)", async (foreignWinner) => {
    const a = await actor(); const other = foreignWinner ? await actor() : a; const ownerContact = phone();
    const transaction = prisma.$transaction.bind(prisma);
    let raced = false;
    let winnerId: string | undefined;
    // Interleave a separate PG connection after the route's lookup but before
    // its INSERT. The INSERT still executes against PostgreSQL and really
    // encounters the phone uniqueness conflict; no Prisma error is fabricated.
    vi.spyOn(prisma, "$transaction").mockImplementation((async (operation: (tx: any) => Promise<unknown>, options?: any) => transaction(async tx => {
      const insert = tx.client.create.bind(tx.client);
      vi.spyOn(tx.client, "create").mockImplementation(async (args: any) => {
        if (!raced && args.data.phone === ownerContact) {
          raced = true;
          winnerId = (await concurrentWriter.client.create({ data: { fullName: "Concurrent synthetic owner", phone: ownerContact, kind: "SELLER", source: "WALK_IN", assignedAgentId: other.id } })).id;
        }
        return insert(args);
      });
      return operation(tx);
    }, options)) as typeof prisma.$transaction);
    const response = await create(a.auth, body(ownerContact));
    expect(raced).toBe(true);
    expect(response.status).toBe(foreignWinner ? 403 : 201);
    expect(await prisma.client.count({ where: { phone: ownerContact } })).toBe(1);
    expect(await prisma.stageEvent.count({ where: { entityType: "CLIENT", entityId: winnerId! } })).toBe(0);
    if (foreignWinner) expect(await prisma.property.count({ where: { createdById: a.id } })).toBe(0);
    else expect((await prisma.property.findUniqueOrThrow({ where: { id: response.body.id } })).sellerClientId).toBe(winnerId);
  });

  it("a duplicate-property refusal also rolls back a new seller", async () => {
    const a = await actor(); const ownerContact = phone();
    const first = await create(a.auth, body(ownerContact)); expect(first.status).toBe(201);
    // The no-address repeat key includes the seller phone, so use an address duplicate.
    const district = await prisma.district.create({ data: { name: `Atomic duplicate ${randomUUID()}` } });
    try {
      const address = `Synthetic ${randomUUID()}`;
      const original = await create(a.auth, body(ownerContact, { districtId: district.id, address })); expect(original.status).toBe(201);
      const nextPhone = phone();
      const refused = await create(a.auth, body(nextPhone, { districtId: district.id, address }));
      expect(refused.status).toBe(409);
      expect(await prisma.client.findUnique({ where: { phone: nextPhone } })).toBeNull();
    } finally {
      await prisma.property.updateMany({ where: { districtId: district.id }, data: { districtId: null } });
      await prisma.district.delete({ where: { id: district.id } });
    }
  });

  it("rolls back the seller and its initial stage event if the property INSERT fails", async () => {
    const a = await actor(); const ownerContact = phone();
    // A valid UUID that has no District row reaches a real PostgreSQL FK
    // failure, after the auto-seller INSERT. No DB method is mocked here.
    const response = await create(a.auth, body(ownerContact, { districtId: randomUUID(), address: `Synthetic missing district ${randomUUID()}` }));
    expect(response.status).toBe(500);
    expect(await prisma.property.count({ where: { createdById: a.id } })).toBe(0);
    expect(await prisma.client.findUnique({ where: { phone: ownerContact } })).toBeNull();
    expect(await prisma.stageEvent.count({ where: { entityType: "CLIENT", agentId: a.id } })).toBe(0);
  });
});
