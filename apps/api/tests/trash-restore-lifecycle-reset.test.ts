import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * ВОССТАНОВЛЕННАЯ ИЗ КОРЗИНЫ КАРТОЧКА НЕ УЛЕТАЕТ ОБРАТНО (23.09.2026).
 *
 * Ночной перенос убирает в Корзину Потерянных/Неактивных старше срока. Когда
 * такой клиент писал снова, карточка восстанавливалась со статусом NEW, но
 * workStatus INACTIVE, исчерпанный счётчик напоминаний и старые inactiveSince/
 * lostAt оставались: ближайший тик светофора снова уводил её в «Потерянные»,
 * ночью перенос — обратно в Корзину. Кнопка «Восстановить» оставляла старый
 * lostAt, и перенос уносил карточку в ту же ночь.
 *
 * Сам перенос здесь не запускается — он общий на всю базу и задел бы соседние
 * файлы. Проверяются ровно те поля, по которым он и светофор выбирают карточки
 * (lib/lostInactiveTrashSweep.ts, lib/inactiveTrafficLight.ts).
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

// Очередь раздачи подменяется только в одном тесте ниже — там нужен агент
// наверняка, а не тот, кого найдёт очередь в общей тестовой базе.
const { queue } = vi.hoisted(() => ({ queue: { agentId: "" } }));
vi.mock("../src/services/leads/selection.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/leads/selection.js")>();
  return {
    ...orig,
    pickAgentForLead: async (...args: Parameters<typeof orig.pickAgentForLead>) =>
      queue.agentId || orig.pickAgentForLead(...args),
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const longAgo = () => new Date(Date.now() - 120 * DAY);
const clientIds: string[] = [];
let adminId = "";
let adminToken = "";
let queueAgentId = "";

beforeAll(async () => {
  const a = await prisma.agent.create({
    data: { fullName: `Админ восстановления ${runId}`, phone: `+99298${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  adminId = a.id;
  adminToken = signAccessToken({ sub: a.id, role: "ADMIN" });
  queueAgentId = (
    await prisma.agent.create({
      data: { fullName: `Агент очереди ${runId}`, phone: `+99296${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { agentId: queueAgentId } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, queueAgentId] } } });
});

/** Карточка ровно в том виде, в каком её убирает в Корзину ночной перенос. */
async function trashedLostClient(phone: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Потерянный из Корзины ${runId}`,
      phone,
      source: "INSTAGRAM",
      kind: "BUYER",
      status: "LOST",
      lostAt: longAgo(),
      workStatus: "INACTIVE",
      inactiveLevel: "RED",
      inactiveSince: longAgo(),
      inactivePingCount: 9,
      deletedAt: new Date(Date.now() - 20 * DAY),
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("Возврат из Корзины сбрасывает часы светофора и переноса", () => {
  it("клиент написал снова — карточка живая, не Потерянная и без часов светофора", async () => {
    const phone = `+99299${String(runId).slice(-7)}`;
    const c = await trashedLostClient(phone);

    const result = await createLeadFromChannel({ fullName: "Потерянный из Корзины", phone, source: "WHATSAPP", kind: "BUYER" });
    expect(result.created).toBe(false);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.status).not.toBe("LOST");
    expect(after.lostAt).toBeNull();
    // Светофор выбирает только inactiveLevel/inactiveSince не null, перенос — старый inactiveSince.
    expect(after.inactiveSince).toBeNull();
    expect(after.inactiveLevel).toBeNull();
    expect(after.inactivePingCount).toBe(0);
  });

  it("клиент из Корзины, с которым раньше говорили, отдан по очереди — у агента срок принять, а не вечное ожидание (23.09.2026, №21)", async () => {
    // Карусель «не принял — следующему» не берёт карточки с прошлым контактом
    // (firstContactAt, закон П-2), а таймер возврата у воскресшей из Корзины не
    // ставился — непринятый лид висел у агента без напоминаний и эскалации.
    const phone = `+99297${String(runId).slice(-7)}`;
    const c = await trashedLostClient(phone);
    await prisma.client.update({ where: { id: c.id }, data: { firstContactAt: longAgo() } });

    queue.agentId = queueAgentId;
    try {
      await createLeadFromChannel({ fullName: "Потерянный из Корзины", phone, source: "WHATSAPP", kind: "BUYER" });
    } finally {
      queue.agentId = "";
    }

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(queueAgentId);
    expect(after.acceptedAt).toBeNull();
    expect(after.returnAcceptDueAt).not.toBeNull();
  });

  it("кнопка «Восстановить» — перенос считает срок заново, с сегодняшнего дня", async () => {
    const c = await trashedLostClient(`+99290${String(runId).slice(-7)}`);

    const res = await request(app).post(`/api/v1/clients/${c.id}/restore`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBeLessThan(300);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.deletedAt).toBeNull();
    const weekAgo = Date.now() - 7 * DAY;
    expect(after.lostAt!.getTime()).toBeGreaterThan(weekAgo);
    expect(after.inactiveSince!.getTime()).toBeGreaterThan(weekAgo);
  });
});
