import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ПЕРЕДАЧА РОП — УВЕДОМЛЕНИЕ ДИРЕКТОРУ (владелец 16.11.2026, вторая редакция).
 * Агентам ничего нельзя и ничего не приходит. Директор передаёт сразу. РОП передаёт сразу, после чего
 * директору уходит уведомление (CRM + Telegram) с «Подтвердить» / «Отклонить»; отклонить = вернуть прежнему хозяину.
 */

const { push, tgSend, tgReply } = vi.hoisted(() => ({
  push: vi.fn(async () => 1),
  tgSend: vi.fn(async () => ({ message_id: 1 })),
  tgReply: vi.fn(async () => ({ message_id: 2 })),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: push,
  sendPushToAgents: push,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  isTelegramEnabled: () => true,
  sendMessageWithButtons: tgSend,
  sendMessage: tgReply,
  answerCallbackQuery: vi.fn(async () => undefined),
}));

const { app } = await import("../src/app.js");
const { runTransferRequestTick } = await import("../src/lib/ownershipTransferRequest.js");
const { handleTransferReviewCallback } = await import("../src/telegram/transferReviewBot.js");

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
let directorId: string;
const directorChat = `7${runId}`;
let tokens: Record<string, string> = {};
let settingsBackup: { id: string; ropTransferAlertEnabled: boolean } | null = null;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function mkAgent(role: "AGENT" | "HEAD_OF_SALES" | "DIRECTOR", n: number, name: string, extra: Record<string, unknown> = {}) {
  const passwordHash = await bcrypt.hash(password, 4);
  const a = await prisma.agent.create({
    data: { fullName: `${name} ${runId}`, phone: `+99299${n}${runId}`, role, passwordHash, ...extra },
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

async function mkClient(owner: string, fullName?: string) {
  const c = await prisma.client.create({
    data: {
      fullName: fullName ?? `Клиент передачи ${runId}-${clientIds.length}`,
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

const transferProperty = (who: string, id: string, to: string, reason = "Агент в отпуске") =>
  request(app).post(`/api/v1/properties/${id}/transfer`).set("Authorization", `Bearer ${tokens[who]}`).send({ toAgentId: to, reason });
const assignClient = (who: string, id: string, to: string) =>
  request(app).post(`/api/v1/clients/${id}/assign`).set("Authorization", `Bearer ${tokens[who]}`).send({ agentId: to });
const pending = (who: string) => request(app).get("/api/v1/transfer-requests/pending").set("Authorization", `Bearer ${tokens[who]}`);
const decide = (who: string, id: string, decision: "confirm" | "decline", note?: string) =>
  request(app)
    .post(`/api/v1/transfer-requests/${id}/respond`)
    .set("Authorization", `Bearer ${tokens[who]}`)
    .send({ decision, ...(note ? { note } : {}) });
const ownerOf = async (propertyId: string) => (await prisma.property.findUnique({ where: { id: propertyId } }))?.intakeAgentId;
const reviewRow = (where: Record<string, unknown>) =>
  prisma.ownershipTransferRequest.findFirst({ where, orderBy: { createdAt: "desc" } });
/** Уведомление директору уходит в фоне (void) — ждём строку. */
async function waitRow(where: Record<string, unknown>) {
  for (let i = 0; i < 40; i++) {
    const r = await reviewRow(where);
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  return null;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Передача-рое-${runId}` } })).id;
  const owner = await mkAgent("AGENT", 1, "Хозяин");
  const other = await mkAgent("AGENT", 2, "Посторонний");
  const target = await mkAgent("AGENT", 3, "Получатель");
  const rop = await mkAgent("HEAD_OF_SALES", 4, "РОП");
  const director = await mkAgent("DIRECTOR", 6, "Директор", { telegramChatId: directorChat });
  [ownerId, otherId, targetId, ropId, directorId] = [owner.id, other.id, target.id, rop.id, director.id];
  tokens = {
    owner: await login(owner.phone),
    other: await login(other.phone),
    rop: await login(rop.phone),
    director: await login(director.phone),
  };
  const s = await prisma.settings.findFirst({ select: { id: true, ropTransferAlertEnabled: true } });
  settingsBackup = s;
  if (s) await prisma.settings.update({ where: { id: s.id }, data: { ropTransferAlertEnabled: true } });
});

beforeEach(() => {
  push.mockClear();
  tgSend.mockClear();
  tgReply.mockClear();
});

afterAll(async () => {
  if (settingsBackup) {
    await prisma.settings.update({ where: { id: settingsBackup.id }, data: { ropTransferAlertEnabled: settingsBackup.ropTransferAlertEnabled } });
  }
  await prisma.ownershipTransferRequest.deleteMany({ where: { requestedById: { in: agentIds } } });
  await prisma.propertyDeleteRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("РОП передаёт объект сразу, директору уходит уведомление", () => {
  it("объект уже у получателя; директору пуш, Telegram с кнопками и запись в окне; хозяину, агентам и РОП ничего", async () => {
    const p = await mkProperty(ownerId);
    const res = await transferProperty("rop", p.id, targetId);
    expect(res.status).toBe(200);
    expect(await ownerOf(p.id)).toBe(targetId);

    const row = await waitRow({ propertyId: p.id, status: "PENDING" });
    expect(row?.fromAgentId).toBe(ownerId);
    expect(row?.toAgentId).toBe(targetId);
    await vi.waitFor(() => expect(tgSend).toHaveBeenCalled());
    const [chat, text, buttons] = tgSend.mock.calls[0] as unknown as [string, string, { callback_data?: string }[][]];
    expect(chat).toBe(directorChat);
    expect(text).toContain("РОП");
    const data = buttons.flat().map((b) => b.callback_data);
    expect(data).toEqual(expect.arrayContaining([`tr:a:${row!.id}`, `tr:d:${row!.id}`]));
    expect(push).toHaveBeenCalledWith(directorId, expect.objectContaining({ title: expect.stringContaining("РОП передал") }));
    // Хозяину, получателю и посторонним — никаких уведомлений о передаче.
    for (const id of [ownerId, otherId]) {
      expect(push).not.toHaveBeenCalledWith(id, expect.objectContaining({ tag: expect.stringContaining("transfer-review") }));
    }

    const mine = (await pending("director")).body.items as { id: string }[];
    expect(mine.map((i) => i.id)).toContain(row!.id);
    for (const who of ["owner", "other", "rop"]) expect((await pending(who)).body.items).toHaveLength(0);
  });

  it("«Подтвердить» — передача остаётся; повторный клик — 200; потом «Отклонить» — 409", async () => {
    const p = await mkProperty(ownerId);
    await transferProperty("rop", p.id, targetId);
    const row = (await waitRow({ propertyId: p.id, status: "PENDING" }))!;
    const [a, b] = await Promise.all([decide("director", row.id, "confirm"), decide("director", row.id, "confirm")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await ownerOf(p.id)).toBe(targetId);
    expect((await reviewRow({ id: row.id }))?.status).toBe("CONFIRMED");
    expect((await decide("director", row.id, "decline")).status).toBe(409);
  });

  it("«Отклонить» — объект вернулся прежнему хозяину, РОП получил пуш с комментарием", async () => {
    const p = await mkProperty(ownerId);
    await transferProperty("rop", p.id, targetId);
    const row = (await waitRow({ propertyId: p.id, status: "PENDING" }))!;
    push.mockClear();
    const res = await decide("director", row.id, "decline", "Не согласовано");
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("DECLINED");
    expect(await ownerOf(p.id)).toBe(ownerId);
    expect(push).toHaveBeenCalledWith(ropId, expect.objectContaining({ body: expect.stringContaining("Не согласовано") }));
  });

  it("отклонить, когда объект уже у третьего, — вернуть нельзя: 409, объект на месте, запись FAILED", async () => {
    const p = await mkProperty(ownerId);
    await transferProperty("rop", p.id, targetId);
    const row = (await waitRow({ propertyId: p.id, status: "PENDING" }))!;
    await transferProperty("director", p.id, otherId, "Директор передал третьему");
    const res = await decide("director", row.id, "decline");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RETURN_FAILED");
    expect(await ownerOf(p.id)).toBe(otherId);
    expect((await reviewRow({ id: row.id }))?.status).toBe("FAILED");
  });

  it("повторная передача той же карточки снимает прежнее уведомление: живое одно", async () => {
    const p = await mkProperty(ownerId);
    await transferProperty("rop", p.id, targetId);
    const first = (await waitRow({ propertyId: p.id, status: "PENDING" }))!;
    await transferProperty("rop", p.id, otherId, "Передумали");
    await vi.waitFor(async () => expect(await prisma.ownershipTransferRequest.count({ where: { propertyId: p.id, status: "PENDING" } })).toBe(1));
    expect((await reviewRow({ id: first.id }))?.status).toBe("CANCELLED");
    expect((await decide("director", first.id, "confirm")).status).toBe(409);
  });

  it("отклонение, зависшее на возврате, тик добивает в FAILED", async () => {
    const p = await mkProperty(ownerId);
    await transferProperty("rop", p.id, targetId);
    const row = (await waitRow({ propertyId: p.id, status: "PENDING" }))!;
    await prisma.ownershipTransferRequest.update({
      where: { id: row.id },
      data: { status: "DECLINED", resultNote: "executing", decidedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await runTransferRequestTick();
    expect((await reviewRow({ id: row.id }))?.status).toBe("FAILED");
  });
});

describe("Telegram и рубильник", () => {
  it("кнопка «Отклонить» в Telegram из чата директора возвращает объект", async () => {
    const p = await mkProperty(ownerId);
    await transferProperty("rop", p.id, targetId);
    const row = (await waitRow({ propertyId: p.id, status: "PENDING" }))!;
    const handled = await handleTransferReviewCallback({
      id: `cb-${row.id}`,
      data: `tr:d:${row.id}`,
      from: { id: 1 },
      message: { chat: { id: Number(directorChat) } },
    } as never);
    expect(handled).toBe(true);
    expect(await ownerOf(p.id)).toBe(ownerId);
    expect((await reviewRow({ id: row.id }))?.status).toBe("DECLINED");
  });

  it("кнопка из чужого чата ничего не решает", async () => {
    const p = await mkProperty(ownerId);
    await transferProperty("rop", p.id, targetId);
    const row = (await waitRow({ propertyId: p.id, status: "PENDING" }))!;
    await handleTransferReviewCallback({
      id: `cb2-${row.id}`,
      data: `tr:a:${row.id}`,
      from: { id: 2 },
      message: { chat: { id: 999000111 } },
    } as never);
    expect((await reviewRow({ id: row.id }))?.status).toBe("PENDING");
  });

  it("рубильник выключен — РОП передаёт молча: передача есть, записи и уведомлений нет", async () => {
    const s = await prisma.settings.findFirstOrThrow({ select: { id: true } });
    await prisma.settings.update({ where: { id: s.id }, data: { ropTransferAlertEnabled: false } });
    try {
      const p = await mkProperty(ownerId);
      const res = await transferProperty("rop", p.id, targetId);
      expect(res.status).toBe(200);
      expect(await ownerOf(p.id)).toBe(targetId);
      await new Promise((r) => setTimeout(r, 300));
      expect(await reviewRow({ propertyId: p.id })).toBeNull();
      expect(tgSend).not.toHaveBeenCalled();
    } finally {
      await prisma.settings.update({ where: { id: s.id }, data: { ropTransferAlertEnabled: true } });
    }
  });
});

describe("агенты и директор", () => {
  it("рядовой агент объект не передаёт (403) и не решает чужие передачи (403)", async () => {
    const p = await mkProperty(ownerId);
    const res = await transferProperty("owner", p.id, targetId);
    expect(res.status).toBe(403);
    expect(await ownerOf(p.id)).toBe(ownerId);
    await transferProperty("rop", p.id, targetId);
    const row = (await waitRow({ propertyId: p.id, status: "PENDING" }))!;
    expect((await decide("owner", row.id, "confirm")).status).toBe(403);
    expect((await decide("rop", row.id, "confirm")).status).toBe(403);
  });

  it("директор передаёт сразу и без уведомления самому себе", async () => {
    const p = await mkProperty(ownerId);
    const res = await transferProperty("director", p.id, targetId);
    expect(res.status).toBe(200);
    expect(await ownerOf(p.id)).toBe(targetId);
    await new Promise((r) => setTimeout(r, 300));
    expect(await reviewRow({ propertyId: p.id })).toBeNull();
    expect(tgSend).not.toHaveBeenCalled();
  });

  it("РОП не меняет ответственного правкой карточки (PATCH): передача только через передачу", async () => {
    const p = await mkProperty(ownerId);
    await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${tokens.rop}`)
      .send({ intakeAgentId: targetId, assignedAgentId: targetId });
    expect(await ownerOf(p.id)).toBe(ownerId);
  });

  it("телефон из имени клиента в окне директора маскируется", async () => {
    const c = await mkClient(ownerId, "Иван +992901234567");
    await assignClient("rop", c.id, targetId);
    const row = (await waitRow({ clientId: c.id, status: "PENDING" }))!;
    const items = (await pending("director")).body.items as { id: string; targetTitle: string }[];
    const mine = items.find((i) => i.id === row.id);
    expect(mine?.targetTitle).toContain("Иван");
    expect(mine?.targetTitle).not.toContain("901234567");
  });
});

describe("клиент", () => {
  it("РОП назначает клиента сразу; директору уведомление; «Отклонить» возвращает клиента", async () => {
    const c = await mkClient(ownerId);
    const res = await assignClient("rop", c.id, targetId);
    expect(res.status).toBe(200);
    expect((await prisma.client.findUnique({ where: { id: c.id } }))?.assignedAgentId).toBe(targetId);
    const row = (await waitRow({ clientId: c.id, status: "PENDING" }))!;
    expect(row.fromAgentId).toBe(ownerId);
    const back = await decide("director", row.id, "decline");
    expect(back.status).toBe(200);
    expect((await prisma.client.findUnique({ where: { id: c.id } }))?.assignedAgentId).toBe(ownerId);
  });

  it("клиент без прежнего хозяина (очередь) — уведомления нет, спрашивать не о чем", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Очередь передачи ${runId}`,
        phone: `+99297${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        status: "NEW",
        assignedAgentId: null,
      },
    });
    clientIds.push(c.id);
    const res = await assignClient("rop", c.id, targetId);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await reviewRow({ clientId: c.id })).toBeNull();
  });

  it("директор передаёт клиента как раньше, без уведомления", async () => {
    const c = await mkClient(ownerId);
    const res = await assignClient("director", c.id, targetId);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await reviewRow({ clientId: c.id })).toBeNull();
  });
});
