import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { backfillPropertyVoice } from "../src/lib/propertyVoice/backfill.js";

/**
 * Добор «голоса рынка» по старым данным: по умолчанию ничего не пишет, при записи
 * строит связи и проставляет объект только по доказанному, повтор ничего не меняет.
 */

const runId = Date.now().toString(36);

let agentId = "";
let districtId = "";
let propertyA = "";
let propertyAShort = 0;
let propertyB = "";
let sellerPropertyId = "";
let sellerClientId = "";
let buyerClientId = "";
const conversationIds: string[] = [];
let exposureConv = "";
let adConv = "";
let twoObjectsConv = "";
let questionOneObject = "";
let questionTwoObjects = "";
let questionBeforeLink = "";
let callWithPropertyAnalysisId = "";
let commentId = "";
let callBuyerAnalysisId = "";
let callSellerAnalysisId = "";
let callUnknownAnalysisId = "";
const interactionIds: string[] = [];

async function makeProperty(title: string, extra: Record<string, unknown> = {}) {
  return prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      rooms: 2,
      price: 300_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 3",
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: agentId,
      ...extra,
    },
  });
}

async function makeCall(clientId: string, propertyId?: string) {
  const interaction = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "разговор", ...(propertyId ? { propertyId } : {}) },
  });
  interactionIds.push(interaction.id);
  const analysis = await prisma.callAnalysis.create({
    data: { interactionId: interaction.id, agentId, score: 50, objections: [], agreements: [], summary: "сводка" },
  });
  return analysis.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-добор-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент добора ${runId}`, phone: `+992959${runId}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  const a = await makeProperty("Объект А", { publishedPostIds: { INSTAGRAM: `bf-media-${runId}` } });
  propertyA = a.id;
  propertyAShort = a.shortId;
  propertyB = (await makeProperty("Объект Б")).id;

  // Диалог, которому объект А показывали (старые данные: связи ещё нет).
  exposureConv = (await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `bf-${runId}-exp`, messages: [] } })).id;
  await prisma.propertyExposure.create({
    data: { channel: "INSTAGRAM", recipientId: `bf-${runId}-exp`, propertyId: propertyA, shortId: propertyAShort, kind: "PHOTO" },
  });
  // Диалог, пришедший с рекламы объекта Б.
  adConv = (
    await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: `bf-${runId}-ad`, messages: [], adPropertyId: propertyB } })
  ).id;
  // Диалог, которому показали два объекта: вопрос в нём приписать нельзя.
  twoObjectsConv = (await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `bf-${runId}-two`, messages: [] } })).id;
  await prisma.propertyExposure.createMany({
    data: [
      { channel: "INSTAGRAM", recipientId: `bf-${runId}-two`, propertyId: propertyA, shortId: propertyAShort, kind: "LINK" },
      { channel: "INSTAGRAM", recipientId: `bf-${runId}-two`, propertyId: propertyB, shortId: propertyAShort + 1, kind: "LINK" },
    ],
  });
  conversationIds.push(exposureConv, adConv, twoObjectsConv);
  // Вопрос, заданный ДО того, как объект появился в диалоге: ему объект не принадлежит (как в бою).
  questionBeforeLink = (
    await prisma.ownerQuestion.create({
      data: { conversationId: exposureConv, question: "Это раньше?", askedAt: new Date(Date.now() - 3600_000) },
    })
  ).id;
  questionOneObject = (await prisma.ownerQuestion.create({ data: { conversationId: exposureConv, question: "Торг?" } })).id;
  questionTwoObjects = (await prisma.ownerQuestion.create({ data: { conversationId: twoObjectsConv, question: "Мебель?" } })).id;

  commentId = (
    await prisma.instagramComment.create({
      data: { commentId: `bf-c-${runId}`, mediaId: `bf-media-${runId}`, authorId: "a", text: "Нарх?", replyDueAt: new Date(), status: "SKIPPED" },
    })
  ).id;

  // Звонки: продавцу с единственным объектом — объект; покупателю без доказательств — null.
  sellerClientId = (
    await prisma.client.create({
      data: { fullName: `Продавец добора ${runId}`, phone: `+992960${runId.slice(-6)}`, source: "PHONE_CALL", kind: "SELLER", assignedAgentId: agentId },
    })
  ).id;
  sellerPropertyId = (await makeProperty("Объект продавца", { sellerClientId })).id;
  buyerClientId = (
    await prisma.client.create({
      data: { fullName: `Покупатель добора ${runId}`, phone: `+992961${runId.slice(-6)}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
  callSellerAnalysisId = await makeCall(sellerClientId);
  callBuyerAnalysisId = await makeCall(buyerClientId);
  const matchedBuyer = await prisma.client.create({
    data: {
      fullName: `Покупатель с объектом ${runId}`,
      phone: `+992962${runId.slice(-6)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      matchedPropertyId: propertyB,
    },
  });
  callUnknownAnalysisId = await makeCall(matchedBuyer.id);
  callWithPropertyAnalysisId = await makeCall(matchedBuyer.id, propertyA);
  buyerClientId = `${buyerClientId},${matchedBuyer.id}`;
});

