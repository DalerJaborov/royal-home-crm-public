import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import crypto from "node:crypto";

/**
 * ПУБЛИЧНАЯ ССЫЛКА ГОВОРИТ ПРАВДУ (аудит 23.09.2026, №61).
 *
 * Ссылка на объект живёт неделями. Клиенту показывали номер агента, который
 * уже уволен, и «В продаже» у снятого с продажи или забронированного объекта.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const agentIds: string[] = [];
const propertyIds: string[] = [];
let districtId = "";
let firedId = "";
let activeId = "";

async function linkFor(status: string, createdById: string, assignedId: string | null) {
  const p = await prisma.property.create({
    data: {
      title: `Объект честной ссылки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Честная, 1",
      condition: "GOOD",
      status: status as never,
      assignedAgentId: assignedId,
      createdById,
    },
  });
  propertyIds.push(p.id);
  const token = crypto.randomBytes(24).toString("base64url");
  await prisma.propertyShareLink.create({ data: { token, propertyId: p.id, createdByAgentId: createdById } });
  return token;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район честной ссылки ${runId}` } })).id;
  firedId = (
    await prisma.agent.create({
      data: { fullName: `Уволенный ${runId}`, phone: `+99291${tail}`, role: "AGENT", passwordHash: "x", isActive: false },
    })
  ).id;
  activeId = (
    await prisma.agent.create({
      data: { fullName: `В строю ${runId}`, phone: `+99292${tail}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  agentIds.push(firedId, activeId);
});

afterAll(async () => {
  await prisma.propertyShareLink.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Кому звонить по ссылке", () => {
  it("автор ссылки уволен — показываем ответственного за объект", async () => {
    const token = await linkFor("AVAILABLE", firedId, activeId);
    const res = await request(app).get(`/api/v1/l/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.agent.phone).toBe(`+99292${tail}`);
  });

  it("в строю никого — номера нет вовсе", async () => {
    const token = await linkFor("AVAILABLE", firedId, null);
    const res = await request(app).get(`/api/v1/l/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.agent).toBeNull();
  });
});

describe("Статус продажи по ссылке", () => {
  it.each([
    ["AVAILABLE", "AVAILABLE"],
    ["RESERVED", "RESERVED"],
    ["SOLD", "SOLD"],
    ["WITHDRAWN", "UNAVAILABLE"],
    // D16 (владелец 02.10.2026): объект ещё готовится — «Скоро в продаже»,
    // а не «В продаже».
    ["PENDING_REVIEW", "SOON"],
    ["AWAITING_PHOTOS", "SOON"],
    ["AWAITING_VIDEO", "SOON"],
    ["EDITING", "SOON"],
  ])("%s → %s", async (status, expected) => {
    const token = await linkFor(status, activeId, activeId);
    const res = await request(app).get(`/api/v1/l/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.property.saleStatus).toBe(expected);
  });
});
