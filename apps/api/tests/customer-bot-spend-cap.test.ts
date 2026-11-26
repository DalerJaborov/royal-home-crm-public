import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * СУТОЧНЫЙ ДЕНЕЖНЫЙ ПОТОЛОК БОТА КЛИЕНТОВ (CRM-47, 26.11.2026; правки ревью #450).
 *
 * Останавливается только то, что умеет отвечать без модели: понимание и «своими словами» оператора заявок (живой путь
 * WhatsApp/Instagram/Facebook). Старый бот и комментарии считаются, но не глушатся (иначе клиент ждал бы до полуночи).
 * Ядро (`royal-customer-gemini`) в сумму не входит: эта дверь его не останавливает, его таблицу она не читает. Считается
 * только фактическая стоимость, не резерв. Вызов Google подменён.
 */
const { callGemini, sendPushToAgents } = vi.hoisted(() => ({
  callGemini: vi.fn(async () => null),
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
const { understandTurn, OPERATOR_UNDERSTAND_ENDPOINT } = await import("../src/ai/operator/understand.js");
const { OPERATOR_COMPOSE_ENDPOINT } = await import("../src/ai/operator/compose.js");
const { initialOperatorState } = await import("../src/ai/operator/decide.js");
const { customerBotSpendCapReached, customerBotSpentTodayUsd, resetCustomerBotSpendCapCache, SPEND_CAP_ALARM_CHANNEL } =
  await import("../src/lib/customerBotSpendCap.js");
const { dushanbeStartOfToday } = await import("../src/lib/dushanbeTime.js");
type Ctx = import("../src/ai/operator/types.js").OperatorContext;

const marker = `spendcap-${Date.now().toString(36)}`;
let saved: { botDailySpendCapEnabled: boolean; botDailySpendCapUsd: number } | null = null;
const ctx: Ctx = { channel: "WHATSAPP", phoneKnown: true, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: false, ad: { topic: null, propertyId: null },
  focus: null, callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2,
  vacancies: { open: [], contactPhone: null }, brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false };

async function spend(endpoint: string, usd: number | null, at = new Date(), reservedUsd?: number) {
  await prisma.aiLog.create({ data: { endpoint, model: marker, ms: 1, ok: usd !== null, costUsd: usd, createdAt: at,
    ...(reservedUsd !== undefined ? { reservedUsd } : {}) } });
}
async function clean() {
  await prisma.aiLog.deleteMany({ where: { model: marker } });
  await prisma.processedMessage.deleteMany({ where: { channel: SPEND_CAP_ALARM_CHANNEL } });
}
const understand = () => understandTurn({ current: "Хочу купить квартиру в Сино, какие есть?" }, initialOperatorState(), ctx);

beforeAll(async () => {
  saved = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {},
    select: { botDailySpendCapEnabled: true, botDailySpendCapUsd: true } });
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
  it("умолчание (решение владельца 26.11): потолок включён, 15 $", async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string; column_default: string | null }>>`SELECT column_name, column_default
      FROM information_schema.columns WHERE table_name='Settings' AND column_name IN ('botDailySpendCapEnabled','botDailySpendCapUsd')`;
    const byName = Object.fromEntries(columns.map(c => [c.column_name, c.column_default]));
    expect(byName.botDailySpendCapEnabled).toBe("true");
    expect(Number(byName.botDailySpendCapUsd)).toBe(15);
  });

  it("понимание оператора (настоящая точка lead-only-operator): ниже потолка зовёт модель, выше — нет, ответ из правил; одна тревога", async () => {
    await spend(OPERATOR_UNDERSTAND_ENDPOINT, 0.4);
    await understand();
    expect(callGemini).toHaveBeenCalled();
    callGemini.mockClear();
    resetCustomerBotSpendCapCache();
    await spend(OPERATOR_UNDERSTAND_ENDPOINT, 0.7);
    expect(await understand()).toBeTruthy();
    expect(callGemini).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sendPushToAgents).toHaveBeenCalledTimes(1));
    expect(await prisma.processedMessage.count({ where: { channel: SPEND_CAP_ALARM_CHANNEL } })).toBe(1);
  });

  it("«своими словами» оператора тоже останавливается", async () => {
    await spend(OPERATOR_COMPOSE_ENDPOINT, 1.2);
    expect(await callAiText({ endpoint: OPERATOR_COMPOSE_ENDPOINT, system: "s", user: "u" })).toBeNull();
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("старый бот и комментарии считаются, но не глушатся: клиент не ждёт до полуночи", async () => {
    await spend("lead-qualify", 0.8);
    await spend("instagram-comment", 0.5);
    await callAiText({ endpoint: "lead-qualify", system: "s", user: "u" });
    await callAiText({ endpoint: "instagram-comment", system: "s", user: "u" });
    await callAiText({ endpoint: "telegram-comment", system: "s", user: "u" });
    expect(callGemini.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await customerBotSpendCapReached(OPERATOR_UNDERSTAND_ENDPOINT)).toBe(true);
  });

  it("считается только фактическая стоимость: резерв неудачной попытки (без costUsd) не «трата»", async () => {
    await spend(OPERATOR_UNDERSTAND_ENDPOINT, null, new Date(), 5);
    await spend(OPERATOR_UNDERSTAND_ENDPOINT, 0.2);
    expect(await customerBotSpentTodayUsd()).toBeCloseTo(0.2, 6);
    expect(await customerBotSpendCapReached(OPERATOR_UNDERSTAND_ENDPOINT)).toBe(false);
  });

  it("функция сотрудников (operator-showing-detect) в потолок бота не входит и им не останавливается", async () => {
    await spend("operator-showing-detect", 5);
    expect(await customerBotSpentTodayUsd()).toBe(0);
    await callAiText({ endpoint: "operator-showing-detect", system: "s", user: "u" });
    expect(callGemini).toHaveBeenCalled(); // дверь пропустила (callAiText сам делает один повтор на пустом ответе)
  });

  it("сутки по Душанбе: траты до полуночи по Душанбе в сегодняшнюю сумму не входят", async () => {
    const midnight = dushanbeStartOfToday(new Date());
    await spend(OPERATOR_UNDERSTAND_ENDPOINT, 3, new Date(midnight.getTime() - 60_000));
    await spend(OPERATOR_UNDERSTAND_ENDPOINT, 0.3, new Date(midnight.getTime() + 60_000));
    expect(await customerBotSpentTodayUsd(new Date(midnight.getTime() + 120_000))).toBeCloseTo(0.3, 6);
    expect(await customerBotSpentTodayUsd(new Date(midnight.getTime() - 120_000))).toBeCloseTo(3, 6);
  });

  it("рубильник выключен или сумма 0 — потолка нет", async () => {
    await spend(OPERATOR_UNDERSTAND_ENDPOINT, 5);
    await prisma.settings.update({ where: { id: "singleton" }, data: { botDailySpendCapEnabled: false } });
    expect(await customerBotSpendCapReached(OPERATOR_UNDERSTAND_ENDPOINT)).toBe(false);
    resetCustomerBotSpendCapCache();
    await prisma.settings.update({ where: { id: "singleton" }, data: { botDailySpendCapEnabled: true, botDailySpendCapUsd: 0 } });
    expect(await customerBotSpendCapReached(OPERATOR_UNDERSTAND_ENDPOINT)).toBe(false);
  });
});
