import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Скоринг клиента обязан видеть переписку с ботом, а не только структурную
 * хронологию (Interaction).
 *
 * НАЙДЕНО ВЛАДЕЛЬЦЕМ 12.08.2026 на живом клиенте: клиент прямым текстом написал
 * боту «покупаю 100%, когда договор подписывать, деньги наличкой», а оценка
 * осталась той же, что стояла до этого сообщения. Причина — `scoreClient` строил
 * запрос к модели только из `client.interactions`, ничего не зная о живой
 * переписке (BotConversation/TelegramConversation.messages): слова клиента
 * физически не попадали в запрос.
 */

const aiCalls: { user: string }[] = [];
let aiReply: { score: number; reason: string } | null = null;
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: async (params: { user?: string }) => {
    aiCalls.push({ user: params.user ?? "" });
    return aiReply;
  },
}));

const { prisma } = await import("../src/db.js");
const { scoreClient } = await import("../src/ai/scoring.js");

const runId = Date.now();
let agentId = "";
let clientId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент скоринга ${runId}`, phone: `+99263${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент скоринга ${runId}`,
      phone: `+99264${String(runId).slice(-7)}`,
      source: "WHATSAPP",
      status: "HOT",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

afterEach(async () => {
  aiCalls.length = 0;
  aiReply = null;
  await prisma.botConversation.deleteMany({ where: { clientId } });
  await prisma.telegramConversation.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Скоринг видит живую переписку, а не только хронологию", () => {
  it("текст клиента из WhatsApp попадает в запрос к модели", async () => {
    aiReply = { score: 95, reason: "Готов купить, называет сроки" };
    await prisma.botConversation.create({
      data: {
        clientId,
        channel: "WHATSAPP",
        subscriberId: `wa-${runId}`,
        messages: [
          { role: "user", content: "Все. Покупаю 100% когда идем подписывать договор? Деньги у меня наличкой." },
          { role: "assistant", content: "Отлично! Сейчас передам агенту, он свяжется с вами." },
        ],
      },
    });

    const result = await scoreClient(clientId);

    expect(result).toEqual({ aiScore: 95, aiScoreReason: "Готов купить, называет сроки" });
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].user).toContain("Покупаю 100%");
    expect(aiCalls[0].user).toContain("ПЕРЕПИСКА");

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.aiScore).toBe(95);
    expect(client?.aiScoreReason).toBe("Готов купить, называет сроки");
  });

  it("работает и без переписки — только по хронологии, как раньше", async () => {
    aiReply = { score: 40, reason: "Пока присматривается" };
    await prisma.interaction.create({
      data: { clientId, agentId, type: "SYSTEM", notes: "Лид принят агентом" },
    });

    const result = await scoreClient(clientId);

    expect(result).toEqual({ aiScore: 40, aiScoreReason: "Пока присматривается" });
    expect(aiCalls[0].user).toContain("ХРОНОЛОГИЯ");
    expect(aiCalls[0].user).not.toContain("ПЕРЕПИСКА");

    await prisma.interaction.deleteMany({ where: { clientId } });
  });

  it("нет ни хронологии, ни переписки — модель всё равно вызывается честным текстом", async () => {
    // 25.08.2026: user больше не может быть буквально "Ни хронологии, ни переписки
    // нет." — ФАКТЫ О КЛИЕНТЕ (источник, дата контакта и т.п.) уходят в модель
    // всегда, даже без единого взаимодействия (см. scoring.ts). Честность здесь —
    // не пустой user, а отсутствие ВЫДУМАННЫХ хронологии/переписки.
    aiReply = { score: 10, reason: "Данных пока нет" };
    await scoreClient(clientId);
    expect(aiCalls[0].user).toContain("ФАКТЫ О КЛИЕНТЕ");
    expect(aiCalls[0].user).not.toContain("ХРОНОЛОГИЯ");
    expect(aiCalls[0].user).not.toContain("ПЕРЕПИСКА");
  });

  it("переписка из Telegram тоже учитывается, если WhatsApp/бота нет", async () => {
    aiReply = { score: 80, reason: "Просит договор" };
    await prisma.telegramConversation.create({
      data: {
        clientId,
        chatId: `tg-${runId}`,
        messages: [{ role: "user", content: "Готов подписать договор на этой неделе" }],
      },
    });

    await scoreClient(clientId);
    expect(aiCalls[0].user).toContain("подписать договор");
  });

  it("статус вне скоринга (LOST/архив) не вызывает модель вовсе", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { status: "LOST" } });
    const result = await scoreClient(clientId);
    expect(result).toBeNull();
    expect(aiCalls).toHaveLength(0);
    await prisma.client.update({ where: { id: clientId }, data: { status: "HOT" } });
  });

  /**
   * НАЙДЕНО 18.09.2026 (кейс продавца Дильнозы): scoreClient проверял свой
   * собственный, более узкий список статусов (NEW/CONTACTED/HOT), а
   * lib/clientAutopilot.ts уже считал COLD рабочим — вызов автопилота на
   * остывшей карточке молча ничего не делал, и «Коротко от ИИ» замерзало
   * навсегда с последнего дня, когда клиент был не COLD. Списки сведены к
   * одному — SCORABLE_CLIENT_STATUSES.
   */
  it("COLD — рабочий статус, скоринг проходит (раньше молча пропускался)", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { status: "COLD" } });
    aiReply = { score: 30, reason: "Остыл, но ещё в работе" };
    const result = await scoreClient(clientId);
    expect(result).toEqual({ aiScore: 30, aiScoreReason: "Остыл, но ещё в работе" });
    expect(aiCalls).toHaveLength(1);
    await prisma.client.update({ where: { id: clientId }, data: { status: "HOT" } });
  });

  /**
   * ЖИВОЙ КЛАСС 27.08.2026 (сплошная охота). Удаление карточки статус не
   * трогает — без проверки deletedAt клиент, удалённый вчера, платно скорился
   * бы каждую ночь ещё месяц (пока хронология за 30 дней не истечёт).
   */
  it("удалённая карточка (Корзина) не вызывает модель вовсе", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: new Date() } });
    aiCalls.length = 0;
    const result = await scoreClient(clientId);
    expect(result).toBeNull();
    expect(aiCalls).toHaveLength(0);
    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: null } });
  });

  it("scoreAllActiveClients пропускает удалённых клиентов в ночной выборке", async () => {
    const { scoreAllActiveClients } = await import("../src/ai/scoring.js");
    // Уникальная фраза-маркер — отличить запрос ИМЕННО по этому клиенту от
    // остальных активных клиентов в общей тестовой базе (крон сканирует всех).
    const marker = `маркер-удалённого-${runId}`;
    await prisma.interaction.create({
      data: { clientId, agentId, type: "SYSTEM", notes: marker },
    });
    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: new Date() } });
    aiCalls.length = 0;

    await scoreAllActiveClients();

    expect(aiCalls.some((c) => c.user.includes(marker))).toBe(false);
    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: null } });
  });
});
