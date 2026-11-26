import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { linkSpy } = vi.hoisted(() => ({ linkSpy: vi.fn(async () => true) }));
// Сама запись связи и уведомление хозяину покрыты tests/object-routing-owner-notice.test.ts; здесь — что новый бот её зовёт.
vi.mock("../src/lib/propertyVoice/linkConversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyVoice/linkConversation.js")>()),
  linkConversationProperty: linkSpy,
}));

import { prisma } from "../src/db.js";
import { qualifyIncomingCall } from "../src/lib/telephony/qualifyIncoming.js";
import { recentCallerAdPropertyId } from "../src/lib/telephony/callAdProperty.js";
import { customerFocusPropertyForLead, focusInterestSource, linkResolvedCustomerFocus } from "../src/lib/customerFocusOwner.js";
import { customerListingCardFactsSelectors } from "../src/lib/customerAgentMediaFocus.js";
import { parseIncoming, whatsappOrderText } from "../src/messengers/meta.js";
import { objectInterestPullsQueueLead } from "../src/lib/propertyInterestNotice.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * КЛИЕНТ ПО ОБЪЕКТУ — ХОЗЯИНУ ОБЪЕКТА ВО ВСЕХ КАНАЛАХ (27.11.2026, владелец: «бот должен узнать объект и по рекламе,
 * и по переписке, и по скриншотам… чтобы агенты не теряли своих клиентов»). По каналу на блок:
 *  • звонок клиента, пришедшего с рекламы объекта (callAdObjectToOwnerEnabled);
 *  • новый бот WhatsApp/Instagram/Facebook — объект фокуса в заявку и связь «диалог ↔ объект» (chatObjectToOwnerEnabled);
 *  • скриншот карточки без нашего логотипа — по цене и площади, только единственный;
 *  • WhatsApp — заказ из каталога и переход с публикации;
 *  • рубильник «непринятая заявка переходит хозяину» — переменная окружения поверх Настроек.
 * Telegram Direct — в tests/telegram-direct-messages.test.ts.
 */
const runId = Date.now();
const tail = String(runId).slice(-6);
let districtId: string;
let ownerId: string;
let answererId: string;
let propertyId: string;
let propertyShortId: number;
const clientIds: string[] = [];
const callIds: string[] = [];
const conversationIds: string[] = [];
const extraPropertyIds: string[] = [];

async function setSwitch(data: { chatObjectToOwnerEnabled?: boolean; callAdObjectToOwnerEnabled?: boolean }) {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
}

async function makeClient(label: string, kind: "BUYER" | "SELLER" = "BUYER") {
  const client = await prisma.client.create({
    data: { fullName: `Объект-хозяину ${label} ${runId}`, phone: `+99298${tail}${clientIds.length}`, source: "PHONE_CALL", kind },
  });
  clientIds.push(client.id);
  return client;
}

async function adConversation(clientId: string, createdAt = new Date()) {
  const conv = await prisma.botConversation.create({
    data: { channel: "WHATSAPP", subscriberId: `oto-${runId}-${conversationIds.length}`, messages: [], clientId,
      adPropertyId: propertyId, adTopic: "property", createdAt },
  });
  conversationIds.push(conv.id);
  return conv;
}

async function qualify(clientId: string, phone: string) {
  const call = await prisma.incomingCall.create({ data: { channelId: `oto-${runId}-${callIds.length}`, phone, clientId, answered: true } });
  callIds.push(call.id);
  const delegate = prisma.settings;
  const real = delegate.findUnique.bind(delegate);
  const spy = vi.spyOn(delegate, "findUnique").mockImplementation((async (args: Parameters<typeof real>[0]) => {
    const row = await real(args);
    return row ? { ...row, leadDistributionStrategy: "fair", incomingAssignOnQualify: true } : row;
  }) as never);
  try {
    const result = await qualifyIncomingCall({
      callId: call.id, operatorId: null, answeredByAgentId: answererId, knownPropertyId: null,
      data: { kind: "BUYER", fullName: "Фарход" },
    });
    expect("error" in result).toBe(false);
  } finally {
    spy.mockRestore();
  }
  return prisma.client.findUniqueOrThrow({ where: { id: clientId } });
}

