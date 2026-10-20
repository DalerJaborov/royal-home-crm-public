import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * В списке клиентов виден следующий шаг агента.
 *
 * Разбор интерфейса 13.08.2026: список был перечнем людей — имя, статус, бюджет,
 * когда последний раз общались. Того единственного, что определяет работу на
 * сегодня, — «что я обещал сделать и когда» — в нём не было, потому что обещание
 * живёт в хронологии (Interaction.nextAction), а не в карточке клиента. Рабочая
 * очередь из-за этого жила отдельно в Календаре, и агент держал два экрана.
 *
 * Здесь закреплено главное: берётся САМОЕ РАННЕЕ НЕВЫПОЛНЕННОЕ обещание.
 * Просроченное вчера важнее назначенного на следующую неделю, а уже выполненное
 * не должно висеть в списке как незакрытый долг.
 */

const runId = Date.now();
const password = "testpass123";

let directorId = "";
let agentId = "";
let clientId = "";
let otherClientId = "";
let token = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: `Шаг Дир ${runId}`, phone: `+992951${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: `Шаг Агент ${runId}`, phone: `+992952${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Шаг Клиент ${runId}`,
      phone: `+992953${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  const other = await prisma.client.create({
    data: {
      fullName: `Шаг Без обещаний ${runId}`,
      phone: `+992954${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  otherClientId = other.id;

  await prisma.interaction.createMany({
    data: [
      // Уже выполненное — в списке его быть не должно, хотя оно самое раннее.
      {
        clientId,
        agentId: agent.id,
        type: "CALL",
        notes: "старое",
        nextAction: "выполненное обещание",
        nextActionDate: new Date("2026-08-01T10:00:00Z"),
        completedAt: new Date("2026-08-01T12:00:00Z"),
      },
      // Самое раннее из невыполненных — именно оно и ожидается.
      {
        clientId,
        agentId: agent.id,
        type: "CALL",
        notes: "перезвонить",
        nextAction: "перезвонить по цене",
        nextActionDate: new Date("2026-08-14T09:00:00Z"),
      },
      // Позднее невыполненное — не должно перебить более раннее.
      {
        clientId,
        agentId: agent.id,
        type: "MEETING",
        notes: "показ",
        nextAction: "показать вторую квартиру",
        nextActionDate: new Date("2026-08-20T09:00:00Z"),
      },
    ],
  });

  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: [clientId, otherClientId] } } });
  await prisma.client.deleteMany({ where: { id: { in: [clientId, otherClientId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.$disconnect();
});

describe("Список клиентов показывает следующий шаг", () => {
  it("отдаёт самое раннее невыполненное обещание", async () => {
    const res = await request(app)
      .get(`/api/v1/clients?q=${encodeURIComponent(`Шаг Клиент ${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const row = (res.body.items as { id: string; nextStep: { nextAction: string; nextActionDate: string } | null }[]).find(
      (c) => c.id === clientId
    );
    expect(row?.nextStep?.nextAction).toBe("перезвонить по цене");
    expect(row?.nextStep?.nextActionDate).toContain("2026-08-14");
  });

  it("у клиента без обещаний поле пустое, а не выдумано", async () => {
    const res = await request(app)
      .get(`/api/v1/clients?q=${encodeURIComponent(`Шаг Без обещаний ${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const row = (res.body.items as { id: string; nextStep: unknown }[]).find((c) => c.id === otherClientId);
    expect(row?.nextStep).toBeNull();
  });
});
