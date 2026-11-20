import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * ЭСТАФЕТА ВМЕСТО ВЕЧНОЙ ПАУЗЫ (владелец 20.11.2026; lib/conversationDelivery.ts::staffRelayPauseMs). Разбор каналов 20.11:
 * 41 из 128 активных чатов стояли на паузе «10 лет» после первого же ответа сотрудника, 19 клиентов ждали человека 15–67 часов.
 * В режиме «только заявки» ответ сотрудника глушит бота на N минут из Настроек, вне режима — как было.
 */
const config = { enabled: true, repliesAfterLead: true, staffQuietMinutes: 180 };
vi.mock("../src/lib/leadOnlyConfig.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/leadOnlyConfig.js")>();
  return { ...actual, loadLeadOnlyConfig: async () => ({ ...(await actual.loadLeadOnlyConfig()), ...config }) };
});
const { staffRelayPauseMs } = await import("../src/lib/conversationDelivery.js");

const ids: string[] = [];
async function conversation(channel: string): Promise<string> {
  const row = await prisma.botConversation.create({ data: { channel, subscriberId: `relay-${channel}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } });
  ids.push(row.id);
  return row.id;
}
afterAll(async () => { await prisma.botConversation.deleteMany({ where: { id: { in: ids } } }); });

describe("эстафета: сотрудник ответил — бот уступает N минут, а не 10 лет", () => {
  it("WhatsApp, Instagram, Facebook в режиме «только заявки» — N минут из Настроек", async () => {
    for (const channel of ["WHATSAPP", "INSTAGRAM", "FACEBOOK"]) {
      expect(await staffRelayPauseMs({ kind: "bot", id: await conversation(channel) }), channel).toBe(180 * 60_000);
    }
  });
  it("сайт и Telegram, выключенный режим — прежняя пауза (null); выключатель «после заявки» эстафету не трогает", async () => {
    expect(await staffRelayPauseMs({ kind: "bot", id: await conversation("WEBSITE") })).toBeNull();
    expect(await staffRelayPauseMs({ kind: "telegram", id: "x" })).toBeNull();
    config.enabled = false;
    expect(await staffRelayPauseMs({ kind: "bot", id: await conversation("WHATSAPP") })).toBeNull();
    // Выключатель «Бот отвечает и после заявки» эстафетой не управляет (два разных смысла, ревью #333).
    config.enabled = true; config.repliesAfterLead = false;
    expect(await staffRelayPauseMs({ kind: "bot", id: await conversation("WHATSAPP") })).toBe(180 * 60_000);
    config.repliesAfterLead = true;
  });
});

describe("проверяющий из Настроек — одна дверь acceptLead (ревью #333: сторож лидов обходил защиту)", () => {
  it("номер проверяющего: приём не заводит карточку и отвечает «проверяющий», без тревоги; обычный номер — как прежде", async () => {
    const { acceptLead } = await import("../src/messengers/conversation.js");
    const before = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botReviewerPhones: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { botReviewerPhones: ["992900000077"] } });
    try {
      const id = await conversation("WHATSAPP");
      const result = await acceptLead(id, "WHATSAPP", undefined, "+992 90 000 00 77", { stage: "chatting", intent: "buy", confident: true } as never, [],
        { silent: true, fromHistory: true, clientText: "+992 90 000 00 77" });
      expect(result).toMatchObject({ accepted: false, reviewer: true });
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { clientId: true } })).clientId).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { botReviewerPhones: before.botReviewerPhones } });
    }
  });
});
