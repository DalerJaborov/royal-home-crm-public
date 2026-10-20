import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import {
  _clearMarketingInsightsCache,
  buildMarketingInsights,
  notifyReportsAboutMarketingInsights,
} from "../src/lib/marketingInsights.js";

/**
 * Пуш «Разбор маркетинга готов» (05.09.2026, docs/ai-proactivity-audit-05-09-2026.md
 * п.1) — раньше разбор строился только по открытию экрана отчётов (см.
 * marketing-screen.test.ts), теперь ещё и сам приходит раз в неделю крону.
 *
 * ИИ подменён: тест не должен платить за токены и не зависит от ключа Gemini.
 */

const { decide } = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: decide }));

const runId = Date.now();
const password = "testpass123";

let managerId = "";
let agentId = "";
let propertyId = "";
let districtId = "";
let clientId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  managerId = (
    await prisma.agent.create({
      data: { fullName: `Маркетолог пуш ${runId}`, phone: `+99296${runId}`, role: "MANAGER", passwordHash, isActive: true },
    })
  ).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент пуш ${runId}`, phone: `+99295${runId}`, role: "AGENT", passwordHash, isActive: true },
    })
  ).id;

  districtId = (await prisma.district.create({ data: { name: `Тест-район-маркетинг-пуш-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект маркетинг-пуш ${runId}`,
        type: "APARTMENT",
        rooms: 2,
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
      },
    })
  ).id;
  // Хотя бы один лид за месяц, чтобы buildMarketingFunnel вернул непустые каналы
  // (buildMarketingInsights возвращает null при пустой воронке).
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Лид маркетинг-пуш ${runId}`,
        phone: `+99294${runId}`,
        kind: "BUYER",
        source: "WEBSITE",
        status: "NEW",
        currency: "TJS",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [managerId, agentId] } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [managerId, agentId] } } });
});

beforeEach(async () => {
  decide.mockReset();
  _clearMarketingInsightsCache();
  // Обе записи используют один и тот же tag (та же неделя Душанбе) — без очистки
  // второй it() нашёл бы уведомление, оставленное первым.
  await prisma.notification.deleteMany({ where: { agentId: { in: [managerId, agentId] } } });
});

describe("notifyReportsAboutMarketingInsights", () => {
  // ПОРЯДОК ВАЖЕН: этот тест — ПЕРЕД «шлёт заголовок». sendPushToAgents (push.ts)
  // внутри сам вызывает НЕ дожидаемый void createNotifications с тем же payload —
  // редундантная (но безобидная в проде) вторая запись тем же tag может долететь
  // с опозданием. Оба теста используют один и тот же tag (неделя Душанбе одна и
  // та же для обоих запусков) — если бы «успешный» тест шёл первым, его отложенная
  // повторная запись могла бы долететь уже во время этого теста и дать ложный
  // положительный результат.
  it("ИИ недоступен — тихо ничего не отправляет", async () => {
    decide.mockRejectedValue(new Error("boom"));

    await expect(notifyReportsAboutMarketingInsights()).resolves.toBeUndefined();

    const forManager = await prisma.notification.findFirst({
      where: { agentId: managerId, tag: { startsWith: "marketing-insights-" } },
    });
    expect(forManager).toBeNull();
  });

  it("шлёт заголовок разбора тем, у кого есть reports.view, и не шлёт агенту без права", async () => {
    decide.mockResolvedValue({
      headline: "Тестовый заголовок разбора маркетинга",
      insights: ["Первое наблюдение", "Второе наблюдение"],
    });

    await notifyReportsAboutMarketingInsights();

    const forManager = await prisma.notification.findFirst({
      where: { agentId: managerId, tag: { startsWith: "marketing-insights-" } },
    });
    expect(forManager).toBeTruthy();
    expect(forManager!.body).toBe("Тестовый заголовок разбора маркетинга");
    expect(forManager!.title).toContain("маркетинга");

    const forAgent = await prisma.notification.findFirst({
      where: { agentId, tag: { startsWith: "marketing-insights-" } },
    });
    expect(forAgent).toBeNull();
  });
});

/**
 * Ночная проверка 24.09.2026, круг «Сделки, деньги», находка №5: кэш разбора был
 * один на процесс и ключом только по месяцу, а seesMoney (право finance.view)
 * идёт и в воронку, и в промпт. Текст с расходами и ценой лида, построенный для
 * директора, шесть часов отдавался тем, у кого права на деньги нет.
 */
describe("buildMarketingInsights: кэш свой для каждого варианта прав", () => {
  it("разбор без денег не берётся из кэша разбора с деньгами, и наоборот", async () => {
    decide.mockResolvedValue({
      headline: "Заголовок для теста кэша",
      insights: ["Наблюдение"],
    });

    const withMoney = await buildMarketingInsights(true);
    expect(withMoney?.cached).toBe(false);

    const withoutMoney = await buildMarketingInsights(false);
    expect(withoutMoney?.cached).toBe(false);
    expect(decide).toHaveBeenCalledTimes(2);

    const prompts = decide.mock.calls.map((call) => (call[0] as { system: string }).system);
    expect(prompts[0]).toContain("расход");
    expect(prompts[1]).not.toContain("расход");

    // Повторные вызовы — уже из своего кэша, без нового обращения к ИИ.
    expect((await buildMarketingInsights(false))?.cached).toBe(true);
    expect((await buildMarketingInsights(true))?.cached).toBe(true);
    expect(decide).toHaveBeenCalledTimes(2);
  });
});