beforeAll(async () => {
  await setSwitch({ chatObjectToOwnerEnabled: true, callAdObjectToOwnerEnabled: true });
  districtId = (await prisma.district.create({ data: { name: `Район-объект-хозяину-${runId}` } })).id;
  const mk = (fullName: string, n: number) =>
    prisma.agent.create({ data: { fullName, role: "AGENT", phone: `+99297${tail}${n}`, passwordHash: "x" } });
  ownerId = (await mk("Хозяин объекта (все каналы)", 1)).id;
  answererId = (await mk("Снял трубку (все каналы)", 2)).id;
  const p = await prisma.property.create({
    data: {
      title: `Объект все каналы ${runId}`, type: "APARTMENT", areaSqm: 66.5, rooms: 2, price: 351_234, currency: "TJS",
      districtId, address: "Тестовая, 7", condition: "GOOD", status: "AVAILABLE", intakeAgentId: ownerId,
    },
  });
  propertyId = p.id;
  propertyShortId = p.shortId;
});

afterAll(async () => {
  await setSwitch({ chatObjectToOwnerEnabled: true, callAdObjectToOwnerEnabled: true });
  await prisma.conversationProperty.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.incomingCall.deleteMany({ where: { id: { in: callIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, ...extraPropertyIds] } } });
  await deleteAgentsWithTraces([ownerId, answererId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("звонок клиента, пришедшего в переписку с рекламы объекта", () => {
  it("расшифровка объект не назвала — заявка хозяину объекта рекламы, а не снявшему трубку", async () => {
    const client = await makeClient("звонок с рекламы");
    await adConversation(client.id);
    const after = await qualify(client.id, client.phone);
    expect(after.assignedAgentId).toBe(ownerId);
    expect(after.assignReason).toBe("own_property_explicit");
    expect(after.matchedPropertyId).toBe(propertyId);
    const note = await prisma.interaction.findFirst({ where: { clientId: client.id, notes: { contains: "с рекламы объекта" } } });
    expect(note).not.toBeNull();
  });

  it("переписка с рекламы старше 30 дней — звонок у снявшего трубку, как раньше", async () => {
    const client = await makeClient("старая реклама");
    await adConversation(client.id, new Date(Date.now() - 45 * 24 * 60 * 60 * 1000));
    const after = await qualify(client.id, client.phone);
    expect(after.assignedAgentId).toBe(answererId);
  });

  it("продавцу и при выключенном рубильнике объект рекламы не подсказывается", async () => {
    const client = await makeClient("рубильник звонка");
    await adConversation(client.id);
    expect(await recentCallerAdPropertyId(client.id, "SELLER")).toBeNull();
    expect(await recentCallerAdPropertyId(client.id, "BUYER")).toBe(propertyId);
    await setSwitch({ callAdObjectToOwnerEnabled: false });
    try {
      expect(await recentCallerAdPropertyId(client.id, "BUYER")).toBeNull();
      const after = await qualify(client.id, client.phone);
      expect(after.assignedAgentId).toBe(answererId);
    } finally {
      await setSwitch({ callAdObjectToOwnerEnabled: true });
    }
  });
});

describe("новый бот: объект, узнанный в переписке, идёт с заявкой и будит хозяина", () => {
  const scopeKey = "a".repeat(64);
  async function focusedConversation(status: "resolved" | "ambiguous", evidenceKind: "url" | "public_selector" = "url") {
    const focus = {
      version: 1, scopeKey, generation: randomUUID(), lastEvidenceOrder: "7", eventKey: "b".repeat(64), status,
      propertyId: status === "resolved" ? propertyId : null,
      evidence: [{ kind: evidenceKind, origin: "message", reference: evidenceKind === "url" ? "https://royalhome.tj/listing/1" : `short:${propertyShortId}` }],
    };
    const conv = await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", subscriberId: `oto-focus-${runId}-${conversationIds.length}`, messages: [], customerPropertyFocus: focus },
    });
    conversationIds.push(conv.id);
    return { conv, focus };
  }

  it("узнанный объект фокуса — в заявку покупателя; чужая область, «несколько похожих» и выключенный рубильник — нет", async () => {
    const { conv } = await focusedConversation("resolved");
    expect(await customerFocusPropertyForLead(conv.id, scopeKey)).toBe(propertyId);
    expect(await customerFocusPropertyForLead(conv.id, "c".repeat(64))).toBeNull();
    expect(await customerFocusPropertyForLead(null, scopeKey)).toBeNull();
    const { conv: ambiguous } = await focusedConversation("ambiguous");
    expect(await customerFocusPropertyForLead(ambiguous.id, scopeKey)).toBeNull();
    await setSwitch({ chatObjectToOwnerEnabled: false });
    try {
      expect(await customerFocusPropertyForLead(conv.id, scopeKey)).toBeNull();
    } finally {
      await setSwitch({ chatObjectToOwnerEnabled: true });
    }
  });

  it("узнанный объект связывается с перепиской (источник — чем клиент указал), неузнанный — нет", async () => {
    const { conv, focus } = await focusedConversation("resolved", "public_selector");
    linkSpy.mockClear();
    await linkResolvedCustomerFocus(conv.id, focus);
    expect(linkSpy).toHaveBeenCalledWith({ conversationId: conv.id, propertyId, source: "NUMBER_IN_TEXT" });
    const { conv: ambiguous, focus: unsure } = await focusedConversation("ambiguous");
    await linkResolvedCustomerFocus(ambiguous.id, unsure);
    expect(linkSpy).toHaveBeenCalledTimes(1);
    await setSwitch({ chatObjectToOwnerEnabled: false });
    try {
      await linkResolvedCustomerFocus(conv.id, focus);
      expect(linkSpy).toHaveBeenCalledTimes(1);
    } finally {
      await setSwitch({ chatObjectToOwnerEnabled: true });
    }
    expect(focusInterestSource([{ kind: "ad" }, { kind: "url" }])).toBe("AD_REFERRAL");
    expect(focusInterestSource([{ kind: "media" }])).toBe("SHARED_MEDIA");
  });
});

describe("скриншот карточки объявления без нашего логотипа", () => {
  const text = "Продаётся 2-комнатная квартира, 66.5 м², цена 351 234 сомони";
  it("цена и площадь сходятся ровно с одним объектом в продаже — объект узнан", async () => {
    expect(await customerListingCardFactsSelectors({ subject: "listing_card", readableText: text })).toEqual([propertyShortId]);
  });
  it("не карточка объявления или рубильник выключен — не узнаём", async () => {
    expect(await customerListingCardFactsSelectors({ subject: "home_interior", readableText: text })).toEqual([]);
    await setSwitch({ chatObjectToOwnerEnabled: false });
    try {
      expect(await customerListingCardFactsSelectors({ subject: "listing_card", readableText: text })).toEqual([]);
    } finally {
      await setSwitch({ chatObjectToOwnerEnabled: true });
    }
  });
  it("два объекта с теми же ценой и площадью — не угадываем", async () => {
    const twinText = "3 комнаты, 81.3 м², 512 777 сомони";
    for (const n of [1, 2]) {
      const twin = await prisma.property.create({
        data: { title: `Двойник ${n} ${runId}`, type: "APARTMENT", areaSqm: 81.3, rooms: 3, price: 512_777, currency: "TJS",
          districtId, address: `Тестовая, ${10 + n}`, condition: "GOOD", status: "AVAILABLE", intakeAgentId: ownerId },
      });
      extraPropertyIds.push(twin.id);
    }
    expect(await customerListingCardFactsSelectors({ subject: "listing_card", readableText: twinText })).toEqual([]);
  });
});

describe("WhatsApp: каталог и переход с публикации", () => {
  const waBody = (message: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "PHONE-ID" }, contacts: [{ wa_id: "992900000001", profile: { name: "Клиент" } }],
      messages: [{ from: "992900000001", id: `wamid.${runId}`, timestamp: "1", ...message }],
    } }] }],
  });

  it("заказ из каталога: id товара — номер объекта словами", () => {
    const text = whatsappOrderText({ type: "order", order: { product_items: [{ product_retailer_id: String(propertyShortId), quantity: 1 }] } } as never);
    expect(text).toContain(`объект №${propertyShortId}`);
    const foreign = whatsappOrderText({ type: "order", order: { product_items: [{ product_retailer_id: "SKU-abc" }] } } as never);
    expect(foreign).toContain("SKU-abc");
    expect(foreign).not.toContain("объект №");
  });

  it("переход с публикации (source_type post) — номер поста, а не объявления; реклама — как раньше", () => {
    const [post] = parseIncoming(waBody({ type: "text", text: { body: "Здравствуйте" }, referral: { source_id: "1234567890", source_type: "post" } }));
    expect(post.adPostId).toBe("1234567890");
    expect(post.adId).toBeUndefined();
    const [ad] = parseIncoming(waBody({ type: "text", text: { body: "Здравствуйте" }, referral: { source_id: "238500000001", source_type: "ad" } }));
    expect(ad.adId).toBe("238500000001");
  });
});

describe("рубильник «непринятая заявка переходит хозяину»: переменная окружения поверх Настроек", () => {
  it("«1» включает, «0» выключает, без неё решают Настройки", () => {
    expect(objectInterestPullsQueueLead(false, { OBJECT_INTEREST_PULLS_QUEUE_LEAD: "1" })).toBe(true);
    expect(objectInterestPullsQueueLead(true, { OBJECT_INTEREST_PULLS_QUEUE_LEAD: "0" })).toBe(false);
    expect(objectInterestPullsQueueLead(true, {})).toBe(true);
    expect(objectInterestPullsQueueLead(false, {})).toBe(false);
  });
});
