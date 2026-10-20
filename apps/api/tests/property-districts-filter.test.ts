import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/** Фильтр объектов по нескольким районам сразу (districtIds=a,b). */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let token: string;
const districtIds: string[] = [];
const propertyIds: string[] = [];

async function list(query: string) {
  const res = await request(app)
    .get(`/api/v1/properties?${query}`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return (res.body.items as Array<{ title: string }>).map((p) => p.title);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  // Имя района уникально по файлу — см. комментарий в send-properties.test.ts.
  for (const n of ["А", "Б", "В"]) {
    districtIds.push((await prisma.district.create({ data: { name: `Тест-район-мульти-${n}-${runId}` } })).id);
  }
  const agent = await prisma.agent.create({
    data: { fullName: "Агент районов", phone: `+992980${runId}`, role: "ADMIN", passwordHash },
  });
  agentId = agent.id;

  for (const [i, districtId] of districtIds.entries()) {
    const p = await prisma.property.create({
      data: {
        title: `Мульти-${runId}-${i}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        assignedAgentId: agentId,
      },
    });
    propertyIds.push(p.id);
  }

  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: { in: districtIds } } });
  await prisma.$disconnect();
});

describe("Объекты — несколько районов в фильтре", () => {
  it("districtIds=a,b отдаёт объекты обоих районов и не отдаёт третий", async () => {
    const titles = await list(`districtIds=${districtIds[0]},${districtIds[1]}`);
    expect(titles).toContain(`Мульти-${runId}-0`);
    expect(titles).toContain(`Мульти-${runId}-1`);
    expect(titles).not.toContain(`Мульти-${runId}-2`);
  });

  it("одиночный districtId работает как раньше", async () => {
    const titles = await list(`districtId=${districtIds[2]}`);
    expect(titles).toContain(`Мульти-${runId}-2`);
    expect(titles).not.toContain(`Мульти-${runId}-0`);
  });

  it("districtId и districtIds вместе — объединение, а не пересечение", async () => {
    const titles = await list(`districtId=${districtIds[2]}&districtIds=${districtIds[0]}`);
    expect(titles).toContain(`Мульти-${runId}-0`);
    expect(titles).toContain(`Мульти-${runId}-2`);
  });

  it("мусор вместо id отклоняется с 400", async () => {
    const res = await request(app)
      .get(`/api/v1/properties?districtIds=not-a-uuid`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
