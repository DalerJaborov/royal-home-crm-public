import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CHANNEL-NEW-11 (аудит Codex, 04.10.2026): аккаунт Meta, выключенный тумблером в
 * Настройках → Каналы (`MessengerAccount.enabled=false`), продолжал писать клиентам первым.
 * Входящий путь (`resolveIncomingAccount`) токен у выключенного аккаунта отбирает, а
 * исходящие помощники (`accountTokenById`) отдавали рабочий токен, и напоминание уходило.
 * Здесь: фоновые напоминания (cron.sendFollowUps) пропускают диалог выключенного аккаунта,
 * диалог остаётся в очереди; обычный аккаунт не затронут.
 *
 * Модель и транспорт подменены, остальное настоящее, включая базу.
 */
const shortAgentReply = vi.hoisted(() => vi.fn(async () => "Салом! Хотели уточнить, актуален ли поиск?"));
vi.mock("../src/ai/shortAgentReply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/shortAgentReply.js")>()),
  shortAgentReply,
}));
const sendBotMessageWithMid = vi.hoisted(() => vi.fn(async () => ({ sent: true, mid: "wamid.test" })));
vi.mock("../src/messengers/sendBotMessage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/sendBotMessage.js")>()),
  sendBotMessageWithMid,
}));

const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const { resetAccountsCache } = await import("../src/messengers/accounts.js");
const { sendFollowUps } = await import("../src/cron.js");

const runId = Date.now();
const conversationIds: string[] = [];
const accountIds: string[] = [];
let savedSettings: Record<string, unknown> | null = null;

async function makeAccount(tag: string, enabled: boolean) {
  const account = await prisma.messengerAccount.create({
    data: {
      channel: "WHATSAPP",
      externalId: `fu-acc-${runId}-${tag}`,
      title: `Аккаунт напоминаний ${tag}`,
      token: encryptSecret(`token-${tag}`),
      enabled,
    },
  });
  accountIds.push(account.id);
  return account;
}

async function makeConversation(tag: string, accountId: string | null) {
  const conv = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `fu-sub-${runId}-${tag}`,
      accountId,
      name: "Клиент без ответа",
      // Клиент писал два часа назад, последним ответил бот: пора напоминать.
      lastMessageAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      messages: [
        { role: "user", content: "Салом, двушка есть?", at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
        { role: "assistant", content: "Салом! Какой район интересует?", by: { kind: "bot" } },
      ],
    },
  });
  conversationIds.push(conv.id);
  return conv;
}

const sentTo = (tag: string) => sendBotMessageWithMid.mock.calls.some((c) => (c as unknown[])[1] === `fu-sub-${runId}-${tag}`);

beforeAll(async () => {
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    followUpEnabled: s.followUpEnabled,
    followUpWindowStart: s.followUpWindowStart,
    followUpWindowEnd: s.followUpWindowEnd,
    followUpMaxAttempts: s.followUpMaxAttempts,
  };
  // Круглые сутки, чтобы тест не зависел от времени запуска.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { followUpEnabled: true, followUpWindowStart: "00:00", followUpWindowEnd: "24:00", followUpMaxAttempts: 1 },
  });
});

beforeEach(() => {
  sendBotMessageWithMid.mockClear();
  shortAgentReply.mockClear();
  resetAccountsCache();
});

afterAll(async () => {
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings }).catch(() => {});
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  resetAccountsCache();
  await prisma.$disconnect();
});

describe("Напоминания молчащим клиентам и выключенный аккаунт Meta", () => {
  it("диалог включённого аккаунта получает напоминание (контроль: проход вообще отправляет)", async () => {
    const on = await makeAccount("on", true);
    await makeConversation("on", on.id);
    resetAccountsCache();

    await sendFollowUps();

    expect(sentTo("on")).toBe(true);
  });

  it("диалог выключенного аккаунта напоминание не получает и остаётся в очереди", async () => {
    const off = await makeAccount("off", false);
    const conv = await makeConversation("off", off.id);
    resetAccountsCache();

    await sendFollowUps();

    expect(sentTo("off")).toBe(false);
    const after = await prisma.botConversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(after.followUpsSent).toBe(0);
  });
});
