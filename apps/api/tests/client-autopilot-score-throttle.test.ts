import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ДВЕ НАХОДКИ РАЗВЕДКИ 24.09.2026 (карточка клиента, блок «Коротко от ИИ» / aiScore):
 *
 *  1. `runClientAutopilot` пересчитывал оценку на КАЖДОЕ входящее сообщение клиента
 *     (messengers/conversation.ts зовёт его с причиной `client_message` на каждую
 *     реплику) — живой диалог из 3-5 сообщений подряд («здравствуйте» / «ищу
 *     квартиру» / «в центре» / «до 700») давал столько же платных вызовов модели,
 *     хотя сводка успевала устареть только с последним из них.
 *  2. Автопилот скорил карточки, которые агент ещё не принял (`acceptedAt: null`,
 *     лежат в очереди на приём/карусели передачи) — на них тратился тот же платный
 *     вызов, хотя ни очередь лидов (services/leads/*.ts берёт только KPI агента),
 *     ни блок «Коротко от ИИ» (открывается вместе с принятой карточкой) оценку
 *     непринятой карточки не читают.
 *
 * Оба исправления — в lib/clientAutopilot.ts (CLIENT_MESSAGE_THROTTLE_MS,
 * SKIP_WHEN_UNACCEPTED). Мокаем только ai/client.js (тот же приём, что в
 * card-fill-budget-address.test.ts) — карточки заводим уже без дыр (все поля
 * card-fill заполнены), чтобы вызывался ТОЛЬКО scoreClient, а не ещё и
 * buildCardFillSuggestion, иначе счётчик вызовов модели перестаёт быть счётчиком
 * именно скоринга.
 */

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { runClientAutopilot } = await import("../src/lib/clientAutopilot.js");

const runId = Date.now();
let agentId = "";
let districtId = "";
const clientIds: string[] = [];

async function makeClient(name: string, data: Record<string, unknown> = {}) {
  const client = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9925${clientIds.length}${runId}`,
      source: "WHATSAPP",
      assignedAgentId: agentId,
      // Карточка без дыр (см. hasGaps в clientAutopilot.ts) — card-fill не
      // запускается, единственный кандидат на вызов модели — scoreClient.
      budgetMax: 500000,
      currency: "TJS",
      address: "Тестовый ориентир",
      desiredDistrictId: districtId,
      desiredRooms: 2,
      desiredType: "APARTMENT",
      requirementsNotes: "Ищет 2-комнатную квартиру",
      acceptedAt: new Date(),
      ...data,
    },
  });
  clientIds.push(client.id);
  return client.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Троттл-район-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент троттлинга ${runId}`, phone: `+992917${String(runId).slice(-6)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockResolvedValue({ score: 50, reason: "Тест" });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Троттлинг client_message (20 минут от aiInsightAt)", () => {
  it("второе client_message через 5 минут после успешной оценки скоринг НЕ вызывает", async () => {
    const clientId = await makeClient("Троттл 5 минут");
    callAiText.mockResolvedValue({ score: 50, reason: "Тест", insight: "Сводка клиента" });

    const first = await runClientAutopilot(clientId, "client_message");
    expect(first.scored).toBe(true);
    expect(callAiText).toHaveBeenCalledTimes(1);

    // Изображаем, что с той оценки прошло 5 минут: сдвигаем aiInsightAt в прошлое
    // (сам scoreClient пишет его через `new Date()`, время в тесте не подделать иначе).
    await prisma.client.update({
      where: { id: clientId },
      data: { aiInsightAt: new Date(Date.now() - 5 * 60 * 1000) },
    });
    callAiText.mockClear();

    const second = await runClientAutopilot(clientId, "client_message");
    expect(second.scored).toBe(false);
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("client_message через 25 минут после последней оценки скоринг вызывает снова", async () => {
    const clientId = await makeClient("Троттл 25 минут", {
      aiInsightAt: new Date(Date.now() - 25 * 60 * 1000),
    });
    callAiText.mockClear();

    const result = await runClientAutopilot(clientId, "client_message");
    expect(result.scored).toBe(true);
    expect(callAiText).toHaveBeenCalledTimes(1);
  });

  it("троттлинг не действует на interaction_added — это отдельный сигнал, не поток сообщений", async () => {
    const clientId = await makeClient("Не троттлится interaction_added", {
      aiInsightAt: new Date(),
    });
    callAiText.mockClear();

    const result = await runClientAutopilot(clientId, "interaction_added");
    expect(result.scored).toBe(true);
    expect(callAiText).toHaveBeenCalledTimes(1);
  });
});

describe("Непринятую карточку (acceptedAt: null) автопилот не скорит", () => {
  it("client_message на непринятой карточке скоринг не вызывает", async () => {
    const clientId = await makeClient("Непринята: сообщение", { acceptedAt: null });

    const result = await runClientAutopilot(clientId, "client_message");

    expect(result.scored).toBe(false);
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("interaction_added на непринятой карточке скоринг не вызывает", async () => {
    const clientId = await makeClient("Непринята: взаимодействие", { acceptedAt: null });

    const result = await runClientAutopilot(clientId, "interaction_added");

    expect(result.scored).toBe(false);
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("lead_created на непринятой карточке скоринг не вызывает — очередь лидов aiScore не читает", async () => {
    const clientId = await makeClient("Непринята: лид создан", { acceptedAt: null });

    const result = await runClientAutopilot(clientId, "lead_created");

    expect(result.scored).toBe(false);
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("agent_changed на непринятой карточке скоринг всё равно вызывает — разовый факт, не поток", async () => {
    const clientId = await makeClient("Непринята: смена агента", { acceptedAt: null });

    const result = await runClientAutopilot(clientId, "agent_changed");

    expect(result.scored).toBe(true);
    expect(callAiText).toHaveBeenCalledTimes(1);
  });

  it("после приёма (acceptedAt проставлен) то же client_message снова скорит карточку", async () => {
    const clientId = await makeClient("Была непринята, теперь принята", { acceptedAt: null });
    await runClientAutopilot(clientId, "client_message");
    expect(callAiText).not.toHaveBeenCalled();

    await prisma.client.update({ where: { id: clientId }, data: { acceptedAt: new Date() } });
    callAiText.mockClear();

    const result = await runClientAutopilot(clientId, "client_message");
    expect(result.scored).toBe(true);
    expect(callAiText).toHaveBeenCalledTimes(1);
  });
});
