import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Шаг 5, «Активность»: фильтр по типу действия (`GET /interactions?type=`).
 *
 * Раньше шторка фильтров экрана показывала честную заглушку «Нет данных»: сервер
 * фильтровал ленту только по периоду и агенту. Схема conversationFeedQuerySchema
 * расширена полем `type` (packages/shared/src/querySchemas.ts), activityWhere
 * (apps/api/src/lib/activityFeed.ts) применяет его И к ленте, И к сводке — та же
 * область на оба места, что и у agentId/периода (комментарий в activityFeed.ts).
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let clientId: string;
let token: string;
const interactionIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент фильтра типа ${runId}`, phone: `+992983${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: "Клиент фильтра типа",
        phone: `+992984${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  const call = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Звонок для фильтра" },
  });
  const message = await prisma.interaction.create({
    data: { clientId, agentId, type: "MESSAGE", notes: "Сообщение для фильтра" },
  });
  interactionIds.push(call.id, message.id);

  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

function feed(query: string) {
  return request(app).get(`/api/v1/interactions${query}`).set("Authorization", `Bearer ${token}`);
}

describe("Активность: фильтр по типу действия", () => {
  it("?type=CALL отдаёт только звонки этого агента", async () => {
    const res = await feed("?type=CALL");
    expect(res.status).toBe(200);
    const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(interactionIds[0]);
    expect(ids).not.toContain(interactionIds[1]);
    for (const item of res.body.items) expect(item.type).toBe("CALL");
  });

  it("?type=MESSAGE отдаёт только сообщения", async () => {
    const res = await feed("?type=MESSAGE");
    expect(res.status).toBe(200);
    const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(interactionIds[1]);
    expect(ids).not.toContain(interactionIds[0]);
  });

  it("без type — оба типа на месте, ничего не сужено", async () => {
    const res = await feed("?page=1");
    expect(res.status).toBe(200);
    const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining(interactionIds));
  });

  it("значение не из перечня отвергается", async () => {
    expect((await feed("?type=НЕЧТО")).status).toBe(400);
  });
});
