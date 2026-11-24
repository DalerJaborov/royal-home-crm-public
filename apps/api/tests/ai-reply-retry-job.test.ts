import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Задание ai-reply-retry (чертёж Б2): гварды «повторять нечего» и маршрутизация
 * исходов retryStuckConversation. Сам проигрыш хода замокан — его контракт
 * покрывают stuck-conversations-тесты.
 */
/**
 * Модуль подменяется ЦЕЛИКОМ, без importOriginal (07.09.2026).
 *
 * Настоящий stuckConversations тянет за собой весь messengers/conversation.ts —
 * то есть Meta, ИИ и половину прикладного графа. В общем процессе прогона
 * (fileParallelism: false, singleFork) это меняло состояние для ФАЙЛОВ,
 * идущих следом: после такого импорта в CI стабильно падал не связанный с
 * правкой ad-spend-matching (три прогона из трёх, при зелёном локальном).
 * Свойство «диалог на паузе крон больше не подхватывает» проверять здесь и не
 * нужно — оно уже покрыто отдельно: stuck-conversations.test.ts, тест «диалог
 * на паузе (оператор взял на себя) не подхватывается».
 */
vi.mock("../src/lib/stuckConversations.js", () => ({
  retryStuckConversation: vi.fn(),
  // Отпечаток ключа канала: тест меняет его, как будто аккаунт переподключили.
  channelKeyFingerprint: vi.fn(async () => "fp-old"),
}));

// Пуш при сдаче непроходимого хода — проверяем факт вызова, а не доставку.
const sendPushToAgent = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent }));
vi.mock("../src/lib/recipients.js", () => ({ findAgentsWithPermission: async () => ["agent-1"] }));
// Сигнал «клиент без ответа» при остановке повтора — проверяем вызов двери, а не доставку.
const alertClientWaiting = vi.hoisted(() => vi.fn(async () => "agent" as const));
vi.mock("../src/lib/clientWaitingAlert.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientWaitingAlert.js")>()), alertClientWaiting }));
const logSystemError = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError }));

import { prisma } from "../src/db.js";
import { channelKeyFingerprint, retryStuckConversation } from "../src/lib/stuckConversations.js";
import { aiReplyRetryJob } from "../src/jobs/aiReplyRetry.js";

const retryMock = vi.mocked(retryStuckConversation);

const CHANNEL = "INSTAGRAM";
const SUBSCRIBER = "test-ai-retry-sub";
let conversationId = "";

async function makeConversation(messages: unknown[], extra: Record<string, unknown> = {}) {
  await prisma.botConversation.deleteMany({ where: { channel: CHANNEL, subscriberId: SUBSCRIBER } });
  const row = await prisma.botConversation.create({
    data: { channel: CHANNEL, subscriberId: SUBSCRIBER, messages: messages as never, ...extra } as never,
  });
  conversationId = row.id;
  return row.id;
}

beforeEach(() => retryMock.mockReset());

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { channel: CHANNEL, subscriberId: SUBSCRIBER } });
  await prisma.$disconnect();
});

