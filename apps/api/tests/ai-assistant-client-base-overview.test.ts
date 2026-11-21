import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { PermissionId } from "@royal-home/shared";

/**
 * get_client_base_overview — «сколько клиентов, сколько активных, почему неактивны»
 * (17.11.2026, ai/assistant/tools/clientBaseOverviewTool.ts поверх lib/clientBaseOverview.ts).
 *
 * Что проверяем:
 *  1) числа по подготовленным карточкам своего агента — каждое состояние попадает ровно
 *     в свою строку (в работе / без контакта / ждёт принятия / сделка / Архив / работа
 *     завершена / Корзина с причиной / отказ с причиной), сумма сходится с «всего»;
 *  2) одна дверь с экраном: те же числа, что у GET /clients/summary того же агента;
 *  3) скоуп: агент видит только своих, директор — всю компанию и разбивку по агентам;
 *  4) общая группа Telegram закрыта двумя стенами.
 * Выводы — по своим данным (свои сотрудники и карточки), общие счётчики базы не
 * сравниваются: тесты идут в два процесса на одной базе.
 */

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { groupHiddenToolsForTests } = await import("../src/telegram/assistantBot.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = String(Date.now()).slice(-8);
const TOOL = "get_client_base_overview";

type Actor = Parameters<NonNullable<ReturnType<typeof tool>["run"]>>[1]["actor"];
function tool(name: string) {
  const plugin = findAssistantToolPlugin(name);
  if (!plugin || plugin.level !== "A") throw new Error(`нет инструмента чтения ${name}`);
  return plugin;
}
async function call(actor: Actor, args: Record<string, unknown> = {}): Promise<any> {
  return tool(TOOL).run(args, { actor });
}

let agentA = "";
let agentB = "";
let director = "";
const clientIds: string[] = [];
const auditIds: string[] = [];
const requestIds: string[] = [];

function baseActor(id: string, permissions: PermissionId[], over: Partial<Actor> = {}): Actor {
  const set = new Set<PermissionId>(permissions);
  return {
    id,
    role: "AGENT",
    surface: "crm-private",
    canViewAllClients: set.has("clients.viewAll"),
    canViewPhone: set.has("clients.viewPhone"),
    canViewReports: false,
    canViewFinance: false,
    canViewAllDeals: false,
    canAssignClients: set.has("clients.assign"),
    canEditForeignProperties: false,
    canModerate: false,
    canRequestChange: false,
    permissions: set,
    ...over,
  } as Actor;
}
const actorA = () => baseActor(agentA, []);
const actorB = () => baseActor(agentB, []);
const actorLeader = (over: Partial<Actor> = {}) =>
  baseActor(director, ["clients.viewAll", "clients.assign", "clients.delete", "otherInquiries.view"], { role: "DIRECTOR", ...over });

let seq = 0;
async function makeClient(data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `База клиент ${runId}-${seq}`,
      phone: `+99277${runId}${seq++}`,
      source: "WEBSITE",
      kind: "BUYER",
      acceptedAt: new Date(),
      ...data,
    } as never,
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  agentA = await createTestAgent(`Базов ${runId}`);
  agentB = await createTestAgent(`Другой базы ${runId}`);
  director = await createTestAgent(`Директор базы ${runId}`, "DIRECTOR");

  // В работе: покупатель, с которым агент связывался (общая отметка «агент пытался»,
  // lib/noContact.ts) — не «не связывались». Сообщение самого клиента по правилу 21.11 не в счёт.
  await makeClient({ assignedAgentId: agentA, lastClientMessageAt: new Date(), lastAgentAttemptAt: new Date() });
  // В работе: продавец без единого контакта — «не связывались» сразу (общее правило).
  await makeClient({ assignedAgentId: agentA, kind: "SELLER" });
  // В работе: ещё не принят агентом (и не связывались).
  await makeClient({ assignedAgentId: agentA, acceptedAt: null, assignedAt: new Date() });
  // Не в работе: закрытая сделка, Архив, работа завершена — ждёт руководителя.
  await makeClient({ assignedAgentId: agentA, status: "DEAL_CLOSED", lastClientMessageAt: new Date() });
  await makeClient({ assignedAgentId: agentA, status: "ARCHIVED" });
  await makeClient({ assignedAgentId: agentA, assignmentCompletedAt: new Date() });
  // Корзина по одобренной заявке «Дубль».
  const trashed = await makeClient({ assignedAgentId: agentA, deletedAt: new Date(), deletedById: director });
  const req = await prisma.clientDeleteRequest.create({
    data: { clientId: trashed.id, requestedById: agentA, reason: "DUPLICATE", status: "APPROVED", decidedById: director, decidedAt: new Date() },
  });
  requestIds.push(req.id);
  // Отказ «Без сделки» агента A — журнал, как пишет routes/clients/lifecycle.ts.
  const refuse = await prisma.auditLog.create({
    data: {
      action: "CLIENT_REFUSE", entityType: "Client", entityId: trashed.id, agentId: agentA, agentName: `Базов ${runId}`,
      meta: { reason: "EXPENSIVE", assignedAgentId: agentA },
    },
  });
  auditIds.push(refuse.id);

  // У агента B — один свой клиент в работе, с ним агент связывался.
  await makeClient({ assignedAgentId: agentB, lastClientMessageAt: new Date(), lastAgentAttemptAt: new Date() });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
  await prisma.clientDeleteRequest.deleteMany({ where: { id: { in: requestIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentA, agentB, director]);
  await prisma.$disconnect();
});

describe("get_client_base_overview — числа по своим карточкам", () => {
  it("агент: каждое состояние в своей строке, сумма сходится, причины с числами", async () => {
    const out = await call(actorA());
    expect(out.error).toBeUndefined();
    const o = out.overview;
    expect(o.scope).toBe("own");
    expect(o.total).toBe(6);
    expect(o.inWork).toMatchObject({ total: 3, buyers: 2, sellers: 1, other: null, awaitingAcceptance: 1, noContact: 2, withoutAgent: null });
    expect(o.notInWork).toEqual({ total: 3, dealClosed: 1, archived: 1, workCompleted: 1 });
    expect(o.inWork.total + o.notInWork.total).toBe(o.total);
    expect(o.trash).toMatchObject({ total: 1, lastWindow: 1, withoutRequest: 0 });
    expect(o.trash.reasons).toEqual([{ key: "DUPLICATE", label: expect.stringMatching(/Дубль/), count: 1 }]);
    expect(o.refusals.total).toBe(1);
    expect(o.refusals.reasons).toEqual([{ key: "EXPENSIVE", label: expect.stringMatching(/Дорого/), count: 1 }]);
    expect(o.byAgent).toBeNull();
    // Модель получает объяснение «нет статусов» и готовый текст с теми же числами.
    expect(out.meaning.noStatuses).toMatch(/нет с 16\.11\.2026/);
    expect(out.period).toMatch(/по Душанбе/);
    expect(out.display).toMatch(/В работе: 3/);
    expect(out.display).toMatch(/не связывались ни разу: 2/);
    expect(out.display).toMatch(/Не в работе: 3/);
    // Имена клиентов и телефоны в ответ не попадают вовсе.
    expect(JSON.stringify(out)).not.toMatch(new RegExp(`База клиент ${runId}|\\+99277${runId}`));
  });

  it("одна дверь с экраном «Клиенты»: те же числа, что у GET /clients/summary этого агента", async () => {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentA }, select: { phone: true } });
    const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" });
    expect(login.status).toBe(200);
    const token = login.body.accessToken ?? login.body.token;
    const summary = await request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${token}`);
    expect(summary.status).toBe(200);
    const o = (await call(actorA())).overview;
    expect(o.inWork.buyers).toBe(summary.body.buyers);
    expect(o.inWork.sellers).toBe(summary.body.sellers);
    expect(o.inWork.noContact).toBe(summary.body.neverContacted);
    expect(o.inWork.awaitingAcceptance).toBe(summary.body.awaitingAgent.count);
  });

  it("таджикский — тот же разбор на языке собеседника", async () => {
    const out = await call(actorA(), { lang: "tg" });
    expect(out.display).toMatch(/Дар кор: 3/);
    expect(out.display).toMatch(/мизоҷони шумо/);
  });
});

describe("get_client_base_overview — скоуп и стены", () => {
  it("агент B видит только своего клиента, ни Корзины, ни отказов агента A", async () => {
    const o = (await call(actorB())).overview;
    expect(o.total).toBe(1);
    expect(o.inWork).toMatchObject({ total: 1, buyers: 1, noContact: 0 });
    expect(o.trash.total).toBe(0);
    expect(o.refusals.total).toBe(0);
  });

  it("директор (clients.viewAll): вся компания, разбивка по агентам, «прочие» и «без агента»", async () => {
    const own = (await call(actorA())).overview;
    const o = (await call(actorLeader())).overview;
    expect(o.scope).toBe("all");
    expect(o.total).toBeGreaterThanOrEqual(own.total + 1);
    expect(o.inWork.other).not.toBeNull();
    expect(o.inWork.withoutAgent).not.toBeNull();
    expect(o.byAgent).not.toBeNull();
    expect(o.byAgent.rows.length).toBeLessThanOrEqual(12);
    // Если агент A попал в верхние строки — его числа те же, что в его собственном разборе.
    const rowA = o.byAgent.rows.find((r: { agentId: string }) => r.agentId === agentA);
    if (rowA) expect(rowA).toMatchObject({ inWork: own.inWork.total, noContact: own.inWork.noContact });
    expect(o.refusals.reasons.some((r: { key: string }) => r.key === "EXPENSIVE")).toBe(true);
    expect(o.trash.reasons.some((r: { key: string }) => r.key === "DUPLICATE")).toBe(true);
  });

  it("общая группа Telegram: не объявляется, отказывает в run и стоит в GROUP_HIDDEN_TOOLS", async () => {
    const group = actorLeader({ surface: "telegram-group" });
    expect(tool(TOOL).allowed!(group)).toBe(false);
    expect((await call(group)).error).toMatch(/личном/);
    expect(groupHiddenToolsForTests().has(TOOL)).toBe(true);
    expect(tool(TOOL).allowed!(actorA())).toBe(true);
  });
});
