import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomInt } from "node:crypto";

/**
 * B2 глубокой проверки 02.10.2026 (+ №6 проверки объектов): склейка В карточку
 * из Корзины.
 *
 * Новая заявка стояла на «проверке дубля» к карточке X, руководитель отправил X
 * в Корзину, агент нажал «да, это тот же человек» — всё переезжало в удалённую
 * X, а живая новая карточка уходила в Корзину вслед за ней: свежий лид исчезал
 * из всех списков без агента и без следа. Повторный клик по /merge прогонял
 * склейку второй раз (вторая запись в хронологию, вторые пуши).
 *
 * Ожидается: отказ 409, обе карточки как были; при отправке X в Корзину
 * ожидающие проверки к ней снимаются со сроком «сейчас» — ближайший тик
 * отпускает заявку в обычную раздачу. И при склейке продавца с покупателем
 * вторая роль не теряется (dualIntent).
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { mergeClients, ClientMergeTrashedError } = await import("../src/lib/clientMerge.js");
const { trashClient } = await import("../src/lib/trashClient.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const password = "testpass123";
const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
let agentId = "";
let agentPhone = "";
let adminId = "";
let adminPhone = "";
const clientIds: string[] = [];

async function login(p: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone: p, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(data: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: { fullName: "Клиент склейки", phone: phone(), kind: "BUYER", source: "WHATSAPP", ...data },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  agentPhone = phone();
  adminPhone = phone();
  agentId = (await prisma.agent.create({ data: { fullName: "Агент склейки", phone: agentPhone, role: "AGENT", passwordHash } })).id;
  adminId = (await prisma.agent.create({ data: { fullName: "Админ склейки", phone: adminPhone, role: "ADMIN", passwordHash } })).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.updateMany({ where: { id: { in: clientIds } }, data: { duplicateReviewOfClientId: null } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId, adminId]);
  await prisma.$disconnect();
});

describe("склейка с карточкой из Корзины", () => {
  it("основная карточка в Корзине — отказ, живой дубль не уходит в Корзину", async () => {
    const primary = await makeClient({ assignedAgentId: agentId, deletedAt: new Date(), deletedById: adminId });
    const fresh = await makeClient({ phone: primary.phone.replace(/\d$/, (d) => String((Number(d) + 1) % 10)) });

    await expect(mergeClients(primary.id, fresh.id, adminId, "склейка")).rejects.toBeInstanceOf(ClientMergeTrashedError);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(after.deletedAt).toBeNull();
  });

  it("повторная склейка уже удалённого дубля — отказ, вторую запись в хронологию не пишет", async () => {
    const primary = await makeClient({ assignedAgentId: agentId });
    const dup = await makeClient();
    await mergeClients(primary.id, dup.id, adminId, "склейка первая");
    await expect(mergeClients(primary.id, dup.id, adminId, "склейка вторая")).rejects.toBeInstanceOf(ClientMergeTrashedError);
    const notes = await prisma.interaction.count({ where: { clientId: primary.id, notes: { startsWith: "склейка" } } });
    expect(notes).toBe(1);
  });

  it("POST /clients/merge с основной в Корзине отвечает 409", async () => {
    const primary = await makeClient({ deletedAt: new Date(), deletedById: adminId });
    const dup = await makeClient();
    const token = await login(adminPhone);
    const res = await request(app)
      .post("/api/v1/clients/merge")
      .set("Authorization", `Bearer ${token}`)
      .send({ primaryId: primary.id, duplicateId: dup.id, force: true });
    expect(res.status).toBe(409);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: dup.id } });
    expect(after.deletedAt).toBeNull();
  });

  it("«да, мой клиент» по проверке к карточке из Корзины — 409, заявка жива", async () => {
    const candidate = await makeClient({ assignedAgentId: agentId, deletedAt: new Date(), deletedById: adminId });
    const pending = await makeClient({
      duplicateReviewOfClientId: candidate.id,
      duplicateReviewAskedAgentId: agentId,
      duplicateReviewAskedAt: new Date(),
      duplicateReviewDueAt: new Date(Date.now() + 6 * 3600_000),
    });
    const token = await login(agentPhone);
    const res = await request(app)
      .post(`/api/v1/clients/${pending.id}/duplicate-review/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(409);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.deletedAt).toBeNull();
  });

  it("карточка ушла в Корзину — ожидающая проверка к ней истекает сейчас (её отпустит ближайший тик)", async () => {
    const candidate = await makeClient({ assignedAgentId: agentId });
    const pending = await makeClient({
      duplicateReviewOfClientId: candidate.id,
      duplicateReviewAskedAgentId: agentId,
      duplicateReviewAskedAt: new Date(),
      duplicateReviewDueAt: new Date(Date.now() + 6 * 3600_000),
    });
    const r = await trashClient(candidate.id, adminId, { notifyHolder: false });
    expect(r.ok).toBe(true);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.duplicateReviewDueAt).not.toBeNull();
    expect(after.duplicateReviewDueAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("склейка продавца с покупателем (№6 проверки объектов)", () => {
  it("вторая роль сохраняется отметкой «продавец и покупатель»", async () => {
    const primary = await makeClient({ kind: "BUYER", assignedAgentId: agentId });
    const dup = await makeClient({ kind: "SELLER" });
    const merged = await mergeClients(primary.id, dup.id, adminId, "склейка ролей");
    expect(merged.kind).toBe("BUYER");
    expect(merged.dualIntent).toBe(true);
  });

  it("отметка дубля «продавец и покупатель» не теряется", async () => {
    const primary = await makeClient({ kind: "BUYER", assignedAgentId: agentId });
    const dup = await makeClient({ kind: "BUYER", dualIntent: true });
    const merged = await mergeClients(primary.id, dup.id, adminId, "склейка отметки");
    expect(merged.dualIntent).toBe(true);
  });

  it("два покупателя — отметки нет", async () => {
    const primary = await makeClient({ kind: "BUYER", assignedAgentId: agentId });
    const dup = await makeClient({ kind: "BUYER" });
    const merged = await mergeClients(primary.id, dup.id, adminId, "склейка покупателей");
    expect(merged.dualIntent).toBe(false);
  });
});

/**
 * B6 глубокой проверки 02.10.2026: склейка переносила задачи и показы дубля на
 * основную карточку, но оставляла их на агенте дубля — у него в календаре висели
 * показ и напоминание по клиенту, которого он больше не видит, а агент основной
 * карточки этих задач не видел. Теперь открытые задачи уходят владельцу
 * основной карточки, как при обычной передаче (lib/ownershipSatellites.ts).
 */
