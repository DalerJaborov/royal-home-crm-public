import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Закрытый объект без адреса не дублируется при повторе запроса (находка №193).
 *
 * Защита от дубля по адресу работает только когда адрес есть; у закрытого объекта
 * («только для своих») его может не быть, и сетевой повтор или повтор из офлайн-
 * очереди без ключа Idempotency-Key создавал вторую такую же карточку.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+992938${String(runId).slice(-7)}`;
const owner = `+992939${String(runId).slice(-7)}`;
let agentId: string;
let token: string;
const created: string[] = [];

const body = (extra: Record<string, unknown> = {}) => ({
  type: "APARTMENT",
  areaSqm: 50,
  rooms: 2,
  floor: 3,
  totalFloors: 9,
  windowCount: 3,
  price: 300000,
  currency: "TJS",
  condition: "GOOD",
  ownerContact: owner,
  sellerName: "Сосед",
  offSite: true,
  ...extra,
});

const post = (extra: Record<string, unknown> = {}) =>
  request(app).post("/api/v1/properties").set("Authorization", `Bearer ${token}`).send(body(extra));

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "Агент дублей", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) } })).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { createdById: agentId } });
  await prisma.client.deleteMany({ where: { phone: { contains: owner.slice(-9) } } });
  await deleteAgentsWithTraces([agentId]);
});

describe("закрытый объект без адреса — повтор запроса не создаёт второй", () => {
  it("второй такой же запрос подряд → 409 и ссылка на первый", async () => {
    const first = await post();
    expect(first.status).toBe(201);
    created.push(first.body.id);
    const second = await post();
    expect(second.status).toBe(409);
    expect(second.body.existingPropertyId).toBe(first.body.id);
    expect(await prisma.property.count({ where: { createdById: agentId } })).toBe(1);
  });

  it("другая цена — это другой объект, а не повтор", async () => {
    const other = await post({ price: 350000 });
    expect(other.status).toBe(201);
  });
});
