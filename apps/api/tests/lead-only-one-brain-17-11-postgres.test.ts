import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { alertClientWaiting } from "../src/lib/clientWaitingAlert.js";
import { signalStaffFollowUp } from "../src/lib/customerDmAgentTurn.js";
import { channelCoreToolNames, CUSTOMER_AGENT_CHANNEL_CORE_TOOLS } from "../src/lib/customerChannelCore.js";

/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» И «ОДИН МОЗГ» (17.11.2026, перенос #165 на main).
 *
 * После #165 в main появилась одна дверь сигналов «клиент ждёт» (lib/clientWaitingAlert.ts): «это скажет агент»
 * (follow_up) и «модель позвала сотрудника» (escalate). Решение владельца 13.11.2026: до заявки (карточки) людей не
 * зовём вовсе. Дверь сама молчит в режиме у диалога без карточки; сбой бота (failed) и сторож молчания остаются,
 * разговор о вакансии ведёт рекрутер прежним путём. Адаптер каналов (lib/customerChannelCore.ts) в режиме не даёт поиска.
 */
const created = { conversations: [] as string[], clients: [] as string[] };
let settingsBefore: { botLeadOnlyMode: boolean };

const chat = async (channel: "INSTAGRAM" | "WEBSITE" | "WHATSAPP", clientId?: string) => {
  const row = await prisma.botConversation.create({ data: { channel, subscriberId: `lo-17-11-${randomUUID()}`, messages: [],
    ...(clientId ? { clientId } : {}) }, select: { id: true } });
  created.conversations.push(row.id);
  return row.id;
};
const queued = (id: string) => prisma.pendingDirectorAlert.count({ where: { tag: `client-waiting-${id}` } });
const mode = (on: boolean) => prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: on } });

beforeAll(async () => {
  settingsBefore = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botLeadOnlyMode: true } });
});
beforeEach(async () => { await mode(true); });
afterAll(async () => {
  try {
    const tags = created.conversations.map(id => `client-waiting-${id}`);
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: tags } } });
    await prisma.notification.deleteMany({ where: { tag: { in: tags } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: created.conversations } } });
    await prisma.client.deleteMany({ where: { id: { in: created.clients } } });
  } finally {
    await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  }
});

describe("дверь «клиент ждёт» в режиме «только заявки»", () => {
  it("до карточки: «это скажет агент» и «нужен сотрудник» никого не зовут", async () => {
    const id = await chat("INSTAGRAM");
    expect(await signalStaffFollowUp(id, Date.now() - 60_000)).toBe("skipped");
    expect(await alertClientWaiting({ conversationId: id, trigger: "escalate" })).toBe("excluded");
    expect(await queued(id)).toBe(0);
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { silenceAlertFor: true } });
    // Эпизод не занят: включат режим обратно выключенным — сторож увидит молчание как обычно.
    expect(row.silenceAlertFor).toBeNull();
  }, 30_000);

  it("WhatsApp без карточки — тоже тихо: лид появляется заявкой режима, а не пушем", async () => {
    const id = await chat("WHATSAPP");
    expect(await alertClientWaiting({ conversationId: id, trigger: "follow_up", since: new Date() })).toBe("excluded");
    expect(await queued(id)).toBe(0);
  }, 30_000);

  it("сбой бота (failed) человека зовёт и в режиме: это поломка, а не лид", async () => {
    const id = await chat("INSTAGRAM");
    expect(await alertClientWaiting({ conversationId: id, trigger: "failed", why: "бот не смог подготовить ответ" })).toBe("director");
    expect(await queued(id)).toBe(1);
  }, 30_000);

  it("вакансия: рекрутер узнаёт, как раньше", async () => {
    const id = await chat("INSTAGRAM");
    expect(await signalStaffFollowUp(id, Date.now() - 60_000, true)).toBe("director");
  }, 30_000);

  it("карточка есть (лид): сигнал идёт", async () => {
    const client = await prisma.client.create({ data: { fullName: "Клиент 17.11", phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      source: "INSTAGRAM" } });
    created.clients.push(client.id);
    expect(await signalStaffFollowUp(await chat("INSTAGRAM", client.id), Date.now() - 60_000)).toBe("director");
  }, 30_000);

  it("чат сайта режимом не затронут (решение 13.11: только WhatsApp/Instagram/Facebook)", async () => {
    expect(await signalStaffFollowUp(await chat("WEBSITE"), Date.now() - 60_000)).toBe("director");
  }, 30_000);

  it("режим выключен — всё как раньше", async () => {
    await mode(false);
    expect(await signalStaffFollowUp(await chat("INSTAGRAM"), Date.now() - 60_000)).toBe("director");
  }, 30_000);
});

describe("адаптер каналов: в режиме нет поиска", () => {
  it("режим — без search_public_properties, остальные чтения на месте; без режима — полный набор", () => {
    expect(channelCoreToolNames(true)).not.toContain("search_public_properties");
    expect(channelCoreToolNames(true)).toEqual(CUSTOMER_AGENT_CHANNEL_CORE_TOOLS.filter(name => name !== "search_public_properties"));
    expect(channelCoreToolNames(false)).toEqual(CUSTOMER_AGENT_CHANNEL_CORE_TOOLS);
  });
});
