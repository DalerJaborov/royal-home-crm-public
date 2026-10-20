import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Сортировка списка объектов по цене — в одной валюте.
 *
 * Цены лежат каждая в своей валюте, а сравнение шло с голой колонкой price:
 * квартира за $40 000 (≈440 000 сомони при курсе 11) вставала перед квартирой за
 * 100 000 сомони, потому что 40 000 меньше 100 000. Агент, листающий «сначала
 * дешёвые», видел вперемешку два несопоставимых масштаба цен.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+99298${String(runId).slice(-7)}`;
const title = `Тест сортировки ${runId}`;

let token: string;
let agentId: string;
let districtId: string;
const propertyIds: string[] = [];

/** Порядок по возрастанию в сомони: 100 000 TJS < $40 000 (440 000) < 900 000 TJS. */
const FIXTURES = [
  { label: "средний-в-долларах", price: 40_000, currency: "USD" as const },
  { label: "дешёвый-в-сомони", price: 100_000, currency: "TJS" as const },
  { label: "дорогой-в-сомони", price: 900_000, currency: "TJS" as const },
];

/** Курс до правки — возвращается в afterAll: Settings один на всю базу. */
let savedUsdToTjsRate = 0;

beforeAll(async () => {
  const before = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { usdToTjsRate: true },
  });
  savedUsdToTjsRate = before.usdToTjsRate;
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: 11 } });

  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент сортировки ${runId}`,
      phone,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  agentId = agent.id;

  const district = await prisma.district.create({ data: { name: `Район сортировки ${runId}` } });
  districtId = district.id;

  for (const f of FIXTURES) {
    const p = await prisma.property.create({
      data: {
        title: `${title} ${f.label}`,
        type: "APARTMENT",
        status: "AVAILABLE",
        price: f.price,
        currency: f.currency,
        areaSqm: 50,
        rooms: 2,
        districtId,
        address: "тестовый адрес",
        condition: "GOOD",
        createdById: agentId,
      },
    });
    propertyIds.push(p.id);
  }

  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  // Курс — общая настройка: оставленный «11» менял бы суммы в соседних файлах
  // (зарплаты, финансы, отчёты) и падал бы там, где никто ничего не трогал.
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: savedUsdToTjsRate } });
});

/** Только наши объекты: база общая с остальными тестами и с сидами. */
async function pricesInOrder(sort: string) {
  const res = await request(app)
    .get(`/api/v1/properties?sort=${sort}&q=${encodeURIComponent(title)}`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.items.map((p: { price: string; currency: string }) => `${Number(p.price)} ${p.currency}`);
}

describe("Сортировка по цене приводит валюты к одной", () => {
  it("по возрастанию долларовый объект встаёт между двумя сомониевыми, а не первым", async () => {
    expect(await pricesInOrder("price_asc")).toEqual(["100000 TJS", "40000 USD", "900000 TJS"]);
  });

  it("по убыванию — тот же порядок наоборот", async () => {
    expect(await pricesInOrder("price_desc")).toEqual(["900000 TJS", "40000 USD", "100000 TJS"]);
  });
});
