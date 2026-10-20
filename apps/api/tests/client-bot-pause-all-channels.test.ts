import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * «ПАУЗА БОТА» ИЗ КАРТОЧКИ КЛИЕНТА ГЛУШИТ ВСЕ КАНАЛЫ (23.09.2026).
 *
 * После Instagram/WhatsApp в маршруте стоял ранний выход, и до Telegram дело не
 * доходило: у клиента с диалогами в обоих мессенджерах агент жал паузу, а бот в
 * Telegram продолжал отвечать поверх него. Снятие паузы ломалось так же.
 */

const runId = Date.now();
let directorId = "";
let clientId = "";
let token = "";
const telegramChatId = `bp-all-${runId}`;
const subscriberId = `bp-all-${runId}`;

beforeAll(async () => {
  const d = await prisma.agent.create({
    data: { fullName: `Директор пауза ${runId}`, phone: `+99294${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
  });
  directorId = d.id;
  token = signAccessToken({ sub: d.id, role: "DIRECTOR" });
  const c = await prisma.client.create({
    data: { fullName: `Клиент пауза ${runId}`, phone: `+99295${String(runId).slice(-7)}`, source: "INSTAGRAM" },
  });
  clientId = c.id;
  await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId, messages: [], clientId } });
  await prisma.telegramConversation.create({ data: { chatId: telegramChatId, messages: [], clientId } });
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { clientId } });
  await prisma.telegramConversation.deleteMany({ where: { chatId: telegramChatId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

async function pauses() {
  const [meta, tg] = await Promise.all([
    prisma.botConversation.findFirst({ where: { clientId }, select: { pausedUntil: true } }),
    prisma.telegramConversation.findFirst({ where: { clientId }, select: { pausedUntil: true } }),
  ]);
  return { meta: meta?.pausedUntil ?? null, tg: tg?.pausedUntil ?? null };
}

describe("Пауза бота из карточки клиента", () => {
  it("ставится и в Instagram, и в Telegram", async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/bot-pause`)
      .set("Authorization", `Bearer ${token}`)
      .send({ pausedUntil: until });
    expect(res.status).toBe(200);
    const p = await pauses();
    expect(p.meta?.toISOString()).toBe(until);
    expect(p.tg?.toISOString()).toBe(until);
  });

  it("снимается в обоих каналах", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.botConversation.updateMany({ where: { clientId }, data: { pausedUntil: later } });
    await prisma.telegramConversation.updateMany({ where: { clientId }, data: { pausedUntil: later } });
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/bot-pause`)
      .set("Authorization", `Bearer ${token}`)
      .send({ pausedUntil: null });
    expect(res.status).toBe(200);
    const p = await pauses();
    expect(p.meta).toBeNull();
    expect(p.tg).toBeNull();
  });
});
