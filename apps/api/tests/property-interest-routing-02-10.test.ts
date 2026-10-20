import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { assignAgentForLead, createLeadFromChannel } from "../src/leads.js";
import { recordPageInterest } from "../src/messengers/sharedMedia.js";
import { noticeInterestInOtherAgentProperty } from "../src/lib/propertyInterestNotice.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ЛЮБОЙ ИНТЕРЕС К ОБЪЕКТУ — АГЕНТУ ОБЪЕКТА (Dan, 02.10.2026: «любой пересланный пост
 * или скриншот или любой интерес… должна распознаваться и своему агенту идти»).
 *
 * Три дыры из прохода по каналам:
 *  1. Клиент переслал наш объект, бот предложил похожие — лид уходил агенту
 *     последнего ПОКАЗАННОГО, а не присланного клиентом.
 *  2. Посетитель пишет в чат сайта со страницы объекта — страница шла модели
 *     подсказкой, раздача о ней не знала.
 *  3. Клиент вернулся из «Неактивных» по конкретному объекту — раздача звала
 *     голую очередь, объект терялся.
 */

const phone = () => `+99297${randomInt(1_000_000, 9_999_999)}`;
const runId = Date.now().toString(36) + randomInt(1000, 9999).toString(36);
let sharedOwner = "";
let shownOwner = "";
let firedId = "";
let sharedPropertyId = "";
let shownPropertyId = "";
const clientIds: string[] = [];
let savedSettings: { leadDistributionStrategy: string; ownPropertyShownExceptionEnabled: boolean } | null = null;

async function makeProperty(agentId: string) {
  return prisma.property.create({
    data: {
      title: `Тест-интерес-${runId}`,
      type: "APARTMENT",
      address: "Тестовая, 4",
      condition: "GOOD",
      currency: "TJS",
      areaSqm: 60,
      price: 300_000 + randomInt(1, 9999),
      rooms: 2,
      intakeAgentId: agentId,
    },
  });
}

beforeAll(async () => {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { leadDistributionStrategy: true, ownPropertyShownExceptionEnabled: true },
  });
  savedSettings = s;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", leadDistributionStrategy: "round_robin", ownPropertyShownExceptionEnabled: true },
    update: {
      ...(s?.leadDistributionStrategy === "manual" ? { leadDistributionStrategy: "round_robin" } : {}),
      ownPropertyShownExceptionEnabled: true,
    },
  });
  sharedOwner = await createTestAgent("Агент присланного объекта");
  shownOwner = await createTestAgent("Агент показанного объекта");
  firedId = await createTestAgent("Уволенный агент");
  await prisma.agent.update({ where: { id: firedId }, data: { isActive: false } });
  sharedPropertyId = (await makeProperty(sharedOwner)).id;
  shownPropertyId = (await makeProperty(shownOwner)).id;
});

