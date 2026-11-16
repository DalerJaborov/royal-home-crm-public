import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ПЕРЕДАЧА С ПОДТВЕРЖДЕНИЕМ ХОЗЯИНА (владелец 16.11.2026).
 * РОП просит передать объект или клиента; хозяин отвечает; не ответил — отмена.
 * Директор передаёт сразу. Само переназначение — существующим кодом (проверяем итог).
 */

const { push } = vi.hoisted(() => ({ push: vi.fn(async () => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: push,
  sendPushToAgents: push,
}));

const { app } = await import("../src/app.js");
const { runTransferRequestTick } = await import("../src/lib/ownershipTransferRequest.js");

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
const propertyIds: string[] = [];
const clientIds: string[] = [];
let districtId: string;
let ownerId: string;
let otherId: string;
let targetId: string;
let ropId: string;
let rop2Id: string;
let directorId: string;
let tokens: Record<string, string> = {};
let settingsBackup: { id: string; ownerConfirmTransferEnabled: boolean; ownerConfirmTransferHours: number } | null = null;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function mkAgent(role: "AGENT" | "HEAD_OF_SALES" | "DIRECTOR", n: number, name: string) {
  const passwordHash = await bcrypt.hash(password, 4);
  const a = await prisma.agent.create({
    data: { fullName: `${name} ${runId}`, phone: `+99299${n}${runId}`, role, passwordHash },
  });
  agentIds.push(a.id);
  return a;
}

async function mkProperty(owner: string) {
  const p = await prisma.property.create({
    data: {
      title: `Объект передачи ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 60000,
      currency: "USD",
      districtId,
      address: `Тест ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: owner,
      assignedAgentId: owner,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function mkClient(owner: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент передачи ${runId}-${clientIds.length}`,
      phone: `+99298${String(clientIds.length).padStart(2, "0")}${runId}`.slice(0, 13),
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "CONTACTED",
      assignedAgentId: owner,
      assignedAt: new Date(),
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

const ask = (who: string, body: Record<string, unknown>) =>
  request(app).post("/api/v1/transfer-requests").set("Authorization", `Bearer ${tokens[who]}`).send(body);
const answer = (who: string, id: string, decision: "confirm" | "decline", note?: string) =>
  request(app)
    .post(`/api/v1/transfer-requests/${id}/respond`)
    .set("Authorization", `Bearer ${tokens[who]}`)
    .send({ decision, ...(note ? { note } : {}) });
const incoming = (who: string) =>
  request(app).get("/api/v1/transfer-requests/incoming").set("Authorization", `Bearer ${tokens[who]}`);
const ownerOf = async (propertyId: string) => {
  const p = await prisma.property.findUnique({ where: { id: propertyId } });
  return p?.intakeAgentId;
};

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Передача-подтв-${runId}` } })).id;
  const owner = await mkAgent("AGENT", 1, "Хозяин");
  const other = await mkAgent("AGENT", 2, "Посторонний");
  const target = await mkAgent("AGENT", 3, "Получатель");
  const rop = await mkAgent("HEAD_OF_SALES", 4, "РОП");
  const rop2 = await mkAgent("HEAD_OF_SALES", 5, "РОП2");
  const director = await mkAgent("DIRECTOR", 6, "Директор");
  [ownerId, otherId, targetId, ropId, rop2Id, directorId] = [owner.id, other.id, target.id, rop.id, rop2.id, director.id];
  tokens = {
    owner: await login(owner.phone),
    other: await login(other.phone),
    rop: await login(rop.phone),
    rop2: await login(rop2.phone),
    director: await login(director.phone),
  };
  const s = await prisma.settings.findFirst({
    select: { id: true, ownerConfirmTransferEnabled: true, ownerConfirmTransferHours: true },
  });
  settingsBackup = s;
  if (s) await prisma.settings.update({ where: { id: s.id }, data: { ownerConfirmTransferEnabled: true, ownerConfirmTransferHours: 24 } });
});

