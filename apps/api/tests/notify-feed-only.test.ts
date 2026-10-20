import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * «УВЕДОМЛЕНИЕ БЕЗ ЗВОНКА ТЕЛЕФОНА» (владелец 20.09.2026, дословно: «эскалация
 * убрать, то есть прямо таки пуш не нужно, это всё равно отдельно видит
 * руководитель на своём дашборде»).
 *
 * На этой функции держатся все эскалации руководству: срыв первого звонка,
 * непринятый лид по своему объекту, незаполненная карточка через 12 часов,
 * заблокированная законом автопередача, сводка просроченного. Два условия,
 * которые она обязана выполнять одновременно, и проверяются здесь: строка в
 * ленте появляется, а web-push не отправляется вовсе.
 */
const sendNotification = vi.fn(async () => ({}) as unknown);
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification },
}));

process.env.VAPID_PUBLIC_KEY = "тестовый-открытый-ключ";
process.env.VAPID_PRIVATE_KEY = "тестовый-закрытый-ключ";

const { prisma } = await import("../src/db.js");
const { notifyFeedOnly } = await import("../src/lib/notifications.js");
const { sendPushToAgent } = await import("../src/push.js");

const runId = Date.now();
let agentId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Руководитель ленты ${runId}`, phone: `+992931${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  await prisma.pushSubscription.create({
    data: {
      agentId,
      endpoint: `https://fcm.googleapis.com/test/${runId}`,
      p256dh: "тестовый-p256dh",
      auth: "тестовый-auth",
    },
  });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.pushSubscription.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Уведомление руководству без звонка телефона", () => {
  it("строка в ленте появляется, push при этом не уходит", async () => {
    sendNotification.mockClear();
    await notifyFeedOnly([agentId], {
      kind: "lead",
      title: "Первый звонок сорван",
      body: "Иванов: агент не позвонил за 15 мин",
      url: "/clients/1",
      tag: `feed-only-${runId}`,
    });

    const row = await prisma.notification.findFirst({ where: { agentId, tag: `feed-only-${runId}` } });
    expect(row, "строка в колокольчике обязана появиться — информацию не прячем").toBeTruthy();
    expect(row!.title).toBe("Первый звонок сорван");
    expect(sendNotification, "телефон по эскалации звонить не должен").not.toHaveBeenCalled();
  });

  it("для сравнения: обычный путь с push подписку всё так же будит", async () => {
    sendNotification.mockClear();
    await sendPushToAgent(agentId, {
      kind: "lead",
      title: "Новый лид",
      body: "Петров",
      tag: `with-push-${runId}`,
    });
    expect(sendNotification, "обычные уведомления мы не ломали").toHaveBeenCalled();
  });
});
