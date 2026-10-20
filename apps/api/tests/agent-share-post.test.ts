import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * АГЕНТУ ЕГО ГОТОВЫЙ ПОСТ В TELEGRAM (28.09.2026, lib/agentSharePost.ts).
 *
 * Отправка с кнопками по успешным каналам; агент без chatId → ничего; общий
 * рубильник (Settings.agentSharePostTelegram) и личный (Agent.sharePostTelegram)
 * выключены → ничего; второй вызов на тот же объект не дублирует сообщение
 * (agentSharePostSentAt). Telegram подменён, база настоящая.
 */

const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: 1 })),
  sendPhotoFromDisk: vi.fn(async (_chatId: string, _path: string, _caption?: string, _buttons?: unknown) => ({ message_id: 1 })),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  ...tg,
  isTelegramEnabled: () => true,
}));

const { prisma } = await import("../src/db.js");
const { sendAgentSharePost, sendShareTextMessage } = await import("../src/lib/agentSharePost.js");

const runId = String(Date.now()).slice(-8);
const password = "testpass123";
const agentIds: string[] = [];
const propertyIds: string[] = [];

async function makeAgent(suffix: string, extra: Record<string, unknown> = {}) {
  const phone = `+99297${runId}${suffix}`;
  const a = await prisma.agent.create({
    data: {
      fullName: `Пост агенту ${suffix}`,
      phone,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 4),
      sharePostTelegram: true,
      ...extra,
    },
  });
  agentIds.push(a.id);
  return a;
}

async function makeProperty(agentId: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Пост агенту ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      rooms: 2,
      price: 350000,
      currency: "TJS",
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: agentId,
      reelsCaption: "Отличная квартира в центре! Звоните.",
      instagramUrl: "https://instagram.com/p/testpost123/",
      publishedPostIds: { FACEBOOK: "fbvid123" },
      ...extra,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function setGate(agentSharePostTelegram: boolean) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { agentSharePostTelegram },
    create: { id: "singleton", agentSharePostTelegram },
  });
}

beforeAll(async () => {
  await setGate(true);
});

// Моки Telegram общие на файл — без сброса вызовы из предыдущего теста
// (например, успешная отправка в первом it) засчитывались бы и в следующем.
beforeEach(() => {
  tg.sendMessage.mockClear();
  tg.sendMessageWithButtons.mockClear();
  tg.sendPhotoFromDisk.mockClear();
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await setGate(true);
});

describe("sendAgentSharePost", () => {
  it("отправляет пост с кнопками по успешным каналам и ставит agentSharePostSentAt", async () => {
    const chatId = `81${runId}1`;
    const agent = await makeAgent("1", { telegramChatId: chatId });
    const property = await makeProperty(agent.id);

    await sendAgentSharePost(property.id, { succeededChannels: ["INSTAGRAM", "FACEBOOK"] });

    expect(tg.sendMessageWithButtons).toHaveBeenCalledTimes(1);
    const [sentChatId, text, buttons] = tg.sendMessageWithButtons.mock.calls[0] as [string, string, { text: string; url?: string; callback_data?: string }[][]];
    expect(sentChatId).toBe(chatId);
    expect(text).toContain(`№${property.shortId}`);
    expect(text).toContain("Отличная квартира в центре!");

    const flat = buttons.flat();
    expect(flat.find((b) => "url" in b && b.url === "https://instagram.com/p/testpost123/")).toBeTruthy();
    expect(flat.find((b) => "url" in b && b.url === "https://www.facebook.com/watch/?v=fbvid123")).toBeTruthy();
    expect(flat.find((b) => "callback_data" in b && b.callback_data === `share-text:${property.id}`)).toBeTruthy();

    const updated = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { agentSharePostSentAt: true } });
    expect(updated.agentSharePostSentAt).not.toBeNull();
  });

  it("агент без telegramChatId — ничего не отправляет", async () => {
    const agent = await makeAgent("2"); // без telegramChatId
    const property = await makeProperty(agent.id);

    await sendAgentSharePost(property.id, { succeededChannels: ["INSTAGRAM"] });

    expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
    expect(tg.sendPhotoFromDisk).not.toHaveBeenCalled();
  });

  it("общий рубильник Settings.agentSharePostTelegram выключен — ничего не отправляет", async () => {
    await setGate(false);
    try {
      const chatId = `81${runId}3`;
      const agent = await makeAgent("3", { telegramChatId: chatId });
      const property = await makeProperty(agent.id);

      await sendAgentSharePost(property.id, { succeededChannels: ["INSTAGRAM"] });

      expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
    } finally {
      await setGate(true);
    }
  });

  it("личный тумблер Agent.sharePostTelegram выключен — ничего не отправляет", async () => {
    const chatId = `81${runId}4`;
    const agent = await makeAgent("4", { telegramChatId: chatId, sharePostTelegram: false });
    const property = await makeProperty(agent.id);

    await sendAgentSharePost(property.id, { succeededChannels: ["INSTAGRAM"] });

    expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
  });

  it("второй вызов на тот же объект не дублирует сообщение", async () => {
    const chatId = `81${runId}5`;
    const agent = await makeAgent("5", { telegramChatId: chatId });
    const property = await makeProperty(agent.id);

    await sendAgentSharePost(property.id, { succeededChannels: ["INSTAGRAM"] });
    await sendAgentSharePost(property.id, { succeededChannels: ["INSTAGRAM", "FACEBOOK"] });

    expect(tg.sendMessageWithButtons).toHaveBeenCalledTimes(1);
  });

  it("succeededChannels пуст — ничего не отправляет (частичная/неудачная публикация)", async () => {
    const chatId = `81${runId}6`;
    const agent = await makeAgent("6", { telegramChatId: chatId });
    const property = await makeProperty(agent.id);

    await sendAgentSharePost(property.id, { succeededChannels: [] });

    expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
  });
});

describe("sendShareTextMessage", () => {
  it("присылает подпись поста отдельным простым сообщением", async () => {
    const agent = await makeAgent("7");
    const property = await makeProperty(agent.id);
    const chatId = `81${runId}7`;

    await sendShareTextMessage(chatId, property.id);

    expect(tg.sendMessage).toHaveBeenCalledWith(chatId, "Отличная квартира в центре! Звоните.");
  });
});
