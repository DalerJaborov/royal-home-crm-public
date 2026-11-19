import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ЧЕТЫРЕ НАХОДКИ АУДИТА ПЕРЕНАЗНАЧЕНИЯ КЛИЕНТА (18.11.2026), починка 19.11.2026.
 *
 *  1. «Передать» жмёт руководитель (с 16.11.2026), а хронология и аудит
 *     подписывали действие агентом-владельцем карточки.
 *  2. Принятие и снятие по сроку предложения реактивации могли пройти ОБА.
 *  3. intake.ts менял владельца мимо `changeClientAgent` (без спутников, закона,
 *     единого аудита).
 *  4. Спутники смены владельца срабатывали до коммита чужой транзакции — и
 *     при её откате тоже.
 *
 * Каждый тест проверен на красный без починки (журнал docs/journal/2026-11-19-reassign-bugs.md).
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");
const { changeClientAgent } = await import("../src/lib/changeClientAgent.js");
const { acceptReactivationOffer, releaseReactivationOffer } = await import("../src/lib/reactivationOffers.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

/** Настоящий таджикский номер: +992 и девять цифр. */
const phone = () => `+9929${randomInt(10_000_000, 99_999_999)}`;
const password = "testpass123";
let directorId = "";
let directorPhone = "";
let agentAId = "";
let agentBId = "";
const agentIds: string[] = [];
const clientIds: string[] = [];

async function makeAgent(fullName: string, role: "AGENT" | "DIRECTOR", phoneNo = phone()) {
  const passwordHash = await bcrypt.hash(password, 4);
  const a = await prisma.agent.create({ data: { fullName, phone: phoneNo, role, passwordHash } });
  agentIds.push(a.id);
  return a.id;
}

async function makeClient(data: Partial<Parameters<typeof prisma.client.create>[0]["data"]> = {}) {
  const c = await prisma.client.create({
    data: { fullName: `Клиент переназначения ${clientIds.length}`, phone: phone(), source: "PHONE_CALL", kind: "BUYER", ...data },
  });
  clientIds.push(c.id);
  return c;
}

async function leadNotification(agentId: string, client: { id: string; shortId: number; fullName: string }) {
  return prisma.notification.create({
    data: { agentId, kind: "lead", title: "🔔 Новый лид", body: client.fullName, tag: `lead-${client.id}`, url: `/clients/${client.shortId}` },
  });
}

beforeAll(async () => {
  directorPhone = phone();
  directorId = await makeAgent("Руководитель переназначения", "DIRECTOR", directorPhone);
  agentAId = await makeAgent("Агент А переназначения", "AGENT");
  agentBId = await makeAgent("Агент Б переназначения", "AGENT");
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("№1 «Передать»: в хронологии и аудите — нажавший, а не владелец", () => {
  it("руководитель передаёт клиента агента А — подписан руководитель", async () => {
    const c = await makeClient({ assignedAgentId: agentAId, acceptedAt: new Date() });
    await prisma.interaction.create({
      data: { clientId: c.id, agentId: agentAId, type: "CALL", recordingDurationSec: 120, notes: "Разговор" },
    });
    const login = await request(app).post("/api/v1/auth/login").send({ phone: directorPhone, password });
    expect(login.status).toBe(200);

    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ reason: "NO_TRUST" });
    expect(res.status).toBe(200);

    const timeline = await prisma.interaction.findFirst({
      where: { clientId: c.id, type: "SYSTEM", notes: { startsWith: "Передан другому агенту" } },
    });
    expect(timeline?.agentId).toBe(directorId);

    const change = await prisma.auditLog.findFirst({
      where: { entityId: c.id, action: "CLIENT_AGENT_CHANGE" },
      orderBy: { createdAt: "desc" },
    });
    expect(change?.agentId).toBe(directorId);

    const transfer = await prisma.auditLog.findFirst({ where: { entityId: c.id, action: "CLIENT_TRANSFER" } });
    expect(transfer?.agentId).toBe(directorId);
    // Чей клиент — виден отдельно: по нему считается квота передач агента.
    expect((transfer?.meta as { fromAgentId?: string } | null)?.fromAgentId).toBe(agentAId);
  });
});

describe("№2 предложение реактивации: принятие и снятие не проходят оба", () => {
  async function offered() {
    return makeClient({
      workStatus: "INACTIVE",
      assignedAgentId: agentAId,
      lastAgentId: agentAId,
      reactivationOfferedToAgentId: agentAId,
      reactivationOfferedAt: new Date(Date.now() - 48 * 3600_000),
    });
  }

  it("крон прочитал предложение до принятия — его снятие после принятия ничего не меняет", async () => {
    const c = await offered();
    // Снимок, который прочитал крон expireStaleReactivationOffers до нажатия «Принять».
    const stale = { id: c.id, shortId: c.shortId, fullName: c.fullName, kind: c.kind };

    const accepted = await acceptReactivationOffer(c.id, agentAId);
    expect(accepted.ok).toBe(true);
    const released = await releaseReactivationOffer(stale, agentAId, "expired");
    expect(released.raced).toBe(true);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(agentAId);
    expect(after.workStatus).toBe("ACTIVE");
    const releases = await prisma.auditLog.count({
      where: { entityId: c.id, action: "CLIENT_AGENT_CHANGE", meta: { path: ["source"], equals: "reactivation.release" } },
    });
    expect(releases).toBe(0);
  });

  it("крон не снимает по сроку старого предложения новое, сделанное после", async () => {
    const c = await offered();
    const stale = { id: c.id, shortId: c.shortId, fullName: c.fullName, kind: c.kind, reactivationOfferedAt: c.reactivationOfferedAt };
    expect((await acceptReactivationOffer(c.id, agentAId)).ok).toBe(true);
    const freshAt = new Date();
    await prisma.client.update({
      where: { id: c.id },
      data: { workStatus: "INACTIVE", reactivationOfferedToAgentId: agentAId, reactivationOfferedAt: freshAt },
    });

    const released = await releaseReactivationOffer(stale, agentAId, "expired");
    expect(released.raced).toBe(true);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.reactivationOfferedToAgentId).toBe(agentAId);
    expect(after.reactivationOfferedAt?.getTime()).toBe(freshAt.getTime());
  });

  it("одновременно: успешен ровно один из двух", async () => {
    for (let i = 0; i < 4; i++) {
      const c = await offered();
      const stale = { id: c.id, shortId: c.shortId, fullName: c.fullName, kind: c.kind };
      const [accepted, released] = await Promise.all([
        acceptReactivationOffer(c.id, agentAId),
        releaseReactivationOffer(stale, agentAId, "expired"),
      ]);
      const wins = (accepted.ok ? 1 : 0) + (released.raced ? 0 : 1);
      expect(wins).toBe(1);
      const changes = await prisma.auditLog.count({ where: { entityId: c.id, action: "CLIENT_AGENT_CHANGE" } });
      expect(changes).toBe(1);
    }
  });
});

