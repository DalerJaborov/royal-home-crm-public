import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");

/**
 * ВОЗВРАТ ОТМЕНЁННОЙ СДЕЛКИ В РАБОТУ РЕЗЕРВИРУЕТ ОБЪЕКТ (аудит Codex 04.10.2026, №8).
 *
 * Revive шёл в транзакции READ COMMITTED и Property не трогал: проверка «живой
 * сделки» не видела незакоммиченную сделку параллельного POST, обе коммитились
 * (уникального индекса «одна живая сделка на объект» нет) и по объекту
 * оказывалось две живые сделки. Без гонки оживлённая сделка оставляла объект
 * AVAILABLE, и таймер резерва её не видел. Теперь revive делает тот же атомарный
 * property.updateMany, что POST: он же берёт блокировку строки объекта.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let directorId: string;
let token: string;
let directorToken: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент revive ${runId}-${clientIds.length}`,
      phone: `+992989${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Объект revive ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, revive",
      condition: "GOOD",
    },
  });
  propertyIds.push(p.id);
  return p;
}

/** Сделка создана и отменена: объект вернулся в AVAILABLE, как после истёкшего резерва. */
async function makeCancelledDeal() {
  const [client, property] = await Promise.all([makeClient(), makeProperty()]);
  const created = await request(app)
    .post("/api/v1/deals")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientId: client.id, propertyId: property.id, agentId });
  expect(created.status).toBe(201);
  dealIds.push(created.body.id);
  const cancelled = await request(app)
    .patch(`/api/v1/deals/${created.body.id}`)
    .set("Authorization", `Bearer ${directorToken}`)
    .send({ stage: "CANCELLED" });
  expect(cancelled.status).toBe(200);
  const freed = await prisma.property.findUnique({ where: { id: property.id } });
  expect(freed?.status).toBe("AVAILABLE");
  return { client, property, dealId: created.body.id as string };
}

const liveDeals = (propertyId: string) =>
  prisma.deal.count({ where: { propertyId, stage: { notIn: ["COMPLETED", "CANCELLED"] } } });

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-revive-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент revive", phone: `+992991${runId}`, role: "AGENT", passwordHash } })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992991${runId}`, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;

  directorId = (
    await prisma.agent.create({ data: { fullName: "Директор revive", phone: `+992992${runId}`, role: "DIRECTOR", passwordHash } })
  ).id;
  const directorRes = await request(app).post("/api/v1/auth/login").send({ phone: `+992992${runId}`, password });
  expect(directorRes.status).toBe(200);
  grantElevation(directorId);
  directorToken = directorRes.body.accessToken as string;
});

afterEach(() => {
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

describe("Возврат отменённой сделки в работу", () => {
  it("объект снова в резерве: статус, риелтор, клиент и reservedAt как у POST", async () => {
    const { property, client, dealId } = await makeCancelledDeal();
    const before = Date.now();
    const revived = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "NEGOTIATION" });
    expect(revived.status).toBe(200);

    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("RESERVED");
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.reservedForClientId).toBe(client.id);
    expect(after!.reservedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("гонка: POST резервирует объект между проверкой живой сделки и записью revive, выживает одна живая сделка", async () => {
    const { property, dealId } = await makeCancelledDeal();
    const otherClient = await makeClient();

    // Хук: сразу после deal.findFirst («живой сделки нет») внутри транзакции revive
    // запускаем параллельный POST по тому же объекту. Без блокировки объекта POST
    // успевает закоммититься, пока revive ещё не записал; с блокировкой строки
    // объекта (её берёт property.updateMany revive до findFirst) POST ждёт её.
    let postPromise: Promise<request.Response> | null = null;
    let armed = true;
    const realTransaction = prisma.$transaction.bind(prisma) as unknown as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, opts: unknown) => {
      if (typeof fn !== "function") return realTransaction(fn, opts);
      return realTransaction(async (tx: any) => {
        const wrapped = new Proxy(tx, {
          get(target, prop) {
            if (prop !== "deal") return target[prop];
            return new Proxy(target.deal, {
              get(dealTarget, dealProp) {
                if (dealProp !== "findFirst") return dealTarget[dealProp];
                return async (...args: unknown[]) => {
                  const result = await dealTarget.findFirst(...args);
                  if (armed) {
                    armed = false;
                    postPromise = request(app)
                      .post("/api/v1/deals")
                      .set("Authorization", `Bearer ${token}`)
                      .send({ clientId: otherClient.id, propertyId: property.id, agentId })
                      .then((r) => r);
                    // Ждём POST недолго: без блокировки он завершится сразу, с блокировкой повиснет.
                    await Promise.race([postPromise.then(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
                  }
                  return result;
                };
              },
            });
          },
        });
        return (fn as (t: unknown) => Promise<unknown>)(wrapped);
      }, opts);
    }) as never);

    const revived = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "NEGOTIATION" });
    const posted = await postPromise!;
    if (posted.status === 201) dealIds.push(posted.body.id);

    expect(await liveDeals(property.id)).toBe(1);
    // Ровно один из двух выиграл, проигравший получил 409.
    expect([revived.status, posted.status].sort()).toEqual([200, 409]);
  });
});
