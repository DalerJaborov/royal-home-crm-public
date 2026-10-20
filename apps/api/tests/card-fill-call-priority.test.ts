import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Разговор свежее переписки — и должен побеждать при расхождении.
 *
 * Сценарий агентства, на котором это вскрылось (вопрос владельца 07.08.2026):
 * клиент пришёл из Instagram и написал там «до 40 тысяч, двушка». Бот сложил это в
 * черновик, автопилот заполнил карточку. Потом агент перезвонил уточнить желания —
 * и выяснилось, что бюджет 60 и нужна трёшка.
 *
 * Пока приоритет был у черновика бота, свежие слова клиента проигрывали позавчерашней
 * переписке: предложение показывало старые цифры, будто разговор вообще не слушали.
 * Теперь при наличии расшифровки побеждает разбор — он видит и переписку, и звонок
 * сразу, поэтому его ответ это итог по всему общению, а не мнение одного источника.
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
const { buildCardFillSuggestion } = await import("../src/ai/cardFill.js");

const runId = Date.now();
let agentId = "";
let clientId = "";
let districtId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент приоритета ${runId}`, phone: `+99261${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  const district = await prisma.district.create({ data: { name: `Сино-${runId}` } });
  districtId = district.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент из инстаграма ${runId}`,
      phone: `+99262${String(runId).slice(-7)}`,
      source: "INSTAGRAM",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  // Черновик бота из переписки в Instagram: клиент назвал бюджет и комнаты там.
  await prisma.botConversation.create({
    data: {
      clientId,
      channel: "INSTAGRAM",
      subscriberId: `ig-${runId}`,
      leadDraft: { budgetMin: 30000, budgetMax: 40000, rooms: 2, districtName: `Сино-${runId}` },
      messages: [{ role: "user", content: "Салом, квартира даркор, то 40 хазор" }],
    },
  });
});

afterEach(() => {
  aiCalls.length = 0;
  aiReply = null;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.botConversation.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Клиент из мессенджера, потом уточняющий звонок", () => {
  it("без звонка: черновик бота из переписки остаётся главным", async () => {
    aiReply = { budgetMin: 55000, budgetMax: 60000, rooms: 3, notes: "разбор переписки" };

    const suggestion = await buildCardFillSuggestion(clientId);

    // Разбор переписки — один взгляд со стороны, а черновик копился по всему диалогу
    // и пережил уточнения клиента. Он и побеждает.
    expect(suggestion.budgetMax).toBe(40000);
    expect(suggestion.rooms).toBe(2);
    expect(suggestion.source).toBe("chat");
  });

  it("после звонка: свежие слова клиента перебивают старую переписку", async () => {
    await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Звонок через CRM, разговор 3:10",
        transcript: "Агент: какой бюджет? Клиент: тысяч шестьдесят, и лучше трёхкомнатную.",
      },
    });
    aiReply = { budgetMin: 55000, budgetMax: 60000, rooms: 3, notes: "Ищет трёшку, бюджет вырос до 60 тысяч" };

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.budgetMax).toBe(60000);
    expect(suggestion.rooms).toBe(3);
    expect(suggestion.notes).toContain("трёшку");
    // Источник показывается агенту: он должен понимать, что проверяет — услышанное
    // в разговоре или вычитанное в переписке.
    expect(suggestion.source).toBe("call");
  });

  it("в разбор уходят и переписка, и расшифровка — модель видит всё общение сразу", async () => {
    aiReply = { budgetMin: 55000, budgetMax: 60000 };

    await buildCardFillSuggestion(clientId);

    expect(aiCalls).toHaveLength(1);
    const sent = aiCalls[0].user;
    expect(sent).toContain("Телефонный разговор");
    expect(sent).toContain("шестьдесят");
    // Переписка тоже на месте: иначе разбор потерял бы всё, что клиент написал раньше.
    expect(sent).toContain("Салом");
  });
});
