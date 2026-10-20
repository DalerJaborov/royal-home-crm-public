import { deactivateClient } from "../src/lib/clientWorkStatus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { runSilentClientAutoDeactivate } from "../src/lib/silentClientAutoDeactivate.js";

/**
 * «МОЛЧАЛИВЫЙ» КЛИЕНТ УХОДИТ В НЕАКТИВНЫЕ САМ — НО НЕ ТОТ, С КЕМ ПОГОВОРИЛИ
 * (19.09.2026, жалоба владельца: «с клиентом, с которым поговорили, всё равно
 * стоит плашка неактивный»).
 *
 * Крон считал молчанием тишину ИМЕННО В ПЕРЕПИСКЕ С БОТОМ и звонки не смотрел
 * вовсе. Агент дозванивался, разговаривал, назначал показ — а карточка через
 * пять дней всё равно уезжала в Неактивные, и агент узнавал об этом, наткнувшись
 * на плашку. Тест закрывает обе стороны: настоящий молчун уезжает, тот, с кем
 * был разговор или показ, остаётся в работе.
 */

const runId = Date.now();
const clientIds: string[] = [];
let agentId: string;

const DAY = 86_400_000;
const now = new Date();
/** Заведомо больше любого silentClientInactiveDays по умолчанию (5 дней). */
const longAgo = new Date(now.getTime() - 30 * DAY);
const yesterday = new Date(now.getTime() - DAY);

async function makeSilentClient(suffix: string) {
  const client = await prisma.client.create({
    data: {
      fullName: `Молчун ${runId}-${suffix}`,
      phone: `+99298${String(runId).slice(-7)}${suffix}`,
      source: "INSTAGRAM",
      acceptedAt: longAgo,
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
      status: "CONTACTED",
      lastClientMessageAt: longAgo,
    },
  });
  clientIds.push(client.id);
  await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `silent-${runId}-${suffix}`,
      clientId: client.id,
      // Последнее слово — наше, и сказано давно: ровно тот признак молчания,
      // который ищет крон (см. freshestLastWord).
      messages: [
        {
          role: "assistant",
          content: "Подскажите, актуально ли ещё?",
          at: longAgo.toISOString(),
        },
      ] as never,
      lastMessageAt: longAgo,
    },
  });
  return client;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: {
        fullName: `Агент молчунов ${runId}`,
        phone: `+992963${runId}`.slice(0, 13),
        role: "AGENT",
        passwordHash: "x",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({
    where: { subscriberId: { startsWith: `silent-${runId}` } },
  });
  await prisma.property.deleteMany({
    where: { sellerClientId: { in: clientIds } },
  });
  await prisma.interaction.deleteMany({
    where: { clientId: { in: clientIds } },
  });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Автоперевод молчаливых клиентов в Неактивные", () => {
  it("клиент, который молчит везде, уезжает в Неактивные", async () => {
    const client = await makeSilentClient("1");

    await runSilentClientAutoDeactivate(now);

    const after = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(after.workStatus).toBe("INACTIVE");
  });

  it("клиент, с которым вчера состоялся разговор, остаётся в работе", async () => {
    const client = await makeSilentClient("2");
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        outcome: "POSITIVE",
        notes: "Поговорили, готов смотреть",
        createdAt: yesterday,
      },
    });

    await runSilentClientAutoDeactivate(now);

    const after = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(after.workStatus).toBe("ACTIVE");
  });

  it("клиент, которому вчера назначили показ, остаётся в работе", async () => {
    const client = await makeSilentClient("3");
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "SHOWING",
        notes: "Показ квартиры",
        createdAt: yesterday,
      },
    });

    await runSilentClientAutoDeactivate(now);

    const after = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(after.workStatus).toBe("ACTIVE");
  });

  it("недозвон разговором не считается — клиент всё равно уезжает в Неактивные", async () => {
    const client = await makeSilentClient("4");
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        outcome: "NO_ANSWER",
        notes: "Не берёт трубку",
        createdAt: yesterday,
      },
    });

    await runSilentClientAutoDeactivate(now);

    const after = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(after.workStatus).toBe("INACTIVE");
  });
});

describe("Продавец с объектом в работе не «молчит» (владелец 23.09.2026)", () => {
  it("продавец, чей объект в продаже, остаётся в работе", async () => {
    const client = await makeSilentClient("7");
    await prisma.client.update({
      where: { id: client.id },
      data: { kind: "SELLER" },
    });
    await prisma.property.create({
      data: {
        title: `Объект молчуна ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 300000,
        condition: "GOOD",
        status: "AVAILABLE",
        sellerClientId: client.id,
      },
    });
    await runSilentClientAutoDeactivate(now);
    const after = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(after.workStatus).toBe("ACTIVE");
  });

  it("deactivateClient (ИИ, недозвоны) продавца с объектом в работе не переводит", async () => {
    const client = await makeSilentClient("8");
    await prisma.client.update({
      where: { id: client.id },
      data: { kind: "SELLER" },
    });
    await prisma.property.create({
      data: {
        title: `Объект на монтаже ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 300000,
        condition: "GOOD",
        status: "EDITING",
        sellerClientId: client.id,
      },
    });
    const res = await deactivateClient({
      clientId: client.id,
      reason: "STOPPED_RESPONDING",
      initiator: "CLIENT",
      actualNeeds: "—",
      actor: { kind: "system", source: "test" },
    } as never);
    expect(res.ok).toBe(false);
    const after = await prisma.client.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(after.workStatus).toBe("ACTIVE");
  });
});
