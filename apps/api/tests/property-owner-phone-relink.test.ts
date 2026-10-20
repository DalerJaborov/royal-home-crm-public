import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * СМЕНИЛИ ТЕЛЕФОН СОБСТВЕННИКА — КАРТОЧКА ПРОДАВЦА СЛЕДУЕТ ЗА НИМ (24.09.2026,
 * вариант «Исправить номер», lib/propertyOwnerRelink.ts).
 *
 * Раньше PATCH объекта менял только ownerContact, а sellerClientId оставался
 * прежним: имя в «Кто ведёт объект» принадлежало одному человеку, номер — другому.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail5 = String(runId).slice(-5);
// Номера этого файла — префикс +99233, больше нигде в тестах не встречается.
const num = (two: string) => `+99233${tail5}${two}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
let districtId = "";
let propertyId = "";
let sellerId = "";
let agentToken = "";
let agentId = "";
let otherAgentId = "";
let directorToken = "";

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район смены номера ${runId}` } })).id;
  const mk = async (role: "AGENT" | "DIRECTOR", two: string) => {
    const a = await prisma.agent.create({
      data: { fullName: `Смена номера ${role} ${two} ${runId}`, phone: `+99244${tail5}${two}`, role, passwordHash: "x" },
    });
    agentIds.push(a.id);
    return a;
  };
  const agent = await mk("AGENT", "01");
  const other = await mk("AGENT", "02");
  const director = await mk("DIRECTOR", "03");
  agentId = agent.id;
  otherAgentId = other.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
});

async function client(fullName: string, phone: string, assignedAgentId: string) {
  const c = await prisma.client.create({
    data: { fullName: `${fullName} ${runId}`, phone, source: "WALK_IN", kind: "SELLER", status: "NEW", assignedAgentId },
  });
  clientIds.push(c.id);
  return c;
}

beforeEach(async () => {
  if (propertyId) await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  clientIds.length = 0;
  const seller = await client("Продавец с опечаткой", num("10"), agentId);
  sellerId = seller.id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект смены номера ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая смены номера, 1",
        condition: "GOOD",
        status: "EDITING",
        intakeAgentId: agentId,
        createdById: agentId,
        ownerContact: num("10"),
        sellerClientId: seller.id,
      } as never,
    })
  ).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

const patch = (token: string, ownerContact: string) =>
  request(app)
    .patch(`/api/v1/properties/${propertyId}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ ownerContact });

describe("смена телефона собственника в объекте", () => {
  it("номер ничей — исправляется у того же продавца, связь прежняя", async () => {
    const res = await patch(agentToken, num("11"));
    expect(res.status).toBe(200);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.sellerClientId).toBe(sellerId);
    const seller = await prisma.client.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.phone).toBe(num("11"));
    const note = await prisma.interaction.findFirst({ where: { clientId: sellerId, notes: { contains: "Номер исправлен" } } });
    expect(note).not.toBeNull();
  });

  it("номер записан у другой карточки — объект переходит к ней, старый продавец не тронут", async () => {
    const other = await client("Настоящий собственник", num("12"), agentId);
    const res = await patch(agentToken, num("12"));
    expect(res.status).toBe(200);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.sellerClientId).toBe(other.id);
    const old = await prisma.client.findUniqueOrThrow({ where: { id: sellerId } });
    expect(old.phone).toBe(num("10"));
  });

  it("номер у клиента другого агента — агенту отказ, объект не меняется", async () => {
    await client("Чужой клиент", num("13"), otherAgentId);
    const res = await patch(agentToken, num("13"));
    expect(res.status).toBe(403);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.sellerClientId).toBe(sellerId);
    expect(property.ownerContact).toBe(num("10"));
  });

  it("руководитель тот же номер привязывает", async () => {
    const foreign = await client("Чужой клиент", num("14"), otherAgentId);
    const res = await patch(directorToken, num("14"));
    expect(res.status).toBe(200);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.sellerClientId).toBe(foreign.id);
  });

  it("продавца ведёт другой агент — номер в его карточке агенту объекта не поменять", async () => {
    await prisma.client.update({ where: { id: sellerId }, data: { assignedAgentId: otherAgentId } });
    const res = await patch(agentToken, num("15"));
    expect(res.status).toBe(403);
    const seller = await prisma.client.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.phone).toBe(num("10"));
  });

  it("номер в той же записи, но другой формой — ничего не трогается", async () => {
    const res = await patch(agentToken, num("10").replace("+992", "992 "));
    expect(res.status).toBe(200);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.sellerClientId).toBe(sellerId);
    const seller = await prisma.client.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.phone).toBe(num("10"));
  });
});

describe("обратный путь: номер исправили в карточке продавца", () => {
  it("объект с тем же старым номером получает новый, объект с другим номером не трогается", async () => {
    const second = await prisma.property.create({
      data: {
        title: `Второй объект смены номера ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 30000,
        currency: "TJS",
        districtId,
        address: "Тестовая смены номера, 2",
        condition: "GOOD",
        status: "EDITING",
        intakeAgentId: agentId,
        createdById: agentId,
        ownerContact: num("20"),
        sellerClientId: sellerId,
      } as never,
    });
    try {
      const res = await request(app)
        .patch(`/api/v1/clients/${sellerId}`)
        .set("Authorization", `Bearer ${directorToken}`)
        .send({ phone: num("21") });
      expect(res.status).toBe(200);
      const main = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
      expect(main.ownerContact).toBe(num("21"));
      const other = await prisma.property.findUniqueOrThrow({ where: { id: second.id } });
      expect(other.ownerContact).toBe(num("20"));
    } finally {
      await prisma.property.deleteMany({ where: { id: second.id } });
    }
  });
});