describe("склейка: открытые задачи дубля уходят владельцу основной карточки", () => {
  it("задача агента и задача системы на агента дубля переезжают, выполненная — остаётся в истории", async () => {
    const passwordHash = await bcrypt.hash(password, 4);
    const otherAgentId = (
      await prisma.agent.create({ data: { fullName: "Агент дубля", phone: phone(), role: "AGENT", passwordHash } })
    ).id;
    try {
      const primary = await makeClient({ assignedAgentId: agentId });
      const dup = await makeClient({ assignedAgentId: otherAgentId });
      const tomorrow = new Date(Date.now() + 24 * 3600_000);
      const own = await prisma.interaction.create({
        data: { clientId: dup.id, agentId: otherAgentId, type: "CALL", notes: "позвонить", nextAction: "Позвонить", nextActionDate: tomorrow },
      });
      const bot = await prisma.interaction.create({
        data: { clientId: dup.id, agentId: null, actorKind: "BOT", subjectAgentId: otherAgentId, type: "SYSTEM", notes: "показ от бота", nextAction: "Показ", nextActionDate: tomorrow },
      });
      const done = await prisma.interaction.create({
        data: { clientId: dup.id, agentId: otherAgentId, type: "MEETING", notes: "старое", nextAction: "Было", nextActionDate: new Date(Date.now() - 3600_000), completedAt: new Date() },
      });

      await mergeClients(primary.id, dup.id, adminId, "склейка задач");

      const [ownAfter, botAfter, doneAfter] = await Promise.all([
        prisma.interaction.findUniqueOrThrow({ where: { id: own.id } }),
        prisma.interaction.findUniqueOrThrow({ where: { id: bot.id } }),
        prisma.interaction.findUniqueOrThrow({ where: { id: done.id } }),
      ]);
      expect(ownAfter.clientId).toBe(primary.id);
      expect(ownAfter.agentId).toBe(agentId);
      expect(botAfter.subjectAgentId).toBe(agentId);
      expect(doneAfter.agentId).toBe(otherAgentId);
    } finally {
      await prisma.interaction.deleteMany({ where: { OR: [{ agentId: otherAgentId }, { subjectAgentId: otherAgentId }] } });
      await deleteAgentsWithTraces([otherAgentId]);
    }
  });
});
