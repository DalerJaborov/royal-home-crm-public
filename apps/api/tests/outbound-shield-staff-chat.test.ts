import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { admitOutbound, isLinkedStaffChat, resetOutboundShieldCache, MAX_MESSAGES_WITHOUT_INBOUND } from "../src/lib/outboundShield.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Журнал прода 17.11.2026: «Щит исходящих не выпустил» весть хозяину об
 * автопубликации ролика (telegram/clipReviewBot.ts) и кнопки озвучки. Чат
 * сотрудника когда-то писал боту как клиент — у щита осталось его
 * состояние, и служебные сообщения копили «монолог» до паузы.
 *
 * Правка: чат, привязанный к действующей учётке, щит клиентских диалогов не
 * трогает, сколько бы служебных сообщений подряд ему ни ушло. Клиентский чат
 * в том же положении по-прежнему останавливается (контроль ниже).
 */
const runId = Date.now().toString().slice(-9);
const staffChat = `77${runId}`;
const clientChat = `78${runId}`;
let agentId = "";

async function seedMonologueState(chatId: string): Promise<void> {
  await prisma.outboundShieldState.deleteMany({ where: { channel: "TELEGRAM", subscriberId: chatId } });
  await prisma.outboundShieldState.create({
    data: {
      channel: "TELEGRAM",
      subscriberId: chatId,
      lastInboundAt: new Date(Date.now() - 30 * 86_400_000),
      botSentSinceInbound: MAX_MESSAGES_WITHOUT_INBOUND,
    },
  });
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Shield staff chat ${runId}`, phone: `+99293${runId}`, role: "AGENT", passwordHash: "x", telegramChatId: staffChat },
  });
  agentId = agent.id;
  await seedMonologueState(staffChat);
  await seedMonologueState(clientChat);
  resetOutboundShieldCache();
});

afterAll(async () => {
  await prisma.outboundShieldState.deleteMany({ where: { channel: "TELEGRAM", subscriberId: { in: [staffChat, clientChat] } } });
  if (agentId) await deleteAgentsWithTraces([agentId]);
});

describe("щит исходящих не режет служебные сообщения сотруднику", () => {
  it("пять служебных сообщений подряд в привязанный чат сотрудника уходят все", async () => {
    for (let i = 0; i < 5; i++) {
      const verdict = await admitOutbound({
        channel: "TELEGRAM",
        subscriberId: staffChat,
        text: `✅ Ролик объекта №${i} опубликован сам`,
        onlyIfKnown: true,
      });
      expect(verdict.allowed, `сообщение ${i + 1}`).toBe(true);
    }
    const state = await prisma.outboundShieldState.findFirst({ where: { channel: "TELEGRAM", subscriberId: staffChat } });
    // Служебные сообщения в счётчик монолога не попадают.
    expect(state?.botSentSinceInbound).toBe(MAX_MESSAGES_WITHOUT_INBOUND);
  });

  it("клиентский чат в том же положении щит по-прежнему останавливает", async () => {
    const verdict = await admitOutbound({
      channel: "TELEGRAM",
      subscriberId: clientChat,
      text: "Напоминаем о подборке",
      onlyIfKnown: true,
    });
    expect(verdict.allowed).toBe(false);
  });

  it("уволенный сотрудник — уже не служебный чат; Direct Messages канала — всегда клиенты", async () => {
    expect(await isLinkedStaffChat("TELEGRAM", staffChat)).toBe(true);
    expect(await isLinkedStaffChat("TELEGRAM", `${staffChat}:15`)).toBe(false);
    expect(await isLinkedStaffChat("WHATSAPP", staffChat)).toBe(false);
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    try {
      expect(await isLinkedStaffChat("TELEGRAM", staffChat)).toBe(false);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
    }
  });
});
