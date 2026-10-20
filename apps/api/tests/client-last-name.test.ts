import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Фамилия отдельным полем (спецификация: «в карточке отображается имя, фамилия,
 * телефон…») — необязательна, чтобы не ломать старые карточки с именем одной
 * строкой. fullName остаётся источником истины (поиск/бот/шаблоны), lastName —
 * дополнительная подпись.
 */

const runId = Date.now();
const password = "testpass123";
let agentId: string;
let token: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент фамилии", phone: `+992969${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+992969${runId}`, password });
  token = login.body.accessToken;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Фамилия клиента — отдельное необязательное поле", () => {
  it("создаётся без фамилии — как раньше", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: `Без фамилии ${runId}`, phone: `+99290${runId}1`, source: "PHONE_CALL" });
    expect(res.status).toBe(201);
    expect(res.body.lastName ?? null).toBeNull();
    clientIds.push(res.body.id);
  });

  it("сохраняет фамилию при создании", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: `Далер ${runId}`, lastName: "Джаббаров", phone: `+99290${runId}2`, source: "PHONE_CALL" });
    expect(res.status).toBe(201);
    expect(res.body.lastName).toBe("Джаббаров");
    clientIds.push(res.body.id);
  });

  it("правка: null очищает уже заданную фамилию", async () => {
    const created = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: `На очистку ${runId}`, lastName: "Иванов", phone: `+99290${runId}3`, source: "PHONE_CALL" });
    clientIds.push(created.body.id);

    const patched = await request(app)
      .patch(`/api/v1/clients/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ lastName: null });
    expect(patched.status).toBe(200);
    expect(patched.body.lastName).toBeNull();
  });
});
