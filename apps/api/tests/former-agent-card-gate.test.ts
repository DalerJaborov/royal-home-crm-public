import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * АУДИТ БЕЗОПАСНОСТИ 17.11.2026, ЧАСТЬ 2 — S1 и S2 (lib/clientCardAccess.ts).
 *
 * S1: «бывший агент» (`lastAgentId` — его пишет changeClientAgent при ЛЮБОЙ
 * смене владельца, в том числе при отказе от лида) получал всю карточку:
 * бюджет, требования, переписку, ник Telegram, выгрузку переписки. Отказ от
 * лида открывал то, что до принятия закрыто. Теперь — только «передана» и имя.
 *
 * S2: до принятия лида агенту был виден ник клиента в Telegram — правило
 * «только имя» его не прятало.
 */

const runId = Date.now();
const tail = String(runId).slice(-7);
const password = "testpass123";
const NICK = `secret_nick_${tail}`;

const agentIds: string[] = [];
const clientIds: string[] = [];
const conversationIds: string[] = [];
const tokens: Record<"A" | "B" | "C" | "DIRECTOR", string> = { A: "", B: "", C: "", DIRECTOR: "" };
let ids: Record<"A" | "B" | "C" | "DIRECTOR", string>;

let pendingLead: { id: string; shortId: number };
let transferredClient: { id: string; shortId: number };

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  const agent = await prisma.agent.findUnique({ where: { phone }, select: { id: true } });
  if (agent) grantElevation(agent.id);
  return res.body.accessToken as string;
}

async function seedClient(n: string, assignedAgentId: string, accepted: boolean) {
  const client = await prisma.client.create({
    data: {
      fullName: "Фарход Каримов",
      phone: `+99298${n}${tail}`,
      extraPhones: [`+99299${n}${tail}`],
      email: `client-${n}-${tail}@example.test`,
      source: "TELEGRAM",
      telegramUsername: NICK,
      telegramChatId: `tg-${n}-${tail}`,
      budgetMin: 50000,
      budgetMax: 70000,
      requirementsNotes: "3 комнаты, только Сино",
      aiInsight: "Ищет 3-комнатную в Сино, готов платить наличными",
      assignedAgentId,
      acceptedAt: accepted ? new Date() : null,
    },
  });
  clientIds.push(client.id);
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `card-gate-${n}-${tail}`,
      clientId: client.id,
      messages: [{ role: "user", content: "Салом, бюджет 60 000", at: new Date().toISOString() }] as object[],
    },
  });
  conversationIds.push(conv.id);
  await prisma.interaction.create({
    data: { clientId: client.id, agentId: assignedAgentId, type: "MESSAGE", notes: "Клиент рассказал про семью" },
  });
  return { id: client.id, shortId: client.shortId };
}

/** 503 «сервер занят» на занятой машине повторяет и сам экран (lib/queryClient.ts). */
async function get(path: string, who: keyof typeof tokens) {
  for (let attempt = 0; ; attempt++) {
    const res = await request(app).get(`/api/v1/clients/${path}`).set("Authorization", `Bearer ${tokens[who]}`);
    if (res.status !== 503 || attempt >= 3) return res;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Всё, по чему клиента можно найти или вести мимо CRM, и всё, что закрыто до принятия. */
function expectOnlyNameAndTransfer(body: Record<string, unknown>) {
  expect(body.telegramUsername).toBeNull();
  expect(body.telegramChatId).toBeNull();
  expect(body.budgetMin).toBeNull();
  expect(body.budgetMax).toBeNull();
  expect(body.requirementsNotes).toBeNull();
  expect(body.aiInsight).toBeNull();
  expect(body.email).toBeNull();
  expect(JSON.stringify(body.extraPhones)).not.toContain(tail);
  expect(String(body.phone)).not.toContain(tail);
  expect(body.botConversation).toEqual([]);
  expect(body.telegramConversation).toBeNull();
  expect(body.telegramDirectConversations).toEqual([]);
  expect(body.interactions).toEqual([]);
  expect(body.interactionsTotal).toBe(0);
  expect(JSON.stringify(body)).not.toContain(NICK);
  expect(JSON.stringify(body)).not.toContain("бюджет 60 000");
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const make = async (key: keyof typeof tokens, n: string, role: "AGENT" | "DIRECTOR") => {
    const phone = `+99297${n}${tail}`;
    const agent = await prisma.agent.create({ data: { fullName: `Карточка ${key} ${tail}`, phone, role, passwordHash } });
    agentIds.push(agent.id);
    return { id: agent.id, phone };
  };
  const a = await make("A", "1", "AGENT");
  const b = await make("B", "2", "AGENT");
  const c = await make("C", "3", "AGENT");
  const d = await make("DIRECTOR", "4", "DIRECTOR");
  ids = { A: a.id, B: b.id, C: c.id, DIRECTOR: d.id };
  tokens.A = await login(a.phone);
  tokens.B = await login(b.phone);
  tokens.C = await login(c.phone);
  tokens.DIRECTOR = await login(d.phone);

  pendingLead = await seedClient("5", ids.A, false);
  transferredClient = await seedClient("6", ids.A, true);
  // Передача принятого клиента руководителем — через единый вход, как на проде.
  // Именно человеком (actorId): автоматике закон П-3 не даёт увести принятого
  // клиента, с которым уже был контакт.
  const moved = await changeClientAgent({
    clientId: transferredClient.id,
    toAgentId: ids.B,
    reason: "передан руководителем",
    actorId: ids.DIRECTOR,
    source: "test.card-gate",
  });
  expect(moved.ok).toBe(true);
  // Четыре входа с bcrypt и передача через единый вход — на занятой машине
  // дольше стандартных 20 секунд.
}, 120_000);

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Client", entityId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("S2: до принятия лида — только имя, без ника Telegram", () => {
  it("непринятый лид: агент не видит ни ник, ни чат Telegram, ни требований", async () => {
    const res = await get(String(pendingLead.shortId), "A");
    expect(res.status).toBe(200);
    expect(res.body.pendingAcceptance).toBe(true);
    expectOnlyNameAndTransfer(res.body);
    expect(res.body.access).toBeUndefined();
  });
});

