import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * РУЧНАЯ СМЕНА СТАТУСА ОБЪЕКТА ИДЁТ ТЕМ ЖЕ ПУТЁМ, ЧТО И КНОПКИ
 * (глубокая проверка 02.10.2026, D7, D8, D11).
 *
 * D7: EDITING → AVAILABLE выпадающим списком проходил мимо «Готово»: ни записи
 *     «вышел из монтажа», ни пуша, ни сайта, место монтажёра оставалось занятым.
 * D8: маркетинг вернул объект из монтажа на доработку (EDITING → AWAITING_*) —
 *     передача монтажёру не гасилась, и сданный ролик выводил объект в продажу
 *     со старыми материалами.
 * D11: RESERVED → AVAILABLE руками при живой сделке: объект снова «в продаже»,
 *     сделка висит.
 */

const runId = Date.now();
const tail = String(runId).slice(-6);
const password = "testpass123";
const agentIds: string[] = [];
const propertyIds: string[] = [];
const clientIds: string[] = [];
let agentId = "";
let agentToken = "";
let directorToken = "";

async function makeAgent(n: number, role: "AGENT" | "DIRECTOR") {
  const passwordHash = await bcrypt.hash(password, 10);
  const a = await prisma.agent.create({
    data: { fullName: `Ручной статус ${runId}-${n}`, phone: `+992907${tail}${n}`, role, passwordHash },
  });
  agentIds.push(a.id);
  const login = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password });
  expect(login.status).toBe(200);
  return { id: a.id, token: login.body.accessToken as string };
}

async function editingProperty(title: string) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      condition: "GOOD",
      status: "EDITING",
      instagramUrl: "https://www.instagram.com/reel/TEST123/",
      intakeAgentId: agentId,
      createdById: agentId,
      videoHandoffStatus: "SENT_TO_EDITOR",
      videoHandoffSentAt: new Date(),
      photos: { create: [{ url: "/uploads/test-manual-status.webp", thumbUrl: "/uploads/thumbs/test-manual-status.webp" }] },
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const agent = await makeAgent(1, "AGENT");
  agentId = agent.id;
  agentToken = agent.token;
  directorToken = (await makeAgent(2, "DIRECTOR")).token;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.montajerMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("D7: EDITING → AVAILABLE списком = «Готово»", () => {
  it("пишется «вышел из монтажа» и место монтажёра освобождается", async () => {
    const p = await editingProperty("Монтаж списком");
    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "AVAILABLE" });
    expect([200, 207]).toContain(res.status);
    expect(res.body.status).toBe("AVAILABLE");

    await waitFor(
      () => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_EDITING_DONE" } }),
      { label: "запись «вышел из монтажа»" }
    );
    await waitFor(
      async () => (await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoHandoffStatus !== "SENT_TO_EDITOR",
      { label: "место монтажёра освобождено" }
    );
  });
});

describe("D8: возврат из монтажа на доработку", () => {
  it("передача монтажёру гасится", async () => {
    const p = await editingProperty("Монтаж на доработку");
    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ status: "AWAITING_PHOTOS" });
    expect(res.status).toBe(200);
    await waitFor(
      async () => {
        const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
        return after.videoHandoffStatus !== "SENT_TO_EDITOR" && after.videoHandoffStatus !== "QUEUED";
      },
      { label: "передача монтажёру закрыта" }
    );
  });
});

describe("D11: резерв не снимается руками при живой сделке", () => {
  it("RESERVED → AVAILABLE с открытой сделкой — 409, объект остаётся в резерве", async () => {
    const client = await prisma.client.create({
      data: { fullName: `Покупатель брони ${runId}`, phone: `+992908${tail}1`, source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
    });
    clientIds.push(client.id);
    const p = await prisma.property.create({
      data: {
        title: `Бронь ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        condition: "GOOD",
        status: "RESERVED",
        reservedAt: new Date(),
        reservedForClientId: client.id,
        intakeAgentId: agentId,
        assignedAgentId: agentId,
        createdById: agentId,
      },
    });
    propertyIds.push(p.id);
    await prisma.deal.create({ data: { clientId: client.id, propertyId: p.id, agentId, stage: "NEGOTIATION" } });

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ status: "AVAILABLE" });
    expect(res.status).toBe(409);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("RESERVED");
  });
});
