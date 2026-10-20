import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ПРОСЬБА ЖИВОГО АГЕНТА — ПЕРВОЙ В СПИСКЕ, ДАЖЕ ЕСЛИ ПЕРЕПИСКА ДАВНЯЯ.
 *
 * Порядок задан владельцем 18.09.2026 и держался ключом сортировки прямо в SQL:
 * `ORDER BY cl."agentAttentionRequestedAt" IS NOT NULL DESC, ...`. Колонка лежит
 * в присоединённой таблице `Client`, из-за чего база переставала отсекать выборку
 * по индексу на `LIMIT` и сортировала весь join целиком — на самом открытом
 * экране CRM (разбор 19.09.2026, docs/sections-not-loading-19-09.md).
 *
 * 19.09 порядок перенесён: помеченные диалоги добираются отдельным маленьким
 * проходом и ставятся вперёд уже в памяти. Этот тест закрепляет именно ПОВЕДЕНИЕ,
 * а не способ: помеченный диалог обязан быть первым, даже когда его последнее
 * сообщение самое старое, и обязан прийти ровно один раз (два прохода могут
 * поднять одну и ту же строку).
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+99294${String(runId).slice(-7)}`;

let directorId: string;
let attentionClientId: string;
let plainClientId: string;
let token: string;
const createdBotIds: string[] = [];
let askedConversationId: string;
let plainConversationId: string;

const OLD_BUT_ASKED = `Просит человека ${runId}`;
const FRESH_PLAIN = `Свежий обычный ${runId}`;

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: {
      fullName: "Директор порядка",
      phone,
      passwordHash: await bcrypt.hash(password, 10),
      role: "DIRECTOR",
      isActive: true,
    },
  });
  directorId = director.id;

  const asked = await prisma.client.create({
    data: {
      fullName: `Клиент с просьбой ${runId}`,
      phone: `+99295${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: directorId,
      acceptedAt: new Date(),
      agentAttentionRequestedAt: new Date(Date.now() - 30 * 60_000),
    },
  });
  attentionClientId = asked.id;

  const plain = await prisma.client.create({
    data: {
      fullName: `Клиент обычный ${runId}`,
      phone: `+99296${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: directorId,
      acceptedAt: new Date(),
    },
  });
  plainClientId = plain.id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;

  // Помеченный диалог намеренно САМЫЙ СТАРЫЙ: по свежести он был бы последним.
  const oldAsked = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-asked-${runId}`,
      name: OLD_BUT_ASKED,
      clientId: asked.id,
      messages: [{ role: "user", content: `позовите человека ${runId}` }],
      lastMessageAt: new Date(Date.now() - 48 * 60 * 60_000),
    },
  });
  createdBotIds.push(oldAsked.id);
  askedConversationId = oldAsked.id;

  const freshPlain = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `sub-plain-${runId}`,
      name: FRESH_PLAIN,
      clientId: plain.id,
      messages: [{ role: "user", content: `просто вопрос ${runId}` }],
      lastMessageAt: new Date(Date.now() - 60_000),
    },
  });
  createdBotIds.push(freshPlain.id);
  plainConversationId = freshPlain.id;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: createdBotIds } } });
  await prisma.client.deleteMany({ where: { id: { in: [attentionClientId, plainClientId] } } });
  await prisma.session.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

function list(query = "") {
  return request(app).get(`/api/v1/conversations${query}`).set("Authorization", `Bearer ${token}`);
}

describe("инбокс: порядок при просьбе живого агента (19.09.2026)", () => {
  it("помеченный диалог идёт первым, хотя переписка в нём самая старая", async () => {
    const res = await list(`?q=${encodeURIComponent(String(runId))}`);
    expect(res.status).toBe(200);
    // Сверяем по id, а не по name: в ответе имя берётся от клиента, если он
    // привязан (presentListRow), а не от самой переписки.
    const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
    expect(ids[0]).toBe(askedConversationId);
    expect(ids).toContain(plainConversationId);
  });

  it("помеченный диалог приходит ровно один раз — два прохода не задваивают строку", async () => {
    const res = await list(`?q=${encodeURIComponent(String(runId))}`);
    const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === askedConversationId)).toHaveLength(1);
  });

  it("метка снята — порядок снова по свежести", async () => {
    await prisma.client.update({
      where: { id: attentionClientId },
      data: { agentAttentionRequestedAt: null },
    });
    const res = await list(`?q=${encodeURIComponent(String(runId))}`);
    const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
    expect(ids[0]).toBe(plainConversationId);
    await prisma.client.update({
      where: { id: attentionClientId },
      data: { agentAttentionRequestedAt: new Date(Date.now() - 30 * 60_000) },
    });
  });
});
