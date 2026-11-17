import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Четыре новых tool-функции ИИ-ассистента CRM (ai/assistant.ts): search_deals,
 * get_finance_summary, get_lead_sources, get_upcoming_showings — и журнал вызовов
 * (AiAssistantAuditLog, lib/aiAssistantAudit.ts).
 *
 * Проверяем ровно то, что нельзя увидеть по диффу: серверную изоляцию по правам
 * (ownScope, canViewFinance, canViewReports) и то, что каждый вызов инструмента
 * оставляет в аудит-логе ровно одну запись.
 *
 * runTool экспортирован из assistant.ts специально для таких тестов — идти через
 * runAssistant (Gemini) для каждой проверки прав было бы дорого и хрупко; Gemini
 * мокается только в последнем тесте, где важен именно цикл выполнения инструментов.
 *
 * Сидовые данные не используем: районы/агенты/клиенты создаются здесь и удаляются
 * в конце. Финансовые и лид-сорсовые сводки считают ПО ВСЕЙ БАЗЕ (как и REST
 * /expenses/summary, /reports/sources) — поэтому сравниваем ДЕЛЬТУ (до/после
 * создания фикстур), а не абсолютные числа: прогон может идти вместе с другими
 * файлами тестов в одной базе.
 */

const resolveGeminiKey = vi.fn();
const callGemini = vi.fn();
const callGeminiTools = vi.fn();
vi.mock("../src/ai/geminiClient.js", () => ({ resolveGeminiKey, callGemini, callGeminiTools }));
// Ключи и модели помощник берёт одним кэшированным чтением (ai/assistant/runtime.ts),
// а не через resolveGeminiKey — подменяем источник.
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"],
    model: "gemini-test",
    fallbackModels: [],
    transcribeModels: [],
    imageModel: "unused",
    liteModel: "",
    explicitCaching: false,
  }),
}));

