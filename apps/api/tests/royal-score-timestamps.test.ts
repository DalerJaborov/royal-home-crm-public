import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { applyAiCallOutcome } from "../src/lib/aiCallOutcome.js";

/**
 * Автофиксация времён Royal Score (docs/spec-compliance-03-08-2026.md, «Royal
 * Score» — пункт «Автофиксация времён», ранее ⚠️): Client.firstOpenedAt/
 * firstContactAt/firstOutcomeAt — момент первого открытия карточки, первой
 * попытки контакта и первого содержательного результата. Пишутся один раз,
 * повторное срабатывание не должно их переписывать.
 */

const runId = Date.now();
/** Порядковый номер вместо случайного: телефон уникален в базе, а случайных
 *  трёхзначных значений всего тысяча — на трёх десятках карточек в одном прогоне
 *  совпадение почти неизбежно (парадокс дней рождения), и CI падал на
 *  «Unique constraint failed on the fields: (phone)» в исправном коде. */
let phoneSeq = 0;
const password = "testpass123";

let agentId: string;
let token: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(overrides: Partial<Parameters<typeof prisma.client.create>[0]["data"]> = {}) {
  return prisma.client.create({
    data: {
      fullName: `Клиент автофиксации ${runId}-${Math.random().toString(36).slice(2, 8)}`,
      phone: `+992962${runId}${String(phoneSeq++).padStart(4, "0")}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      ...overrides,
    },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент автофиксации времён", phone: `+992963${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  token = await login(`+992963${runId}`);
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { agentId } });
  await prisma.pendingSummary.deleteMany({ where: { agentId } });
  await prisma.client.deleteMany({ where: { assignedAgentId: agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("firstOpenedAt — первое открытие карточки", () => {
  it("проставляется при первом GET /clients/:id и не переписывается при повторном", async () => {
    const client = await makeClient();
    expect(client.firstOpenedAt).toBeNull();

    const first = await request(app)
      .get(`/api/v1/clients/${client.shortId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);

    const afterFirst = await prisma.client.findUnique({ where: { id: client.id } });
    expect(afterFirst?.firstOpenedAt).not.toBeNull();
    const firstOpenedAt = afterFirst!.firstOpenedAt!.getTime();

    const second = await request(app)
      .get(`/api/v1/clients/${client.shortId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(200);

    const afterSecond = await prisma.client.findUnique({ where: { id: client.id } });
    expect(afterSecond?.firstOpenedAt?.getTime()).toBe(firstOpenedAt);
  });
});

describe("firstContactAt — первая попытка контакта", () => {
  it("проставляется на первой записи Interaction и не переписывается на второй", async () => {
    const client = await makeClient();
    expect(client.firstContactAt).toBeNull();

    const first = await request(app)
      .post(`/api/v1/clients/${client.id}/interactions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "CALL", notes: "Первый звонок" });
    expect(first.status).toBe(201);

    const afterFirst = await prisma.client.findUnique({ where: { id: client.id } });
    expect(afterFirst?.firstContactAt).not.toBeNull();
    const firstContactAt = afterFirst!.firstContactAt!.getTime();

    const second = await request(app)
      .post(`/api/v1/clients/${client.id}/interactions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "CALL", notes: "Второй звонок" });
    expect(second.status).toBe(201);

    const afterSecond = await prisma.client.findUnique({ where: { id: client.id } });
    expect(afterSecond?.firstContactAt?.getTime()).toBe(firstContactAt);
  });
});

describe("firstOutcomeAt — первый содержательный результат", () => {
  /**
   * Раньше отметка ставилась при закрытии обязательного окна «Как прошёл звонок».
   * Окна удалены 13.09.2026, и единственный оставшийся писатель отметки — разбор
   * разговора ИИ (lib/aiCallOutcome.ts). Проверяем его, а не удаляем проверку:
   * само поле живо и читается отчётами.
   */
  const LONG_TRANSCRIPT = "Разговор о подборе квартиры ".repeat(15);

  async function applyOutcome(clientId: string) {
    const interaction = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Звонок через CRM" },
    });
    return applyAiCallOutcome({
      interactionId: interaction.id,
      agentId,
      clientId,
      transcriptLength: LONG_TRANSCRIPT.length,
      outcome: "WAITING_CALL",
      nextAction: "Перезвонить клиенту",
      showingAt: null,
      summary: "Договорились созвониться завтра",
    });
  }

  it("проставляется при первом содержательном исходе разговора", async () => {
    const client = await makeClient();
    expect(client.firstOutcomeAt).toBeNull();

    expect(await applyOutcome(client.id)).toBe(true);

    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.firstOutcomeAt).not.toBeNull();
  });

  it("не переписывается вторым содержательным результатом", async () => {
    const client = await makeClient();
    const now = new Date();
    await prisma.client.update({ where: { id: client.id }, data: { firstOutcomeAt: now } });

    expect(await applyOutcome(client.id)).toBe(true);

    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.firstOutcomeAt?.getTime()).toBe(now.getTime());
  });
});
