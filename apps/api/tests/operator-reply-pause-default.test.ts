import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ДЕФОЛТ ПАУЗЫ ПОСЛЕ РУЧНОГО ОТВЕТА (18.08.2026, решение владельца, уточнено тем же
 * днём вечером).
 *
 * Раньше `deliverToConversation` без явного `pausedUntilOverride` ставил ровно 10
 * минут (OPERATOR_REPLY_PAUSE_MS_SHORT). Затем сделали ЛЮБОЙ ручной ответ без явного
 * срока полной передачей диалога («навсегда», OPERATOR_REPLY_PAUSE_MS) — но владелец
 * поправил: это верно только когда отвечает СВОЙ, ЗАКРЕПЛЁННЫЙ за клиентом агент
 * (Client.assignedAgentId). Если отвечает директор/незакреплённый сотрудник, или у
 * клиента вообще нет закреплённого агента, или клиент ещё не карточка (clientId
 * пуст) — пауза короткая, как и раньше. Явный `pausedUntilOverride` по-прежнему
 * уважается в любом случае.
 *
 * Транспорт (Meta) подменён моками — проверяется решение о `pausedUntil`, а не сеть.
 */

const { sendMessage, isMetaChannelEnabled } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_c: string, _to: string, _text: string) => "wamid.sent-1"),
  isMetaChannelEnabled: vi.fn(async () => true),
}));

vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage,
  isMetaChannelEnabled,
}));

const { prisma } = await import("../src/db.js");
const { deliverToConversation, OPERATOR_REPLY_PAUSE_MS, OPERATOR_REPLY_PAUSE_MS_SHORT } = await import(
  "../src/lib/conversationDelivery.js"
);

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });

const runId = Date.now();
const conversationIds: string[] = [];
const clientIds: string[] = [];
const agentIds: string[] = [];
/**
 * Счётчик вместо случайного числа в телефоне клиента. Было
 * `Math.floor(Math.random() * 1000)` — тысяча значений на шесть-восемь клиентов
 * за прогон, то есть несколько процентов на совпадение в СВОЁМ же файле и
 * падение `Unique constraint failed on Client_phone_key` на ровном месте
 * (поймано 23.09.2026 полным прогоном main; в одиночку файл всегда зелёный, и
 * красным становится не тот, кто менял код). Остальные тесты берут полосу в
 * десять миллионов — здесь она была в десять тысяч раз уже. Счётчик закрывает
 * совпадение внутри файла начисто, а не уменьшает его вероятность.
 */
let clientSeq = 0;

async function makeConversation(clientId?: string) {
  const c = await prisma.botConversation.create({
    data: { channel: "INSTAGRAM", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: `pause-default-${runId}-${Math.random()}`, messages: [], clientId },
  });
  conversationIds.push(c.id);
  return c;
}

async function makeAgent(suffix: string) {
  const a = await prisma.agent.create({
    data: { fullName: `Агент ${suffix} ${runId}`, phone: `+99291${runId}${suffix}`, role: "AGENT", passwordHash: "x" },
  });
  agentIds.push(a.id);
  return a;
}