beforeEach(() => push.mockClear());

afterAll(async () => {
  if (settingsBackup) {
    await prisma.settings.update({
      where: { id: settingsBackup.id },
      data: {
        ownerConfirmTransferEnabled: settingsBackup.ownerConfirmTransferEnabled,
        ownerConfirmTransferHours: settingsBackup.ownerConfirmTransferHours,
      },
    });
  }
  await prisma.ownershipTransferRequest.deleteMany({ where: { requestedById: { in: agentIds } } });
  await prisma.propertyDeleteRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("объект: РОП просит — хозяин подтверждает", () => {
  it("до ответа объект на месте, хозяину пуш и запрос в окне; после «Подтвердить» объект у получателя", async () => {
    const p = await mkProperty(ownerId);
    const res = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Агент в отпуске" });
    expect(res.status).toBe(201);
    expect(res.body.pending).toBe(true);
    expect(await ownerOf(p.id)).toBe(ownerId);
    expect(push).toHaveBeenCalledWith(ownerId, expect.objectContaining({ tag: expect.stringContaining("transfer-confirm-") }));

    const mine = await incoming("owner");
    expect(mine.body.items.map((i: { id: string }) => i.id)).toContain(res.body.request.id);
    expect((await incoming("other")).body.items).toHaveLength(0);

    const ok = await answer("owner", res.body.request.id, "confirm");
    expect(ok.status).toBe(200);
    expect(ok.body.request.status).toBe("CONFIRMED");
    expect(await ownerOf(p.id)).toBe(targetId);
    expect((await incoming("owner")).body.items).toHaveLength(0);
  });

  it("двойной клик «Подтвердить» и гонка двух вкладок — передача одна, оба ответа 200", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Двойной клик" });
    const [a, b] = await Promise.all([
      answer("owner", created.body.request.id, "confirm"),
      answer("owner", created.body.request.id, "confirm"),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await ownerOf(p.id)).toBe(targetId);
    const audits = await prisma.auditLog.count({ where: { action: "PROPERTY_TRANSFER", entityId: p.id } });
    expect(audits).toBe(1);
    const late = await answer("owner", created.body.request.id, "decline");
    expect(late.status).toBe(409);
  });

  it("«Отказать» — объект остаётся, РОП получает пуш с причиной", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Хочу передать" });
    push.mockClear();
    const res = await answer("owner", created.body.request.id, "decline", "Веду сам");
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("DECLINED");
    expect(await ownerOf(p.id)).toBe(ownerId);
    expect(push).toHaveBeenCalledWith(ropId, expect.objectContaining({ body: expect.stringContaining("Веду сам") }));
  });

  it("чужой агент ответить не может, хозяин — только хозяин (403), директор может за хозяина", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Права" });
    expect((await answer("other", created.body.request.id, "confirm")).status).toBe(403);
    expect(await ownerOf(p.id)).toBe(ownerId);
    expect((await answer("director", created.body.request.id, "confirm")).status).toBe(200);
    expect(await ownerOf(p.id)).toBe(targetId);
  });
});

