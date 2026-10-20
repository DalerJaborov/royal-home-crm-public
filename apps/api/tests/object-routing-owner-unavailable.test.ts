import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { assignAgentForLead } from "../src/services/leads/assignment.js";
import { assignPendingLeads, waveProperty } from "../src/services/leads/reassignment.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * P0-5 и P0-6 аудита docs/audit-bots-2026-10-10-object-routing.md.
 *  - Заморозка (отпуск) не снимает с хозяина лид по его объекту — «отпуск не
 *    отменяет владение»; обычный непринятый лид снимается, как раньше.
 *  - Утренняя волна знает объект снятого в очередь лида (matchedPropertyId при
 *    прямом указании) — лид возвращается к хозяину, а не по очереди.
 *  - Хозяин уволен — руководитель получает «лид по объекту без хозяина»; ступень
 *    с не-агентом (директор-интейкер) уступает ведущему агенту объекта.
 */
const runId = Date.now();
const tail = String(runId).slice(-6);
const password = "testpass123";
let districtId: string;
let ownerId: string;
let firedId: string;
let directorId: string;
let adminId: string;
let adminToken: string;
let ownPropertyId: string;
let firedPropertyId: string;
let directorIntakePropertyId: string;
const agentIds: string[] = [];
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function mkAgent(fullName: string, n: number, role = "AGENT", extra: Record<string, unknown> = {}) {
  const a = await prisma.agent.create({
    data: { fullName, role: role as never, phone: `+99297${tail}${n}`, passwordHash: await bcrypt.hash(password, 4), ...extra },
  });
  agentIds.push(a.id);
  return a;
}

async function mkProperty(title: string, data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 70,
      rooms: 3,
      price: 400_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 7",
      condition: "GOOD",
      status: "AVAILABLE",
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function mkClient(label: string, data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `Владелец недоступен ${label} ${runId}`,
      phone: `+99298${tail}${clientIds.length}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      status: "NEW",
      ...data,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-хозяин-недоступен-${runId}` } })).id;
  ownerId = (await mkAgent("Хозяин в отпуске", 1)).id;
  firedId = (await mkAgent("Уволенный хозяин", 2, "AGENT", { isActive: false })).id;
  directorId = (await mkAgent("Директор интейкер", 3, "DIRECTOR")).id;
  const admin = await mkAgent("Админ заморозки объекта", 4, "ADMIN");
  adminId = admin.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken;
  grantElevation(adminId);
  ownPropertyId = (await mkProperty("Объект хозяина в отпуске", { intakeAgentId: ownerId })).id;
  firedPropertyId = (await mkProperty("Объект уволенного", { intakeAgentId: firedId })).id;
  directorIntakePropertyId = (await mkProperty("Объект с директором-интейкером", { intakeAgentId: directorId, assignedAgentId: ownerId })).id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { in: propertyIds.map((id) => `own-property-no-owner-${id}`) } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...clientIds, ...agentIds] } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.session.deleteMany({ where: { agentId: { in: agentIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("P0-5: заморозка хозяина и утренняя волна", () => {
  it("заморозка снимает обычный непринятый лид, а лид по своему объекту оставляет хозяину", async () => {
    const own = await mkClient("свой", {
      assignedAgentId: ownerId,
      assignedAt: new Date(),
      ownPropertyLead: true,
      assignReason: "own_property_explicit",
      matchedPropertyId: ownPropertyId,
    });
    const plain = await mkClient("обычный", { assignedAgentId: ownerId, assignedAt: new Date(), assignReason: "queue" });
    const res = await request(app)
      .post(`/api/v1/agents/${ownerId}/freeze`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Отпуск по тесту", kind: "VACATION" });
    expect(res.status).toBe(200);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: own.id } })).assignedAgentId).toBe(ownerId);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: plain.id } })).assignedAgentId).toBeNull();
    await prisma.agent.update({ where: { id: ownerId }, data: { frozenAt: null, frozenById: null, frozenReason: null, absenceKind: null, absenceUntil: null } });
  });

  it("волна берёт объект снятого лида только при прямом указании на него", () => {
    expect(waveProperty({ requestedPropertyId: null, matchedPropertyId: "p1", assignReason: "own_property_explicit" })).toBe("p1");
    expect(waveProperty({ requestedPropertyId: null, matchedPropertyId: "p1", assignReason: "instagram_post_link" })).toBe("p1");
    expect(waveProperty({ requestedPropertyId: null, matchedPropertyId: "p1", assignReason: "own_property_match" })).toBeUndefined();
    expect(waveProperty({ requestedPropertyId: "p2", matchedPropertyId: "p1", assignReason: "own_property_explicit" })).toBe("p2");
  });

  it("лид, снятый с хозяина в очередь, утренняя волна возвращает хозяину объекта", async () => {
    const lead = await mkClient("снят в очередь", {
      assignedAgentId: null,
      assignReason: "own_property_explicit",
      matchedPropertyId: ownPropertyId,
    });
    const delegate = prisma.settings;
    const real = delegate.findUnique.bind(delegate);
    const spy = vi.spyOn(delegate, "findUnique").mockImplementation((async (args: Parameters<typeof real>[0]) => {
      const row = await real(args);
      return row ? { ...row, leadDistributionStrategy: "fair", ownPropertyPriorityEnabled: true, ownPropertyShownExceptionEnabled: true } : row;
    }) as never);
    try {
      await assignPendingLeads();
    } finally {
      spy.mockRestore();
    }
    const after = await prisma.client.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.assignedAgentId).toBe(ownerId);
    expect(after.assignReason).toBe("own_property_explicit");
  });
});

describe("P0-6: хозяин уволен или не агент", () => {
  it("хозяин уволен — правило не срабатывает, руководитель получает «лид по объекту без хозяина»", async () => {
    const result = await assignAgentForLead({ kind: "BUYER", propertyId: firedPropertyId });
    expect(result.reason).not.toBe("own_property_explicit");
    expect(result.agentId).not.toBe(firedId);
    await waitFor(async () =>
      prisma.notification.findFirst({ where: { agentId: directorId, tag: `own-property-no-owner-${firedPropertyId}` } })
    );
  });

  it("интейкер — директор, ведёт объект агент — лид агенту, а не в очередь", async () => {
    const result = await assignAgentForLead({ kind: "BUYER", propertyId: directorIntakePropertyId });
    expect(result.reason).toBe("own_property_explicit");
    expect(result.agentId).toBe(ownerId);
  });
});
