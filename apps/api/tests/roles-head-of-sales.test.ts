import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { pickAgentForLead } from "../src/services/leads/selection.js";

/**
 * Роли «Руководитель продаж» (HEAD_OF_SALES) и «Акционер» (SHAREHOLDER),
 * серверная часть (спека ролей §2.3, §2.4):
 *  - автораспределение лидов его обходит (LEAD_RECEIVING_ROLES), вручную назначить можно;
 *  - одобряет сделки, но денег компании (расходы) не видит;
 *  - в рейтинг/доску почёта не попадает (RATED_ROLES);
 *  - акционер не заводит объекты.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let adminId: string;
let directorId: string;
let hosId: string;
let agentId: string;
let shareholderId: string;
let directorToken: string;
let hosToken: string;
let agentToken: string;
let shareholderToken: string;
let savedStrategy: string | undefined;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function mk(name: string, role: "ADMIN" | "DIRECTOR" | "AGENT" | "HEAD_OF_SALES" | "SHAREHOLDER", n: number) {
  const passwordHash = await bcrypt.hash(password, 10);
  const a = await prisma.agent.create({
    data: { fullName: `${name} ${runId}`, phone: `+99297${n}${String(runId).slice(-7)}`, role, passwordHash, lastSeenAt: new Date() },
  });
  const res = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password });
  expect(res.status).toBe(200);
  return { id: a.id, token: res.body.accessToken as string };
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-роли-${runId}` } })).id;
  adminId = (await mk("Админ роли", "ADMIN", 1)).id;
  ({ id: directorId, token: directorToken } = await mk("Директор роли", "DIRECTOR", 2));
  ({ id: hosId, token: hosToken } = await mk("РОП роли", "HEAD_OF_SALES", 3));
  ({ id: agentId, token: agentToken } = await mk("Агент роли", "AGENT", 4));
  ({ id: shareholderId, token: shareholderToken } = await mk("Акционер роли", "SHAREHOLDER", 5));
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  savedStrategy = s?.leadDistributionStrategy;
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "fair" } });
});

afterAll(async () => {
  if (savedStrategy) await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: savedStrategy } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, directorId, hosId, agentId, shareholderId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Руководитель продаж и лиды", () => {
  it("автораспределение не отдаёт лид HEAD_OF_SALES, даже если он активен и свободен; обычному агенту — отдаёт", async () => {
    const all = (await prisma.agent.findMany({ select: { id: true } })).map((a) => a.id);
    const exceptMine = (keep: string[]) => all.filter((id) => !keep.includes(id));
    // Из всех сотрудников остаётся только РОП — выдать некому.
    expect(await pickAgentForLead(exceptMine([hosId]), "BUYER")).toBeNull();
    // Остаётся РОП и агент — лид уходит агенту.
    expect(await pickAgentForLead(exceptMine([hosId, agentId]), "BUYER")).toBe(agentId);
  });

  it("вручную клиента на HEAD_OF_SALES назначить можно", async () => {
    const c = await prisma.client.create({
      data: { fullName: `Клиент роли ${runId}`, phone: `+992981${String(runId).slice(-8)}`, source: "PHONE_CALL" },
    });
    clientIds.push(c.id);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ agentId: hosId, accept: true });
    expect(res.status).toBe(200);
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(hosId);
  });
});

describe("Руководитель продаж: сделки, деньги, рейтинг", () => {
  it("одобряет сделку PENDING_APPROVAL → COMPLETED", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент сделки ${runId}`,
        phone: `+992982${String(runId).slice(-8)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(client.id);
    const property = await prisma.property.create({
      data: {
        title: `Объект роли ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, роли",
        condition: "GOOD",
        intakeAgentId: agentId,
      },
    });
    propertyIds.push(property.id);
    await prisma.interaction.create({
      data: { clientId: client.id, propertyId: property.id, agentId, type: "SHOWING", notes: "Показ", completedAt: new Date() },
    });
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);
    const submitted = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ stage: "PENDING_APPROVAL", soldPrice: 95000, commissionRealtorAmount: 500, commissionCompanyAmount: 1000 });
    expect(submitted.status).toBe(200);
    const approved = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${hosToken}`)
      .send({ stage: "COMPLETED" });
    expect(approved.status).toBe(200);
    expect(approved.body.stage).toBe("COMPLETED");
  });

  it("денег компании не видит: GET /expenses/summary -> 403", async () => {
    const res = await request(app).get("/api/v1/expenses/summary").set("Authorization", `Bearer ${hosToken}`);
    expect(res.status).toBe(403);
  });

  it("в доску почёта / рейтинг не попадает, обычный агент попадает", async () => {
    const res = await request(app).get("/api/v1/hall-of-fame/top-agents").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.agents as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(agentId);
    expect(ids).not.toContain(hosId);
  });

  it("акционер видит полный рейтинг, как директор", async () => {
    const res = await request(app).get("/api/v1/hall-of-fame/top-agents").set("Authorization", `Bearer ${shareholderToken}`);
    expect(res.status).toBe(200);
    expect((res.body.agents as Array<{ id: string }>).map((a) => a.id)).toContain(agentId);
  });
});

describe("Акционер", () => {
  it("объекты не заводит: POST /properties -> 403", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${shareholderToken}`)
      .send({ title: "Акционер не заводит", type: "APARTMENT", areaSqm: 40, price: 50000, currency: "TJS", districtId, address: "Тест", condition: "GOOD" });
    expect(res.status).toBe(403);
  });
});
