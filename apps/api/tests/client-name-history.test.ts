import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ПРАВКА ИМЕНИ КЛИЕНТА — ВИДНА В ХРОНОЛОГИИ (владелец 19.08.2026).
 *
 * Смена статуса уже писала запись в хронологию (STATUS_CHANGE); правка имени —
 * то поле, которое теперь можно поменять одним кликом прямо в карточке
 * (ClientDetail.tsx, без четырёх шагов ClientFormModal) — молча терялась.
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
      data: { fullName: "Агент имени", phone: `+992968${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+992968${runId}`, password });
  token = login.body.accessToken;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Правка имени клиента", () => {
  it("меняет fullName и оставляет запись в хронологии", async () => {
    const created = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: `Покупатель №0099`, phone: `+99290${runId}4`, source: "PHONE_CALL" });
    clientIds.push(created.body.id);

    const patched = await request(app)
      .patch(`/api/v1/clients/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Дилноза" });

    expect(patched.status).toBe(200);
    expect(patched.body.fullName).toBe("Дилноза");

    const history = await prisma.interaction.findMany({ where: { clientId: created.body.id } });
    const nameChange = history.find((h) => h.type === "SYSTEM" && h.notes?.includes("Имя изменено"));
    expect(nameChange).toBeTruthy();
    expect(nameChange?.notes).toContain("Покупатель №0099");
    expect(nameChange?.notes).toContain("Дилноза");
  });

  it("не пишет запись, если имя не изменилось", async () => {
    const created = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: `Без изменений`, phone: `+99290${runId}5`, source: "PHONE_CALL" });
    clientIds.push(created.body.id);

    await request(app)
      .patch(`/api/v1/clients/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Без изменений" });

    const history = await prisma.interaction.findMany({ where: { clientId: created.body.id } });
    expect(history.some((h) => h.type === "SYSTEM" && h.notes?.includes("Имя изменено"))).toBe(false);
  });
});
