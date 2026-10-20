import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

/**
 * АННУЛИРОВАНИЕ ЗАКРЫТОЙ СДЕЛКИ (глубокая проверка 02.10.2026, C10; решение
 * владельца «да, по советам»).
 *
 * Раньше «аннулированная» (доли 0/0) сделка оставалась закрытой: доска почёта,
 * отчёты, главная считали её продажей, объект навсегда «Продано». Теперь кнопка
 * «Аннулировать» с причиной: сделка уходит из всех счётчиков продаж, объект —
 * обратно в продажу, баллы за сделку снимаются, вернуть её в работу нельзя.
 */

const runId = Date.now();

let managerId: string;
let securityId: string;
let agentId: string;
let managerToken: string;
let securityToken: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

/** Закрытая сделка, как её оставляет одобрение: объект продан, клиент «Сделка закрыта», +баллы. */
async function makeClosedDeal() {
  const n = dealIds.length;
  const property = await prisma.property.create({
    data: {
      title: `Объект аннулирования ${runId}-${n}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, аннулирование",
      condition: "GOOD",
      status: "SOLD",
      soldAt: new Date(),
      soldPrice: 98000,
      assignedAgentId: agentId,
    },
  });
  propertyIds.push(property.id);
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент аннулирования ${runId}-${n}`,
      phone: `+99293${n}${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "DEAL_CLOSED",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  const deal = await prisma.deal.create({
    data: {
      clientId: client.id,
      propertyId: property.id,
      agentId,
      stage: "COMPLETED",
      soldPrice: 98000,
      commissionAmount: 2940,
      commissionRealtorAmount: 1470,
      commissionCompanyAmount: 1470,
      closedAt: new Date(),
    },
  });
  dealIds.push(deal.id);
  await prisma.royalScoreEvent.create({
    data: { agentId, kind: "deal_closed", delta: 10, reason: "Сделка закрыта", sourceId: deal.id },
  });
  return { deal, property, client };
}

/** Агент на доске почёта в номинации «Лучший продажник» (считает закрытые сделки месяца). */
async function onSalesBoard(): Promise<boolean> {
  const res = await request(app).get("/api/v1/hall-of-fame").set("Authorization", `Bearer ${managerToken}`);
  expect(res.status).toBe(200);
  const sales = (res.body.nominations as { key: string; nominees: { id: string }[] }[]).find((n) => n.key === "sales");
  return !!sales?.nominees.some((x) => x.id === agentId);
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-аннулирование-${runId}` } })).id;
  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер аннулирует ${runId}`, phone: `+99292${runId}1`, role: "MANAGER", passwordHash: "x" },
  });
  const security = await prisma.agent.create({
    data: { fullName: `Безопасность аннулирование ${runId}`, phone: `+99292${runId}2`, role: "SECURITY", passwordHash: "x" },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент аннулирование ${runId}`, phone: `+99292${runId}3`, role: "AGENT", passwordHash: "x" },
  });
  managerId = manager.id;
  securityId = security.id;
  agentId = agent.id;
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
  securityToken = signAccessToken({ sub: security.id, role: "SECURITY" });
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces([managerId, securityId, agentId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("«Аннулировать» закрытую сделку (C10)", () => {
  it("без права закрывать сделки — 403, без причины — 400", async () => {
    const { deal } = await makeClosedDeal();
    const denied = await request(app)
      .post(`/api/v1/deals/${deal.id}/annul`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ reason: "Мошенничество" });
    expect(denied.status).toBe(403);
    const noReason = await request(app)
      .post(`/api/v1/deals/${deal.id}/annul`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ reason: " " });
    expect(noReason.status).toBe(400);
    const still = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(still?.stage).toBe("COMPLETED");
    expect(still?.annulledAt).toBeNull();
    // Убираем из продаж, чтобы следующий тест видел на доске только свою сделку.
    await prisma.deal.update({ where: { id: deal.id }, data: { stage: "CANCELLED" } });
  });

  it("сделка уходит из продаж, объект — в продажу, баллы сняты, история сохранена", async () => {
    const { deal, property, client } = await makeClosedDeal();
    expect(await onSalesBoard()).toBe(true);

    const res = await request(app)
      .post(`/api/v1/deals/${deal.id}/annul`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ reason: "Покупатель оказался подставным" });
    expect(res.status).toBe(200);
    expect(res.body.propertyReturnedToSale).toBe(true);

    const after = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(after?.stage).toBe("CANCELLED");
    expect(after?.annulledAt).not.toBeNull();
    expect(after?.annulledById).toBe(managerId);
    expect(after?.annulReason).toBe("Покупатель оказался подставным");
    // История не стирается: когда закрыли и на какие суммы.
    expect(after?.closedAt).not.toBeNull();
    expect(Number(after?.commissionAmount)).toBe(2940);

    // Доска почёта — один из счётчиков продаж — сделку больше не считает.
    expect(await onSalesBoard()).toBe(false);

    const prop = await prisma.property.findUnique({ where: { id: property.id } });
    expect(prop?.status).toBe("AVAILABLE");
    expect(prop?.soldAt).toBeNull();
    expect(prop?.assignedAgentId).toBeNull();
    const buyer = await prisma.client.findUnique({ where: { id: client.id } });
    expect(buyer?.status).toBe("HOT");

    const reversed = await prisma.royalScoreEvent.findFirst({
      where: { agentId, kind: "deal_closed_reversed", sourceId: deal.id },
    });
    expect(reversed).not.toBeNull();

    // В списке сделок — отметка для метки «аннулирована».
    const list = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${managerToken}`);
    const row = (list.body as { id: string; annulledAt?: string | null; annulReason?: string | null }[]).find(
      (d) => d.id === deal.id
    );
    expect(row?.annulledAt).toBeTruthy();
    expect(row?.annulReason).toBe("Покупатель оказался подставным");
  });

  it("повторно аннулировать и вернуть в работу нельзя — 409", async () => {
    const { deal } = await makeClosedDeal();
    const first = await request(app)
      .post(`/api/v1/deals/${deal.id}/annul`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ reason: "Ошибка оформления" });
    expect(first.status).toBe(200);
    const again = await request(app)
      .post(`/api/v1/deals/${deal.id}/annul`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ reason: "Ошибка оформления" });
    expect(again.status).toBe(409);
    const revive = await request(app)
      .patch(`/api/v1/deals/${deal.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ stage: "NEGOTIATION" });
    expect(revive.status).toBe(409);
    // Баллы списаны один раз.
    expect(
      await prisma.royalScoreEvent.count({ where: { agentId, kind: "deal_closed_reversed", sourceId: deal.id } })
    ).toBe(1);
  });

  it("незакрытую сделку не аннулируют — её отменяют", async () => {
    const { deal } = await makeClosedDeal();
    await prisma.deal.update({ where: { id: deal.id }, data: { stage: "NEGOTIATION", closedAt: null } });
    const res = await request(app)
      .post(`/api/v1/deals/${deal.id}/annul`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ reason: "Пробуем" });
    expect(res.status).toBe(409);
  });
});
