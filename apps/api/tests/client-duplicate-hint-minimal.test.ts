import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ПРЕДУПРЕЖДЕНИЕ О ДУБЛЕ НЕ ОТДАЁТ ЧУЖУЮ КАРТОЧКУ (аудит 23.09.2026, №43).
 *
 * Агент набирал номер чужого клиента в форме «Новый клиент» и получал в ответе
 * всю карточку: заметки, запасные номера, бюджет. Кнопке «Открыть карточку»
 * нужны только ссылка и имя, и номер внутри имени закрыт.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const PHONE = `+99294${tail}`;
const SPACED = `+992 94 ${tail.slice(0, 3)} ${tail.slice(3)}`;
const SECRET = `Секретная заметка ${runId}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
let otherToken = "";

beforeAll(async () => {
  const owner = await prisma.agent.create({
    data: { fullName: `Хозяин дубля ${runId}`, phone: `+99295${tail}`, role: "AGENT", passwordHash: "x" },
  });
  const other = await prisma.agent.create({
    data: { fullName: `Чужой агент ${runId}`, phone: `+99296${tail}`, role: "AGENT", passwordHash: "x" },
  });
  agentIds.push(owner.id, other.id);
  otherToken = signAccessToken({ sub: other.id, role: "AGENT" });
  await prisma.client.deleteMany({ where: { phone: { in: [PHONE, SPACED] } } });
  clientIds.push(
    (
      await prisma.client.create({
        data: {
          fullName: "Азиз 910001003",
          phone: SPACED,
          source: "INSTAGRAM",
          kind: "BUYER",
          assignedAgentId: owner.id,
          acceptedAt: new Date(),
          requirementsNotes: SECRET,
          extraPhones: ["+992910001003"],
          budgetMax: 90000,
        } as never,
      })
    ).id
  );
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

function expectOnlyHint(client: Record<string, unknown>) {
  expect(Object.keys(client).sort()).toEqual(["fullName", "id", "shortId"]);
  expect(JSON.stringify(client)).not.toContain(SECRET);
  expect(String(client.fullName)).not.toContain("910001003");
}

describe("Чужой агент набрал номер существующего клиента", () => {
  it("тот же номер в другом формате — в предупреждении только ссылка и скрытое имя", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ fullName: "Новый человек", phone: PHONE, source: "PHONE_CALL" });
    if (res.body?.id && !res.body.warning) clientIds.push(res.body.id);
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeTruthy();
    expectOnlyHint(res.body.client);
    expect(res.body.client.id).toBe(clientIds[0]);
  });

  it("точно тот же номер — отказ, и в отказе тоже только ссылка и скрытое имя", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ fullName: "Новый человек", phone: SPACED, source: "PHONE_CALL", force: true });
    if (res.body?.id && !res.body.error) clientIds.push(res.body.id);
    expect(res.status).toBe(409);
    expectOnlyHint(res.body.client);
  });
});
