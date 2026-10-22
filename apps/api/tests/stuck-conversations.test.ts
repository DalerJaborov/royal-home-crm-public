import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";

/**
 * ЗАВИСШИЕ ДИАЛОГИ — src/lib/stuckConversations.ts (кнопка «Повторить зависшим
 * диалогам» + периодический крон). Модуль МАССОВО пишет живым клиентам, поэтому
 * здесь проверяется сама библиотека, без HTTP-слоя (маршрут покрыт в
 * stuck-conversations-retry.test.ts):
 *
 *  1) findStuckConversations находит ТОЛЬКО настоящие зависшие: последняя
 *     реплика — от клиента, сегодня, без паузы оператора и без «не пишите мне»;
 *  2) retryAllStuckConversations шлёт ровно одно сообщение каждому зависшему —
 *     ни одному постороннему и никому дважды;
 *  3) сбой одного диалога не роняет остальные (иначе один битый канал глушил бы
 *     всю пачку);
 *  4) после успешного повтора история кончается ответом бота, и повторный поиск
 *     диалог больше не находит — механизм идемпотентности между прогонами крона.
 *
 * Вся отправка в мессенджеры замокана: реальных вызовов Graph API быть не должно.
 */

const { sendMessage, processMessengerTurn, stampOutgoingMid, markLastReplyUndelivered,
  accountTokenById, listAccounts, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => "mid-out-1"), processMessengerTurn: vi.fn(),
  stampOutgoingMid: vi.fn(async () => undefined), markLastReplyUndelivered: vi.fn(async () => undefined),
  accountTokenById: vi.fn(async () => ({ id: undefined, title: undefined, token: "tok-test" })),
  listAccounts: vi.fn(async (): Promise<{ id: string; externalId: string }[]> => []),
  logSystemError: vi.fn(async () => undefined),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessage,
}));

// Отметка «не дошло» — сама функция покрыта send-failure-marked-undelivered.test.ts,
// здесь проверяется только, что повтор её зовёт (24.09.2026, ночная проверка).
vi.mock("../src/messengers/conversation.js", () => ({ processMessengerTurn, stampOutgoingMid, markLastReplyUndelivered }));

vi.mock("../src/messengers/accounts.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/messengers/accounts.js")>()), accountTokenById, listAccounts,
}));

// Между отправками модуль спит 1200/1500 мс — в тестах не спим вовсе.
vi.mock("../src/messengers/humanPacing.js", () => ({ sleep: vi.fn(async () => undefined) }));

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { findStuckConversations, retryAllStuckConversations, retryStuckConversation } = await import(
  "../src/lib/stuckConversations.js"
);
type StuckRow = Awaited<ReturnType<typeof findStuckConversations>>[number];
const { prisma } = await import("../src/db.js");

const runId = Date.now().toString(36);
const conversationIds: string[] = [];
const inquiryIds = new Set<string>();
const extraScopeIds = new Set<string>();
let facebook: CustomerMessengerFixture;
beforeAll(async () => { facebook = await createCustomerMessengerFixture("FACEBOOK"); });

/** Диалог, зависший по всем признакам; overrides ломают ровно один признак. */
async function makeConversation(suffix: string, overrides: Record<string, unknown> = {}) {
  const subscriberId = `stucklib-${runId}-${suffix}`;
  const channel = typeof overrides.channel === "string" ? overrides.channel : "FACEBOOK";
  const scoped = channel === "FACEBOOK" || channel === "WEBSITE"
    ? await prisma.$transaction(tx => ensureScopedBotConversation(tx, {
      channel, subscriberId,
      ...(channel === "FACEBOOK" ? typeof overrides.accountId === "string"
        ? { accountId: overrides.accountId } : { transport: facebook.transport } : {}),
    })) : null;
  const data = {
    messages: [{ role: "user", content: `Салом, хона доред? (${suffix})` }],
    lastMessageAt: new Date(Date.now() - 6 * 60 * 1000), ...overrides,
  };
  if (scoped) {
    const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: scoped.id }, select: { id: true } });
    inquiryIds.add(inquiry.id);
    if (typeof overrides.accountId === "string") extraScopeIds.add(scoped.transport.endpointScopeId);
    const conv = await prisma.botConversation.update({ where: { id: scoped.id }, data });
    conversationIds.push(conv.id); return conv;
  }
  // Intentionally unsupported channel stays unknown; it must never acquire
  // the configured Meta scope or permission to send.
  const conv = await prisma.botConversation.create({
    data: {
      channel, subscriberId,
      // Старше пяти минут: свежую реплику ещё обрабатывает живой ход (28.09.2026).
      ...data,
    },
  });
  conversationIds.push(conv.id);
  return conv;
}

