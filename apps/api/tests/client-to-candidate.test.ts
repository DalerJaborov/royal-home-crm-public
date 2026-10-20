import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { convertClientToJobApplication } from "../src/lib/clientToCandidate.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * «В КАНДИДАТЫ» — разгребание того, что уже случилось на проде (17.09.2026).
 *
 * Клиенты 302 (Шоира), 315 (Азиза), 319 (Томирис) пришли с рекламы вакансии, а
 * CRM завела их ПОКУПАТЕЛЯМИ с назначенным агентом: автоматика такие карточки не
 * трогает — кандидатом их признал живой человек по телефону. Поэтому перевод
 * обязан работать для BUYER/SELLER с агентом, а не только для OTHER.
 */

const runId = Date.now();
/** Телефон уникален в базе — свой номер на каждый случай, иначе второй seed падает. */
const PHONE_SUFFIX: Record<string, string> = { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7", h: "8" };
const clientIds: string[] = [];
const conversationIds: string[] = [];
/** Свои агенты: держатель карточки и тот, кто нажимает кнопку. См. helpers/ownAgent.ts. */
const agentIds: string[] = [];

async function ownAgents(): Promise<{ holderId: string; actorId: string }> {
  if (agentIds.length === 0) {
    agentIds.push(await createTestAgent(`Перевод-держатель ${runId}`));
    agentIds.push(await createTestAgent(`Перевод-нажал ${runId}`));
  }
  return { holderId: agentIds[0], actorId: agentIds[1] };
}

const tgDirectIds: string[] = [];
const profileIds: string[] = [];
const propertyIds: string[] = [];
let districtId: string | null = null;

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.jobApplication.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.telegramDirectConversation.deleteMany({ where: { id: { in: tgDirectIds } } });
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.jobApplication.deleteMany({ where: { name: { startsWith: `Кандидат-перевод ${runId}` } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds } } });
  await deleteAgentsWithTraces(agentIds);
});

