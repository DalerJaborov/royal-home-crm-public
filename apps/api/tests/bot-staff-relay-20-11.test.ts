import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * ЭСТАФЕТА ВМЕСТО ВЕЧНОЙ ПАУЗЫ (владелец 20.11.2026; lib/conversationDelivery.ts::staffRelayPauseMs). Разбор каналов 20.11:
 * 41 из 128 активных чатов стояли на паузе «10 лет» после первого же ответа сотрудника, 19 клиентов ждали человека 15–67 часов.
 * В режиме «только заявки» ответ сотрудника глушит бота на N минут из Настроек, вне режима — как было.
 */
const config = { enabled: true, repliesAfterLead: true, staffQuietMinutes: 30 };
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
      expect(await staffRelayPauseMs({ kind: "bot", id: await conversation(channel) }), channel).toBe(30 * 60_000);
    }
  });
  it("сайт и Telegram, выключенный режим или выключатель «после заявки» — прежняя пауза (null)", async () => {
    expect(await staffRelayPauseMs({ kind: "bot", id: await conversation("WEBSITE") })).toBeNull();
    expect(await staffRelayPauseMs({ kind: "telegram", id: "x" })).toBeNull();
    config.enabled = false;
    expect(await staffRelayPauseMs({ kind: "bot", id: await conversation("WHATSAPP") })).toBeNull();
    config.enabled = true; config.repliesAfterLead = false;
    expect(await staffRelayPauseMs({ kind: "bot", id: await conversation("WHATSAPP") })).toBeNull();
    config.repliesAfterLead = true;
  });
});