describe("S1: бывший агент видит только «передана»", () => {
  it("отказ от лида не открывает карточку: после «Отклонить» — только факт передачи", async () => {
    const declined = await request(app)
      .post(`/api/v1/clients/${pendingLead.id}/decline`)
      .set("Authorization", `Bearer ${tokens.A}`)
      .send({});
    expect(declined.status).toBe(200);
    const after = await prisma.client.findUnique({ where: { id: pendingLead.id }, select: { assignedAgentId: true, lastAgentId: true } });
    expect(after?.assignedAgentId).not.toBe(ids.A);
    expect(after?.lastAgentId).toBe(ids.A);

    const res = await get(String(pendingLead.shortId), "A");
    expect(res.status).toBe(200);
    expect(res.body.access?.readOnly).toBe(true);
    expectOnlyNameAndTransfer(res.body);
  });

  it("переданный руководителем клиент: прежний агент видит «передана», без истории и контактов", async () => {
    const res = await get(String(transferredClient.shortId), "A");
    expect(res.status).toBe(200);
    expect(res.body.access).toMatchObject({ readOnly: true, transferredTo: { id: ids.B } });
    expect(res.body.fullName).toContain("Фарход");
    expectOnlyNameAndTransfer(res.body);
    expect(res.body.extraPhones).toEqual([]);
    expect(res.body.propertyActivitySummary).toBeNull();
    expect(res.body.nextStep).toBeNull();
  });

  it("хронология, выгрузка переписки и объекты бывшему агенту закрыты", async () => {
    const timeline = await get(`${transferredClient.shortId}/timeline`, "A");
    expect(timeline.status).toBe(200);
    expect(timeline.body).toEqual({ items: [], total: 0, hasMore: false });

    const exported = await get(`${transferredClient.shortId}/conversation-export?format=txt`, "A");
    expect(exported.status).toBe(403);

    const activity = await get(`${transferredClient.id}/property-activity?section=sent`, "A");
    expect(activity.status).toBe(200);
    expect(activity.body.items).toEqual([]);
    expect(activity.body.total).toBe(0);
  });

  it("новые сообщения после передачи бывшему агенту тоже не приходят", async () => {
    const conv = await prisma.botConversation.findFirst({ where: { clientId: transferredClient.id }, select: { id: true } });
    await prisma.botConversation.update({
      where: { id: conv!.id },
      data: { messages: [{ role: "user", content: "Новый номер для связи после передачи", at: new Date().toISOString() }] as object[] },
    });
    const res = await get(String(transferredClient.shortId), "A");
    expect(JSON.stringify(res.body)).not.toContain("Новый номер для связи");
  });

  it("новый агент работает с карточкой как обычно (контакт Telegram закрыт и ему — нет права на номер)", async () => {
    const res = await get(String(transferredClient.shortId), "B");
    expect(res.status).toBe(200);
    expect(res.body.access).toBeUndefined();
    expect(Number(res.body.budgetMin)).toBe(50000);
    expect(res.body.botConversation).toHaveLength(1);
    expect(res.body.interactionsTotal).toBeGreaterThan(0);
    expect(res.body.telegramUsername).toBeNull();
    const exported = await get(`${transferredClient.shortId}/conversation-export?format=txt`, "B");
    expect(exported.status).toBe(200);
  });

  it("директор (видит всех и номера) — без изменений: видит всё, включая ник", async () => {
    const res = await get(String(transferredClient.shortId), "DIRECTOR");
    expect(res.status).toBe(200);
    expect(res.body.access).toBeUndefined();
    expect(res.body.telegramUsername).toBe(NICK);
    expect(res.body.botConversation).toHaveLength(1);
    expect(Number(res.body.budgetMin)).toBe(50000);
  });

  it("посторонний агент по-прежнему получает 403 на всех путях", async () => {
    expect((await get(String(transferredClient.shortId), "C")).status).toBe(403);
    expect((await get(`${transferredClient.shortId}/timeline`, "C")).status).toBe(403);
    expect((await get(`${transferredClient.shortId}/conversation-export`, "C")).status).toBe(403);
    expect((await get(`${transferredClient.id}/property-activity?section=sent`, "C")).status).toBe(403);
  });
});