describe("№3 intake меняет владельца только через changeClientAgent", () => {
  it("возврат из «Неактивных» при уволенном агенте: спутники прежнего гаснут, аудит с from/to", async () => {
    const firedId = await makeAgent("Уволенный агент переназначения", "AGENT");
    const c = await makeClient({ assignedAgentId: firedId, lastAgentId: firedId, acceptedAt: new Date(), workStatus: "INACTIVE" });
    await prisma.interaction.create({
      data: { clientId: c.id, agentId: firedId, type: "CALL", recordingDurationSec: 60, notes: "Звонок" },
    });
    const note = await leadNotification(firedId, c);
    await prisma.agent.update({ where: { id: firedId }, data: { isActive: false } });

    await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "WHATSAPP", requirementsNotes: "снова ищу" });

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).not.toBe(firedId);
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: c.id, action: "CLIENT_AGENT_CHANGE", meta: { path: ["source"], equals: "intake.reactivation-fallback" } },
    });
    const meta = audit?.meta as Record<string, unknown> | null;
    expect(meta?.from).toBe(firedId);
    expect(meta?.fromAgentId).toBe(firedId);
    expect(meta?.toAgentId).toBe(after.assignedAgentId);
    // Единая дверь гасит «новый лид» у прежнего держателя; прямая запись — нет.
    const noteAfter = await prisma.notification.findUniqueOrThrow({ where: { id: note.id } });
    expect(noteAfter.read).toBe(true);
  });

  it("смена типа на покупателя вместе со сменой владельца — бюджет под сторожем перевёрнутых границ", async () => {
    const firedId = await makeAgent("Уволенный агент бюджета", "AGENT");
    const c = await makeClient({ kind: "SELLER", assignedAgentId: firedId, lastAgentId: firedId, acceptedAt: null, workStatus: "INACTIVE" });
    await prisma.agent.update({ where: { id: firedId }, data: { isActive: false } });

    await createLeadFromChannel({
      fullName: c.fullName, phone: c.phone, source: "WHATSAPP", kind: "BUYER", budgetMin: 900_000, budgetMax: 100_000,
    });

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.kind).toBe("BUYER");
    expect(after.assignedAgentId).not.toBe(firedId);
    expect(Number(after.budgetMin)).toBe(100_000);
    expect(Number(after.budgetMax)).toBe(900_000);
  });

  it("возврат из Корзины к другому агенту: уведомление прежнего гаснет после коммита", async () => {
    const formerId = await makeAgent("Прежний агент Корзины", "AGENT");
    const c = await makeClient({ assignedAgentId: formerId, lastAgentId: null, deletedAt: new Date() });
    const note = await leadNotification(formerId, c);
    await prisma.agent.update({ where: { id: formerId }, data: { isActive: false } });

    await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "WHATSAPP", kind: "BUYER" });

    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({
        where: { entityId: c.id, action: "CLIENT_AGENT_CHANGE", meta: { path: ["source"], equals: "intake.basket-return" } },
      })
    );
    const meta = audit?.meta as Record<string, unknown> | null;
    expect(meta?.from).toBe(formerId);
    expect(meta?.fromAgentId).toBe(formerId);
    const read = await waitFor(async () => {
      const n = await prisma.notification.findUniqueOrThrow({ where: { id: note.id } });
      return n.read ? n : null;
    });
    expect(read?.read).toBe(true);
  });
});

