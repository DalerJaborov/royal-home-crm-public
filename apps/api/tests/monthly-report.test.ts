import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { buildMonthlyMetrics, generateMonthlyReport, monthKeyLabel, monthRange } = await import("../src/lib/monthlyReport.js");
const { dushanbeStartOfMonth } = await import("../src/lib/dushanbeTime.js");
const { logTimeline } = await import("../src/lib/timeline.js");

/** Месячный отчёт руководству (примечание владельца от 30.07): цифры снапшотом,
 *  заметки правятся отдельно, повторный запуск ничего не портит. */

const runId = Date.now();
let agentId: string;
let directorId: string;
let districtId: string;
let propertyId: string;
let clientId: string;
let dealId: string;
let periodStart: Date;

beforeAll(async () => {
  // Отчётный месяц — прошлый, как у настоящего джоба, и по календарю ДУШАНБЕ.
  // Считать границу месяца в UTC нельзя: с 19:00 UTC последнего числа в Душанбе
  // уже наступил следующий месяц — джоб собирает отчёт за июль, а тест искал за
  // июнь. Падало это ровно в эти пять часов, то есть в конце КАЖДОГО месяца, и
  // каждый раз выглядело как случайный сбой.
  const now = new Date();
  const wall = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  periodStart = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 1) - 5 * 60 * 60 * 1000);

  // Отчёт месяца в таблице один (periodStart уникален), поэтому тест обязан
  // начинать с чистого места: чужой оставленный отчёт за тот же месяц превращал
  // проверку «отчёт составлен» в «отчёт уже был», и падало не то, что сломано.
  await prisma.monthlyReport.deleteMany({ where: { periodStart } });

  districtId = (await prisma.district.create({ data: { name: `Тест-район-отчёт-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент отчёта", phone: `+992925${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  // Отчёт уходит тем, у кого есть право dashboard.analytics. Своего получателя
  // тест заводит сам: в CI база поднимается миграциями без сида, руководства в ней
  // нет вовсе — и проверка «уведомили руководство» падала, хотя код исправен.
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор отчёта", phone: `+992926${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект отчёта ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        createdAt: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000),
      },
    })
  ).id;
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент отчёта ${runId}`,
      phone: `+992924${runId}`,
      source: "INSTAGRAM",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      createdAt: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000),
    },
  });
  clientId = client.id;
  dealId = (
    await prisma.deal.create({
      data: {
        clientId,
        propertyId,
        agentId,
        stage: "COMPLETED",
        commissionAmount: 5000,
        currency: "TJS",
        closedAt: new Date(periodStart.getTime() + 5 * 24 * 60 * 60 * 1000),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.monthlyReport.deleteMany({ where: { periodStart } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Месячный отчёт", () => {
  it("границы месяца считаются по Душанбе и не залезают в соседние", () => {
    const { from, to } = monthRange(periodStart);
    expect(from.getTime()).toBe(periodStart.getTime());
    // Ровно один месяц: между началами 28–31 день.
    const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
  });

  it("собирает цифры месяца: сделки, комиссию, воронку, агентов", async () => {
    const m = await buildMonthlyMetrics(periodStart);
    expect(m.dealsCompleted).toBeGreaterThanOrEqual(1);
    expect(m.commission).toBeGreaterThanOrEqual(5000);
    expect(m.funnel.find((f) => f.key === "leads")!.count).toBeGreaterThanOrEqual(1);
    const mine = m.agents.find((a) => a.agentId === agentId);
    expect(mine?.deals).toBe(1);
    expect(mine?.commission).toBe(5000);
    expect(m.sources.some((s) => s.source === "INSTAGRAM")).toBe(true);
  });

  /**
   * Задание Б2-КПИ (18.09.2026, docs/archive/agent-briefs/timeline-kpi-subject-agent-18-09.md):
   * после Б1/Б2 показ, записанный ботом от лица клиента, пишется с agentId: null
   * и subjectAgentId: держатель карточки — а не agentId: держатель, как раньше.
   * Отчёт обязан по-прежнему засчитывать его держателю.
   */
  it("показ, записанный ботом от лица клиента, засчитывается держателю карточки", async () => {
    await logTimeline({
      clientId,
      actor: { kind: "bot", source: "test-bot-showing", subjectAgentId: agentId, channel: "whatsapp" },
      type: "SHOWING",
      nextActionDate: new Date(periodStart.getTime() + 2 * 24 * 60 * 60 * 1000),
      showingOffCrm: true,
      showingOffCrmDetails: "Тестовый объект вне CRM, улица Проверочная 1",
      notes: `Бот записал показ ${runId}`,
      createdAt: new Date(periodStart.getTime() + 2 * 24 * 60 * 60 * 1000),
    });
    const m = await buildMonthlyMetrics(periodStart);
    const mine = m.agents.find((a) => a.agentId === agentId);
    expect(mine?.showings).toBe(1);
  });

  it("агенты без единого действия в отчёт не попадают", async () => {
    const empty = await prisma.agent.create({
      data: { fullName: "Агент без дел", phone: `+992923${runId}`, role: "AGENT", passwordHash: "x" },
    });
    const m = await buildMonthlyMetrics(periodStart);
    expect(m.agents.find((a) => a.agentId === empty.id)).toBeUndefined();
    await prisma.agent.delete({ where: { id: empty.id } });
  });

  it("составляет отчёт и уведомляет руководство", async () => {
    const result = await generateMonthlyReport();
    expect(result.created).toBe(true);
    const saved = await prisma.monthlyReport.findUnique({ where: { periodStart: result.periodStart } });
    expect(saved).not.toBeNull();
    expect(sendPushToAgent).toHaveBeenCalledWith(directorId, expect.objectContaining({ url: "/reports" }));
  });

  it("повторный запуск не дублирует отчёт и не трогает заметки", async () => {
    await prisma.monthlyReport.update({ where: { periodStart }, data: { notes: "Мои дополнения" } });
    const again = await generateMonthlyReport();
    expect(again.created).toBe(false);
    const saved = await prisma.monthlyReport.findUnique({ where: { periodStart } });
    expect(saved?.notes).toBe("Мои дополнения");
    const count = await prisma.monthlyReport.count({ where: { periodStart } });
    expect(count).toBe(1);
  });

  it("цифры — снапшот: отмена сделки задним числом отчёт не меняет", async () => {
    const before = await prisma.monthlyReport.findUnique({ where: { periodStart } });
    const beforeDeals = (before!.metrics as unknown as { dealsCompleted: number }).dealsCompleted;
    await prisma.deal.update({ where: { id: dealId }, data: { stage: "CANCELLED" } });
    const after = await prisma.monthlyReport.findUnique({ where: { periodStart } });
    expect((after!.metrics as unknown as { dealsCompleted: number }).dealsCompleted).toBe(beforeDeals);
    await prisma.deal.update({ where: { id: dealId }, data: { stage: "COMPLETED" } });
  });
});

/**
 * Расходы месяца.
 *
 * Отчёт живёт по календарю Душанбе (periodStart — 19:00 предыдущего дня), а
 * Expense.month записывается UTC-полночью первого числа. Пока эти две формы
 * сравнивались напрямую, равенство не выполнялось НИКОГДА: в отчёте каждый месяц
 * стояло «Расходы 0 с.», и по этой цифре считали прибыль. Ни один тест расходов не
 * трогал — поэтому сборка была зелёной.
 */
describe("Расходы попадают в отчёт", () => {
  let expenseId: string;

  it("сумма расходов месяца не теряется на границе часовых поясов", async () => {
    const wall = new Date(periodStart.getTime() + 5 * 60 * 60 * 1000);
    // Ровно так месяц записывает routes/expenses.ts: UTC-полночь первого числа.
    const month = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1));
    const expense = await prisma.expense.create({
      data: { month, category: "OTHER", amount: 7000, currency: "TJS", note: `Тест расхода ${runId}` },
    });
    expenseId = expense.id;

    const m = await buildMonthlyMetrics(periodStart);
    expect(m.expenses).toBeGreaterThanOrEqual(7000);

    await prisma.expense.delete({ where: { id: expenseId } });
  });

  it("метка месяца называет настоящий месяц отчёта, а не предыдущий", () => {
    const wall = new Date(periodStart.getTime() + 5 * 60 * 60 * 1000);
    const expected = `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(monthKeyLabel(periodStart)).toBe(expected);
    // Прежний способ (срез ISO от periodStart) давал чужой месяц.
    expect(monthKeyLabel(periodStart)).not.toBe(periodStart.toISOString().slice(0, 7));
  });
});
