import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { noticeOwnerOfConversationInterest } from "../src/lib/propertyInterestNotice.js";
import { linkConversationProperty } from "../src/lib/propertyVoice/linkConversation.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * P0-3 и безусловная часть P0-7 аудита docs/audit-bots-2026-10-10-object-routing.md:
 * хозяин объекта узнаёт о переписке по своему объекту ВСЕГДА — и когда клиента
 * ещё нет в базе (номера не дал), и когда карточка есть, но без агента. Без
 * персональных данных, со ссылкой на переписку, раз в сутки на пару «диалог +
 * объект». Показ объекта ботом (EXPOSURE) хозяина не будит. Хозяин отключён —
 * сигнал руководителю. Флаг варианта (а) по умолчанию выключен: лид другого
 * агента не переезжает; включён — переезжает только непринятый лид из очереди.
 */
const runId = Date.now();
const tail = String(runId).slice(-6);
let districtId: string;
let ownerId: string;
let firedOwnerId: string;
let otherId: string;
let directorId: string;
let propertyId: string;
let firedPropertyId: string;
const conversationIds: string[] = [];
const clientIds: string[] = [];

async function makeConversation(suffix: string, clientId?: string) {
  const conv = await prisma.botConversation.create({
    data: { channel: "INSTAGRAM", subscriberId: `orn-${runId}-${suffix}`, messages: [], ...(clientId ? { clientId } : {}) },
  });
  conversationIds.push(conv.id);
  return conv;
}

