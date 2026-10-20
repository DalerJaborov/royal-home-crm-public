import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomInt } from "node:crypto";

/**
 * Решение владельца 02.10.2026 «да, по советам» (лиды, п. 5): склейка двух
 * карточек одного человека не выполняется, если у карточки-дубля идёт сделка
 * (не завершена и не отменена) у ДРУГОГО агента, чем владелец основной. Ответ —
 * словами, с именем агента сделки. Раньше сделка молча переезжала на чужую
 * карточку: её агент терял доступ к собственной сделке.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { mergeClients, ClientMergeOpenDealError } = await import("../src/lib/clientMerge.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const password = "testpass123";
const tail = () => String(randomInt(1_000_000, 9_999_999));
let districtId = "";
let propertyId = "";
let directorId = "";
let directorPhone = "";
let agentAId = "";
let agentBId = "";
let token = "";
const clientIds: string[] = [];
const dealIds: string[] = [];

async function pair(dealStage: "NEGOTIATION" | "CANCELLED" | "COMPLETED" | null, dealAgent: "A" | "B" = "B") {
  const t = tail();
  const primary = await prisma.client.create({
    data: { fullName: "Основная склейка", phone: `+99293${t}`, kind: "BUYER", source: "WALK_IN", assignedAgentId: agentAId, acceptedAt: new Date() },
  });
  const duplicate = await prisma.client.create({
    data: { fullName: "Дубль склейка", phone: `+99294${t}`, kind: "BUYER", source: "WALK_IN", assignedAgentId: agentBId, acceptedAt: new Date() },
  });
  clientIds.push(primary.id, duplicate.id);
  if (dealStage) {
    const d = await prisma.deal.create({
      data: { clientId: duplicate.id, propertyId, agentId: dealAgent === "A" ? agentAId : agentBId, stage: dealStage },
    });
    dealIds.push(d.id);
  }
  return { primary, duplicate };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  const mk = async (fullName: string, role: "AGENT" | "DIRECTOR") => {
    const p = `+99295${tail()}`;
    const a = await prisma.agent.create({ data: { fullName, phone: p, role, passwordHash } });
    return { id: a.id, phone: p };
  };
  const d = await mk("Директор склейки", "DIRECTOR");
  directorId = d.id;
  directorPhone = d.phone;
  agentAId = (await mk("Агент Ноза", "AGENT")).id;
  agentBId = (await mk("Агент Фаррух", "AGENT")).id;
  districtId = (await prisma.district.create({ data: { name: `Район склейки ${tail()}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: "Объект склейки",
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        assignedAgentId: agentBId,
        ownerContact: `+99296${tail()}`,
      },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: directorPhone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([directorId, agentAId, agentBId]);
  await prisma.$disconnect();
});

describe("склейка при открытой сделке у другого агента", () => {
  it("у дубля идёт сделка у Фарруха, основная у Нозы — не склеиваем, говорим словами, ничего не меняется", async () => {
    const { primary, duplicate } = await pair("NEGOTIATION");
    await expect(mergeClients(primary.id, duplicate.id, directorId, "тест")).rejects.toBeInstanceOf(ClientMergeOpenDealError);
    await expect(mergeClients(primary.id, duplicate.id, directorId, "тест")).rejects.toThrow(
      "У второй карточки идёт сделка у агента Агент Фаррух — склеить можно, когда сделка закроется"
    );
    const dup = await prisma.client.findUniqueOrThrow({ where: { id: duplicate.id }, select: { deletedAt: true } });
    expect(dup.deletedAt).toBeNull();
    const deal = await prisma.deal.findFirstOrThrow({ where: { id: dealIds.at(-1)! }, select: { clientId: true } });
    expect(deal.clientId).toBe(duplicate.id);
  });

  it("кнопка «Объединить» отвечает той же причиной (409)", async () => {
    const { primary, duplicate } = await pair("NEGOTIATION");
    const res = await request(app)
      .post("/api/v1/clients/merge")
      .set("Authorization", `Bearer ${token}`)
      .send({ primaryId: primary.id, duplicateId: duplicate.id, force: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("идёт сделка у агента Агент Фаррух");
  });

  it("сделка отменена — склейка проходит", async () => {
    const { primary, duplicate } = await pair("CANCELLED");
    const merged = await mergeClients(primary.id, duplicate.id, directorId, "тест");
    expect(merged.id).toBe(primary.id);
  });

  it("сделка завершена — склейка проходит", async () => {
    const { primary, duplicate } = await pair("COMPLETED");
    const merged = await mergeClients(primary.id, duplicate.id, directorId, "тест");
    expect(merged.id).toBe(primary.id);
  });

  it("открытая сделка у того же агента, что ведёт основную, — склейка проходит", async () => {
    const { primary, duplicate } = await pair("NEGOTIATION", "A");
    const merged = await mergeClients(primary.id, duplicate.id, directorId, "тест");
    expect(merged.id).toBe(primary.id);
  });
});