async function seedBuyerWithAgent(tag: string, withConversation: boolean) {
  const { holderId } = await ownAgents();
  const client = await prisma.client.create({
    data: {
      fullName: `Кандидат-перевод ${runId} ${tag}`,
      phone: `+9929${String(runId).slice(-7)}${PHONE_SUFFIX[tag]}`,
      source: "WHATSAPP",
      kind: "BUYER",
      currency: "TJS",
      requirementsNotes: "3 хона, Сино",
      assignedAgentId: holderId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  if (withConversation) {
    const conversationId = `to-candidate-${runId}-${tag}`;
    conversationIds.push(conversationId);
    await prisma.botConversation.create({
      data: {
        id: conversationId,
        channel: "WHATSAPP",
        subscriberId: `to-candidate-sub-${runId}-${tag}`,
        name: "Профиль WhatsApp",
        clientId: client.id,
        lastMessageAt: new Date(),
        messages: [
          { role: "user", content: "Привет! Можно узнать об этом подробнее?" },
          { role: "assistant", content: "Здравствуйте! Что вас интересует?" },
          {
            role: "user",
            content: "Ман барои кор омадам",
            attachments: [{ kind: "file", file: "cv-2026.pdf", mime: "application/pdf" }],
          },
        ],
      },
    });
  }
  return { client, agentId: holderId };
}

describe("перевод клиента в кандидаты", () => {
  it("BUYER с агентом: анкета создана, агент снят, карточка в Корзине", async () => {
    const { client, agentId } = await seedBuyerWithAgent("a", true);
    const { actorId } = await ownAgents();

    const result = await convertClientToJobApplication({ clientId: client.id, actorId });
    expect(result.ok).toBe(true);

    const app = await prisma.jobApplication.findUnique({
      where: { conversationId: `to-candidate-${runId}-a` },
    });
    expect(app).not.toBeNull();
    expect(app?.name).toBe(client.fullName);
    expect(app?.phone).toBe(client.phone);
    // Резюме — последний присланный файл, тем же правилом, что у бота.
    expect(app?.cvFile).toBe("cv-2026.pdf");
    // Рассказ о себе: требования карточки плюс слова клиента из переписки.
    expect(app?.rawText).toContain("барои кор");

    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBeNull();
    expect(after?.kind).toBe("OTHER");
    expect(after?.deletedAt).not.toBeNull();
    // Кто вёл — сохранено, вернуть карточку из Корзины будет к кому.
    expect(after?.lastAgentId).toBe(agentId);

    // Событие в хронологии подписано ТЕМ, КТО НАЖАЛ, а не дежурным директором.
    const events = await prisma.interaction.findMany({ where: { clientId: client.id } });
    const moved = events.find((e) => e.notes.startsWith("Обращение переведено в кандидаты"));
    expect(moved).toBeDefined();
    expect(moved?.agentId).toBe(actorId);
  });

  it("переписки нет — анкета всё равно заводится, без диалога", async () => {
    const { client, agentId } = await seedBuyerWithAgent("b", false);
    const result = await convertClientToJobApplication({ clientId: client.id, actorId: agentId });
    expect(result.ok).toBe(true);
    const app = await prisma.jobApplication.findFirst({ where: { name: client.fullName } });
    expect(app?.conversationId).toBeNull();
    expect(app?.phone).toBe(client.phone);
  });

  it("карточки нет — 404, а не падение", async () => {
    const { actorId } = await ownAgents();
    const result = await convertClientToJobApplication({
      clientId: "00000000-0000-0000-0000-000000000000",
      actorId,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("карточка уже в Корзине — переводить нечего", async () => {
    const { client, agentId } = await seedBuyerWithAgent("c", false);
    await prisma.client.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
    const result = await convertClientToJobApplication({ clientId: client.id, actorId: agentId });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

async function makeProperty(sellerClientId: string | null) {
  if (!districtId) {
    districtId = (await prisma.district.create({ data: { name: `Тест-район-в-кандидаты-${runId}` } })).id;
  }
  const p = await prisma.property.create({
    data: {
      title: `Объект перевода в кандидаты ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, перевод в кандидаты",
      condition: "GOOD",
      sellerClientId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

/**
 * Разбор 02.10.2026: отказ trashClient (открытая сделка, объекты продавца)
 * приходил ПОСЛЕ того, как анкета создана и агент снят. Клиент со сделкой
 * оставался без агента, а каждое повторное нажатие плодило ещё одну анкету.
 */
describe("перевод в кандидаты: отказ — ничего не изменено", () => {
  it("открытая сделка — 409, анкеты нет, агент на месте, карточка не тронута", async () => {
    const { client, agentId } = await seedBuyerWithAgent("d", true);
    const property = await makeProperty(null);
    await prisma.deal.create({ data: { clientId: client.id, propertyId: property.id, agentId, stage: "NEGOTIATION" } });
    const { actorId } = await ownAgents();

    const first = await convertClientToJobApplication({ clientId: client.id, actorId });
    const second = await convertClientToJobApplication({ clientId: client.id, actorId });
    expect(first).toMatchObject({ ok: false, status: 409 });
    expect(second).toMatchObject({ ok: false, status: 409 });

    expect(await prisma.jobApplication.count({ where: { conversationId: `to-candidate-${runId}-d` } })).toBe(0);
    expect(await prisma.jobApplication.count({ where: { clientId: client.id } })).toBe(0);
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.kind).toBe("BUYER");
    expect(after?.acceptedAt).not.toBeNull();
    expect(after?.deletedAt).toBeNull();
  });

  it("у продавца объект в работе — 409 и ничего не изменено (без переписки тоже)", async () => {
    const { client, agentId } = await seedBuyerWithAgent("e", false);
    await makeProperty(client.id);
    const { actorId } = await ownAgents();

    const result = await convertClientToJobApplication({ clientId: client.id, actorId });
    expect(result).toMatchObject({ ok: false, status: 409 });
    await convertClientToJobApplication({ clientId: client.id, actorId });

    expect(await prisma.jobApplication.count({ where: { name: client.fullName } })).toBe(0);
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.deletedAt).toBeNull();
  });
});

describe("перевод в кандидаты: анкету бота дополняет, а не затирает", () => {
  it("имя, номер, канал, рассказ бота остаются; clientId, досье и статус NEW проставлены", async () => {
    const { client, agentId } = await seedBuyerWithAgent("f", true);
    const conversationId = `to-candidate-${runId}-f`;
    // Карточка с запасным именем — так её и заводит бот в мессенджере.
    await prisma.client.update({
      where: { id: client.id },
      data: { fullName: "Клиент WhatsApp", reactivationOfferedToAgentId: agentId, reactivationOfferedAt: new Date() },
    });
    const profile = await prisma.contactProfile.create({ data: { displayName: "Фарход", language: "tg" } });
    profileIds.push(profile.id);
    await prisma.botConversation.update({ where: { id: conversationId }, data: { contactProfileId: profile.id } });
    // Анкету бот уже собрал, а пересчёт отбора спрятал её как «не кандидат».
    await prisma.jobApplication.create({
      data: {
        conversationId,
        channel: "INSTAGRAM",
        name: "Фарход Каримов",
        phone: "+992931112233",
        rawText: "Опыт продаж 3 года, 27 лет",
        status: "NOT_CANDIDATE",
      },
    });
    const { actorId } = await ownAgents();

    const result = await convertClientToJobApplication({ clientId: client.id, actorId });
    expect(result.ok).toBe(true);

    const app = await prisma.jobApplication.findUnique({ where: { conversationId } });
    expect(app?.name).toBe("Фарход Каримов");
    expect(app?.phone).toBe("+992931112233");
    expect(app?.channel).toBe("INSTAGRAM");
    expect(app?.rawText?.startsWith("Опыт продаж 3 года, 27 лет")).toBe(true);
    expect(app?.rawText).toContain("барои кор");
    expect(app?.cvFile).toBe("cv-2026.pdf");
    expect(app?.clientId).toBe(client.id);
    expect(app?.contactProfileId).toBe(profile.id);
    expect(app?.status).toBe("NEW");

    // Предложение реактивации прежнему агенту погашено вместе с лидом.
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.reactivationOfferedToAgentId).toBeNull();
    expect(after?.reactivationOfferedAt).toBeNull();
  });

  it("без переписки: анкета по этой карточке уже есть — вторую не заводит", async () => {
    const { client } = await seedBuyerWithAgent("g", false);
    await prisma.jobApplication.create({
      data: { channel: "WHATSAPP", clientId: client.id, name: "Гулнора", status: "NEW" },
    });
    const { actorId } = await ownAgents();

    const result = await convertClientToJobApplication({ clientId: client.id, actorId });
    expect(result.ok).toBe(true);
    const apps = await prisma.jobApplication.findMany({ where: { clientId: client.id } });
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Гулнора");
    expect(apps[0].phone).toBe(client.phone);
  });

  it("личные сообщения Telegram — канал TELEGRAM_DIRECT, запасное имя карточки в анкету не идёт", async () => {
    const { client } = await seedBuyerWithAgent("h", false);
    await prisma.client.update({ where: { id: client.id }, data: { fullName: "Клиент Telegram" } });
    const tgd = await prisma.telegramDirectConversation.create({
      data: {
        chatId: `tgd-chat-${runId}`,
        topicId: `tgd-topic-${runId}`,
        username: "farhod_tg",
        clientId: client.id,
        lastMessageAt: new Date(),
        messages: [{ role: "user", content: "Ищу работу агентом" }],
      },
    });
    tgDirectIds.push(tgd.id);
    const { actorId } = await ownAgents();

    const result = await convertClientToJobApplication({ clientId: client.id, actorId });
    expect(result.ok).toBe(true);
    const app = await prisma.jobApplication.findUnique({ where: { conversationId: tgd.id } });
    expect(app?.channel).toBe("TELEGRAM_DIRECT");
    expect(app?.name).toBeNull();
    expect(app?.contactName).toBe("farhod_tg");
  });
});