afterAll(async () => {
  const ids = [sharedPropertyId, shownPropertyId].filter(Boolean);
  await prisma.propertyExposure.deleteMany({ where: { propertyId: { in: ids } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await deleteAgentsWithTraces([sharedOwner, shownOwner, firedId]);
});

describe("присланное клиентом важнее показанного ботом", () => {
  it("клиент переслал объект, бот следом показал другой — лид агенту присланного", async () => {
    const recipientId = `ig-${runId}-a`;
    const shortIds = await prisma.property.findMany({
      where: { id: { in: [sharedPropertyId, shownPropertyId] } },
      select: { id: true, shortId: true },
    });
    const short = (id: string) => shortIds.find((p) => p.id === id)!.shortId;
    await prisma.propertyExposure.create({
      data: {
        channel: "INSTAGRAM",
        recipientId,
        propertyId: sharedPropertyId,
        shortId: short(sharedPropertyId),
        kind: "CLIENT_SHARED",
        sentAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.propertyExposure.create({
      data: { channel: "INSTAGRAM", recipientId, propertyId: shownPropertyId, shortId: short(shownPropertyId), kind: "PHOTO" },
    });
    const result = await assignAgentForLead({ channel: "INSTAGRAM", recipientId });
    expect(result.reason).toBe("own_property_shown");
    expect(result.agentId).toBe(sharedOwner);
  });

  it("только показанное ботом — по-прежнему агенту показанного", async () => {
    const recipientId = `ig-${runId}-b`;
    const p = await prisma.property.findUniqueOrThrow({ where: { id: shownPropertyId }, select: { shortId: true } });
    await prisma.propertyExposure.create({
      data: { channel: "INSTAGRAM", recipientId, propertyId: shownPropertyId, shortId: p.shortId, kind: "PHOTO" },
    });
    expect((await assignAgentForLead({ channel: "INSTAGRAM", recipientId })).agentId).toBe(shownOwner);
  });
});

describe("чат сайта со страницы объекта", () => {
  it("страница карточки записывает интерес — раздача отдаёт лид агенту объекта", async () => {
    const sessionId = `web-${runId}`;
    await recordPageInterest(`https://royalhome.tj/listing/by-crm/${sharedPropertyId}`, "WEBSITE", sessionId);
    const exposure = await prisma.propertyExposure.findFirst({
      where: { channel: "WEBSITE", recipientId: sessionId, propertyId: sharedPropertyId, kind: "CLIENT_SHARED" },
    });
    expect(exposure).not.toBeNull();
    expect((await assignAgentForLead({ channel: "WEBSITE", recipientId: sessionId })).agentId).toBe(sharedOwner);
  });

  it("страница без объекта — ничего не пишет", async () => {
    const sessionId = `web-${runId}-none`;
    await recordPageInterest("https://royalhome.tj/about", "WEBSITE", sessionId);
    await recordPageInterest(undefined, "WEBSITE", sessionId);
    expect(await prisma.propertyExposure.count({ where: { channel: "WEBSITE", recipientId: sessionId } })).toBe(0);
  });
});

describe("вернувшийся клиент — к агенту объекта, а не первому по очереди", () => {
  it("возврат из «Неактивных» с названным объектом — агенту объекта", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Вернулся по объекту ${runId}`,
        phone: phone(),
        source: "INSTAGRAM",
        kind: "BUYER",
        status: "CONTACTED",
        workStatus: "INACTIVE",
        assignedAgentId: firedId,
        lastAgentId: firedId,
        assignedAt: new Date(Date.now() - 30 * 86_400_000),
        acceptedAt: new Date(Date.now() - 30 * 86_400_000),
      },
    });
    clientIds.push(c.id);
    await createLeadFromChannel({
      fullName: c.fullName,
      phone: c.phone,
      source: "INSTAGRAM",
      kind: "BUYER",
      propertyId: sharedPropertyId,
    });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.workStatus).toBe("ACTIVE");
    expect(after.assignedAgentId).toBe(sharedOwner);
  });
});

describe("клиент агента А интересуется объектом агента Б — сообщить обоим", () => {
  async function clientOf(agentId: string) {
    const c = await prisma.client.create({
      data: { fullName: `Закреплённый ${runId}`, phone: phone(), source: "INSTAGRAM", kind: "BUYER", assignedAgentId: agentId, acceptedAt: new Date() },
    });
    clientIds.push(c.id);
    return c;
  }
  const notes = (clientId: string) =>
    prisma.interaction.findMany({ where: { clientId, propertyId: sharedPropertyId, subjectAgentId: sharedOwner } });

  it("карточка остаётся у А, в хронологии запись для агента объекта — один раз в сутки", async () => {
    const c = await clientOf(shownOwner);
    await noticeInterestInOtherAgentProperty({ clientId: c.id, propertyId: sharedPropertyId });
    await noticeInterestInOtherAgentProperty({ clientId: c.id, propertyId: sharedPropertyId });
    expect(await notes(c.id)).toHaveLength(1);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(shownOwner);
  });

  it("клиент уже у агента объекта — ничего не шлём", async () => {
    const c = await clientOf(sharedOwner);
    await noticeInterestInOtherAgentProperty({ clientId: c.id, propertyId: sharedPropertyId });
    expect(await prisma.interaction.count({ where: { clientId: c.id } })).toBe(0);
  });
});
