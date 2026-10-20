import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ОТКЛЮЧЁННОМУ СОТРУДНИКУ ПУШИ НЕ ИДУТ (23.09.2026).
 *
 * Отключение учётки гасило сессии, но не подписки устройств, а доставка пушей
 * не смотрела, действует ли сотрудник. Клиенты при отключении не передаются,
 * поэтому новые сообщения, звонки и лиды по ним уходили на телефон уволенного —
 * с именами и номерами клиентов.
 */

const sendNotification = vi.fn(async () => ({}) as unknown);
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...args: unknown[]) => sendNotification(...(args as [])) },
}));
// Без ключей push.ts выключает отправку целиком — проверка была бы зелёной впустую.
process.env.VAPID_PUBLIC_KEY = "тестовый-открытый-ключ";
process.env.VAPID_PRIVATE_KEY = "тестовый-закрытый-ключ";

const { prisma } = await import("../src/db.js");
const { deliverPushToAgents } = await import("../src/push.js");

const runId = Date.now();
let agentId = "";

beforeAll(async () => {
  const a = await prisma.agent.create({
    data: { fullName: `Уволенный пуш ${runId}`, phone: `+99297${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = a.id;
  await prisma.pushSubscription.create({
    data: {
      agentId,
      endpoint: `https://example.test/push-inactive/${runId}`,
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=",
      auth: "tBHItJI5svbpez7KI4CCXg==", // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    },
  });
});

beforeEach(() => sendNotification.mockClear());

afterAll(async () => {
  await prisma.pushSubscription.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Пуши только действующим сотрудникам", () => {
  it("действующему — уходит", async () => {
    await deliverPushToAgents([agentId], { title: "Новое сообщение", body: "Клиент написал" });
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("отключённому — не уходит, даже если подписка осталась", async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    await deliverPushToAgents([agentId], { title: "Новое сообщение", body: "Клиент написал" });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
