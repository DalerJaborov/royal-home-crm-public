import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Акционер видит бизнес, но не номера (10.10.2026): в его пресете нарочно нет
 * clients.viewPhone и properties.viewOwners. Плюс — личными надстройками права ему
 * добавлять нельзя (PUT /agents/:id/permissions).
 */

const runId = Date.now();
const PHONE = `+99290${String(runId).slice(-7)}`;
const OWNER_CONTACT = `+99291${String(runId).slice(-7)}`;
const ids: string[] = [];
let shareholderToken = "";
let directorToken = "";
let shareholderId = "";
let clientId = "";
let clientShortId = 0;
let propertyId = "";
let districtId = "";
let conversationId = "";

beforeAll(async () => {
  const mk = (name: string, role: "SHAREHOLDER" | "DIRECTOR" | "AGENT", n: number) =>
    prisma.agent.create({
      data: { fullName: `${name} ${runId}`, phone: `+9929${n}${String(runId).slice(-7)}`, role, passwordHash: "x" },
    });
  const shareholder = await mk("Акционер маски", "SHAREHOLDER", 5);
  const director = await mk("Директор маски", "DIRECTOR", 6);
  const agent = await mk("Агент маски", "AGENT", 7);
  ids.push(shareholder.id, director.id, agent.id);
  shareholderId = shareholder.id;
  shareholderToken = signAccessToken({ sub: shareholder.id, role: "SHAREHOLDER" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  grantElevation(director.id);

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент маски ${runId}`,
      phone: PHONE,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  clientShortId = client.shortId;

  const district = await prisma.district.create({ data: { name: `Район маски ${runId}` } });
  districtId = district.id;
  const property = await prisma.property.create({
    data: {
      title: `Объект маски ${runId}`,
      address: "Рудаки 1",
      price: 100000,
      areaSqm: 50,
      currency: "USD",
      type: "APARTMENT",
      condition: "GOOD",
      status: "AVAILABLE",
      districtId,
      assignedAgentId: agent.id,
      ownerContact: OWNER_CONTACT,
    },
  });
  propertyId = property.id;
  const conversation = await prisma.botConversation.create({
    data: { channel: "WHATSAPP", subscriberId: PHONE, name: PHONE, clientId,
      messages: [{ role: "user", content: `Номер ${PHONE}`, at: new Date().toISOString() }] },
  });
  conversationId = conversation.id;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: conversationId } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("Акционер: номера скрыты", () => {
  it("служебный ID и имя WhatsApp не обходят маску номера", async () => {
    const res = await request(app).get(`/api/v1/conversations/${conversationId}`).set("Authorization", `Bearer ${shareholderToken}`);
    expect(res.status).toBe(200);
    // Origin visibility retains the canonical mask, never the delivery phone.
    expect(res.body.subscriberId).toBe(`+992•••••${PHONE.slice(-2)}`);
    expect(JSON.stringify(res.body)).not.toContain(PHONE);
    const permitted = await request(app).get(`/api/v1/conversations/${conversationId}`).set("Authorization", `Bearer ${directorToken}`);
    expect(permitted.status).toBe(200);
    expect(permitted.body.subscriberId).toBe(PHONE);
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { subscriberId: true } })).subscriberId).toBe(PHONE);
  });
  it("карточка клиента: телефон закрыт", async () => {
    const res = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${shareholderToken}`);
    expect(res.status).toBe(200);
    expect(res.body.phone).toContain("•");
    expect(JSON.stringify(res.body)).not.toContain(PHONE);
  });

  it("главная: контакт собственника объекта не приходит", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${shareholderToken}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(OWNER_CONTACT);
    for (const p of res.body.topProperties ?? []) {
      expect(p.ownerContact).toBeFalsy();
      expect(p.ownerContactHidden).toBe(true);
    }
  });

  it("список и карточка объекта: контакт собственника не приходит", async () => {
    const list = await request(app).get("/api/v1/properties").set("Authorization", `Bearer ${shareholderToken}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(OWNER_CONTACT);
    const one = await request(app).get(`/api/v1/properties/${propertyId}`).set("Authorization", `Bearer ${shareholderToken}`);
    expect(JSON.stringify(one.body)).not.toContain(OWNER_CONTACT);
  });
});

describe("Акционеру права не добавляются", () => {
  it("PUT /agents/:id/permissions с granted -> 400", async () => {
    const res = await request(app)
      .put(`/api/v1/agents/${shareholderId}/permissions`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ granted: ["clients.viewPhone"], revoked: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Акционеру права не добавляются");
    const row = await prisma.agent.findUnique({ where: { id: shareholderId }, select: { permissions: true } });
    expect(row?.permissions).toBeNull();
  });

  it("снимать (revoked) можно", async () => {
    const res = await request(app)
      .put(`/api/v1/agents/${shareholderId}/permissions`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ granted: [], revoked: ["finance.view"] });
    expect(res.status).toBe(200);
  });
});