afterAll(async () => {
  const clients = [sellerClientId, ...buyerClientId.split(",")].filter(Boolean);
  await prisma.callAnalysis.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.instagramComment.deleteMany({ where: { id: commentId } });
  await prisma.ownerQuestion.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.propertyExposure.deleteMany({ where: { recipientId: { startsWith: `bf-${runId}` } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyA, propertyB, sellerPropertyId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("добор «голоса рынка» по старым данным", () => {
  it("по умолчанию только считает: в базе ничего не меняется", async () => {
    const dry = await backfillPropertyVoice({ apply: false });
    expect(dry.apply).toBe(false);
    expect(dry.conversationLinks).toBeGreaterThanOrEqual(4); // показ А, реклама Б, два показа в диалоге «два объекта»
    expect(dry.conversationLinksBySource.EXPOSURE).toBeGreaterThanOrEqual(3);
    expect(dry.conversationLinksBySource.AD_REFERRAL).toBeGreaterThanOrEqual(1);
    expect(dry.ownerQuestions).toBeGreaterThanOrEqual(1);
    expect(dry.comments).toBeGreaterThanOrEqual(1);
    expect(dry.callAnalyses).toBeGreaterThanOrEqual(1);

    expect(await prisma.conversationProperty.count({ where: { conversationId: { in: conversationIds } } })).toBe(0);
    expect((await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: questionOneObject } })).propertyId).toBeNull();
    expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: commentId } })).propertyId).toBeNull();
    expect((await prisma.callAnalysis.findUniqueOrThrow({ where: { id: callSellerAnalysisId } })).propertyId).toBeNull();
  });

  it("--apply строит связи и проставляет объект только по доказанному", async () => {
    const dryBefore = await backfillPropertyVoice({ apply: false });
    const applied = await backfillPropertyVoice({ apply: true });
    expect(applied.conversationLinks).toBeGreaterThanOrEqual(4);
    expect(dryBefore.conversationLinks).toBeGreaterThanOrEqual(4);

    const links = await prisma.conversationProperty.findMany({ where: { conversationId: { in: conversationIds } } });
    expect(links).toHaveLength(4);
    expect(links.find((l) => l.conversationId === exposureConv)).toMatchObject({ propertyId: propertyA, source: "EXPOSURE", hits: 1 });
    expect(links.find((l) => l.conversationId === adConv)).toMatchObject({ propertyId: propertyB, source: "AD_REFERRAL" });

    // Вопрос в диалоге с одним объектом получил его; в диалоге с двумя — остался пустым.
    expect((await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: questionOneObject } })).propertyId).toBe(propertyA);
    expect((await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: questionTwoObjects } })).propertyId).toBeNull();

    // Комментарий под публикацией объекта А.
    expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: commentId } })).propertyId).toBe(propertyA);

    // Вопрос, заданный раньше появления объекта в диалоге, объект не получает.
    expect((await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: questionBeforeLink } })).propertyId).toBeNull();

    // Звонки: только объект, прямо указанный в записи звонка. Сегодняшнее состояние клиента
    // (единственный объект продавца, причина назначения лида) для старого звонка не доказательство.
    expect((await prisma.callAnalysis.findUniqueOrThrow({ where: { id: callWithPropertyAnalysisId } })).propertyId).toBe(propertyA);
    expect((await prisma.callAnalysis.findUniqueOrThrow({ where: { id: callSellerAnalysisId } })).propertyId).toBeNull();
    expect((await prisma.callAnalysis.findUniqueOrThrow({ where: { id: callUnknownAnalysisId } })).propertyId).toBeNull();
    expect((await prisma.callAnalysis.findUniqueOrThrow({ where: { id: callBuyerAnalysisId } })).propertyId).toBeNull();
  });

  it("повторная запись идемпотентна: наши строки не двоятся и не меняются", async () => {
    const snapshot = async () =>
      JSON.stringify(
        await prisma.conversationProperty.findMany({
          where: { conversationId: { in: conversationIds } },
          orderBy: [{ conversationId: "asc" }, { propertyId: "asc" }],
        })
      );
    const before = await snapshot();
    await backfillPropertyVoice({ apply: true });
    await backfillPropertyVoice({ apply: true });
    // Общий счётчик по базе здесь не сверяем — соседние тесты пишут в ту же базу, —
    // но строки этого теста (в том числе hits и время) остаются байт в байт.
    expect(await snapshot()).toBe(before);
    expect((await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: questionOneObject } })).propertyId).toBe(propertyA);
    expect((await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: questionTwoObjects } })).propertyId).toBeNull();
  });
});
