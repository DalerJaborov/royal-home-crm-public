import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Предупреждение о дубликате должно срабатывать НЕЗАВИСИМО ОТ ФОРМАТА номера.
 *
 * Разбор 09.08.2026: проверка искала `phone contains <9 цифр>` по сырой колонке,
 * а clientPhoneSchema разрешает пробелы и скобки — значит в базе лежит «+992 90
 * 000 00 01», и LIKE '%900000001%' не находил его никогда. Комментарий рядом с
 * кодом при этом обещал ровно обратное: «совпадение по телефону в любом формате».
 * Рабочий предикат всё это время лежал в lib/whatsappPhone.ts.
 */

const runId = Date.now();
const password = "testpass123";
const tail = String(runId).slice(-7);

let agentId = "";
let token = "";
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Дубли Агент ${runId}`, phone: `+992921${tail}`, role: "DIRECTOR", passwordHash },
  });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function createClient(phone: string, force = false) {
  const res = await request(app)
    .post("/api/v1/clients")
    .set("Authorization", `Bearer ${token}`)
    .send({ fullName: `Дубль ${runId}`, phone, source: "PHONE_CALL", ...(force ? { force: true } : {}) });
  if (res.body?.id) clientIds.push(res.body.id);
  return res;
}

describe("Дубликат клиента ловится в любом формате номера", () => {
  it("номер с пробелами в базе находится по слитному номеру", async () => {
    // В базе — «как набрали», с пробелами.
    const spaced = `+992 92 2${tail.slice(0, 2)} ${tail.slice(2, 4)} ${tail.slice(4, 6)}${tail.slice(6)}`;
    const created = await createClient(spaced);
    expect(created.status).toBe(201);

    // Второй раз тот же номер, но слитно — обязано прийти предупреждение.
    const solid = spaced.replace(/\s/g, "");
    const again = await createClient(solid);
    expect(again.status).toBe(200);
    expect(again.body.warning, `ответ: ${JSON.stringify(again.body)}`).toBeTruthy();
    expect(again.body.client?.id).toBe(created.body.id);
  });

  it("другой номер дубликатом не считается", async () => {
    // Хвост должен отличаться и в последних 7 цифрах, не только в 9 — с
    // 03.09.2026 (раздел L, уровень 3) тот же fullName + совпадающие последние
    // 7 цифр номера уже ловятся мягким предупреждением (см.
    // duplicate-review-manual-warning.test.ts), даже если 9-значный хвост другой.
    const other = `+99293${tail.split("").reverse().join("")}`;
    const res = await createClient(other);
    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
  });
});