const { prisma } = await import("../src/db.js");
const { waitForCount, waitForSettled } = await import("./helpers/waitFor.js");
const { runTool, runAssistant, resolveStatsPeriod } = await import("../src/ai/assistant.js");
const { dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");

const runId = Date.now();
let districtId: string;
let agentAId: string; // роль AGENT, свои сделки
let agentBId: string; // роль AGENT, чужие сделки (для agentA)
let directorId: string;
let propertyId: string;
const clientIds: string[] = [];
const dealIds: string[] = [];
const expenseIds: string[] = [];
// Отдельные объекты для тестов с ДВУМЯ ОДНОВРЕМЕННО активными сделками —
// частичный уникальный индекс Deal_active_propertyId_unique (30.08.2026)
// запрещает второй активной Deal на тот же объект. propertyId выше делить
// между такими сделками больше нельзя.
const propertyIds: string[] = [];
async function makeProperty(): Promise<string> {
  const p = await prisma.property.create({
    data: {
      title: `Объект ассистента ${propertyIds.length}-${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 60000,
      currency: "TJS",
      districtId,
      address: `Тестовая, ${20 + propertyIds.length}`,
      condition: "GOOD",
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

const actorAgent = () => ({
  id: agentAId,
  role: "AGENT",
  canViewAllClients: false,
  canViewPhone: false,
  canViewReports: false,
  canViewFinance: false,
  canViewAllDeals: false,
});
const actorDirector = () => ({
  id: directorId,
  role: "DIRECTOR",
  canViewAllClients: true,
  canViewPhone: true,
  canViewReports: true,
  canViewFinance: true,
  canViewAllDeals: true,
});

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Ассистент-тест-${runId}` } })).id;
  agentAId = (
    await prisma.agent.create({
      data: { fullName: `Агент А ${runId}`, phone: `+992900${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  agentBId = (
    await prisma.agent.create({
      data: { fullName: `Агент Б ${runId}`, phone: `+992901${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор ${runId}`, phone: `+992902${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект ассистента ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 60000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 10",
        condition: "GOOD",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.aiAssistantAuditLog.deleteMany({ where: { agentId: { in: [agentAId, agentBId, directorId] } } });
  await prisma.expense.deleteMany({ where: { id: { in: expenseIds } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, ...propertyIds] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeClient(name: string, assignedAgentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9929${clientIds.length}${runId}`,
      source: "WEBSITE",
      assignedAgentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c.id;
}

describe("search_deals — ownScope как у search_clients", () => {
  it("агент без clients.viewAll видит только свои сделки, руководитель — все", async () => {
    const clientA = await makeClient(`Клиент-А-${runId}`, agentAId);
    const clientB = await makeClient(`Клиент-Б-${runId}`, agentBId);
    const dealA = await prisma.deal.create({
      data: { clientId: clientA, propertyId: await makeProperty(), agentId: agentAId, stage: "NEGOTIATION" },
    });
    const dealB = await prisma.deal.create({
      data: { clientId: clientB, propertyId: await makeProperty(), agentId: agentBId, stage: "NEGOTIATION" },
    });
    dealIds.push(dealA.id, dealB.id);

    // query — подстрока, общая для имён обоих клиентов этого прогона: без неё
    // выдача обрезалась бы лимитом в 8 сделок и могла случайно не захватить нужные
    // среди сделок остальных тестов той же базы.
    const query = String(runId);

    const asAgent = (await runTool("search_deals", { query }, actorAgent())) as Array<{ id: string }>;
    expect(asAgent.map((d) => d.id)).toEqual([dealA.id]);

    const asDirector = (await runTool("search_deals", { query }, actorDirector())) as Array<{ id: string }>;
    const idsForDirector = asDirector.map((d) => d.id);
    expect(idsForDirector).toContain(dealA.id);
    expect(idsForDirector).toContain(dealB.id);
  });

  /**
   * Сделки скоупятся СВОИМ правом (deals.viewAll), а не правом на клиентов.
   * Права переключаются поштучно, поэтому сочетание «видит всех клиентов, но не
   * чужие сделки» достижимо — и на экране «Сделки» такой сотрудник видит только
   * свои (scopeDealsToOwnAgent). Ассистент обязан отвечать так же, иначе он
   * обходной путь вокруг раздела. Ровно это расхождение уже чинили один раз в
   * REST — см. комментарий у scopeDealsToOwnAgent в auth/middleware.ts.
   */
  it("clients.viewAll без deals.viewAll — чужие сделки всё равно не видны", async () => {
    const clientA = await makeClient(`Смешанные-права-А-${runId}`, agentAId);
    const clientB = await makeClient(`Смешанные-права-Б-${runId}`, agentBId);
    const dealA = await prisma.deal.create({
      data: { clientId: clientA, propertyId: await makeProperty(), agentId: agentAId, stage: "NEGOTIATION" },
    });
    const dealB = await prisma.deal.create({
      data: { clientId: clientB, propertyId: await makeProperty(), agentId: agentBId, stage: "NEGOTIATION" },
    });
    dealIds.push(dealA.id, dealB.id);

    const mixed = { ...actorAgent(), canViewAllClients: true, canViewAllDeals: false };
    const found = (await runTool("search_deals", { query: `Смешанные-права` }, mixed)) as Array<{ id: string }>;
    const ids = found.map((d) => d.id);
    expect(ids).toContain(dealA.id);
    expect(ids).not.toContain(dealB.id);
  });
});

describe("get_finance_summary — только ADMIN/DIRECTOR (finance.view)", () => {
  it("роль без finance.view получает отказ, а не частичные данные", async () => {
    const result = await runTool("get_finance_summary", {}, actorAgent());
    expect(result).toEqual({ error: "Доступ только для руководства" });
  });

  it("finance.view — реальная сводка, дельта совпадает с добавленными записями", async () => {
    const monthKey = dushanbeWallClock().toISOString().slice(0, 7);
    const before = (await runTool("get_finance_summary", {}, actorDirector())) as {
      revenueTJS: number;
      expensesTJS: number;
      dealsCompleted: number;
    };

    const clientC = await makeClient(`Клиент-В-${runId}`, agentAId);
    const closedDeal = await prisma.deal.create({
      data: {
        clientId: clientC,
        propertyId,
        agentId: agentAId,
        stage: "COMPLETED",
        commissionAmount: 5000,
        currency: "TJS",
        closedAt: new Date(),
      },
    });
    dealIds.push(closedDeal.id);
    const expense = await prisma.expense.create({
      data: {
        category: "OFFICE",
        amount: 200,
        currency: "TJS",
        // Expense.month — плоский маркер месяца (первое число UTC-полночью), тот
        // же формат, что пишет routes/expenses.ts (monthToDate) — см. комментарий
        // у expenseMonthDate в ai/assistant.ts.
        month: new Date(`${monthKey}-01T00:00:00.000Z`),
      },
    });
    expenseIds.push(expense.id);

    const after = (await runTool("get_finance_summary", {}, actorDirector())) as {
      month: string;
      revenueTJS: number;
      expensesTJS: number;
      profitTJS: number;
      dealsCompleted: number;
    };
    expect(after.month).toBe(monthKey);
    expect(after.revenueTJS - before.revenueTJS).toBe(5000);
    expect(after.expensesTJS - before.expensesTJS).toBe(200);
    expect(after.dealsCompleted - before.dealsCompleted).toBe(1);
  });

  it("прибыль помощницы = прибыль экрана «Финансы» на одной базе, с зарплатой из сделок", async () => {
    // Одна дверь (10.11.2026): своя копия арифметики вычитала строку «Зарплата из сделок»
    // из доли компании второй раз; экран её не вычитает — доля риелтора уже вне дохода компании.
    const monthKey = dushanbeWallClock().toISOString().slice(0, 7);
    const salary = await prisma.expense.create({
      data: { category: "SALARY", amount: 1500, currency: "TJS", agentId: agentAId, autoKey: `salary:${runId}:${monthKey}`,
        note: "Зарплата из сделок", month: new Date(`${monthKey}-01T00:00:00.000Z`) },
    });
    expenseIds.push(salary.id);
    const { default: request } = await import("supertest");
    const { app } = await import("../src/app.js");
    const { signAccessToken } = await import("../src/auth/jwt.js");
    const screen = await request(app).get(`/api/v1/expenses/summary?months=1&through=${monthKey}`)
      .set("Authorization", `Bearer ${signAccessToken({ sub: directorId, role: "DIRECTOR" })}`);
    expect(screen.status).toBe(200);
    const shown = screen.body.months[0] as { profit: number; companyRevenue: number; totalExpenses: number; revenue: number };
    const assistant = (await runTool("get_finance_summary", { month: monthKey }, actorDirector())) as {
      profitTJS: number; companyRevenueTJS: number; expensesTJS: number; revenueTJS: number;
    };
    expect(assistant.profitTJS).toBe(shown.profit);
    expect(assistant.companyRevenueTJS).toBe(shown.companyRevenue);
    expect(assistant.expensesTJS).toBe(shown.totalExpenses);
    expect(assistant.revenueTJS).toBe(shown.revenue);
  });
});

describe("get_lead_sources — то же право, что REST /reports/sources (reports.view)", () => {
  it("роль без reports.view получает отказ", async () => {
    const result = await runTool("get_lead_sources", {}, actorAgent());
    expect(result).toEqual({ error: "Доступ только для руководства" });
  });

  it("reports.view — новый лид этого месяца увеличивает total своего источника на 1", async () => {
    const before = (await runTool("get_lead_sources", {}, actorDirector())) as {
      sources: { source: string; total: number; closed: number }[];
    };
    const beforeTotal = before.sources.find((s) => s.source === "REFERRAL")?.total ?? 0;

    await makeClient(`Клиент-Реферал-${runId}`, agentAId).then((id) =>
      prisma.client.update({ where: { id }, data: { source: "REFERRAL" } })
    );

    const after = (await runTool("get_lead_sources", {}, actorDirector())) as {
      sources: { source: string; total: number; closed: number }[];
    };
    const afterTotal = after.sources.find((s) => s.source === "REFERRAL")?.total ?? 0;
    expect(afterTotal - beforeTotal).toBe(1);
  });
});

describe("сводки за день и за отрезок дат", () => {
  // 17.11.2026, живой случай: на «сколько обращений сегодня» помощница отдала цифру
  // за весь месяц и назвала её сегодняшней, а на «за 17.11» ответила, что по дням
  // считать не умеет — у сводки не было периода вовсе.
  it("resolveStatsPeriod: день, отрезок, пусто и ошибки", () => {
    expect(resolveStatsPeriod(undefined, undefined)).toBeNull();
    const day = resolveStatsPeriod("2019-03-05", undefined) as { from: Date; to: Date; label: string };
    // Сутки по Душанбе (UTC+5): с 19:00 UTC накануне до 19:00 UTC этого дня.
    expect(day.from.toISOString()).toBe("2019-03-04T19:00:00.000Z");
    expect(day.to.toISOString()).toBe("2019-03-05T19:00:00.000Z");
    expect(day.label).toBe("2019-03-05");
    const range = resolveStatsPeriod("2019-03-04", "2019-03-05") as { from: Date; to: Date; label: string };
    expect(range.from.toISOString()).toBe("2019-03-03T19:00:00.000Z");
    expect(range.to.toISOString()).toBe("2019-03-05T19:00:00.000Z");
    expect(range.label).toBe("2019-03-04 — 2019-03-05");
    expect(resolveStatsPeriod("сегодня", undefined)).toEqual({ error: expect.any(String) });
    expect(resolveStatsPeriod("2019-02-31", undefined)).toEqual({ error: expect.any(String) });
    expect(resolveStatsPeriod("2019-03-05", "2019-03-04")).toEqual({ error: expect.any(String) });
    expect(resolveStatsPeriod("2017-01-01", "2019-03-04")).toEqual({ error: expect.any(String) });
  });

  it("get_company_stats и get_lead_sources считают ровно названный день, а не месяц", async () => {
    const stats = (from: string, to?: string) =>
      runTool("get_company_stats", { from, ...(to ? { to } : {}) }, actorDirector()) as Promise<{
        period: string; newLeads: number; month?: string; leadsBySource: { source: string; count: number }[];
      }>;
    const before = await stats("2019-03-05");
    const beforeRange = await stats("2019-03-04", "2019-03-05");

    // 00:30 пятого марта по Душанбе — это ещё четвёртое по UTC; 23:30 четвёртого — день раньше.
    const inDay = await makeClient(`Клиент-День-${runId}`, agentAId);
    const dayBefore = await makeClient(`Клиент-Накануне-${runId}`, agentAId);
    await prisma.client.update({ where: { id: inDay }, data: { source: "TELEGRAM", createdAt: new Date("2019-03-04T19:30:00.000Z") } });
    await prisma.client.update({ where: { id: dayBefore }, data: { source: "TELEGRAM", createdAt: new Date("2019-03-04T18:30:00.000Z") } });

    const day = await stats("2019-03-05");
    expect(day.period).toBe("2019-03-05");
    expect("month" in day).toBe(false);
    expect(day.newLeads - before.newLeads).toBe(1);
    const tg = (r: { leadsBySource: { source: string; count: number }[] }) => r.leadsBySource.find((x) => x.source === "TELEGRAM")?.count ?? 0;
    expect(tg(day) - tg(before)).toBe(1);

    const range = await stats("2019-03-04", "2019-03-05");
    expect(range.period).toBe("2019-03-04 — 2019-03-05");
    expect(range.newLeads - beforeRange.newLeads).toBe(2);

    const sources = (await runTool("get_lead_sources", { from: "2019-03-05" }, actorDirector())) as {
      period: string; sources: { source: string; total: number }[];
    };
    expect(sources.period).toBe("2019-03-05");
    expect(sources.sources.find((x) => x.source === "TELEGRAM")?.total).toBe(tg(day));

    // Без дат — прежний месяц, и период назван словами, чтобы модель не выдала его за «сегодня».
    const month = (await runTool("get_company_stats", {}, actorDirector())) as { period: string; month: string; today: string };
    expect(month.period).toContain("текущий месяц");
    expect(month.month).toBe(month.today.slice(0, 7));
    expect(await runTool("get_company_stats", { from: "17.11.26" }, actorDirector())).toEqual({ error: expect.any(String) });
  });
});

describe("AiAssistantAuditLog — одна точка записи на все инструменты", () => {
  it("вызов любого инструмента через runAssistant пишет ровно одну строку журнала", async () => {
    resolveGeminiKey.mockReset();
    callGemini.mockReset();
    callGeminiTools.mockReset();
    // Классификатора больше нет (31.10.2026, пачка П1 задача 1.3) — callGemini
    // помощник не зовёт вовсе. Первый ход: модель просит search_clients. Второй ход (после результата
    // инструмента): модель отвечает текстом, инструментов больше не просит.
    callGeminiTools
      .mockResolvedValueOnce({
        text: "",
        calls: [{ name: "search_clients", args: { q: String(runId) } }],
        modelParts: [{ functionCall: { name: "search_clients", args: { q: String(runId) } } }],
        tokens: 10,
      })
      .mockResolvedValueOnce({ text: "Готово.", calls: [], modelParts: [{ text: "Готово." }], tokens: 5 });

    const countRows = () => prisma.aiAssistantAuditLog.count({ where: { agentId: agentAId } });
    const before = await waitForSettled(countRows);
    const reply = await runAssistant([{ role: "user", content: "Найди клиентов" }], actorAgent());
    expect(reply).toBe("Готово.");
    expect(callGemini).not.toHaveBeenCalled();

    // Журнал пишется «в отрыве» (задача 1.4: не на критическом пути) — ждём строку,
    // а не читаем сразу. Потом убеждаемся, что лишних не прилетело.
    await waitForCount(countRows, before + 1);
    expect((await waitForSettled(countRows)) - before).toBe(1);
    const rows = await prisma.aiAssistantAuditLog.findMany({ where: { agentId: agentAId }, orderBy: { createdAt: "asc" } });
    const last = rows[rows.length - 1];
    expect(last.tool).toBe("search_clients");
    // Строка поиска в журнале — под маской телефона (ревью П3, п.8): длинный ряд цифр
    // похож на номер, поэтому виден только хвост; сам вызов при этом опознаётся.
    expect(last.argsSummary).toContain('"q"');
    expect(last.argsSummary).toContain(String(runId).slice(-2));
    expect(last.argsSummary).not.toContain(String(runId));
  });
});
