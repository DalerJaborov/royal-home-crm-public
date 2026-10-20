import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Ночная проверка 02.10.2026, «Права ИИ-помощника»: ассистент ходит в базу под
 * теми же правами, что и экраны. Проверяем дыры, найденные аудитом:
 *  - комиссия без finance.view (company stats, search_deals) — только своя сделка;
 *  - карточка из Корзины и непринятый лид агенту не отдаются (история, задачи);
 *  - бюджет непринятого лида закрыт;
 *  - номер внутри имени закрыт маской без clients.viewPhone;
 *  - get_finance_summary: расходы в долларах переведены в сомони, прибыль —
 *    от доли компании, как в «Финансах».
 */

const resolveGeminiKey = vi.fn();
const callGemini = vi.fn();
const callGeminiTools = vi.fn();
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  resolveGeminiKey, callGemini, callGeminiTools,
}));

const { prisma } = await import("../src/db.js");
const { runTool } = await import("../src/ai/assistant.js");
const { dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");

const runId = Date.now();
let agentAId: string;
let agentBId: string;
let directorId: string;
let districtId: string;
const propertyIds: string[] = [];
const clientIds: string[] = [];
const dealIds: string[] = [];
const expenseIds: string[] = [];

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

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Права-объект ${propertyIds.length}-${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 60000,
      currency: "TJS",
      districtId,
      address: `Тестовая, ${40 + propertyIds.length}`,
      condition: "GOOD",
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

async function makeClient(name: string, agentId: string, extra: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: name,
      phone: `+9928${clientIds.length}${String(runId).slice(-7)}`,
      source: "WEBSITE",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      ...extra,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Права-район-${runId}` } })).id;
  const mk = async (name: string, phone: string, role: "AGENT" | "DIRECTOR") =>
    (await prisma.agent.create({ data: { fullName: `${name} ${runId}`, phone, role, passwordHash: "x" } })).id;
  agentAId = await mk("Права А", `+992910${String(runId).slice(-8)}`, "AGENT");
  agentBId = await mk("Права Б", `+992911${String(runId).slice(-8)}`, "AGENT");
  directorId = await mk("Права Д", `+992912${String(runId).slice(-8)}`, "DIRECTOR");
});

afterAll(async () => {
  await prisma.aiAssistantAuditLog.deleteMany({ where: { agentId: { in: [agentAId, agentBId, directorId] } } });
  await prisma.expense.deleteMany({ where: { id: { in: expenseIds } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("комиссия — только по праву на финансы или по своей сделке", () => {
  it("search_deals: чужая сделка без finance.view — без суммы, своя — с суммой", async () => {
    const mixed = { ...actorAgent(), canViewAllClients: true, canViewAllDeals: true };
    const own = await makeClient(`Комиссия-своя-${runId}`, agentAId);
    const foreign = await makeClient(`Комиссия-чужая-${runId}`, agentBId);
    const dOwn = await prisma.deal.create({
      data: { clientId: own.id, propertyId: await makeProperty(), agentId: agentAId, stage: "NEGOTIATION", commissionAmount: 1234 },
    });
    const dForeign = await prisma.deal.create({
      data: { clientId: foreign.id, propertyId: await makeProperty(), agentId: agentBId, stage: "NEGOTIATION", commissionAmount: 4321 },
    });
    dealIds.push(dOwn.id, dForeign.id);

    const rows = (await runTool("search_deals", { query: `Комиссия-` }, mixed)) as Array<Record<string, unknown>>;
    const rowOwn = rows.find((r) => r.id === dOwn.id)!;
    const rowForeign = rows.find((r) => r.id === dForeign.id)!;
    expect(rowOwn.commissionAmount).toBe(1234);
    expect("commissionAmount" in rowForeign).toBe(false);

    const asDirector = (await runTool("search_deals", { query: `Комиссия-` }, actorDirector())) as Array<Record<string, unknown>>;
    expect(asDirector.find((r) => r.id === dForeign.id)!.commissionAmount).toBe(4321);
  });

  it("get_company_stats: сотрудник «все клиенты» без финансов не получает комиссию компании", async () => {
    const noFinance = { ...actorAgent(), canViewAllClients: true };
    const stats = (await runTool("get_company_stats", {}, noFinance)) as Record<string, unknown>;
    expect("commissionTJS" in stats).toBe(false);

    const own = (await runTool("get_company_stats", {}, actorAgent())) as Record<string, unknown>;
    expect("commissionTJS" in own).toBe(true);
    const dir = (await runTool("get_company_stats", {}, actorDirector())) as Record<string, unknown>;
    expect("commissionTJS" in dir).toBe(true);
  });
});

describe("карточки из Корзины и непринятые лиды", () => {
  it("get_client_history / create_task / reschedule_task: Корзина — «не найден» всем", async () => {
    const c = await makeClient(`Корзина-${runId}`, agentAId, { deletedAt: new Date() });
    for (const actor of [actorAgent(), actorDirector()]) {
      expect(await runTool("get_client_history", { clientId: c.id }, actor)).toEqual({ error: "Клиент не найден" });
      expect(
        await runTool("create_task", { clientId: c.id, notes: "x", nextAction: "x", nextActionDate: "2030-01-01" }, actor)
      ).toEqual({ error: "Клиент не найден" });
      expect(await runTool("reschedule_task", { clientId: c.id, newDate: "2030-01-01" }, actor)).toEqual({
        error: "Клиент не найден",
      });
    }
  });

  it("непринятый лид: агенту — «не найден», руководству — доступен", async () => {
    const c = await makeClient(`Непринятый-${runId}`, agentAId, { acceptedAt: null });
    expect(await runTool("get_client_history", { clientId: c.id }, actorAgent())).toEqual({ error: "Клиент не найден" });
    const asDirector = (await runTool("get_client_history", { clientId: c.id }, actorDirector())) as { error?: string };
    expect(asDirector.error).toBeUndefined();
  });

  it("search_clients: бюджет и комнаты непринятого лида закрыты для агента", async () => {
    const c = await makeClient(`Бюджет-лид-${runId}`, agentAId, {
      acceptedAt: null,
      budgetMin: 50000,
      budgetMax: 90000,
      desiredRooms: 3,
    });
    const rows = (await runTool("search_clients", { q: `Бюджет-лид-${runId}` }, actorAgent())) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.id === c.id)!;
    expect(row.budgetMax).toBeNull();
    expect(row.budgetMin).toBeNull();
    expect(row.desiredRooms).toBeNull();

    const dirRows = (await runTool("search_clients", { q: `Бюджет-лид-${runId}` }, actorDirector())) as Array<Record<string, unknown>>;
    expect(dirRows.find((r) => r.id === c.id)!.budgetMax).toBe(90000);
  });
});

describe("номер внутри имени закрыт без clients.viewPhone", () => {
  it("search_clients / search_deals / get_upcoming_showings не называют номер из имени", async () => {
    const digits = "992901234567";
    const c = await makeClient(`Продавец ${digits} ${runId}`, agentAId);
    const deal = await prisma.deal.create({
      data: { clientId: c.id, propertyId: await makeProperty(), agentId: agentAId, stage: "NEGOTIATION" },
    });
    dealIds.push(deal.id);
    await prisma.interaction.create({
      data: {
        clientId: c.id,
        agentId: agentAId,
        type: "SHOWING",
        notes: "показ",
        nextAction: "показ",
        nextActionDate: new Date(Date.now() + 86_400_000),
      },
    });

    const q = String(runId);
    const clients = (await runTool("search_clients", { q }, actorAgent())) as Array<{ id: string; fullName: string }>;
    expect(clients.find((r) => r.id === c.id)!.fullName).not.toContain(digits);

    const deals = (await runTool("search_deals", { query: q }, actorAgent())) as Array<{ id: string; client: string }>;
    expect(deals.find((r) => r.id === deal.id)!.client).not.toContain(digits);

    const showings = (await runTool("get_upcoming_showings", {}, actorAgent())) as Array<{ client: string }>;
    for (const s of showings) expect(s.client).not.toContain(digits);
  });
});

describe("get_finance_summary — те же цифры, что в «Финансах»", () => {
  it("расход в долларах переводится в сомони, прибыль считается от доли компании", async () => {
    const monthKey = dushanbeWallClock().toISOString().slice(0, 7);
    const before = (await runTool("get_finance_summary", {}, actorDirector())) as {
      expensesTJS: number;
      companyRevenueTJS: number;
      profitTJS: number;
    };

    const c = await makeClient(`Финансы-${runId}`, agentAId);
    const deal = await prisma.deal.create({
      data: {
        clientId: c.id,
        propertyId: await makeProperty(),
        agentId: agentAId,
        stage: "COMPLETED",
        commissionAmount: 10000,
        commissionRealtorAmount: 6000,
        commissionCompanyAmount: 4000,
        currency: "TJS",
        closedAt: new Date(),
      },
    });
    dealIds.push(deal.id);
    const expense = await prisma.expense.create({
      data: { category: "ADVERTISING", amount: 100, currency: "USD", month: new Date(`${monthKey}-01T00:00:00.000Z`) },
    });
    expenseIds.push(expense.id);

    const after = (await runTool("get_finance_summary", {}, actorDirector())) as typeof before;
    expect(after.companyRevenueTJS - before.companyRevenueTJS).toBe(4000);
    // 100 долларов — это больше 100 сомони (курс > 1), а не «100 с.».
    const spent = after.expensesTJS - before.expensesTJS;
    expect(spent).toBeGreaterThan(100);
    expect(Math.round((after.profitTJS - before.profitTJS) * 100)).toBe(Math.round((4000 - spent) * 100));
  });
});
