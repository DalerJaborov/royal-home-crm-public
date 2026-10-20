import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/** Поиск объектов по адресу: агент набирает адрес так, как его произносят
 *  («Рудаки 45»), а в карточке он записан «пр. Рудаки, 45». Проверяется, что
 *  список находит объект по любому порядку и написанию слов адреса. */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let token: string;
const propertyIds: string[] = [];

async function search(q: string) {
  const res = await request(app)
    .get(`/api/v1/properties?q=${encodeURIComponent(q)}`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return (res.body.items as Array<{ address: string }>).map((p) => p.address);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  // Имя района уникально ПО ФАЙЛУ, не только по времени: файлы стартуют параллельно,
  // и два runId = Date.now() в одну миллисекунду роняли второй файл на unique(name).
  const district = await prisma.district.create({ data: { name: `Тест-район-поиск-${runId}` } });
  districtId = district.id;

  const agent = await prisma.agent.create({
    data: { fullName: "Тест Поиск", phone: `+992995${runId}`, role: "ADMIN", passwordHash },
  });
  agentId = agent.id;

  for (const address of ["пр. Рудаки, 45", "ул. Носира Махмудова, 3", "мкр. Зарафшон, 14"]) {
    const p = await prisma.property.create({
      data: {
        title: `Поиск-${runId} · ${address}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address,
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
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Объекты — поиск по адресу", () => {
  it("находит по одному слову адреса", async () => {
    expect(await search("Рудаки")).toContain("пр. Рудаки, 45");
  });

  it("находит, когда набрали улицу и дом без запятой и сокращения", async () => {
    expect(await search("Рудаки 45")).toContain("пр. Рудаки, 45");
  });

  it("не зависит от порядка слов", async () => {
    expect(await search("45 Рудаки")).toContain("пр. Рудаки, 45");
  });

  it("находит по части адреса из нескольких слов", async () => {
    expect(await search("Носира Махмудова")).toContain("ул. Носира Махмудова, 3");
  });

  it("регистр не важен", async () => {
    expect(await search("зарафшон 14")).toContain("мкр. Зарафшон, 14");
  });

  it("лишние знаки препинания в запросе не мешают", async () => {
    expect(await search("Рудаки, 45")).toContain("пр. Рудаки, 45");
  });

  it("найтись должны все слова, а не любое из них", async () => {
    // Улицы из разных карточек: по «любому слову» выдало бы обе, по «всем словам» — ни одной.
    const found = await search("Рудаки Махмудова");
    expect(found).not.toContain("пр. Рудаки, 45");
    expect(found).not.toContain("ул. Носира Махмудова, 3");
  });

  it("запрос из одних знаков препинания не отсекает выдачу", async () => {
    expect((await search(", .")).length).toBeGreaterThan(0);
  });

  it("забыли переключить раскладку: Helfrb находит Рудаки", async () => {
    expect(await search("Helfrb")).toContain("пр. Рудаки, 45");
  });

  it("набрали латиницей: Rudaki находит Рудаки", async () => {
    expect(await search("Rudaki")).toContain("пр. Рудаки, 45");
  });

  it("раскладка и цифра вместе: Helfrb 45", async () => {
    expect(await search("Helfrb 45")).toContain("пр. Рудаки, 45");
  });
});
