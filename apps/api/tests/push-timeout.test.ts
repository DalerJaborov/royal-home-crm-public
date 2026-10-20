import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Зависший транспорт push не должен подвешивать итог звонка.
 *
 * webpush.sendNotification был единственным внешним вызовом в цепочке входящего
 * звонка без явного таймаута (правило CLAUDE.md). notifyRinging вызывается из
 * setupIncomingCall на пути entry.ready, за которую держится finishIncomingCall:
 * зависший FCM/APNs подвешивал бы итог звонка, задачу перезвонить и запись
 * разговора на неопределённое время.
 *
 * РЕАЛЬНЫЕ ТАЙМЕРЫ, А НЕ ФЕЙКОВЫЕ. Фейковые часы (vi.useFakeTimers) конфликтуют
 * с внутренним планированием клиента Prisma (findMany внутри sendPushToAgent
 * зависает сам, ещё до проверяемого таймаута) — попытка их развести оставляла
 * тест хрупким и непрозрачным. PUSH_SEND_TIMEOUT_MS = 10с укладывается в
 * testTimeout проекта (20с), поэтому тест просто ждёт по-настоящему.
 */

const sendNotification = vi.fn(() => new Promise<never>(() => {})); // вечно висит
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...args: unknown[]) => sendNotification(...(args as [])) },
}));

// Ключи нужны только как признак «push настроен» (сам web-push замокан выше).
// На соседние файлы не влияют: tests/setup.ts возвращает process.env к исходному
// состоянию после каждого файла — весь прогон идёт в одном процессе.
process.env.VAPID_PUBLIC_KEY = "тестовый-открытый-ключ";
process.env.VAPID_PRIVATE_KEY = "тестовый-закрытый-ключ";

const { prisma } = await import("../src/db.js");
const { sendPushToAgent } = await import("../src/push.js");

const runId = Date.now();
let agentId: string;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент push-таймаута ${runId}`, phone: `+992962${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  await prisma.pushSubscription.create({
    data: {
      agentId,
      endpoint: `https://example.test/push/${runId}`,
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=",
      auth: "tBHItJI5svbpez7KI4CCXg==", // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    },
  });
});

afterEach(() => sendNotification.mockClear());

afterAll(async () => {
  await prisma.pushSubscription.deleteMany({ where: { agentId } });
  await prisma.agent.delete({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("sendPushToAgent: зависший транспорт не подвешивает отправителя", () => {
  it(
    "вечно висящий sendNotification — возврат 0 в пределах таймаута, а не зависание",
    async () => {
      const startedAt = Date.now();
      const result = await sendPushToAgent(agentId, { title: "t", body: "b" });
      const elapsedMs = Date.now() - startedAt;

      expect(result).toBe(0);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      // Таймаут push.ts — 10с; с запасом на накладные расходы теста ждём не
      // дольше 15с. Без починки этот await не вернулся бы никогда.
      expect(elapsedMs).toBeLessThan(15_000);
    },
    18_000
  );

  it("быстрый ответ транспорта — доставлено без ожидания таймаута", async () => {
    sendNotification.mockImplementationOnce(async () => ({}) as unknown as never);
    const result = await sendPushToAgent(agentId, { title: "t", body: "b" });
    expect(result).toBe(1);
  });
});