async function makeClient(label: string, data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `Интерес к объекту ${label} ${runId}`,
      phone: `+99295${tail}${clientIds.length}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      ...data,
    },
  });
  clientIds.push(c.id);
  return c;
}

const tagOf = (convId: string, propId: string) => `interest-conv-${convId}-${propId}`;
const notesFor = (agentId: string, tag: string) => prisma.notification.findMany({ where: { agentId, tag } });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-интерес-${runId}` } })).id;
  const mk = (fullName: string, n: number, extra: Record<string, unknown> = {}) =>
    prisma.agent.create({ data: { fullName, role: "AGENT", phone: `+99296${tail}${n}`, passwordHash: "x", ...extra } });
  ownerId = (await mk("Хозяин объекта (интерес)", 1)).id;
  firedOwnerId = (await mk("Уволенный хозяин (интерес)", 2, { isActive: false })).id;
  otherId = (await mk("Другой агент (интерес)", 3)).id;
  directorId = (await mk("Директор (интерес)", 4, { role: "DIRECTOR" })).id;
  const mkProperty = (title: string, intakeAgentId: string) =>
    prisma.property.create({
      data: {
        title: `${title} ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        rooms: 2,
        price: 280_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 3",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId,
      },
    });
  propertyId = (await mkProperty("Объект хозяина (интерес)", ownerId)).id;
  firedPropertyId = (await mkProperty("Объект уволенного (интерес)", firedOwnerId)).id;
});

afterEach(() => {
  delete process.env.OBJECT_INTEREST_PULLS_QUEUE_LEAD;
});

afterAll(async () => {
  const tags = conversationIds.flatMap((c) => [tagOf(c, propertyId), tagOf(c, firedPropertyId)]);
  await waitForSettled(() => prisma.notification.count({ where: { tag: { in: tags } } }));
  await prisma.notification.deleteMany({ where: { tag: { in: tags } } });
  await prisma.conversationProperty.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, firedPropertyId].filter(Boolean) } } });
  await deleteAgentsWithTraces([ownerId, firedOwnerId, otherId, directorId].filter(Boolean));
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("P0-3: хозяин узнаёт о переписке по своему объекту и без карточки клиента", () => {
  it("клиента нет — хозяину уведомление со ссылкой на переписку, без персональных данных, один раз", async () => {
    const conv = await makeConversation("anon");
    // Через единую точку «код узнал объект в диалоге» — как пересланный пост.
    await linkConversationProperty({ conversationId: conv.id, propertyId, source: "SHARED_MEDIA" });
    const tag = tagOf(conv.id, propertyId);
    const [n] = await waitFor(async () => {
      const rows = await notesFor(ownerId, tag);
      return rows.length ? rows : null;
    });
    expect(n.url).toBe(`/messages?open=${conv.id}`);
    const shortId = (await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).shortId;
    expect(n.body).toContain(`№${shortId}`);
    expect(n.body).not.toContain(`orn-${runId}`);

    // Повтор узнавания (тот же пост ещё раз) — хозяина не будим второй раз.
    await linkConversationProperty({ conversationId: conv.id, propertyId, source: "NUMBER_IN_TEXT" });
    await noticeOwnerOfConversationInterest({ conversationId: conv.id, propertyId });
    const rows = await waitForSettled(() => notesFor(ownerId, tag).then((r) => r.reduce((s, x) => s + (x.count ?? 1), 0)));
    expect(rows).toBe(1);
  });

  it("показ объекта ботом (EXPOSURE) хозяина не будит", async () => {
    const conv = await makeConversation("exposure");
    await linkConversationProperty({ conversationId: conv.id, propertyId, source: "EXPOSURE" });
    const count = await waitForSettled(() => prisma.notification.count({ where: { tag: tagOf(conv.id, propertyId) } }));
    expect(count).toBe(0);
  });

  it("карточка без агента — хозяину тоже уведомление", async () => {
    const client = await makeClient("без агента", {});
    const conv = await makeConversation("noagent", client.id);
    await noticeOwnerOfConversationInterest({ conversationId: conv.id, propertyId });
    await waitFor(async () => (await notesFor(ownerId, tagOf(conv.id, propertyId))).length > 0);
  });

  it("клиент уже у хозяина — ничего не шлём", async () => {
    const client = await makeClient("у хозяина", { assignedAgentId: ownerId, assignedAt: new Date() });
    const conv = await makeConversation("mine", client.id);
    await noticeOwnerOfConversationInterest({ conversationId: conv.id, propertyId });
    const count = await waitForSettled(() => prisma.notification.count({ where: { tag: tagOf(conv.id, propertyId) } }));
    expect(count).toBe(0);
  });

  it("хозяин отключён — сигнал руководителю «по объекту пишут, а хозяина нет»", async () => {
    const conv = await makeConversation("fired");
    await noticeOwnerOfConversationInterest({ conversationId: conv.id, propertyId: firedPropertyId });
    const [n] = await waitFor(async () => {
      const rows = await notesFor(directorId, tagOf(conv.id, firedPropertyId));
      return rows.length ? rows : null;
    });
    expect(n.title).toContain("хозяина нет");
    expect(await prisma.notification.count({ where: { agentId: firedOwnerId } })).toBe(0);
  });
});

describe("P0-7: флаг варианта (а) — по умолчанию лид другого агента не переезжает", () => {
  it("флаг выключен: непринятый лид из очереди остаётся у агента Б", async () => {
    const client = await makeClient("очередь, флаг выкл", { assignedAgentId: otherId, assignedAt: new Date(), assignReason: "queue" });
    const conv = await makeConversation("queue-off", client.id);
    await noticeOwnerOfConversationInterest({ conversationId: conv.id, propertyId });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.assignedAgentId).toBe(otherId);
  });

  it("флаг включён: непринятый лид из очереди переезжает к хозяину объекта", async () => {
    process.env.OBJECT_INTEREST_PULLS_QUEUE_LEAD = "1";
    const client = await makeClient("очередь, флаг вкл", { assignedAgentId: otherId, assignedAt: new Date(), assignReason: "queue" });
    const conv = await makeConversation("queue-on", client.id);
    await noticeOwnerOfConversationInterest({ conversationId: conv.id, propertyId });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.assignedAgentId).toBe(ownerId);
    expect(after.assignReason).toBe("own_property_explicit");
    expect(after.matchedPropertyId).toBe(propertyId);
    expect(after.ownPropertyLead).toBe(true);
  });

  it("флаг включён, но лид уже принят — остаётся у агента Б", async () => {
    process.env.OBJECT_INTEREST_PULLS_QUEUE_LEAD = "1";
    const client = await makeClient("принят, флаг вкл", {
      assignedAgentId: otherId,
      assignedAt: new Date(),
      acceptedAt: new Date(),
      assignReason: "queue",
    });
    const conv = await makeConversation("accepted-on", client.id);
    await noticeOwnerOfConversationInterest({ conversationId: conv.id, propertyId });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.assignedAgentId).toBe(otherId);
  });
});
