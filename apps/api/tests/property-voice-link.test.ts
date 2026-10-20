import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * «Голос рынка» (03.10.2026): связь «диалог ↔ объект», привязка вопросов, комментариев
 * и отказов к объекту и право на раздел «голос клиента после показа».
 *
 * Модель подменена: проверяется решение кода (что и куда записано), а не качество ответа.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const {
  linkConversationProperty,
  linkConversationPropertyByChannel,
  linkConversationPropertiesByChannel,
  singleLinkedPropertyId,
} = await import("../src/lib/propertyVoice/linkConversation.js");
const { recordOwnerQuestion } = await import("../src/lib/ownerQuestions.js");
const { recordExposure } = await import("../src/messengers/propertyShowcase.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");
const { loadPropertyVoice } = await import("../src/lib/propertyVoice/loadPropertyVoice.js");
const { lastConductedShowingPropertyId } = await import("../src/lib/propertyVoice/showingProperty.js");
const { refuseClient } = await import("../src/lib/clientRefuse.js");
const { resolveCommentPropertyByMedia, propertyIdForStoredComment, resolveTelegramCommentProperty } = await import(
  "../src/lib/propertyVoice/commentProperty.js"
);

const runId = Date.now().toString(36);
const DAY = 24 * 3600_000;

let agentId = "";
let districtId = "";
let propertyA = "";
let propertyAShortId = 0;
let propertyB = "";
let clientId = "";
let instagram: CustomerMessengerFixture;
let whatsapp: CustomerMessengerFixture;
const conversationIds: string[] = [];
const commentIds: string[] = [];
const tgCommentIds: string[] = [];
let settingsBefore: {
  botReplyDelaySec: number;
  botReplyMaxWaitSec: number;
  workHoursStart: string;
  workHoursEnd: string;
  botCanAskOwner: boolean;
} | null = null;

async function makeConversation(channel: "INSTAGRAM" | "WHATSAPP" = "INSTAGRAM", suffix = String(conversationIds.length)) {
  const fixture = channel === "INSTAGRAM" ? instagram : whatsapp;
  const scoped = await fixture.ensureConversation(`pv-${runId}-${suffix}`);
  const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id: scoped.id } });
  conversationIds.push(conv.id);
  return conv;
}