describe("задание ai-reply-retry", () => {
  it("последняя реплика клиентская → проигрывает ход, sent завершает задание", async () => {
    const id = await makeConversation([{ role: "user", content: "нархаш чанд?" }]);
    retryMock.mockResolvedValue("sent");
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).toHaveBeenCalledOnce();
    expect(retryMock.mock.calls[0][0]).toMatchObject({ id, lastText: "нархаш чанд?" });
  });

  it("уже отвечено (последняя реплика — бот) → повтора нет", async () => {
    const id = await makeConversation([
      { role: "user", content: "вопрос" },
      { role: "assistant", content: "ответ более свежего хода" },
    ]);
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).not.toHaveBeenCalled();
  });

  it("последняя реплика — бот с отметкой «не дошло» → ход проигрывается заново по реплике клиента", async () => {
    /**
     * Ночная проверка 24.09.2026: реплика бота пишется в историю ДО отправки, и
     * при отказе Meta повтор помечает её deliveryStatus:"failed". Такой «ответ»
     * клиент не видел — считать ход отвеченным и закрывать задание нельзя.
     */
    const id = await makeConversation([
      { role: "user", content: "нархаш чанд?" },
      { role: "assistant", content: "ответ, который не ушёл", by: { kind: "bot" }, deliveryStatus: "failed" },
    ]);
    retryMock.mockResolvedValue("sent");
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).toHaveBeenCalledOnce();
    expect(retryMock.mock.calls[0][0]).toMatchObject({ id, lastText: "нархаш чанд?" });
  });

  it("две недоставленные реплики бота подряд → всё ещё неотвечено, текст берётся у клиента", async () => {
    const id = await makeConversation([
      { role: "user", content: "вопрос" },
      { role: "assistant", content: "первая попытка", by: { kind: "bot" }, deliveryStatus: "failed" },
      { role: "assistant", content: "вторая попытка", by: { kind: "bot" }, deliveryStatus: "failed" },
    ]);
    retryMock.mockResolvedValue("sent");
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).toHaveBeenCalledOnce();
    expect(retryMock.mock.calls[0][0]).toMatchObject({ id, lastText: "вопрос" });
  });

  it("реплика бота доставлена (deliveryStatus: delivered) → повтора нет", async () => {
    const id = await makeConversation([
      { role: "user", content: "вопрос" },
      { role: "assistant", content: "ответ", by: { kind: "bot" }, mid: "m1", deliveryStatus: "delivered" },
    ]);
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).not.toHaveBeenCalled();
  });

  it("оператор ведёт диалог (pausedUntil в будущем) → бот не лезет", async () => {
    const id = await makeConversation([{ role: "user", content: "вопрос" }], {
      pausedUntil: new Date(Date.now() + 60 * 60_000),
    });
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).not.toHaveBeenCalled();
  });

  it("клиент отписался → повтора нет", async () => {
    const id = await makeConversation([{ role: "user", content: "не пишите" }], { optedOutAt: new Date() });
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).not.toHaveBeenCalled();
  });

  it("ИИ всё ещё лежит → исключение (очередь ретраит по лесенке)", async () => {
    const id = await makeConversation([{ role: "user", content: "вопрос" }]);
    retryMock.mockResolvedValue("ai-down");
    await expect(aiReplyRetryJob.run({ conversationId: id })).rejects.toThrow(/недоступен/);
  });

  it("диалог удалён → тихое завершение", async () => {
    await expect(aiReplyRetryJob.run({ conversationId: "00000000-0000-0000-0000-000000000000" })).resolves.toBeUndefined();
    expect(retryMock).not.toHaveBeenCalled();
  });
});

/**
 * РАЗМЫКАНИЕ ПЕТЛИ НА НЕПРОХОДИМОМ ХОДЕ (живой случай 03–07.09.2026: клиент
 * прислал фото человека с вопросом «он вам не знаком?», Gemini блокирует такой
 * промт своей политикой НАВСЕГДА). Крон «здоровье системы» каждые 30 минут видел
 * диалог без ответа и ставил новое задание — 415 заданий и ~19 000 оплаченных
 * вызовов модели по одной переписке, пока живой клиент ждал ответа.
 */