async function makeClient(assignedAgentId: string | null) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент ${runId}`,
      phone: `+99292${runId}${String(clientSeq++).padStart(3, "0")}`,
      source: "INSTAGRAM",
      assignedAgentId,
    },
  });
  clientIds.push(c.id);
  return c;
}

afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await fixture?.dispose();
  if (clientIds.length > 0) await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  if (agentIds.length > 0) await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

// Порог, ниже которого паузу точно нельзя считать «навсегда» — короткая пауза
// (10 минут) не пройдёт этой проверки, а «10 лет вперёд» пройдёт с большим запасом.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe("Пауза бота после ручного ответа — дефолт", () => {
  it("отвечает закреплённый за клиентом агент — постоянная пауза, и снимается просьба живого агента", async () => {
    const agent = await makeAgent("own");
    const client = await makeClient(agent.id);
    // Клиент до этого попросил живого агента (владелец 18.09.2026,
    // messengers/conversation.ts::looksLikeWantsHumanAgent) — свой закреплённый
    // агент теперь ответил сам, значит просьбу уже услышали.
    await prisma.client.update({ where: { id: client.id }, data: { agentAttentionRequestedAt: new Date() } });
    const c = await makeConversation(client.id);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Здравствуйте, помогу вам сам",
      undefined,
      { sender: { kind: "agent", agentId: agent.id, agentName: agent.fullName } }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pausedUntil.getTime() - Date.now()).toBeGreaterThan(ONE_YEAR_MS);
    expect(result.pausedUntil.getTime() - Date.now()).toBeLessThanOrEqual(OPERATOR_REPLY_PAUSE_MS + 5000);

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id }, select: { pausedUntil: true } });
    expect(saved!.pausedUntil!.getTime() - Date.now()).toBeGreaterThan(ONE_YEAR_MS);

    const savedClient = await prisma.client.findUnique({ where: { id: client.id }, select: { agentAttentionRequestedAt: true } });
    expect(savedClient?.agentAttentionRequestedAt).toBeNull();
  });

  it("отвечает директор/сотрудник, не закреплённый за этим клиентом — короткая пауза", async () => {
    const owner = await makeAgent("director");
    const assignedElsewhere = await makeAgent("other");
    const client = await makeClient(assignedElsewhere.id);
    const c = await makeConversation(client.id);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Отвечаю разово вместо коллеги",
      undefined,
      { sender: { kind: "agent", agentId: owner.id, agentName: owner.fullName } }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pausedUntil.getTime() - Date.now()).toBeLessThan(ONE_YEAR_MS);
    expect(result.pausedUntil.getTime() - Date.now()).toBeLessThanOrEqual(OPERATOR_REPLY_PAUSE_MS_SHORT + 5000);
  });

  it("у клиента вообще нет закреплённого агента — короткая пауза", async () => {
    const owner = await makeAgent("noagent");
    const client = await makeClient(null);
    const c = await makeConversation(client.id);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Лид пока ничей, отвечаю сам",
      undefined,
      { sender: { kind: "agent", agentId: owner.id, agentName: owner.fullName } }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pausedUntil.getTime() - Date.now()).toBeLessThan(ONE_YEAR_MS);
  });

  it("диалог ещё не стал карточкой клиента (clientId пуст) — короткая пауза", async () => {
    const owner = await makeAgent("noclient");
    const c = await makeConversation(undefined);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Отвечаю до создания карточки",
      undefined,
      { sender: { kind: "agent", agentId: owner.id, agentName: owner.fullName } }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pausedUntil.getTime() - Date.now()).toBeLessThan(ONE_YEAR_MS);
  });

  it("без sender вовсе (служебная отправка) — короткая пауза, не «навсегда»", async () => {
    const c = await makeConversation();

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Служебное сообщение"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pausedUntil.getTime() - Date.now()).toBeLessThan(ONE_YEAR_MS);
  });

  it("с явным коротким override пауза остаётся такой, как задал агент, даже для закреплённого агента", async () => {
    const agent = await makeAgent("override");
    const client = await makeClient(agent.id);
    const c = await makeConversation(client.id);
    const shortPause = new Date(Date.now() + 10 * 60 * 1000);

    const result = await deliverToConversation(
      { kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport },
      "Отвечаю сам, но скоро верну бота",
      shortPause,
      { sender: { kind: "agent", agentId: agent.id, agentName: agent.fullName } }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pausedUntil.getTime()).toBe(shortPause.getTime());
    expect(result.pausedUntil.getTime() - Date.now()).toBeLessThan(ONE_YEAR_MS);

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id }, select: { pausedUntil: true } });
    expect(saved!.pausedUntil!.getTime()).toBe(shortPause.getTime());
  });
});