/** База общая с другими данными — сверяем только свои диалоги по id. */
async function findOurStuck(): Promise<StuckRow[]> {
  const rows = await findStuckConversations();
  return rows.filter((r) => conversationIds.includes(r.id));
}

const okTurn = { reply: "Хуб, чӣ мехоҳед?", ready: false, accepted: false, shouldReply: true };

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue("mid-out-1");
  stampOutgoingMid.mockClear();
  markLastReplyUndelivered.mockClear();
  logSystemError.mockClear();
  accountTokenById.mockClear();
  processMessengerTurn.mockReset();
  processMessengerTurn.mockResolvedValue(okTurn);
});

afterEach(async () => {
  await facebook.cleanupConversations();
  await prisma.customerInquiry.deleteMany({ where: { id: { in: [...inquiryIds] } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  conversationIds.length = 0;
  inquiryIds.clear();
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...extraScopeIds] } } });
  extraScopeIds.clear();
});

afterAll(async () => {
  await facebook.dispose();
  await prisma.$disconnect();
});

describe("findStuckConversations — кто считается зависшим", () => {
  it("последняя реплика клиента сегодня без ответа — зависший, с текстом реплики", async () => {
    const conv = await makeConversation("hang");

    const rows = await findOurStuck();

    expect(rows.map((r) => r.id)).toContain(conv.id);
    const row = rows.find((r) => r.id === conv.id)!;
    expect(row.channel).toBe("FACEBOOK");
    expect(row.subscriberId).toBe(`stucklib-${runId}-hang`);
    expect(row.lastText).toBe("Салом, хона доред? (hang)");
  });

  it("диалог, где последним ответил бот, зависшим не считается", async () => {
    const conv = await makeConversation("answered", {
      messages: [
        { role: "user", content: "Салом" },
        { role: "assistant", content: "Салом! Чӣ мехоҳед?", by: { kind: "bot" } },
      ],
    });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });

  it("вчерашний диалог не подхватывается: повтор — только про сегодняшние сбои", async () => {
    const conv = await makeConversation("old", {
      lastMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });

  it("диалог на паузе (оператор взял на себя) не подхватывается", async () => {
    const conv = await makeConversation("paused", {
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000),
    });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });

  it("истёкшая пауза больше не защищает — диалог снова зависший", async () => {
    const conv = await makeConversation("pause-over", {
      pausedUntil: new Date(Date.now() - 60 * 1000),
    });

    expect((await findOurStuck()).map((r) => r.id)).toContain(conv.id);
  });

  it("«не пишите мне» (optedOutAt) исключает диалог безусловно", async () => {
    const conv = await makeConversation("optout", { optedOutAt: new Date() });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });

  it("диалог с пустой историей сообщений не подхватывается", async () => {
    const conv = await makeConversation("empty", { messages: [] });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });

  /**
   * РЕГРЕССИЯ 14.09.2026 (скриншоты владельца, лид «Сафия»): клиент с живым
   * закреплённым агентом — бот молчит НАМЕРЕННО (conversationState.ts
   * hasActiveAssignedAgent), это не «завис», а «ждёт человека». До правки
   * такой диалог считался зависшим и на каждом тике health-automation заново
   * ставил ai-reply-retry, который «успешно» завершался (no-reply) и попутно
   * слал агенту тот же пуш с сообщением клиента — раз в 30 минут бесконечно.
   */
  it("клиент с живым закреплённым агентом не считается зависшим", async () => {
    const agent = await prisma.agent.create({
      data: { fullName: `Тест агент ${runId}`, phone: `+992900${runId}`, role: "AGENT", passwordHash: "x" },
    });
    const client = await prisma.client.create({
      data: { fullName: `Тест клиент ${runId}`, phone: `+992901${runId}`, source: "PHONE_CALL", assignedAgentId: agent.id },
    });
    const conv = await makeConversation("assigned", { clientId: client.id });

    try {
      expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
    } finally {
      await prisma.client.delete({ where: { id: client.id } });
      await prisma.agent.delete({ where: { id: agent.id } });
    }
  });

  it("клиент LOST с формально закреплённым агентом остаётся зависшим (брошен, бот обязан ответить)", async () => {
    const agent = await prisma.agent.create({
      data: { fullName: `Тест агент лост ${runId}`, phone: `+992902${runId}`, role: "AGENT", passwordHash: "x" },
    });
    const client = await prisma.client.create({
      data: {
        fullName: `Тест клиент лост ${runId}`,
        phone: `+992903${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agent.id,
        status: "LOST",
      },
    });
    const conv = await makeConversation("assigned-lost", { clientId: client.id });

    try {
      expect((await findOurStuck()).map((r) => r.id)).toContain(conv.id);
    } finally {
      await prisma.client.delete({ where: { id: client.id } });
      await prisma.agent.delete({ where: { id: agent.id } });
    }
  });
});

describe("retryAllStuckConversations — отправка только зависшим и ровно по разу", () => {
  it("каждый зависший получает ровно одно сообщение, посторонние — ни одного", async () => {
    await makeConversation("send-a");
    await makeConversation("send-b");
    // Посторонние: уже отвеченный и отписавшийся — их в выборке быть не должно.
    await makeConversation("send-done", {
      messages: [
        { role: "user", content: "Салом" },
        { role: "assistant", content: "Салом!", by: { kind: "bot" } },
      ],
    });
    await makeConversation("send-optout", { optedOutAt: new Date() });

    const rows = await findOurStuck();
    expect(rows).toHaveLength(2);

    const result = await retryAllStuckConversations(rows);

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const recipients = sendMessage.mock.calls.map((c) => c[1] as string).sort();
    expect(recipients).toEqual([`stucklib-${runId}-send-a`, `stucklib-${runId}-send-b`]);
    // Токен берётся через accountTokenById, а не глобальный по умолчанию.
    expect(sendMessage.mock.calls.every((c) => c[3] === "tok-test")).toBe(true);
  });

  it("ход проигрывается на сохранённой истории: та же реплика и skipSaveIncoming, без дубля в истории", async () => {
    const rows = await findOurStuck();
    expect(rows).toHaveLength(0);
    await makeConversation("replay");

    await retryAllStuckConversations(await findOurStuck());

    expect(processMessengerTurn).toHaveBeenCalledTimes(1);
    expect(processMessengerTurn.mock.calls[0][0]).toMatchObject({
      channel: "FACEBOOK",
      subscriberId: `stucklib-${runId}-replay`,
      text: "Салом, хона доред? (replay)",
      skipSaveIncoming: true,
    });
  });

  it("CHANNEL-NEW-11: диалог выключенного аккаунта повтор не отправляет и ИИ не тратит", async () => {
    const account = await prisma.messengerAccount.create({
      data: { channel: "FACEBOOK", externalId: `stuck-off-${runId}`, title: "Выключенный аккаунт", token: "x", enabled: false },
    });
    try {
      // accountTokenById помечает выключенный аккаунт: токен у него настоящий, а слать им нельзя.
      accountTokenById.mockResolvedValue({ id: account.id, title: account.title, token: "tok-off", disabled: true } as never);
      const conv = await makeConversation("disabled-account", { accountId: account.id });
      const [row] = (await findOurStuck()).filter((r) => r.id === conv.id);

      expect(await retryStuckConversation(row)).toBe("no-reply");

      expect(processMessengerTurn).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      accountTokenById.mockImplementation(async () => ({ id: undefined, title: undefined, token: "tok-test" }));
      await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
      await prisma.messengerAccount.delete({ where: { id: account.id } });
    }
  });
  it("второй «пузырь» (reply2) уходит тем же получателем вторым сообщением", async () => {
    processMessengerTurn.mockResolvedValue({ ...okTurn, reply2: "Ва боз як савол" });
    await makeConversation("bubble2");

    const result = await retryAllStuckConversations(await findOurStuck());

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][2]).toBe(okTurn.reply);
    expect(sendMessage.mock.calls[1][2]).toBe("Ва боз як савол");
    expect(sendMessage.mock.calls[1][1]).toBe(`stucklib-${runId}-bubble2`);
  });

  it("бот решил молчать (shouldReply: false) — клиенту не отправляется ничего", async () => {
    processMessengerTurn.mockResolvedValue({ reply: "", ready: true, accepted: true, shouldReply: false });
    await makeConversation("silent");

    const result = await retryAllStuckConversations(await findOurStuck());

    // Молчание — не успех и не сбой: в счётчики не попадает.
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("сбой одного диалога не роняет остальные: соседи получают ответы, сбой уходит в журнал", async () => {
    await makeConversation("mix-a");
    await makeConversation("mix-bad");
    await makeConversation("mix-c");

    processMessengerTurn.mockImplementation(async (input: { subscriberId: string }) => {
      if (input.subscriberId === `stucklib-${runId}-mix-bad`) throw new Error("Gemini недоступен");
      return okTurn;
    });

    const rows = await findOurStuck();
    expect(rows).toHaveLength(3);
    const result = await retryAllStuckConversations(rows);

    expect(result).toEqual({ sent: 2, failed: 1 });
    const recipients = sendMessage.mock.calls.map((c) => c[1] as string).sort();
    expect(recipients).toEqual([`stucklib-${runId}-mix-a`, `stucklib-${runId}-mix-c`]);
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(String(logSystemError.mock.calls[0][1])).toContain("не удался");
  });

  it("сбой самой отправки в мессенджер — failed, но пачка идёт дальше", async () => {
    await makeConversation("net-a");
    await makeConversation("net-b");

    sendMessage
      .mockRejectedValueOnce(new Error("Graph API 500"))
      .mockResolvedValue("mid-out-2");

    const result = await retryAllStuckConversations(await findOurStuck());

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(logSystemError).toHaveBeenCalledTimes(1);
  });

  it("сбой отправки в Meta — реплика бота помечается «не дошло», как в вебхуке и в Telegram", async () => {
    /**
     * Ночная проверка 24.09.2026: повтор зависшего — единственный из четырёх путей
     * отправки, который при отказе Meta не ставил отметку. Реплика бота уже
     * дописана в историю внутри processMessengerTurn, и без отметки задание
     * ai-reply-retry на следующей попытке видело «последняя реплика — бот» и
     * закрывалось как «уже отвечено»: клиент без ответа, в CRM ответ выглядит
     * отправленным.
     */
    const conv = await makeConversation("undelivered");
    sendMessage.mockRejectedValueOnce(new Error("Graph API 500"));
    // Use the real captured native snapshot. A different text/timestamp is an
    // intentionally stale job and must stop before the model or transport.
    const snapshot = (await findOurStuck()).find(row => row.id === conv.id)!;
    expect(snapshot).toBeDefined();
    const result = await retryStuckConversation(snapshot);

    expect(result).toBe("failed");
    expect(markLastReplyUndelivered).toHaveBeenCalledTimes(1);
    expect(markLastReplyUndelivered).toHaveBeenCalledWith("FACEBOOK", conv.subscriberId,
      { ...facebook.transport, subscriberId: conv.subscriberId });
  });

  it("отправка удалась — отметку «не дошло» не ставим", async () => {
    await makeConversation("delivered");

    const result = await retryAllStuckConversations(await findOurStuck());

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(markLastReplyUndelivered).not.toHaveBeenCalled();
  });

  it("чат на сайте — ход проигрывается, в сеть не ходим и ошибку не пишем", async () => {
    // 11.09.2026: раньше WEBSITE попадал в ветку «неизвестный канал», и посетитель
    // сайта, чьё сообщение застало ИИ занятым, не получал ответа никогда.
    const conv = await makeConversation("website", { channel: "WEBSITE" });
    const snapshot = (await findOurStuck()).find(row => row.id === conv.id)!;
    expect(snapshot).toBeDefined();
    const result = await retryStuckConversation(snapshot);

    expect(result).toBe("sent");
    expect(processMessengerTurn).toHaveBeenCalledTimes(1);
    expect((processMessengerTurn.mock.calls[0][0] as { channel: string }).channel).toBe("WEBSITE");
    // Реплику в переписку пишет сам processMessengerTurn, посетитель забирает её
    // опросом — Graph API здесь не при чём.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("неизвестный канал — failed без единой попытки отправить", async () => {
    const conv = await makeConversation("badchan", { channel: "TELEGRAM" });
    const snapshot = (await findOurStuck()).find(row => row.id === conv.id)!;
    expect(snapshot).toBeDefined();
    const result = await retryStuckConversation(snapshot);

    expect(result).toBe("failed");
    expect(processMessengerTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logSystemError).toHaveBeenCalledTimes(1);
  });
});

describe("идемпотентность между прогонами", () => {
  it("после успешного повтора история кончается ответом бота — второй прогон диалог не находит", async () => {
    const conv = await makeConversation("idem");

    // Настоящий processMessengerTurn дописывает ответ бота в историю
    // (appendConversationMessages) — мок делает то же самое, чтобы проверить
    // именно контракт: «последняя реплика — assistant» выводит диалог из выборки.
    processMessengerTurn.mockImplementation(async () => {
      const current = await prisma.botConversation.findUniqueOrThrow({
        where: { id: conv.id },
        select: { messages: true },
      });
      const messages = current.messages as { role: string; content: string }[];
      await prisma.botConversation.update({
        where: { id: conv.id },
        data: { messages: [...messages, { role: "assistant", content: okTurn.reply, by: { kind: "bot" } }] },
      });
      return okTurn;
    });

    const first = await findOurStuck();
    expect(first.map((r) => r.id)).toContain(conv.id);
    expect(await retryAllStuckConversations(first)).toEqual({ sent: 1, failed: 0 });

    // Повторный прогон (крон через час, вторая кнопка) — диалога в выборке нет,
    // клиент второго сообщения не получит.
    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
