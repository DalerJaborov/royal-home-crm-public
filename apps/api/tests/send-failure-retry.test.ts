import { afterAll, afterEach, describe, expect, it } from "vitest";

/**
 * НЕУДАЧНАЯ ОТПРАВКА — ТОЖЕ «ЗАВИСШИЙ» ДИАЛОГ (24.09.2026, ночная проверка,
 * находка №108).
 *
 * Ночью #848 (журнал docs/journal/2026-09-24-povtor-nedostavlen-i-pauza-avtootveta.md)
 * научил повтор зависшего ставить deliveryStatus:"failed" на реплику бота при
 * отказе Meta (markLastReplyUndelivered, lib/stuckConversations.ts) и научил
 * jobs/aiReplyRetry.ts проигрывать такой ход заново по реплике клиента перед
 * недоставленным хвостом. Но findStuckConversations по-прежнему брала только
 * диалоги, где ПОСЛЕДНЯЯ реплика в истории — клиентская: диалог с недоставленной
 * репликой бота (последняя в истории — она, а не клиент) не поднимал ни
 * периодический крон health-automation, ни кнопка «Повторить зависшим» — только
 * уже поставленное (если вообще поставленное) задание ai-reply-retry.
 *
 * Здесь проверяется вторая ветка условия: последняя реплика assistant с
 * deliveryStatus:"failed" и пустой pausedUntil — диалог зависший, КРОМЕ случая
 * закрытого 24-часового окна (клиент не писал больше суток — повтор бессмысленен,
 * Meta откажет тем же кодом снова).
 */

const { findStuckConversations } = await import("../src/lib/stuckConversations.js");
type StuckRow = Awaited<ReturnType<typeof findStuckConversations>>[number];
const { prisma } = await import("../src/db.js");

const runId = Date.now().toString(36);
const conversationIds: string[] = [];

async function makeConversation(suffix: string, overrides: Record<string, unknown> = {}) {
  const conv = await prisma.botConversation.create({
    data: {
      channel: "FACEBOOK",
      subscriberId: `sendfail-${runId}-${suffix}`,
      messages: [{ role: "user", content: `Салом (${suffix})` }],
      lastMessageAt: new Date(),
      ...overrides,
    },
  });
  conversationIds.push(conv.id);
  return conv;
}

async function findOurStuck(): Promise<StuckRow[]> {
  const rows = await findStuckConversations();
  return rows.filter((r) => conversationIds.includes(r.id));
}

afterEach(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  conversationIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("findStuckConversations — ответ бота не дошёл", () => {
  it("последняя реплика assistant с deliveryStatus:failed и пустой паузой — диалог зависший", async () => {
    const now = new Date();
    const conv = await makeConversation("failed", {
      messages: [
        { role: "user", content: "Салом, хона доред?", at: now.toISOString() },
        { role: "assistant", content: "Хуб, чӣ мехоҳед?", by: { kind: "bot" }, deliveryStatus: "failed", at: now.toISOString() },
      ],
    });

    expect((await findOurStuck()).map((r) => r.id)).toContain(conv.id);
  });

  it("диалог с недоставленной репликой на паузе (оператор взял на себя) не подхватывается", async () => {
    const now = new Date();
    const conv = await makeConversation("failed-paused", {
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000),
      messages: [
        { role: "user", content: "Салом", at: now.toISOString() },
        { role: "assistant", content: "...", by: { kind: "bot" }, deliveryStatus: "failed", at: now.toISOString() },
      ],
    });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });

  it("реплика бота недоставленной не отмечена (deliveryStatus отсутствует) — не зависший по этой ветке", async () => {
    const now = new Date();
    const conv = await makeConversation("no-status", {
      messages: [
        { role: "user", content: "Салом", at: now.toISOString() },
        { role: "assistant", content: "Хуб!", by: { kind: "bot" }, at: now.toISOString() },
      ],
    });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });

  it("закрытое 24-часовое окно — повтор бессмысленен, диалог в списке не появляется", async () => {
    // Клиент писал больше суток назад: WhatsApp/Instagram запрещают инициативный
    // текст, и повторная отправка упадёт тем же отказом — аналог
    // isMessagingWindowClosedError, только по данным диалога, а не по тексту ошибки.
    const oldUserAt = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const conv = await makeConversation("window-closed", {
      messages: [
        { role: "user", content: "Салом, хона доред?", at: oldUserAt.toISOString() },
        {
          role: "assistant",
          content: "Хуб, чӣ мехоҳед?",
          by: { kind: "bot" },
          deliveryStatus: "failed",
          at: new Date().toISOString(),
        },
      ],
    });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });

  it("реплика клиента без «at» (записана до 01.08.2026) считается протухшей — в список не попадает", async () => {
    const conv = await makeConversation("no-at", {
      messages: [
        { role: "user", content: "Салом" },
        { role: "assistant", content: "Хуб!", by: { kind: "bot" }, deliveryStatus: "failed", at: new Date().toISOString() },
      ],
    });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });

  it("«не пишите мне» (optedOutAt) исключает недоставленный ответ тоже", async () => {
    const now = new Date();
    const conv = await makeConversation("failed-optout", {
      optedOutAt: new Date(),
      messages: [
        { role: "user", content: "Салом", at: now.toISOString() },
        { role: "assistant", content: "...", by: { kind: "bot" }, deliveryStatus: "failed", at: now.toISOString() },
      ],
    });

    expect((await findOurStuck()).map((r) => r.id)).not.toContain(conv.id);
  });
});
