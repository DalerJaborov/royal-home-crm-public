import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { loadPipelineDeadlines } from "../src/lib/propertyPipeline.js";

/**
 * GET /properties/summary — сводная плашка над каталогом (шаг 5 переноса,
 * tpl-properties): заменяет честную заглушку «показы CRM не считает, просрочку
 * этапа по каталогу сервер не суммирует».
 *
 * Проверяем ровно то, что ничем другим не ловится:
 *  1) showings30d считает Interaction(type=SHOWING, propertyId≠null) за
 *     последние 30 дней и НЕ считает более старую запись и запись другого типа;
 *  2) overduePipelineCount считает объект просроченным ТЕМ ЖЕ правилом, что и
 *     p.pipeline.overdue у конкретного объекта (та же граница «строго больше
 *     срока»), и не считает объект, который ещё укладывается в срок.
 *
 * Числа — дельтой (до/после создания фикстур), а не абсолютным значением:
 * каталог общий на все тесты, приезжающие параллельно (см. clients-summary.test.ts).
 */

const runId = Date.now();
const password = "testpass123";
let districtId: string;
let agentId: string;
let clientId: string;
let agentPhone = "";
const propertyIds: string[] = [];
const interactionIds: string[] = [];

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken ?? res.body.token;
}

async function makeProperty(status: "AWAITING_PHOTOS", stageEnteredAt: Date) {
  const p = await prisma.property.create({
    data: {
      title: `Объект сводки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая сводки, 3",
      condition: "GOOD",
      status,
      intakeAgentId: agentId,
    },
  });
  await prisma.property.update({ where: { id: p.id }, data: { stageEnteredAt } });
  propertyIds.push(p.id);
  return p;
}

async function makeShowing(propertyId: string, createdAt: Date) {
  const i = await prisma.interaction.create({
    data: { clientId, agentId, propertyId, type: "SHOWING", notes: "тест", createdAt },
  });
  interactionIds.push(i.id);
  return i;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-сводка-${runId}` } })).id;
  agentPhone = `+992951${String(runId).slice(-7)}`;
  const agent = await prisma.agent.create({
    data: { fullName: `Сводка Объектов Агент ${runId}`, phone: agentPhone, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Сводка Объектов Клиент ${runId}`,
      phone: `+992952${String(runId).slice(-7)}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      assignedAgentId: agentId,
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { phone: agentPhone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("GET /properties/summary", () => {
  it("считает показы за 30 дней и просрочку этапа по всему каталогу дельтой", async () => {
    const token = await login(agentPhone);

    const before = await request(app).get("/api/v1/properties/summary").set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.windowDays).toBe(30);

    const deadlines = await loadPipelineDeadlines();
    const limitDays = deadlines.AWAITING_PHOTOS;
    const now = new Date();
    // Просрочен строго: daysInStage > limitDays — с запасом в 5 дней сверху.
    const overdueProperty = await makeProperty("AWAITING_PHOTOS", new Date(now.getTime() - (limitDays + 5) * 86_400_000));
    // Ровно на грани срока — ещё НЕ просрочен (та же граница, что у stageState).
    await makeProperty("AWAITING_PHOTOS", new Date(now.getTime() - limitDays * 86_400_000));

    // Один показ внутри окна, один — старше 30 дней (не должен попасть в счёт),
    // и один звонок (другой тип — тоже не должен попасть).
    await makeShowing(overdueProperty.id, new Date(now.getTime() - 5 * 86_400_000));
    await makeShowing(overdueProperty.id, new Date(now.getTime() - 40 * 86_400_000));
    const oldCall = await prisma.interaction.create({
      data: { clientId, agentId, propertyId: overdueProperty.id, type: "CALL", notes: "тест", createdAt: now },
    });
    interactionIds.push(oldCall.id);

    const after = await request(app).get("/api/v1/properties/summary").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.showings30d - before.body.showings30d).toBe(1);
    expect(after.body.overduePipelineCount - before.body.overduePipelineCount).toBe(1);
  });
});
