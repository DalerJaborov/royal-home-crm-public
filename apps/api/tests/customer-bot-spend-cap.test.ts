import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * СУТОЧНЫЙ ДЕНЕЖНЫЙ ПОТОЛОК БОТА КЛИЕНТОВ (CRM-47, 26.11.2026).
 *
 * Было: у бота клиентов не было потолка в деньгах — петля (07.09: ~19 000 вызовов по одной переписке) останавливалась
 * только месячным лимитом проекта Google, а он кладёт весь прод. Теперь одна дверь: траты бота за сутки по Душанбе
 * достигли потолка из Настроек — точки бота клиентов модель не зовут (оператор отвечает правилами и готовыми фразами),
 * руководству одна тревога в сутки. Вызов Google подменён: тест про то, дошёл ли запрос до поставщика.
 */

const { callGemini, sendPushToAgents } = vi.hoisted(() => ({
  callGemini: vi.fn(async () => ({ ok: true })),
  sendPushToAgents: vi.fn(async () => 1),
}));
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGemini,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { callAiText } = await import("../src/ai/client.js");
const { customerBotSpendCapReached, customerBotSpentTodayUsd, resetCustomerBotSpendCapCache, SPEND_CAP_ALARM_CHANNEL,
  CUSTOMER_CORE_POLICY_KEY } = await import("../src/lib/customerBotSpendCap.js");
const { providerDayKey } = await import("../src/ai/providerContract.js");

const marker = `spendcap-${Date.now().toString(36)}`;
let saved: { botDailySpendCapEnabled: boolean; botDailySpendCapUsd: number } | null = null;
const day = providerDayKey(new Date());

async function spend(endpoint: string, usd: number) {
  await prisma.aiLog.create({ data: { endpoint, model: marker, ms: 1, ok: true, costUsd: usd } });
}
async function clean() {
  await prisma.aiLog.deleteMany({ where: { model: marker } });
  await prisma.aiProviderDailyBudget.deleteMany({ where: { policyKey: CUSTOMER_CORE_POLICY_KEY, dayKey: day } });
  await prisma.processedMessage.deleteMany({ where: { channel: SPEND_CAP_ALARM_CHANNEL } });
}

beforeAll(async () => {
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {},
    select: { botDailySpendCapEnabled: true, botDailySpendCapUsd: true } });
  saved = s;
});
beforeEach(async () => {
  await clean();
  resetCustomerBotSpendCapCache();
  callGemini.mockClear();
  sendPushToAgents.mockClear();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botDailySpendCapEnabled: true, botDailySpendCapUsd: 1 } });
});
afterAll(async () => {
  await clean();
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.$disconnect();
});

describe("суточный потолок трат бота клиентов", () => {
  it("умолчание: включено, 5 $ в сутки", async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string; column_default: string | null }>>`SELECT column_name, column_default
      FROM information_schema.columns WHERE table_name='Settings' AND column_name IN ('botDailySpendCapEnabled','botDailySpendCapUsd')`;
    const byName = Object.fromEntries(columns.map(c => [c.column_name, c.column_default]));
    expect(byName.botDailySpendCapEnabled).toBe("true");
    expect(Number(byName.botDailySpendCapUsd)).toBe(5);
  });

  it("ниже потолка — модель зовётся как обычно", async () => {
    await spend("lead-only-intent", 0.4);
    await callAiText({ endpoint: "lead-only-intent", system: "s", user: "u" });
    expect(callGemini).toHaveBeenCalledTimes(1);
  });

  it("потолок достигнут — точка бота клиентов модель не зовёт и возвращает «нет ответа»; руководству одна тревога в сутки", async () => {
    await spend("lead-only-intent", 0.7);
    await spend("instagram-comment", 0.4);
    expect(await callAiText({ endpoint: "lead-only-intent", system: "s", user: "u" })).toBeNull();
    resetCustomerBotSpendCapCache();
    expect(await callAiText({ endpoint: "lead-only-operator-compose", system: "s", user: "u" })).toBeNull();
    expect(callGemini).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sendPushToAgents).toHaveBeenCalledTimes(1));
    expect(await prisma.processedMessage.count({ where: { channel: SPEND_CAP_ALARM_CHANNEL, messageId: day } })).toBe(1);
  });

  it("траты ядра (AiProviderDailyBudget) входят в сумму, вызовы ядра из AiLog не считаются дважды", async () => {
    await prisma.aiProviderDailyBudget.create({ data: { policyKey: CUSTOMER_CORE_POLICY_KEY, dayKey: day, settledUsd: 0.6, reservedUsd: 0.1 } });
    await spend("lead-only-intent", 0.2);
    expect(await customerBotSpentTodayUsd()).toBeCloseTo(0.9, 6);
    expect(await customerBotSpendCapReached("lead-only-intent")).toBe(false);
  });

  it("чужие точки (Шабнам, звонки, карточки) потолок бота не трогает", async () => {
    await spend("lead-only-intent", 5);
    await callAiText({ endpoint: "call-analysis", system: "s", user: "u" });
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(await customerBotSpendCapReached("assistant-tools")).toBe(false);
  });

  it("рубильник выключен — потолка нет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botDailySpendCapEnabled: false } });
    await spend("lead-only-intent", 5);
    await callAiText({ endpoint: "lead-only-intent", system: "s", user: "u" });
    expect(callGemini).toHaveBeenCalledTimes(1);
  });

  it("0 — без потолка", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botDailySpendCapUsd: 0 } });
    await spend("lead-only-intent", 5);
    expect(await customerBotSpendCapReached("lead-only-intent")).toBe(false);
  });
});
