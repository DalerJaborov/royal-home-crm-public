import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Лишние уведомления агентам (владелец 27.11.2026: «Все пять групп»). Не удалены —
 * рубильники в Настройках → «Уведомления», по умолчанию «тихо». Здесь группа 1
 * (повторы поверх «Ваш клиент написал»): пуша нет, запись в истории клиента есть;
 * рубильник ВКЛ — пуш как раньше. Группы 2–5 проверены в своих файлах
 * (market-own-match, deal-client-recovered-bonus, incoming-calls, duplicate-review,
 * phone-lead-watchdog, new-inquiry-detector).
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { notifyRepeatInquiry } = await import("../src/services/leads/intake.js");
const { reactivateClientFromLost } = await import("../src/lib/clientLifecycle.js");

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];
let saved: { notifyRepeatContactPushEnabled: boolean } | null = null;

async function setSwitch(on: boolean) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", notifyRepeatContactPushEnabled: on },
    update: { notifyRepeatContactPushEnabled: on },
  });
}

async function makeClient(data: Record<string, unknown> = {}) {
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент тихо ${runId}-${clientIds.length}`,
      phone: `+99290${String(runId).slice(-6)}${clientIds.length}`,
      kind: "BUYER",
      source: "INSTAGRAM",
      assignedAgentId: agentId,
      ...data,
    },
  });
  clientIds.push(client.id);
  return client;
}

beforeAll(async () => {
  saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { notifyRepeatContactPushEnabled: true } });
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент тихо ${runId}`, phone: `+992930${String(runId).slice(-6)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => {
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { notifyRepeatContactPushEnabled: saved?.notifyRepeatContactPushEnabled ?? false } });
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("группа 1: «снова на связи» поверх «Ваш клиент написал»", () => {
  it("по умолчанию пуша нет, запись в истории клиента есть", async () => {
    await setSwitch(false);
    const client = await makeClient();
    await notifyRepeatInquiry(client.id, "Ищет 2-комнатную в Сино");
    expect(sendPushToAgent).not.toHaveBeenCalled();
    expect(await prisma.interaction.count({ where: { clientId: client.id, notes: { contains: "снова написал боту" } } })).toBe(1);
  });

  it("рубильник ВКЛ — пуш «снова на связи», как раньше", async () => {
    await setSwitch(true);
    try {
      const client = await makeClient();
      await notifyRepeatInquiry(client.id, "Ищет 2-комнатную в Сино");
      expect(sendPushToAgent).toHaveBeenCalledTimes(1);
      expect((sendPushToAgent.mock.calls[0] as unknown[])[1]).toMatchObject({ title: expect.stringContaining("снова на связи") });
    } finally {
      await setSwitch(false);
    }
  });

  it("возврат из «Потерянных» по сообщению: по умолчанию пуша нет, но одна строка в колокольчике есть", async () => {
    await setSwitch(false);
    const client = await makeClient({ status: "LOST", workStatus: "ACTIVE", assignedAgentId: null, lastAgentId: agentId });
    const res = await reactivateClientFromLost({ clientId: client.id, reason: "тест тихо", agentId, returnTimer: true });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(sendPushToAgent.mock.calls.filter(([, p]) => String((p as { title: string }).title).includes("снова обратился"))).toHaveLength(0);
    // «Ваш клиент написал» в этот момент не уходит (ответственного ещё нет) — агент узнаёт из колокольчика (ревью 27.11).
    const rows = await prisma.notification.findMany({ where: { agentId, tag: `repeat-contact-${client.id}` } });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });

  it("возврат из «Потерянных», рубильник ВКЛ — пуш «снова обратился»", async () => {
    await setSwitch(true);
    try {
      const client = await makeClient({ status: "LOST", workStatus: "ACTIVE", assignedAgentId: null, lastAgentId: agentId });
      const res = await reactivateClientFromLost({ clientId: client.id, reason: "тест тихо", agentId, returnTimer: true });
      expect(res.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(sendPushToAgent.mock.calls.filter(([, p]) => String((p as { title: string }).title).includes("снова обратился"))).toHaveLength(1);
    } finally {
      await setSwitch(false);
    }
  });
});