describe("№4 спутники смены владельца — только после коммита чужой транзакции", () => {
  it("транзакция откатилась — уведомление прежнего агента не тронуто", async () => {
    {
      const c = await makeClient({ assignedAgentId: agentAId, acceptedAt: null });
      const note = await leadNotification(agentAId, c);
      await expect(
        prisma.$transaction(async (tx) => {
          const changed = await changeClientAgent({
            clientId: c.id,
            toAgentId: agentBId,
            reason: "тест отката",
            actorId: directorId,
            source: "test.rollback",
            tx,
          });
          expect(changed.ok).toBe(true);
          // Дадим спутникам время сработать, если они запускаются до коммита.
          await new Promise((r) => setTimeout(r, 300));
          throw new Error("откат");
        })
      ).rejects.toThrow("откат");
      await new Promise((r) => setTimeout(r, 1500));

      const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
      expect(after.assignedAgentId).toBe(agentAId);
      const noteAfter = await prisma.notification.findUniqueOrThrow({ where: { id: note.id } });
      expect(noteAfter.read).toBe(false);
    }
  });

  it("спутник устарел (карточку передали ещё раз) — задачи едут к текущему владельцу, а не к устаревшему", async () => {
    const agentCId = await makeAgent("Агент В переназначения", "AGENT");
    const c = await makeClient({ assignedAgentId: agentAId, acceptedAt: null });
    const task = await prisma.interaction.create({
      data: { clientId: c.id, agentId: agentAId, type: "MESSAGE", notes: "Перезвонить", nextAction: "Позвонить", nextActionDate: new Date(Date.now() + 3600_000) },
    });
    await prisma.$transaction(async (tx) => {
      await changeClientAgent({ clientId: c.id, toAgentId: agentBId, reason: "первая", actorId: directorId, source: "test.stale-1", tx });
      // Вторая смена без своих спутников — имитирует «её спутники ещё не дошли».
      await changeClientAgent({
        clientId: c.id, toAgentId: agentCId, reason: "вторая", actorId: directorId, source: "test.stale-2", skipSatellites: true, tx,
      });
    });
    const moved = await waitFor(async () => {
      const t = await prisma.interaction.findUniqueOrThrow({ where: { id: task.id } });
      return t.agentId !== agentAId ? t : null;
    });
    expect(moved?.agentId).toBe(agentCId);
  });

  it("транзакция закоммичена — спутники срабатывают", async () => {
    const c = await makeClient({ assignedAgentId: agentAId, acceptedAt: null });
    const note = await leadNotification(agentAId, c);
    await prisma.$transaction(async (tx) => {
      await changeClientAgent({ clientId: c.id, toAgentId: agentBId, reason: "тест коммита", actorId: directorId, source: "test.commit", tx });
    });
    const read = await waitFor(async () => {
      const n = await prisma.notification.findUniqueOrThrow({ where: { id: note.id } });
      return n.read ? n : null;
    });
    expect(read?.read).toBe(true);
  });
});