describe("сдача задания: петля на непроходимом ходе", () => {
  /** Сдачи считаются по журналу заданий — заводим их столько, сколько нужно сценарию. */
  async function seedGiveUps(id: string, count: number) {
    await prisma.backgroundJob.deleteMany({ where: { type: "ai-reply-retry" } });
    for (let i = 0; i < count; i++) {
      await prisma.backgroundJob.create({
        data: {
          type: "ai-reply-retry",
          payload: { conversationId: id },
          status: "GIVEN_UP",
          maxAttempts: 46,
          attempts: 46,
        },
      });
    }
  }

  it("первая сдача — авария поставщика: бота с диалога не снимаем, человека не дёргаем", async () => {
    const id = await makeConversation([{ role: "user", content: "вопрос" }]);
    await seedGiveUps(id, 1);
    sendPushToAgent.mockClear();

    await aiReplyRetryJob.onGiveUp!({ conversationId: id });

    const after = await prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true } });
    expect(after?.pausedUntil).toBeNull();
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("вторая сдача подряд — бот снят с диалога, позван человек, крон больше не ставит заданий", async () => {
    // lastMessageAt сегодняшний: именно по этому условию крон и отбирает «зависших».
    const id = await makeConversation([{ role: "user", content: "он вам не знаком?" }], {
      lastMessageAt: new Date(),
    });
    await seedGiveUps(id, 2);
    sendPushToAgent.mockClear();

    await aiReplyRetryJob.onGiveUp!({ conversationId: id });

    /**
     * Петля разорвана: диалог помечен паузой оператора, а такие диалоги крон
     * «здоровье системы» не подхватывает — это и крутило круг. Само исключение
     * паузы из выборки проверяет stuck-conversations.test.ts («диалог на паузе
     * (оператор взял на себя) не подхватывается»), поэтому здесь достаточно
     * убедиться, что пауза действительно проставлена и она в будущем.
     */
    const after = await prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true } });
    expect(after?.pausedUntil).not.toBeNull();
    expect(after!.pausedUntil!.getTime()).toBeGreaterThan(Date.now());
    // И человека позвали — клиент ждёт живого ответа.
    expect(sendPushToAgent).toHaveBeenCalled();
    expect(sendPushToAgent.mock.calls[0][1]).toMatchObject({ url: `/messages?open=${id}` });
  });

  /**
   * АУДИТ CODEX 04.10.2026, JOB-05: сдачи считались по диалогу БЕЗ границы по времени,
   * а строки GIVEN_UP нигде не чистятся. Старая авария месячной давности плюс новая
   * первая сдача давали «две подряд» и ложно снимали бота с диалога.
   */
  it("JOB-05: старая сдача месячной давности + свежая первая — это НЕ вторая подряд, бота не снимаем", async () => {
    const id = await makeConversation([{ role: "user", content: "вопрос" }]);
    await prisma.backgroundJob.deleteMany({ where: { type: "ai-reply-retry" } });
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await prisma.backgroundJob.create({
      data: {
        type: "ai-reply-retry", payload: { conversationId: id }, status: "GIVEN_UP",
        maxAttempts: 46, attempts: 46, createdAt: monthAgo, updatedAt: monthAgo,
      },
    });
    await prisma.backgroundJob.create({
      data: { type: "ai-reply-retry", payload: { conversationId: id }, status: "GIVEN_UP", maxAttempts: 46, attempts: 46 },
    });
    sendPushToAgent.mockClear();

    await aiReplyRetryJob.onGiveUp!({ conversationId: id });

    const after = await prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true } });
    expect(after?.pausedUntil).toBeNull();
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("JOB-05: две свежие сдачи в пределах окна по-прежнему снимают бота", async () => {
    const id = await makeConversation([{ role: "user", content: "он вам не знаком?" }], { lastMessageAt: new Date() });
    await prisma.backgroundJob.deleteMany({ where: { type: "ai-reply-retry" } });
    const yesterday = new Date(Date.now() - 20 * 60 * 60 * 1000);
    await prisma.backgroundJob.create({
      data: {
        type: "ai-reply-retry", payload: { conversationId: id }, status: "GIVEN_UP",
        maxAttempts: 46, attempts: 46, createdAt: yesterday, updatedAt: yesterday,
      },
    });
    await prisma.backgroundJob.create({
      data: { type: "ai-reply-retry", payload: { conversationId: id }, status: "GIVEN_UP", maxAttempts: 46, attempts: 46 },
    });
    await aiReplyRetryJob.onGiveUp!({ conversationId: id });
    const after = await prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true } });
    expect(after?.pausedUntil).not.toBeNull();
  });

  afterAll(async () => {
    await prisma.backgroundJob.deleteMany({ where: { type: { in: ["ai-reply-retry", "ai-turn-blocked-followup"] } } });
  });
});

/**
 * ПОТОЛОК ПОВТОРА НА РЕПЛИКУ КЛИЕНТА (разбор прода 24.11.2026): крон каждые 30 минут ставил новое задание на переписку
 * без ответа, задание завершалось «отвечать не нужно», и так 31–35 раз по одной переписке. Счёт на реплике, в базе.
 */
