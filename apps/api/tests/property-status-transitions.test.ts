import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Сервер сам решает, какие смены статуса объекта допустимы (находки №182, №180).
 *
 * Раньше переходы ограничивал только выпадающий список на экране: прямой PATCH
 * принимал «Резерв»/«Продано» без сделки (комиссия не считается, отчёт по продажам
 * расходится с карточками), а у объекта в продаже агент мог выбрать любой этап
 * подготовки — минуя маркетинг. Объект, возвращённый из продажи в подготовку,
 * при этом оставался на сайте.
 */

const syncPropertiesToSite = vi.fn(async () => ({ ok: true as const, results: [{ ok: true as const, shortId: 1 }] }));
vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  syncPropertiesToSite,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let agentToken: string;
let marketingToken: string;
let clientId: string;
const propertyIds: string[] = [];
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty(status: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Переходы ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: `Тестовая переходов, ${propertyIds.length + 1}`,
      condition: "GOOD",
      status,
      intakeAgentId: agentId,
      createdById: agentId,
      ...extra,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

const patch = (id: string, token: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/v1/properties/${id}`).set("Authorization", `Bearer ${token}`).send(body);

const statusOf = async (id: string) => (await prisma.property.findUniqueOrThrow({ where: { id } })).status;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-переходы-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент переходов", phone: `+992981${runId}`, role: "AGENT", passwordHash } })).id;
  const marketingId = (await prisma.agent.create({ data: { fullName: "Маркетинг переходов", phone: `+992982${runId}`, role: "MARKETING", passwordHash } })).id;
  agentIds.push(agentId, marketingId);
  agentToken = await login(`+992981${runId}`);
  marketingToken = await login(`+992982${runId}`);
  clientId = (await prisma.client.create({ data: { fullName: "Клиент переходов", phone: `+99293${String(runId).slice(-7)}`, source: "PHONE_CALL" } as never })).id;
});

beforeEach(() => syncPropertiesToSite.mockClear());

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("«Резерв» и «Продано» ставит сделка, а не PATCH", () => {
  it("RESERVED без сделки → 409", async () => {
    const p = await makeProperty("AVAILABLE");
    const res = await patch(p.id, agentToken, { status: "RESERVED" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/сделк/i);
    expect(await statusOf(p.id)).toBe("AVAILABLE");
  });

  it("SOLD без сделки → 409", async () => {
    const p = await makeProperty("AVAILABLE");
    const res = await patch(p.id, marketingToken, { status: "SOLD" });
    expect(res.status).toBe(409);
    expect(await statusOf(p.id)).toBe("AVAILABLE");
  });

  it("объект ещё в подготовке — в резерв и в продажу его не поставить даже при сделке", async () => {
    const p = await makeProperty("PENDING_REVIEW");
    await prisma.deal.create({ data: { clientId, propertyId: p.id, agentId, stage: "NEGOTIATION" } });
    const res = await patch(p.id, marketingToken, { status: "RESERVED" });
    expect(res.status).toBe(409);
    expect(await statusOf(p.id)).toBe("PENDING_REVIEW");
  });
});

describe("Объект в продаже не возвращается в подготовку мимо маркетинга", () => {
  it("АГЕНТ: AVAILABLE → «Ждём видео» → 403", async () => {
    const p = await makeProperty("AVAILABLE");
    const res = await patch(p.id, agentToken, { status: "AWAITING_VIDEO" });
    expect(res.status).toBe(403);
    expect(await statusOf(p.id)).toBe("AVAILABLE");
  });

  it("зарезервированный или проданный объект в подготовку не уходит ни у кого", async () => {
    for (const status of ["RESERVED", "SOLD"]) {
      const p = await makeProperty(status);
      const res = await patch(p.id, marketingToken, { status: "AWAITING_PHOTOS" });
      expect(res.status).toBe(409);
      expect(await statusOf(p.id)).toBe(status);
    }
  });

  it("МАРКЕТИНГ: AVAILABLE → этап подготовки проходит и объявление снимается с сайта (№180)", async () => {
    const p = await makeProperty("AVAILABLE", { publishedOnSite: true });
    const res = await patch(p.id, marketingToken, { status: "AWAITING_VIDEO" });
    expect(res.status).toBe(200);
    expect(syncPropertiesToSite).toHaveBeenCalledWith(expect.anything(), "unpublish");
    for (let i = 0; i < 30; i++) {
      const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
      if (!row.publishedOnSite) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).publishedOnSite).toBe(false);
  });
});

describe("Разрешённые переходы работают как раньше", () => {
  it("AVAILABLE → WITHDRAWN (агент)", async () => {
    const p = await makeProperty("AVAILABLE");
    const res = await patch(p.id, agentToken, { status: "WITHDRAWN" });
    expect(res.status).toBe(200);
  });

  it("RESERVED при живой сделке — возврат статуса разрешён", async () => {
    const p = await makeProperty("AVAILABLE");
    await prisma.deal.create({ data: { clientId, propertyId: p.id, agentId, stage: "NEGOTIATION" } });
    const res = await patch(p.id, marketingToken, { status: "RESERVED" });
    expect(res.status).toBe(200);
  });
});
