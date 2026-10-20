import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { TASK_WHERE } from "../src/lib/tasks.js";

/** Дата без текста задачи — задача-невидимка: календарь, напоминания и KPI отбирают
 *  записи по nextAction != null (lib/tasks.ts). Сервер обязан добрать текст сам. */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let clientId: string;
let propertyId: string;
let token: string;

async function createInteraction(body: Record<string, unknown>) {
  const res = await request(app)
    .post(`/api/v1/clients/${clientId}/interactions`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  expect(res.status).toBe(201);
  return res.body as { id: string; nextAction: string | null };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  // Имя района уникально ПО ФАЙЛУ, не только по времени: файлы стартуют параллельно,
  // и два runId = Date.now() в одну миллисекунду роняли второй файл на unique(name).
  districtId = (await prisma.district.create({ data: { name: `Тест-район-задачи-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент задач", phone: `+992982${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: "Клиент задач",
        phone: `+992981${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект задач ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        assignedAgentId: agentId,
      },
    })
  ).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Задача из взаимодействия", () => {
  it("показ с датой, но без текста — получает текст и виден отбору задач", async () => {
    const created = await createInteraction({
      type: "SHOWING",
      propertyId,
      notes: "Показ без текста задачи",
      nextActionDate: "2099-01-15T10:00:00.000Z",
    });
    expect(created.nextAction).toBe("Показ объекта");
    const asTask = await prisma.interaction.findFirst({ where: { ...TASK_WHERE, id: created.id } });
    expect(asTask).not.toBeNull();
  });

  it("звонок с датой без текста — «Связаться с клиентом»", async () => {
    const created = await createInteraction({
      type: "CALL",
      notes: "Звонок без текста задачи",
      nextActionDate: "2099-01-16T10:00:00.000Z",
    });
    expect(created.nextAction).toBe("Связаться с клиентом");
  });

  it("свой текст задачи не перетирается", async () => {
    const created = await createInteraction({
      type: "SHOWING",
      propertyId,
      notes: "Показ со своим текстом",
      nextAction: "Взять ключи у собственника",
      nextActionDate: "2099-01-17T10:00:00.000Z",
    });
    expect(created.nextAction).toBe("Взять ключи у собственника");
  });

  it("запись без даты текст не получает — задачи из неё нет", async () => {
    const created = await createInteraction({ type: "CALL", notes: "Просто звонок" });
    expect(created.nextAction).toBeNull();
  });
});
