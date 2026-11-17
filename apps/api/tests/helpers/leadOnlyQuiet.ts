import { prisma } from "../../src/db.js";
import { waitForSettled } from "./waitFor.js";

/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ»: «ДО НОМЕРА — НИ ОДНОГО УВЕДОМЛЕНИЯ» (решение владельца 13.11.2026).
 *
 * Любой пуш CRM идёт через push.ts, который сперва пишет строку в ленту уведомлений (Notification), даже без
 * подписки устройства. Поэтому «никого не звали» = в ленте нет ни одной строки об этом диалоге (ссылка или метка
 * с его id) и ни одной строки агентам теста с момента `since`. Запись в ленту идёт в отрыве (`void`), поэтому
 * счёт берётся после того, как он осел (tests/helpers/waitFor.ts).
 */
export async function leadOnlyNotificationsSince(conversationId: string, since: Date, agentIds: readonly string[] = []): Promise<number> {
  return waitForSettled(() => prisma.notification.count({ where: { createdAt: { gte: since }, OR: [
    { url: { contains: conversationId } }, { tag: { contains: conversationId } },
    ...(agentIds.length ? [{ agentId: { in: [...agentIds] } }] : []),
  ] } }), { timeoutMs: 1500, intervalMs: 150 });
}

/** Уведомления, которые шлёт сам режим (тревоги о сбое заявки), — по метке диалога. */
export async function leadOnlyModeNotifications(conversationId: string) {
  await waitForSettled(() => prisma.notification.count({ where: { tag: { startsWith: `lead-only-alarm-${conversationId}` } } }),
    { timeoutMs: 1500, intervalMs: 150 });
  return prisma.notification.findMany({ where: { tag: { startsWith: `lead-only-alarm-${conversationId}` } },
    select: { agentId: true, title: true, body: true, url: true, tag: true } });
}