describe("потолок фонового повтора (jobs/aiReplyRetryCap.ts)", () => {
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const fingerprintMock = vi.mocked(channelKeyFingerprint);
  async function setCap(on: boolean) {
    await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", botRetryCapEnabled: on } as never,
      update: { botRetryCapEnabled: on } });
  }
  const stopLines = () => logSystemError.mock.calls.filter((c) => String(c[1]).includes("Повтор ответа бота остановлен"));
  beforeEach(async () => {
    alertClientWaiting.mockClear();
    logSystemError.mockClear();
    fingerprintMock.mockResolvedValue("fp-old");
    await prisma.processedMessage.deleteMany({ where: { channel: "ai-retry-no-reply" } });
    await setCap(true);
  });
  afterAll(async () => {
    await prisma.processedMessage.deleteMany({ where: { channel: "ai-retry-no-reply" } });
    await setCap(true);
  });

  it("три пустых повтора одной реплики — дальше без хода; людям не сигналим (это дело сторожа молчания), журнал — раз", async () => {
    const id = await makeConversation([{ role: "user", content: "салом", at }]);
    retryMock.mockResolvedValue("no-reply");
    for (let i = 0; i < 5; i++) await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).toHaveBeenCalledTimes(3);
    expect(alertClientWaiting).not.toHaveBeenCalled();
    expect(stopLines()).toHaveLength(1);
    expect(stopLines()[0][2]).toMatchObject({ dedupKey: `ai-retry-stop:${id}` });
    // В журнале только служебный id переписки — ни слов клиента, ни имени.
    expect(String(stopLines()[0][1])).not.toContain("салом");
  });

  it("мёртвый ключ — стоп сразу (без лесенки), один сигнал «ответьте вручную»; переподключили аккаунт — ответ уходит", async () => {
    const id = await makeConversation([{ role: "user", content: "нарх?", at }]);
    retryMock.mockResolvedValue("channel-dead");
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(alertClientWaiting).toHaveBeenCalledTimes(1);
    const why = String((alertClientWaiting.mock.calls[0][0] as { why?: string }).why);
    expect(why).toContain("ключ канала");
    // Агенту нечего переподключать: текст не шлёт его в Настройки.
    expect(why).not.toMatch(/Настройк|переподключ/u);
    // Владелец переподключил аккаунт: ключ другой — крон или кнопка снова пробуют, и ответ уходит.
    fingerprintMock.mockResolvedValue("fp-new");
    retryMock.mockResolvedValue("sent");
    await expect(aiReplyRetryJob.run({ conversationId: id })).resolves.toBeUndefined();
    expect(retryMock).toHaveBeenCalledTimes(2);
  });

  it("сигнал до метки: упали между ними — следующий повтор доводит остановку, сигнал не теряется", async () => {
    const id = await makeConversation([{ role: "user", content: "нарх?", at }]);
    retryMock.mockResolvedValue("channel-dead");
    alertClientWaiting.mockRejectedValueOnce(new Error("сбой сети"));
    await aiReplyRetryJob.run({ conversationId: id });
    // Метки нет — повтор ещё раз, и теперь сигнал уходит.
    await aiReplyRetryJob.run({ conversationId: id });
    await aiReplyRetryJob.run({ conversationId: id });
    expect(retryMock).toHaveBeenCalledTimes(2);
    expect(alertClientWaiting).toHaveBeenCalledTimes(2);
    expect(await alertClientWaiting.mock.results[1].value).toBe("agent");
  });

  it("кнопка «Повторить зависшим» снимает остановку и счёт (resetAiRetryCap)", async () => {
    const { resetAiRetryCap } = await import("../src/jobs/aiReplyRetryCap.js");
    const id = await makeConversation([{ role: "user", content: "салом", at }]);
    retryMock.mockResolvedValue("no-reply");
    for (let i = 0; i < 4; i++) await aiReplyRetryJob.run({ conversationId: id });
    expect(retryMock).toHaveBeenCalledTimes(3);
    expect(await resetAiRetryCap([id])).toBe(4);
    retryMock.mockResolvedValue("sent");
    await aiReplyRetryJob.run({ conversationId: id });
    expect(retryMock).toHaveBeenCalledTimes(4);
  });

  it("новая реплика клиента — новый счёт: бот снова пробует ответить", async () => {
    const id = await makeConversation([{ role: "user", content: "салом", at }]);
    retryMock.mockResolvedValue("no-reply");
    for (let i = 0; i < 4; i++) await aiReplyRetryJob.run({ conversationId: id });
    expect(retryMock).toHaveBeenCalledTimes(3);
    await prisma.botConversation.update({ where: { id }, data: { messages: [{ role: "user", content: "салом", at },
      { role: "user", content: "хона доред?", at: new Date().toISOString() }] as never } });
    await aiReplyRetryJob.run({ conversationId: id });
    expect(retryMock).toHaveBeenCalledTimes(4);
  });

  it("«ИИ лежит» и обычный сбой не считаются: лесенка поставщика как раньше", async () => {
    const id = await makeConversation([{ role: "user", content: "вопрос", at }]);
    retryMock.mockResolvedValue("ai-down");
    for (let i = 0; i < 4; i++) await expect(aiReplyRetryJob.run({ conversationId: id })).rejects.toThrow(/недоступен/);
    retryMock.mockResolvedValue("failed");
    await expect(aiReplyRetryJob.run({ conversationId: id })).rejects.toThrow(/не удался/);
    expect(retryMock).toHaveBeenCalledTimes(5);
    expect(alertClientWaiting).not.toHaveBeenCalled();
  });

  it("рубильник выключен — прежнее поведение: повторы без потолка, мёртвый ключ — обычный сбой (лесенка)", async () => {
    await setCap(false);
    const id = await makeConversation([{ role: "user", content: "салом", at }]);
    retryMock.mockResolvedValue("no-reply");
    for (let i = 0; i < 5; i++) await aiReplyRetryJob.run({ conversationId: id });
    expect(retryMock).toHaveBeenCalledTimes(5);
    retryMock.mockResolvedValue("channel-dead");
    await expect(aiReplyRetryJob.run({ conversationId: id })).rejects.toThrow(/ключ канала/);
    expect(alertClientWaiting).not.toHaveBeenCalled();
  });

  it("рубильник подписан и по умолчанию включён", async () => {
    const { AUTOMATION_SWITCH_LABELS, isAutomationSwitchOn } = await import("@royal-home/shared");
    expect(AUTOMATION_SWITCH_LABELS.botRetryCapEnabled.title).toBeTruthy();
    expect(isAutomationSwitchOn(null, "botRetryCapEnabled")).toBe(true);
  });
});
