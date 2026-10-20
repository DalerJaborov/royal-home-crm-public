import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const { siteHook } = vi.hoisted(() => ({
  /** Что выполнить «пока объект снимается с сайта» (сетевой вызов внутри trashProperties). */
  siteHook: { run: null as null | (() => Promise<void>) },
}));
vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  syncPropertiesToSite: async () => {
    if (siteHook.run) await siteHook.run();
    return { ok: true, results: [] };
  },
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { trashProperties } = await import("../src/lib/trashProperty.js");

/**
 * ОБЪЕКТ СО СДЕЛКОЙ НЕ УХОДИТ В КОРЗИНУ, ДАЖЕ ЕСЛИ СДЕЛКУ ЗАВЕЛИ В ОКНЕ СНЯТИЯ С САЙТА
 * (аудит Codex 04.10.2026, №13).
 *
 * Корзина проверяла `_count.deals` до снятия с сайта (сетевой вызов), а записывала
 * deletedAt позже и без повторной проверки: POST /deals, прошедший в этом окне,
 * оставлял объект в Корзине с живой сделкой. Зеркально: POST, прочитавший объект
 * до удаления, резервировал его уже удалённым (в where резерва не было deletedAt).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let directorId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент корзина-гонка ${runId}-${clientIds.length}`,
      phone: `+992993${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(publishedOnSite: boolean) {
  const p = await prisma.property.create({
    data: {
      title: `Объект корзина-гонка ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, корзина-гонка",
      condition: "GOOD",
      publishedOnSite,
    },
  });
  propertyIds.push(p.id);
  return p;
}

const postDeal = (clientId: string, propertyId: string) =>
  request(app).post("/api/v1/deals").set("Authorization", `Bearer ${token}`).send({ clientId, propertyId, agentId });

const liveDeals = (propertyId: string) =>
  prisma.deal.count({ where: { propertyId, stage: { notIn: ["COMPLETED", "CANCELLED"] } } });

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-корзина-гонка-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент корзина-гонка", phone: `+992994${runId}`, role: "AGENT", passwordHash } })
  ).id;
  directorId = (
    await prisma.agent.create({ data: { fullName: "Директор корзина-гонка", phone: `+992995${runId}`, role: "DIRECTOR", passwordHash } })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992994${runId}`, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterEach(() => {
  siteHook.run = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Корзина против параллельного POST /deals", () => {
  it("сделку завели, пока объект снимался с сайта: в Корзину не уходит, ответ 409, сделка жива", async () => {
    const property = await makeProperty(true);
    const client = await makeClient();
    let posted: request.Response | null = null;
    siteHook.run = async () => {
      siteHook.run = null;
      posted = await postDeal(client.id, property.id);
      if (posted.status === 201) dealIds.push(posted.body.id);
    };

    const [result] = await trashProperties([property.id], directorId);

    expect(posted!.status).toBe(201);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.deletedAt).toBeNull();
    expect(await liveDeals(property.id)).toBe(1);
  });

  it("партия: объект без сделок уходит, объект с гонкой-сделкой остаётся", async () => {
    const [clean, raced] = [await makeProperty(true), await makeProperty(true)];
    const client = await makeClient();
    siteHook.run = async () => {
      siteHook.run = null;
      const posted = await postDeal(client.id, raced.id);
      if (posted.status === 201) dealIds.push(posted.body.id);
    };

    const results = await trashProperties([clean.id, raced.id], directorId);

    expect(results.map((r) => [r.id, r.ok, r.status])).toEqual([
      [clean.id, true, undefined],
      [raced.id, false, 409],
    ]);
    expect((await prisma.property.findUnique({ where: { id: clean.id } }))?.deletedAt).not.toBeNull();
    expect((await prisma.property.findUnique({ where: { id: raced.id } }))?.deletedAt).toBeNull();
  });

  it("объект без сделок по-прежнему уходит в Корзину", async () => {
    const property = await makeProperty(false);
    const [result] = await trashProperties([property.id], directorId);
    expect(result.ok).toBe(true);
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.deletedById).toBe(directorId);
  });

  it("POST по объекту в Корзине: 404 и сделки нет", async () => {
    const property = await makeProperty(false);
    await prisma.property.update({ where: { id: property.id }, data: { deletedAt: new Date() } });
    const client = await makeClient();
    const res = await postDeal(client.id, property.id);
    expect(res.status).toBe(404);
    expect(await prisma.deal.count({ where: { propertyId: property.id } })).toBe(0);
  });

  it("POST прочитал объект живым, а до резерва его удалили: 409, сделки нет, статус не RESERVED", async () => {
    const property = await makeProperty(false);
    const client = await makeClient();
    // Окно между чтением объекта в начале POST и транзакцией резерва.
    const realTransaction = prisma.$transaction.bind(prisma) as unknown as (...a: unknown[]) => Promise<unknown>;
    let armed = true;
    vi.spyOn(prisma, "$transaction").mockImplementation((async (fn: unknown, opts: unknown) => {
      if (armed && typeof fn === "function") {
        armed = false;
        await prisma.property.update({ where: { id: property.id }, data: { deletedAt: new Date() } });
      }
      return realTransaction(fn, opts);
    }) as never);

    const res = await postDeal(client.id, property.id);

    expect(res.status).toBe(409);
    expect(await prisma.deal.count({ where: { propertyId: property.id } })).toBe(0);
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("AVAILABLE");
    expect(after?.deletedAt).not.toBeNull();
  });
});
