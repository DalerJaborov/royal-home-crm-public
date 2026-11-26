import { afterAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";

/**
 * КЛАСС «ДУБЛИ» (CRM-38, 26.11.2026): одно действие клиента или сотрудника — одна запись.
 *
 * 1. Повторное «перезвоните» в переписке (любой канал) заводило вторую просьбу о звонке и второй пуш агенту:
 *    защита от повтора стояла только у живого голоса. Теперь правило одно в двери recordCallbackRequest.
 * 2. Восстановление из Корзины оживляло старую карточку рядом с живой, которая уже держит номер этого
 *    человека (новая заявка бота или слияние дублей) — две живые карточки одного клиента.
 *
 * Пуш подменён: тест про число записей и уведомлений, а не про доставку.
 */

const { sendPushToAgent } = vi.hoisted(() => ({ sendPushToAgent: vi.fn(async () => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { recordCallbackRequest, callbackRepeatRule, callbackPerson } = await import("../src/lib/callbackRequests.js");
const { restoreClientFromTrash } = await import("../src/lib/restoreClient.js");

const runId = Date.now().toString(36).slice(-6);
const conversationIds: string[] = [];
const clientIds: string[] = [];
const agentIds: string[] = [];
/** Номера своей полосы и одной длины (правило соседних файлов: иначе столкнутся). */
const phone = () => `+992937${randomInt(100_000, 999_999)}`;

async function conversation(channel = "INSTAGRAM") {
  const row = await prisma.botConversation.create({
    data: { channel, subscriberId: `dupcls-${runId}-${conversationIds.length}`, messages: [] }, select: { id: true },
  });
  conversationIds.push(row.id);
  return row.id;
}
async function agent() {
  const row = await prisma.agent.create({ data: { fullName: `Агент дублей ${runId}`, phone: phone(), role: "AGENT", passwordHash: "x" } });
  agentIds.push(row.id);
  return row.id;
}
const count = (conversationId: string) => prisma.callbackRequest.count({ where: { conversationId } });

afterAll(async () => {
  await prisma.callbackRequest.deleteMany({ where: { OR: [{ conversationId: { in: conversationIds } }, { topic: { startsWith: `dupcls ${runId}` } }] } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("повторная просьба о звонке в переписке — одна запись и один пуш", () => {
  it("второе «перезвоните» той же переписки не заводит вторую просьбу и не шлёт второй пуш", async () => {
    const agentId = await agent();
    const conversationId = await conversation();
    sendPushToAgent.mockClear();
    await recordCallbackRequest({ conversationId, channel: "INSTAGRAM", topic: `dupcls ${runId}: перезвоните`, targetAgentId: agentId, autoConnect: false });
    await recordCallbackRequest({ conversationId, channel: "INSTAGRAM", topic: `dupcls ${runId}: ну перезвоните же`, targetAgentId: agentId, autoConnect: false });
    expect(await count(conversationId)).toBe(1);
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
  });

  it("два хода разом (параллельно) — тоже одна просьба", async () => {
    const agentId = await agent();
    const conversationId = await conversation("WHATSAPP");
    await Promise.all([1, 2, 3].map((i) => recordCallbackRequest({ conversationId, channel: "WHATSAPP",
      topic: `dupcls ${runId}: параллельно ${i}`, targetAgentId: agentId, autoConnect: false })));
    expect(await count(conversationId)).toBe(1);
  });

  it("агент закрыл просьбу — следующая просьба снова новая", async () => {
    const agentId = await agent();
    const conversationId = await conversation();
    await recordCallbackRequest({ conversationId, channel: "FACEBOOK", topic: `dupcls ${runId}: первая`, targetAgentId: agentId, autoConnect: false });
    await prisma.callbackRequest.updateMany({ where: { conversationId }, data: { doneAt: new Date() } });
    await recordCallbackRequest({ conversationId, channel: "FACEBOOK", topic: `dupcls ${runId}: вторая`, targetAgentId: agentId, autoConnect: false });
    expect(await count(conversationId)).toBe(2);
  });

  it("повтор с номером дописывает номер в открытую просьбу без номера", async () => {
    const agentId = await agent();
    const conversationId = await conversation();
    const p = phone();
    await recordCallbackRequest({ conversationId, channel: "INSTAGRAM", topic: `dupcls ${runId}: без номера`, targetAgentId: agentId, autoConnect: false });
    await recordCallbackRequest({ conversationId, channel: "INSTAGRAM", phone: p, topic: `dupcls ${runId}: с номером`, targetAgentId: agentId, autoConnect: false });
    const rows = await prisma.callbackRequest.findMany({ where: { conversationId }, select: { phone: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phone).toBe(p);
  });

  it("разные переписки разных людей не склеиваются", async () => {
    const agentId = await agent();
    const a = await conversation();
    const b = await conversation();
    await recordCallbackRequest({ conversationId: a, channel: "INSTAGRAM", topic: `dupcls ${runId}: A`, targetAgentId: agentId, autoConnect: false });
    await recordCallbackRequest({ conversationId: b, channel: "INSTAGRAM", topic: `dupcls ${runId}: B`, targetAgentId: agentId, autoConnect: false });
    expect(await count(a)).toBe(1);
    expect(await count(b)).toBe(1);
  });

  it("правило: живой голос без просьбы клиента не трогаем, у переписки — двое суток по любому признаку", () => {
    expect(callbackRepeatRule({ channel: "LIVE_VOICE", byClientRequest: false })).toBeNull();
    expect(callbackRepeatRule({ channel: "LIVE_VOICE", byClientRequest: true })?.windowMs).toBe(10 * 60_000);
    expect(callbackRepeatRule({ channel: "TELEGRAM", byClientRequest: false })?.windowMs).toBe(48 * 60 * 60_000);
    expect(callbackPerson({})).toBeNull();
    expect(callbackPerson({ clientId: "c", conversationId: "v", phone: "p" })?.lockKey).toBe("v");
    expect(callbackPerson({ clientId: "c", phone: "p" })?.lockKey).toBe("c");
  });
});

describe("восстановление из Корзины не делает вторую живую карточку", () => {
  async function client(data: { phone: string; deleted: boolean; extraPhones?: string[] }) {
    const row = await prisma.client.create({ data: { fullName: `Дубль ${runId}`, phone: data.phone, source: "PHONE_CALL", kind: "BUYER",
      status: "NEW", extraPhones: data.extraPhones ?? [], deletedAt: data.deleted ? new Date() : null } });
    clientIds.push(row.id);
    return row;
  }

  it("номер уже у живой карточки запасным — отказ 409 с номером живой карточки, старая остаётся в Корзине", async () => {
    const p = phone();
    const trashed = await client({ phone: p, deleted: true });
    // Слияние перенесло номер живой карточке запасным, в другой записи формы.
    const live = await client({ phone: phone(), deleted: false, extraPhones: [p.replace("+992", "992 ")] });
    const result = await restoreClientFromTrash(trashed.id, (await agent()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.duplicateOf?.id).toBe(live.id);
    expect(result.error).toContain(`№${live.shortId}`);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: trashed.id } })).deletedAt).not.toBeNull();
  });

  it("номер ни у кого живого — восстановление проходит", async () => {
    const trashed = await client({ phone: phone(), deleted: true });
    const result = await restoreClientFromTrash(trashed.id, (await agent()));
    expect(result.ok).toBe(true);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: trashed.id } })).deletedAt).toBeNull();
  });
});
