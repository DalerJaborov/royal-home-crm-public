import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Задача K (план docs/audit-02-09-2026/19-plan-03-09-evening.md): «ИИ копит
 * информацию по всем каналам касания с продавцом... к моменту открытия формы
 * создания объекта черновик уже заполнен».
 *
 * Тот же характер проверки, что у apps/api/tests/card-fill*.test.ts (заполнение
 * карточки КЛИЕНТА) — здесь источник переписка/звонки с ПРОДАВЦОМ, а извлекаемые
 * поля — параметры ЕГО ОБЪЕКТА (площадь, комнаты, этаж, состояние, цена, район),
 * а не требования покупателя. Проверяем саму функцию buildPropertyDraftSuggestion
 * напрямую (роут в routes/ai.ts — только гейты доступа поверх неё, как и у card-fill).
 */

const aiCalls: { user: string }[] = [];
let aiReply: Record<string, unknown> | null = null;
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: async (params: { user?: string }) => {
    aiCalls.push({ user: params.user ?? "" });
    return aiReply;
  },
}));

const { prisma } = await import("../src/db.js");
const { buildPropertyDraftSuggestion } = await import("../src/ai/propertyDraft.js");

const runId = Date.now();
let agentId = "";
let districtId = "";
const clientIds: string[] = [];

async function makeSeller(name: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9927${clientIds.length}${runId}`,
      status: "NEW",
      kind: "SELLER",
      workStatus: "ACTIVE",
      source: "WEBSITE",
      assignedAgentId: agentId,
      currency: "TJS",
      acceptedAt: new Date(),
    } as never,
  });
  clientIds.push(c.id);
  return c.id;
}

async function attachConversation(clientId: string, messages: { role: "user" | "assistant"; content: string }[]) {
  await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `sub-${clientId}`,
      clientId,
      messages: messages as never,
    },
  });
}

async function attachCall(clientId: string, transcript: string) {
  await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Звонок через CRM", transcript },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Черновик-объекта-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент черновика объекта ${runId}`, phone: `+992935${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterEach(() => {
  aiCalls.length = 0;
  aiReply = null;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.botConversation.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Черновик карточки объекта из переписки с продавцом", () => {
  it("продавец без переписки и звонков даёт пустое предложение, а не ошибку — платный вызов пропускается", async () => {
    const clientId = await makeSeller("Без диалога");

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.source).toBe("none");
    expect(suggestion.type).toBeNull();
    expect(suggestion.price).toBeNull();
    expect(suggestion.aiUnavailable).toBe(false);
    expect(aiCalls).toHaveLength(0);
  });

  it("собирает площадь, комнаты, этаж, состояние, цену и район из переписки", async () => {
    const clientId = await makeSeller("Полная переписка");
    await attachConversation(clientId, [
      { role: "user", content: "Продаю 2-хонага дар Черновик-объекта, 54 метра, 3 этаж, каробка, за 450000" },
    ]);
    aiReply = {
      propertyType: "APARTMENT",
      rooms: 2,
      areaSqm: 54,
      floor: 3,
      condition: "NEEDS_REPAIR",
      price: 450000,
      currency: "TJS",
      districtName: `Черновик-объекта-${runId}`,
      address: "рядом с рынком Саховат",
      evidence: ["54 метра", "за 450000"],
    };

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.source).toBe("chat");
    expect(suggestion.type).toBe("APARTMENT");
    expect(suggestion.rooms).toBe(2);
    expect(suggestion.areaSqm).toBe(54);
    expect(suggestion.floor).toBe(3);
    expect(suggestion.condition).toBe("NEEDS_REPAIR");
    expect(suggestion.price).toBe(450000);
    expect(suggestion.currency).toBe("TJS");
    expect(suggestion.districtId).toBe(districtId);
    expect(suggestion.districtName).toBe(`Черновик-объекта-${runId}`);
    expect(suggestion.address).toBe("рядом с рынком Саховат");
    expect(suggestion.evidence).toEqual(["54 метра", "за 450000"]);
  });

  it("звонок даёт source=call, а не chat — расшифровка надёжнее переписки", async () => {
    const clientId = await makeSeller("Со звонком");
    await attachConversation(clientId, [{ role: "user", content: "Здравствуйте, хочу продать квартиру" }]);
    await attachCall(clientId, "Продавец: квартира 60 метров, этаж пятый, с ремонтом, прошу 500 тысяч сомони.");
    aiReply = { areaSqm: 60, floor: 5, condition: "GOOD", price: 500000, currency: "TJS" };

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.source).toBe("call");
    expect(suggestion.areaSqm).toBe(60);
    // В разбор уходит и переписка, и расшифровка одним запросом — модель видит всё общение.
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].user).toContain("Телефонный разговор");
    expect(aiCalls[0].user).toContain("Здравствуйте");
  });

  it("выдуманные и неверные значения модели отбрасываются, а не уезжают в форму", async () => {
    const clientId = await makeSeller("Мусор от модели");
    await attachConversation(clientId, [{ role: "user", content: "Салом" }]);
    aiReply = {
      propertyType: "ДВОРЕЦ",
      condition: "ИДЕАЛЬНОЕ",
      currency: "EUR",
      rooms: -3,
      areaSqm: -10,
      floor: "мансарда",
      price: 0,
      districtName: "Несуществующий район",
      evidence: ["", "  ", "настоящая цитата"],
    };

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.type).toBeNull();
    expect(suggestion.condition).toBeNull();
    expect(suggestion.currency).toBeNull();
    expect(suggestion.rooms).toBeNull();
    expect(suggestion.areaSqm).toBeNull();
    expect(suggestion.floor).toBeNull();
    expect(suggestion.price).toBeNull();
    expect(suggestion.districtId).toBeNull();
    expect(suggestion.districtName).toBeNull();
    // Пустые/пробельные цитаты отфильтрованы, настоящая осталась.
    expect(suggestion.evidence).toEqual(["настоящая цитата"]);
  });

  it("молчание модели не ломает форму — aiUnavailable=true, источник остаётся «none»", async () => {
    const clientId = await makeSeller("ИИ недоступен");
    await attachConversation(clientId, [{ role: "user", content: "3 хонага, 70 метров" }]);
    aiReply = null;

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.aiUnavailable).toBe(true);
    expect(suggestion.source).toBe("none");
    expect(suggestion.rooms).toBeNull();
  });

  it("до 3 цитат в evidence, лишние обрезаются", async () => {
    const clientId = await makeSeller("Много цитат");
    await attachConversation(clientId, [{ role: "user", content: "Дом продаю" }]);
    aiReply = { evidence: ["раз", "два", "три", "четыре", "пять"] };

    const suggestion = await buildPropertyDraftSuggestion(clientId);

    expect(suggestion.evidence).toEqual(["раз", "два", "три"]);
  });
});
