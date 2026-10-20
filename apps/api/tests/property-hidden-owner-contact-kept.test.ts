import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * СКРЫТЫЙ НОМЕР СОБСТВЕННИКА НЕ СТИРАЕТСЯ ПРАВКОЙ ОБЪЕКТА (аудит 23.09.2026, №31).
 *
 * Кому номер не показан (монтажёр: правит чужой объект, но без права видеть
 * собственника), тот получает `ownerContact: null`, форма кладёт его пустой
 * строкой и при сохранении шлёт `null` — правка этажа молча стирала номер
 * собственника из базы.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const OWNER_PHONE = "+992900000077 Собственник";
const agentIds: string[] = [];
let districtId = "";
let propertyId = "";
let editorToken = "";
let managerToken = "";

async function agent(role: "AGENT" | "EDITOR" | "MANAGER", tail: string) {
  const a = await prisma.agent.create({
    data: { fullName: `Номер собственника ${role} ${runId}`, phone: `+99297${tail}${String(runId).slice(-5)}`, role, passwordHash: "x" },
  });
  agentIds.push(a.id);
  return a;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район скрытого номера ${runId}` } })).id;
  const owner = await agent("AGENT", "61");
  editorToken = signAccessToken({ sub: (await agent("EDITOR", "62")).id, role: "EDITOR" });
  managerToken = signAccessToken({ sub: (await agent("MANAGER", "63")).id, role: "MANAGER" });
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект скрытого номера ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая скрытого номера, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: owner.id,
        createdById: owner.id,
        assignedAgentId: owner.id,
        ownerContact: OWNER_PHONE,
      } as never,
    })
  ).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("Правка объекта тем, кому номер собственника скрыт", () => {
  it("форма прислала пустой номер — номер собственника в базе остался", async () => {
    const view = await request(app).get(`/api/v1/properties/${propertyId}`).set("Authorization", `Bearer ${editorToken}`);
    if (view.status === 200) expect(view.body.ownerContactHidden).toBe(true);

    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ floor: 4, ownerContact: null });
    expect(res.status).toBeLessThan(300);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(after.floor).toBe(4);
    expect(after.ownerContact).toBe(OWNER_PHONE);
  });

  it("кому номер виден, тот по-прежнему может его стереть", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ ownerContact: null });
    expect(res.status).toBeLessThan(300);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(after.ownerContact).toBeNull();
  });
});
