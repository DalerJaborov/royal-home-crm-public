import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, A6 (вторая половина) — подсказки ИИ для мастера
 * карточки (`POST /ai/card-fill/:id`) и черновик объекта (`POST
 * /ai/property-draft/:id`) отдают дословные цитаты клиента (evidence), заметку и
 * адрес со слов продавца без маскирования. Тот же вход в переписке и
 * расшифровках маскируется по clients.viewPhone — здесь номер шёл открытым.
 *
 * Сами построители зовут модель, поэтому подменены: проверяется только выдача
 * маршрута — что поверх ответа построителя стоит то же правило номера.
 */

const DIGITS = "935553311";

vi.mock("../src/ai/cardFill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/cardFill.js")>()),
  buildCardFillSuggestion: vi.fn(async () => ({
    source: "chat",
    budgetMin: null,
    budgetMax: 70000,
    districtId: null,
    districtName: null,
    rooms: 2,
    type: null,
    urgency: null,
    notes: `Перезвонить на ${DIGITS}`,
    tags: [],
    evidence: [`пишите на ${DIGITS}`],
    aiUnavailable: false,
  })),
}));
vi.mock("../src/ai/propertyDraft.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/propertyDraft.js")>()),
  buildPropertyDraftSuggestion: vi.fn(async () => ({
    source: "chat",
    type: null,
    rooms: 2,
    areaSqm: 50,
    floor: null,
    condition: null,
    price: 60000,
    currency: "USD",
    districtId: null,
    districtName: null,
    address: `Сино 5, звоните ${DIGITS}`,
    evidence: [`продаю, мой номер ${DIGITS}`],
    aiUnavailable: false,
    ambiguityReason: null,
    existingObjectsCount: 0,
  })),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
let sellerId: string;
let agentToken: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент A6-ИИ ${runId}`, phone: `+992977${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(agent.id);
  sellerId = (
    await prisma.client.create({
      data: {
        fullName: `Продавец A6-ИИ ${runId}`,
        phone: `+992978${runId}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: agent.id,
        acceptedAt: new Date(),
      },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  agentToken = login.body.accessToken;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: sellerId } });
  await prisma.client.deleteMany({ where: { id: sellerId } });
  await deleteAgentsWithTraces(agentIds);
});

describe("A6: цитаты клиента в подсказках ИИ — без номера тому, кому он скрыт", () => {
  it("card-fill", async () => {
    const res = await request(app).post(`/api/v1/ai/card-fill/${sellerId}`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.budgetMax).toBe(70000);
    expect(res.body.evidence).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("5553311");
  });

  it("property-draft", async () => {
    const res = await request(app)
      .post(`/api/v1/ai/property-draft/${sellerId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.price).toBe(60000);
    expect(res.body.address).toContain("Сино 5");
    expect(JSON.stringify(res.body)).not.toContain("5553311");
  });
});