describe("срок: хозяин не ответил — передача отменяется", () => {
  it("после срока тик закрывает запрос EXPIRED, объект на месте, ответ уже 409, окно пустое, РОП узнаёт", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Срок" });
    await prisma.ownershipTransferRequest.update({
      where: { id: created.body.request.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // До тика просроченный уже не показывается и не принимает ответ.
    expect((await incoming("owner")).body.items).toHaveLength(0);
    expect((await answer("owner", created.body.request.id, "confirm")).status).toBe(409);
    push.mockClear();
    const tick = await runTransferRequestTick();
    expect(tick.expired).toBeGreaterThanOrEqual(1);
    const row = await prisma.ownershipTransferRequest.findUnique({ where: { id: created.body.request.id } });
    expect(row?.status).toBe("EXPIRED");
    expect(await ownerOf(p.id)).toBe(ownerId);
    expect(push).toHaveBeenCalledWith(ropId, expect.objectContaining({ title: expect.stringContaining("не ответил") }));
  });

  it("пока срок идёт, раз в 30 минут хозяину уходит напоминание, не чаще", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Напоминание" });
    push.mockClear();
    await runTransferRequestTick();
    expect(push).not.toHaveBeenCalledWith(ownerId, expect.anything());
    await prisma.ownershipTransferRequest.update({
      where: { id: created.body.request.id },
      data: { lastRemindedAt: new Date(Date.now() - 31 * 60_000) },
    });
    await runTransferRequestTick();
    expect(push).toHaveBeenCalledWith(ownerId, expect.objectContaining({ title: expect.stringContaining("Ждём") }));
    const row = await prisma.ownershipTransferRequest.findUnique({ where: { id: created.body.request.id } });
    expect(row?.remindCount).toBe(1);
  });
});

describe("права и крайние случаи", () => {
  it("рядовой агент запрос не создаёт (403)", async () => {
    const p = await mkProperty(ownerId);
    const res = await ask("other", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Нельзя" });
    expect(res.status).toBe(403);
  });

  it("директор передаёт сразу, без вопроса хозяину", async () => {
    const p = await mkProperty(ownerId);
    const res = await ask("director", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Решение директора" });
    expect(res.status).toBe(200);
    expect(res.body.immediate).toBe(true);
    expect(await ownerOf(p.id)).toBe(targetId);
  });

  it("если РОП сам хозяин объекта — передача сразу", async () => {
    const p = await mkProperty(ropId);
    const res = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Свой объект" });
    expect(res.status).toBe(200);
    expect(res.body.immediate).toBe(true);
    expect(await ownerOf(p.id)).toBe(targetId);
  });

  it("повторный запрос того же РОП — тот же запрос; другой РОП на ту же карточку — 409", async () => {
    const p = await mkProperty(ownerId);
    const first = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Первый" });
    const again = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Первый" });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.request.id).toBe(first.body.request.id);
    const rival = await ask("rop2", { kind: "PROPERTY", targetId: p.id, toAgentId: otherId, reason: "Второй" });
    expect(rival.status).toBe(409);
    expect(rival.body.code).toBe("ALREADY_PENDING");
  });

  it("два РОП одновременно — живой запрос один", async () => {
    const p = await mkProperty(ownerId);
    const [a, b] = await Promise.all([
      ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Гонка А" }),
      ask("rop2", { kind: "PROPERTY", targetId: p.id, toAgentId: otherId, reason: "Гонка Б" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await prisma.ownershipTransferRequest.count({ where: { propertyId: p.id, status: "PENDING" } })).toBe(1);
  });

  it("хозяин уволен — спрашивать некого, РОПу отказ с понятным текстом", async () => {
    const gone = await mkAgent("AGENT", 7, "Уволенный");
    const p = await mkProperty(gone.id);
    await prisma.agent.update({ where: { id: gone.id }, data: { isActive: false } });
    const res = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Уволен" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OWNER_INACTIVE");
  });

  it("объект сменил хозяина до ответа — подтверждение ничего не передаёт, запрос закрыт", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Сменится" });
    // Директор передал объект третьему, пока РОП ждал.
    await ask("director", { kind: "PROPERTY", targetId: p.id, toAgentId: otherId, reason: "Директор вперёд" });
    expect(await ownerOf(p.id)).toBe(otherId);
    const res = await answer("owner", created.body.request.id, "confirm");
    expect(res.status).toBe(409);
    expect(await ownerOf(p.id)).toBe(otherId);
    const row = await prisma.ownershipTransferRequest.findUnique({ where: { id: created.body.request.id } });
    expect(row?.status).toBe("EXPIRED");
  });

  it("объект удалён до ответа — запрос закрыт без передачи", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Удалят" });
    await prisma.property.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    const res = await answer("owner", created.body.request.id, "confirm");
    expect(res.status).toBe(404);
    const row = await prisma.ownershipTransferRequest.findUnique({ where: { id: created.body.request.id } });
    expect(row?.status).toBe("EXPIRED");
  });

  it("РОП отзывает свой запрос — окно у хозяина гаснет, ответить нельзя", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Отзыв" });
    const other = await request(app)
      .post(`/api/v1/transfer-requests/${created.body.request.id}/cancel`)
      .set("Authorization", `Bearer ${tokens.rop2}`);
    expect(other.status).toBe(403);
    const res = await request(app)
      .post(`/api/v1/transfer-requests/${created.body.request.id}/cancel`)
      .set("Authorization", `Bearer ${tokens.rop}`);
    expect(res.status).toBe(200);
    const open = (await incoming("owner")).body.items as { id: string }[];
    expect(open.map((i) => i.id)).not.toContain(created.body.request.id);
    expect((await answer("owner", created.body.request.id, "confirm")).status).toBe(409);
    expect(await ownerOf(p.id)).toBe(ownerId);
  });

  it("рубильник выключен — РОП не просит (403 DISABLED), директор передаёт как раньше", async () => {
    const s = await prisma.settings.findFirstOrThrow({ select: { id: true } });
    await prisma.settings.update({ where: { id: s.id }, data: { ownerConfirmTransferEnabled: false } });
    try {
      const p = await mkProperty(ownerId);
      const res = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Выключено" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("DISABLED");
      const viaDirector = await ask("director", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Директору можно" });
      expect(viaDirector.status).toBe(200);
    } finally {
      await prisma.settings.update({ where: { id: s.id }, data: { ownerConfirmTransferEnabled: true } });
    }
  });

  it("срок из настроек: запрос живёт заданное число часов", async () => {
    const s = await prisma.settings.findFirstOrThrow({ select: { id: true } });
    await prisma.settings.update({ where: { id: s.id }, data: { ownerConfirmTransferHours: 2 } });
    try {
      const p = await mkProperty(ownerId);
      const res = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Два часа" });
      const hours = (new Date(res.body.request.expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(1.9);
      expect(hours).toBeLessThan(2.1);
    } finally {
      await prisma.settings.update({ where: { id: s.id }, data: { ownerConfirmTransferHours: 24 } });
    }
  });
});

describe("клиент", () => {
  it("прямое назначение чужого клиента РОПом закрыто (409 OWNER_CONFIRM_REQUIRED), клиент на месте", async () => {
    const c = await mkClient(ownerId);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${tokens.rop}`)
      .send({ agentId: targetId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OWNER_CONFIRM_REQUIRED");
    expect((await prisma.client.findUnique({ where: { id: c.id } }))?.assignedAgentId).toBe(ownerId);
  });

  it("запрос на клиента: хозяин подтвердил — клиент у получателя, принят сразу", async () => {
    const c = await mkClient(ownerId);
    const created = await ask("rop", { kind: "CLIENT", targetId: c.id, toAgentId: targetId, reason: "Перегруз" });
    expect(created.status).toBe(201);
    expect((await prisma.client.findUnique({ where: { id: c.id } }))?.assignedAgentId).toBe(ownerId);
    const res = await answer("owner", created.body.request.id, "confirm");
    expect(res.status).toBe(200);
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(targetId);
    expect(after?.acceptedAt).not.toBeNull();
  });

  it("запрос на клиента: отказ — клиент остаётся у хозяина", async () => {
    const c = await mkClient(ownerId);
    const created = await ask("rop", { kind: "CLIENT", targetId: c.id, toAgentId: targetId, reason: "Пробуем" });
    await answer("owner", created.body.request.id, "decline");
    expect((await prisma.client.findUnique({ where: { id: c.id } }))?.assignedAgentId).toBe(ownerId);
  });

  it("директор передаёт клиента по-прежнему напрямую через /assign", async () => {
    const c = await mkClient(ownerId);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${tokens.director}`)
      .send({ agentId: targetId });
    expect(res.status).toBe(200);
    expect((await prisma.client.findUnique({ where: { id: c.id } }))?.assignedAgentId).toBe(targetId);
  });

  it("клиент без принятого хозяина (очередь) РОП назначает напрямую — спрашивать некого", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Очередь передачи ${runId}`,
        phone: `+99297${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        status: "NEW",
        assignedAgentId: ownerId,
        assignedAt: new Date(),
        acceptedAt: null,
      },
    });
    clientIds.push(c.id);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${tokens.rop}`)
      .send({ agentId: targetId });
    expect(res.status).toBe(200);
  });
});

describe("ревью 16.11: закрытые двери и спутники", () => {
  it("РОП не передаёт объект напрямую: ни POST /transfer, ни PATCH ответственного", async () => {
    const p = await mkProperty(ownerId);
    const direct = await request(app)
      .post(`/api/v1/properties/${p.id}/transfer`)
      .set("Authorization", `Bearer ${tokens.rop}`)
      .send({ toAgentId: targetId, reason: "В обход хозяина" });
    expect(direct.status).toBe(403);
    await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${tokens.rop}`)
      .send({ intakeAgentId: targetId, assignedAgentId: targetId });
    expect(await ownerOf(p.id)).toBe(ownerId);
  });

  it("РОП не отдаёт чужого принятого покупателя через POST /clients/:id/transfer", async () => {
    const c = await mkClient(ownerId);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${tokens.rop}`)
      .send({ reason: "NO_TRUST", comment: "от имени агента" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OWNER_CONFIRM_REQUIRED");
  });

  it("подтверждённый, но не доведённый до конца запрос тик помечает FAILED", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Зависнет" });
    await prisma.ownershipTransferRequest.update({
      where: { id: created.body.request.id },
      data: { status: "CONFIRMED", resultNote: "executing", decidedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await runTransferRequestTick();
    const row = await prisma.ownershipTransferRequest.findUnique({ where: { id: created.body.request.id } });
    expect(row?.status).toBe("FAILED");
    expect(await ownerOf(p.id)).toBe(ownerId);
  });

  it("хозяин сменился другим путём (директор) — ждущий запрос закрывается сам, окно гаснет", async () => {
    const p = await mkProperty(ownerId);
    const created = await ask("rop", { kind: "PROPERTY", targetId: p.id, toAgentId: targetId, reason: "Обгонит" });
    await ask("director", { kind: "PROPERTY", targetId: p.id, toAgentId: otherId, reason: "Директор вперёд" });
    const row = await prisma.ownershipTransferRequest.findUnique({ where: { id: created.body.request.id } });
    expect(row?.status).toBe("EXPIRED");
    const open = (await incoming("owner")).body.items as { id: string }[];
    expect(open.map((i) => i.id)).not.toContain(created.body.request.id);
  });

  it("в окне хозяина номер телефона из имени клиента маскируется", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: "Иван +992901234567",
        phone: `+99296${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        status: "CONTACTED",
        assignedAgentId: ownerId,
        assignedAt: new Date(),
        acceptedAt: new Date(),
      },
    });
    clientIds.push(c.id);
    await ask("rop", { kind: "CLIENT", targetId: c.id, toAgentId: targetId, reason: "Маска" });
    const items = (await incoming("owner")).body.items as { targetTitle: string }[];
    const mine = items.find((i) => i.targetTitle.includes("Иван"));
    expect(mine?.targetTitle).not.toContain("901234567");
  });

  it("клиента уволенного агента РОП раздаёт сразу, как раньше", async () => {
    const gone = await mkAgent("AGENT", 8, "Уволенный2");
    const c = await mkClient(gone.id);
    await prisma.agent.update({ where: { id: gone.id }, data: { isActive: false } });
    const res = await ask("rop", { kind: "CLIENT", targetId: c.id, toAgentId: targetId, reason: "Раздача" });
    expect(res.status).toBe(200);
    expect(res.body.immediate).toBe(true);
    expect((await prisma.client.findUnique({ where: { id: c.id } }))?.assignedAgentId).toBe(targetId);
  });
});