async function makeProperty(title: string, extra: Record<string, unknown> = {}) {
  return prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 2,
      price: 500_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 7",
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: agentId,
      ...extra,
    },
  });
}

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  settingsBefore = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true, workHoursStart: true, workHoursEnd: true, botCanAskOwner: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    // botCanAskOwner: без него бот не записывает «уточню у собственника» вовсе.
    data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3, workHoursStart: "00:00", workHoursEnd: "24:00", botCanAskOwner: true },
  });
  districtId = (await prisma.district.create({ data: { name: `Тест-голос-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент голоса ${runId}`, phone: `+992906${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  const a = await makeProperty("Объект А", { publishedPostIds: { INSTAGRAM: `ig-media-${runId}`, TELEGRAM: `777${Date.now() % 10000}` } });
  propertyA = a.id;
  propertyAShortId = a.shortId;
  propertyB = (await makeProperty("Объект Б")).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент голоса ${runId}`, phone: `+992907${runId.slice(-6)}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.instagramComment.deleteMany({ where: { id: { in: commentIds } } });
  await prisma.telegramGroupComment.deleteMany({ where: { id: { in: tgCommentIds } } });
  await prisma.ownerQuestion.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.showingSurveyCall.deleteMany({ where: { agentId } });
  await prisma.propertyInterestEvent.deleteMany({ where: { propertyId: { in: [propertyA, propertyB] } } });
  await prisma.propertyExposure.deleteMany({ where: { propertyId: { in: [propertyA, propertyB] } } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await instagram?.dispose();
  await whatsapp?.dispose();
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyA, propertyB] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("ConversationProperty: идемпотентная запись", () => {
  it("повтор не плодит строк: растёт hits и двигается lastSeenAt, источник первого узнавания сохраняется", async () => {
    const conv = await makeConversation();
    expect(await linkConversationProperty({ conversationId: conv.id, propertyId: propertyA, source: "SHARED_MEDIA" })).toBe(true);
    const first = await prisma.conversationProperty.findFirstOrThrow({ where: { conversationId: conv.id } });
    expect(first.hits).toBe(1);

    await linkConversationProperty({ conversationId: conv.id, propertyId: propertyA, source: "EXPOSURE" });
    const rows = await prisma.conversationProperty.findMany({ where: { conversationId: conv.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].hits).toBe(2);
    expect(rows[0].source).toBe("SHARED_MEDIA");
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
    expect(rows[0].firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
  });

  it("ensureOnly гарантирует пару, но не растит hits", async () => {
    const conv = await makeConversation();
    await linkConversationProperty({ conversationId: conv.id, propertyId: propertyA, source: "AD_REFERRAL", ensureOnly: true });
    await linkConversationProperty({ conversationId: conv.id, propertyId: propertyA, source: "AD_REFERRAL", ensureOnly: true });
    const rows = await prisma.conversationProperty.findMany({ where: { conversationId: conv.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].hits).toBe(1);
  });

  it("одновременные записи одной пары не падают и дают одну строку", async () => {
    const conv = await makeConversation();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => linkConversationProperty({ conversationId: conv.id, propertyId: propertyB, source: "NUMBER_IN_TEXT" }))
    );
    expect(results.every(Boolean)).toBe(true);
    const rows = await prisma.conversationProperty.findMany({ where: { conversationId: conv.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].hits).toBe(6);
  });

  it("несуществующий объект или диалог — false без исключения", async () => {
    const conv = await makeConversation();
    expect(
      await linkConversationProperty({ conversationId: conv.id, propertyId: "00000000-0000-4000-8000-000000000000", source: "EXPOSURE" })
    ).toBe(false);
    expect(await linkConversationProperty({ conversationId: "", propertyId: propertyA, source: "EXPOSURE" })).toBe(false);
  });

  it("по паре (канал, собеседник): нет диалога — ничего не пишется, есть — связь создаётся", async () => {
    expect(
      await linkConversationPropertyByChannel({ channel: "INSTAGRAM", recipientId: `нет-такого-${runId}`, transport: instagram.transport, propertyId: propertyA, source: "EXPOSURE" })
    ).toBe(false);
    const conv = await makeConversation("WHATSAPP", "by-channel");
    // A raw peer without a server-selected account is not an alternate route
    // to the positive fixture; keep the unknown-namespace boundary meaningful.
    expect(await linkConversationPropertyByChannel({ channel: "WHATSAPP", recipientId: conv.subscriberId,
      propertyId: propertyA, source: "LISTING_LINK" })).toBe(false);
    expect(
      await linkConversationPropertyByChannel({ channel: "WHATSAPP", recipientId: conv.subscriberId, transport: whatsapp.transport, propertyId: propertyA, source: "LISTING_LINK" })
    ).toBe(true);
    await linkConversationPropertiesByChannel({
      channel: "WHATSAPP",
      recipientId: conv.subscriberId,
      transport: whatsapp.transport,
      propertyIds: [propertyA, propertyB],
      source: "EXPOSURE",
    });
    expect(await prisma.conversationProperty.count({ where: { conversationId: conv.id } })).toBe(2);
  });

  it("singleLinkedPropertyId: ровно один объект — он, два и больше или ноль — null", async () => {
    const conv = await makeConversation();
    expect(await singleLinkedPropertyId(conv.id)).toBeNull();
    await linkConversationProperty({ conversationId: conv.id, propertyId: propertyA, source: "EXPOSURE" });
    expect(await singleLinkedPropertyId(conv.id)).toBe(propertyA);
    await linkConversationProperty({ conversationId: conv.id, propertyId: propertyB, source: "EXPOSURE" });
    expect(await singleLinkedPropertyId(conv.id)).toBeNull();
  });

  it("показ объекта ботом (recordExposure) оставляет связь EXPOSURE с диалогом", async () => {
    const conv = await makeConversation("INSTAGRAM", "exposure");
    await recordExposure("INSTAGRAM", conv.subscriberId, propertyA, propertyAShortId, "PHOTO", undefined, instagram.transport);
    const row = await waitFor(() => prisma.conversationProperty.findFirst({ where: { conversationId: conv.id, propertyId: propertyA } }));
    expect(row.source).toBe("EXPOSURE");
  });
});

describe("вопрос собственнику знает объект", () => {
  it("recordOwnerQuestion пишет переданный propertyId", async () => {
    const conv = await makeConversation();
    await recordOwnerQuestion({ conversationId: conv.id, propertyId: propertyA, question: "Торг возможен?" });
    const q = await prisma.ownerQuestion.findFirstOrThrow({ where: { conversationId: conv.id } });
    expect(q.propertyId).toBe(propertyA);
  });

  it("без propertyId всё как раньше: поле пустое", async () => {
    const conv = await makeConversation();
    await recordOwnerQuestion({ conversationId: conv.id, question: "Мебель остаётся?" });
    const q = await prisma.ownerQuestion.findFirstOrThrow({ where: { conversationId: conv.id } });
    expect(q.propertyId).toBeNull();
  });

  it("в живом диалоге: клиент называет номер объекта и задаёт вопрос — связь NUMBER_IN_TEXT и propertyId у вопроса", async () => {
    const subscriberId = `pv-${runId}-live`;
    callAi.mockClear();
    callAi.mockResolvedValue({
      reply: ["Уточню у собственника и вернусь."],
      intent: "buy",
      confident: true,
      askOwner: "Возможен ли торг по цене?",
      ready: false,
      topic: "other",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });
    await processMessengerTurn({
      ...whatsapp.turnInput(subscriberId),
      text: `Здравствуйте, объект №${propertyAShortId}, можно ли торговаться?`,
    });
    const conv = await prisma.botConversation.findUniqueOrThrow({
      where: { channel_subscriberId: { channel: "WHATSAPP", subscriberId } },
      select: { id: true },
    });
    conversationIds.push(conv.id);

    const link = await waitFor(() => prisma.conversationProperty.findFirst({ where: { conversationId: conv.id, propertyId: propertyA } }));
    expect(link.source).toBe("NUMBER_IN_TEXT");
    const q = await waitFor(() => prisma.ownerQuestion.findFirst({ where: { conversationId: conv.id } }));
    expect(q.propertyId).toBe(propertyA);
  });

  it("первое сообщение с узнанным вебхуком объектом: пара появляется через sharedPropertyId, а AD_REFERRAL — через adPropertyId", async () => {
    const subscriberId = `pv-${runId}-first`;
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Здравствуйте! Чем помочь?"], confident: true, ready: false, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    await processMessengerTurn({
      ...instagram.turnInput(subscriberId),
      text: "Здравствуйте",
      sharedPropertyId: propertyA,
      adPropertyId: propertyB,
    });
    const conv = await prisma.botConversation.findUniqueOrThrow({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId } },
      select: { id: true },
    });
    conversationIds.push(conv.id);
    const rows = await waitFor(async () => {
      const found = await prisma.conversationProperty.findMany({ where: { conversationId: conv.id } });
      return found.length === 2 ? found : null;
    });
    const bySource = Object.fromEntries(rows.map((r) => [r.propertyId, r.source]));
    expect(bySource[propertyA]).toBe("SHARED_MEDIA");
    expect(bySource[propertyB]).toBe("AD_REFERRAL");
  });
});

describe("комментарии: объект по базе", () => {
  it("публикация из CRM находится по Property.publishedPostIds, чужая — нет", async () => {
    expect(await resolveCommentPropertyByMedia("INSTAGRAM", `ig-media-${runId}`)).toBe(propertyA);
    expect(await resolveCommentPropertyByMedia("INSTAGRAM", `чужая-${runId}`)).toBeNull();
    // Канал без ключа в publishedPostIds не ищется вовсе.
    expect(await resolveCommentPropertyByMedia("TELEGRAM", `ig-media-${runId}`)).toBeNull();
  });

  it("propertyIdForStoredComment: добирает объект у комментария без него и не трогает найденный", async () => {
    const without = await prisma.instagramComment.create({
      data: {
        commentId: `pv-c1-${runId}`,
        mediaId: `ig-media-${runId}`,
        authorId: "author-1",
        text: "Нарх чанд?",
        replyDueAt: new Date(),
        status: "SKIPPED",
      },
    });
    const already = await prisma.instagramComment.create({
      data: {
        commentId: `pv-c2-${runId}`,
        mediaId: `ig-media-${runId}`,
        authorId: "author-2",
        text: "Цена?",
        replyDueAt: new Date(),
        status: "SKIPPED",
        propertyId: propertyB,
      },
    });
    commentIds.push(without.id, already.id);
    expect(await propertyIdForStoredComment(without.id)).toBe(propertyA);
    expect(await propertyIdForStoredComment(already.id)).toBeNull(); // уже есть — не перезаписываем
  });

  it("Telegram: по id поста канала из зеркала и по соседнему комментарию ветки", async () => {
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyA }, select: { publishedPostIds: true } });
    const channelPostId = Number((property.publishedPostIds as { TELEGRAM: string }).TELEGRAM);
    expect(await resolveTelegramCommentProperty({ postMessageId: `m-${runId}`, channelPostId })).toBe(propertyA);
    expect(await resolveTelegramCommentProperty({ postMessageId: `m-${runId}`, channelPostId: 1 })).toBeNull();

    const sibling = await prisma.telegramGroupComment.create({
      data: { messageId: `pv-t1-${runId}`, postMessageId: `thread-${runId}`, authorId: "u1", text: "Сколько?", replyDueAt: new Date(), propertyId: propertyA },
    });
    tgCommentIds.push(sibling.id);
    expect(await resolveTelegramCommentProperty({ postMessageId: `thread-${runId}` })).toBe(propertyA);
    expect(await resolveTelegramCommentProperty({ postMessageId: `другая-ветка-${runId}` })).toBeNull();
  });
});

describe("отказ после показа знает объект показа", () => {
  it("свежий проведённый показ — его объект; показ без объекта и устаревший — null", async () => {
    expect(await lastConductedShowingPropertyId(clientId)).toBeNull(); // показов нет

    const old = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "SHOWING",
        propertyId: propertyB,
        notes: "старый показ",
        completedAt: new Date(Date.now() - 60 * DAY),
        nextActionDate: new Date(Date.now() - 60 * DAY),
        createdAt: new Date(Date.now() - 61 * DAY),
      },
    });
    expect(await lastConductedShowingPropertyId(clientId)).toBeNull(); // старше 30 дней

    const fresh = await prisma.interaction.create({
      data: { clientId, agentId, type: "SHOWING", propertyId: propertyA, notes: "свежий показ", completedAt: new Date() },
    });
    expect(await lastConductedShowingPropertyId(clientId)).toBe(propertyA);

    // Последний показ без объекта: брать объект предыдущего — значит приписать наугад.
    await prisma.interaction.create({
      data: { clientId, agentId, type: "SHOWING", notes: "без объекта", completedAt: new Date(Date.now() + 1000), createdAt: new Date(Date.now() + 1000) },
    });
    expect(await lastConductedShowingPropertyId(clientId)).toBeNull();
    await prisma.interaction.deleteMany({ where: { id: { in: [old.id, fresh.id] } } });
  });
});

describe("отказ клиента (refuseClient) пишет объект показа в запись хронологии", () => {
  it("после свежего показа объекта А запись «Клиент отказался» несёт propertyId А, а причина видна в голосе объекта", async () => {
    const refusing = await prisma.client.create({
      data: {
        fullName: `Отказавший ${runId}`,
        phone: `+992908${runId.slice(-6)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    try {
      await prisma.interaction.create({
        data: { clientId: refusing.id, agentId, type: "SHOWING", propertyId: propertyA, notes: "Показ", completedAt: new Date() },
      });
      const result = await refuseClient({
        clientId: refusing.id,
        reason: "EXPENSIVE",
        initiator: "CLIENT",
        actorAgentId: agentId,
        actorId: agentId,
      });
      expect(result.ok).toBe(true);
      const record = await prisma.interaction.findFirstOrThrow({
        where: { clientId: refusing.id, type: "SYSTEM", notes: { startsWith: "Клиент отказался (" } },
      });
      expect(record.propertyId).toBe(propertyA);

      const voice = await loadPropertyVoice(propertyA, { canSeeShowingFeedback: false });
      expect(voice!.questions.refusals.total).toBeGreaterThanOrEqual(1);
      expect(voice!.questions.refusals.byReason.find((r) => r.key === "EXPENSIVE")).toBeDefined();
    } finally {
      await prisma.interaction.deleteMany({ where: { clientId: refusing.id } });
      await prisma.client.deleteMany({ where: { id: refusing.id } });
    }
  });
});

describe("GET /properties/:id/voice: загрузка и права", () => {
  it("собирает интерес, комментарии, вопросы и скрывает опросы после показа от не-директора", async () => {
    await prisma.propertyInterestEvent.createMany({
      data: [
        { propertyId: propertyA, kind: "SHARE_SENT", clientId },
        { propertyId: propertyA, kind: "COMMENT", externalAuthorId: "ig-author", externalAuthorName: "x" },
      ],
    });
    const esc = await prisma.instagramComment.create({
      data: {
        commentId: `pv-c3-${runId}`,
        mediaId: `ig-media-${runId}`,
        authorId: "author-3",
        text: "Позвоните мне 900 123 456, торг есть?",
        replyDueAt: new Date(),
        status: "ESCALATED",
        note: "нужен человек",
        propertyId: propertyA,
      },
    });
    commentIds.push(esc.id);
    await prisma.showingSurveyCall.create({
      data: {
        interactionId: `survey-${runId}`,
        clientId,
        agentId,
        propertyId: propertyA,
        redFlags: [{ category: "agent_rude", detail: "грубил по телефону +992 900 11 22 33" }],
      },
    });

    const asAgent = await loadPropertyVoice(propertyA, { canSeeShowingFeedback: false });
    expect(asAgent).not.toBeNull();
    expect(asAgent!.interest.events).toBe(2);
    expect(asAgent!.interest.people).toBe(2);
    expect(asAgent!.interest.conversations.total).toBeGreaterThan(0); // из тестов выше
    expect(asAgent!.questions.comments.escalated.count).toBe(1);
    expect(JSON.stringify(asAgent)).not.toMatch(/900 123 456/);
    expect("showingFeedback" in asAgent!).toBe(false);
    expect(JSON.stringify(asAgent)).not.toContain("грубил");

    const asDirector = await loadPropertyVoice(propertyA, { canSeeShowingFeedback: true });
    expect(asDirector!.showingFeedback).toBeDefined();
    expect(asDirector!.showingFeedback!.calls).toBe(1);
    expect(asDirector!.showingFeedback!.redFlags[0].text).toMatch(/agent_rude/);
    expect(JSON.stringify(asDirector)).not.toMatch(/900 11 22 33/);

    expect(await loadPropertyVoice("00000000-0000-4000-8000-000000000000", { canSeeShowingFeedback: true })).toBeNull();
  });
});
