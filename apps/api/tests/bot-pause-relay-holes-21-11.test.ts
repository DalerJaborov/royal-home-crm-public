import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Рубильник «ответ сотрудника останавливает бота» по умолчанию выключен (27.11.2026); тут проверяется сама пауза, поэтому он включён подменой.
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) =>
  (await import("./helpers/staffReplyPauseOn.js")).withStaffReplyPauseOn(await importOriginal()));
import request from "supertest";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ВЕЧНЫЕ ПАУЗЫ ПОСЛЕ ВЫКАТА #333 (прод 20.11.2026, после 16:19 UTC — два новых диалога с паузой до 2036):
 *  - da333405: ответ сотрудника из CRM — интерфейс шлёт с каждым ответом явный срок «Бессрочно» (Messages.tsx,
 *    MobileChatView.tsx), и явный срок обходил эстафету (lib/conversationDelivery.ts::deliveryPauseFor);
 *  - 74c51673: состоявшийся звонок (callTracker → pauseConversationsAfterRealContact) ставил 10 лет всем диалогам клиента.
 * И ручная «Пауза» / «Вернуть боту» не писали журнал действий: ручную паузу было не отличить от автоматической.
 */
const config = { enabled: true, repliesAfterLead: true, staffQuietMinutes: 180 };
vi.mock("../src/lib/leadOnlyConfig.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/leadOnlyConfig.js")>();
  return { ...actual, loadLeadOnlyConfig: async () => ({ ...(await actual.loadLeadOnlyConfig()), ...config }) };
});
// Поиск переписки по адресу Meta (пространства адресов, #344) — не предмет этого теста: подставляем найденную переписку.
const scoped = { id: "" };
vi.mock("../src/lib/customerConversationScope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/customerConversationScope.js")>()),
  findScopedBotConversation: async () => (scoped.id ? { id: scoped.id, accountId: null } : null),
}));
const { deliveryPauseFor: deliveryPauseForBase, defaultPauseForSender, pauseConversationsAfterRealContact, OPERATOR_REPLY_PAUSE_MS } =
  await import("../src/lib/conversationDelivery.js");
const { pauseBotForOtherThreadOwner } = await import("../src/lib/threadOwnerPause.js");
// Дверь срока живёт в lib/deliveryPause.ts (вынесена #344, без отправки); срок по умолчанию передаёт отправка — как здесь.
const deliveryPauseFor = (target: { kind: "bot"; id: string }, override: Date | undefined, sender: typeof agent) =>
  deliveryPauseForBase(target, override, sender, () => defaultPauseForSender(target as never, sender));
const { app } = await import("../src/app.js");

const runId = `${Date.now()}`.slice(-7);
const ids: string[] = [];
let clientId = "", directorId = "", token = "";
const TEN_YEARS = () => new Date(Date.now() + OPERATOR_REPLY_PAUSE_MS);
const RELAY_MS = 180 * 60_000;
const agent = { kind: "agent" as const, agentId: "a", agentName: "Агент" };

async function conversation(channel: string, over: Record<string, unknown> = {}): Promise<string> {
  const row = await prisma.botConversation.create({ data: { channel, subscriberId: `holes-${channel}-${runId}-${Math.random().toString(36).slice(2, 8)}`, ...over } });
  ids.push(row.id);
  return row.id;
}
const near = (value: Date | null | undefined, ms: number) => !!value && Math.abs(value.getTime() - Date.now() - ms) < 60_000;

beforeAll(async () => {
  const d = await prisma.agent.create({ data: { fullName: `Директор паузы ${runId}`, phone: `+99293${runId}`, role: "DIRECTOR", passwordHash: "x" } });
  directorId = d.id;
  token = signAccessToken({ sub: d.id, role: "DIRECTOR" });
  clientId = (await prisma.client.create({ data: { fullName: `Клиент паузы ${runId}`, phone: `+99292${runId}`, source: "WHATSAPP" } })).id;
});
afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ids, clientId] } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: ids } } });
  await prisma.telegramConversation.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

describe("ответ сотрудника: «Бессрочно» из интерфейса в режиме «только заявки» — эстафета", () => {
  it("явный срок длиннее эстафеты → эстафета, действующую паузу не укорачиваем; короче → как выбран; вне режима — как прежде", async () => {
    const wa = await conversation("WHATSAPP");
    expect(await deliveryPauseFor({ kind: "bot", id: wa } as never, TEN_YEARS(), agent)).toMatchObject({ keepLonger: true });
    expect(near((await deliveryPauseFor({ kind: "bot", id: wa } as never, TEN_YEARS(), agent)).until, RELAY_MS)).toBe(true);
    const short = new Date(Date.now() + 10 * 60_000);
    expect(await deliveryPauseFor({ kind: "bot", id: wa } as never, short, agent)).toEqual({ until: short, keepLonger: false });
    expect(near((await deliveryPauseFor({ kind: "bot", id: wa } as never, undefined, agent)).until, RELAY_MS)).toBe(true);
    const site = await conversation("WEBSITE");
    const forever = TEN_YEARS();
    expect(await deliveryPauseFor({ kind: "bot", id: site } as never, forever, agent)).toEqual({ until: forever, keepLonger: false });
    config.enabled = false;
    try { expect(await deliveryPauseFor({ kind: "bot", id: wa } as never, forever, agent)).toEqual({ until: forever, keepLonger: false }); }
    finally { config.enabled = true; }
  });
});

describe("переписку ведёт другое приложение (#344, lib/threadOwnerPause.ts) — тоже эстафета, и тревога паузы сначала", () => {
  it("режим «только заявки»: пауза на срок эстафеты, а не 12 часов; отметка тревоги «бот на паузе» сброшена", async () => {
    const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `holes-acc-${runId}`, title: "Проверка эстафеты", token: "x" } });
    try {
      const peer = `holes-peer-${runId}`;
      const conv = await conversation("INSTAGRAM", { pauseAlertSentAt: new Date() });
      scoped.id = conv;
      expect(await pauseBotForOtherThreadOwner({ accountId: account.id, peer, code: 10, subcode: 2018300 })).toEqual({ paused: true });
      const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: conv }, select: { pausedUntil: true, pauseAlertSentAt: true } });
      expect(near(row.pausedUntil, RELAY_MS)).toBe(true);
      expect(row.pauseAlertSentAt).toBeNull();
    } finally {
      scoped.id = "";
      await prisma.messengerAccount.deleteMany({ where: { id: account.id } });
    }
  });
});

describe("звонок состоялся: бот уступает на срок эстафеты, а не на 10 лет", () => {
  it("WhatsApp-диалог клиента — эстафета; уже стоящая более длинная пауза не укорачивается; Telegram — как прежде", async () => {
    const wa = await conversation("WHATSAPP", { clientId });
    const longer = new Date(Date.now() + 30 * 24 * 3600_000);
    const ig = await conversation("INSTAGRAM", { clientId, pausedUntil: longer, botPausedAt: new Date() });
    await prisma.telegramConversation.create({ data: { chatId: `holes-${runId}`, messages: [], clientId } });
    await pauseConversationsAfterRealContact(clientId);
    const rows = await prisma.botConversation.findMany({ where: { id: { in: [wa, ig] } }, select: { id: true, pausedUntil: true } });
    expect(near(rows.find(row => row.id === wa)!.pausedUntil, RELAY_MS)).toBe(true);
    expect(rows.find(row => row.id === ig)!.pausedUntil?.getTime()).toBe(longer.getTime());
    const tg = await prisma.telegramConversation.findFirstOrThrow({ where: { clientId }, select: { pausedUntil: true } });
    expect(near(tg.pausedUntil, OPERATOR_REPLY_PAUSE_MS)).toBe(true);
  });
});

describe("ручная «Пауза» и «Вернуть боту» — в журнале действий (кто, когда, на сколько)", () => {
  it("POST /conversations/:id/pause и /resume пишут BOT_PAUSE_SET / BOT_PAUSE_CLEARED", async () => {
    const id = await conversation("INSTAGRAM");
    const until = new Date(Date.now() + 2 * 3600_000).toISOString();
    expect((await request(app).post(`/api/v1/conversations/${id}/pause`).set("Authorization", `Bearer ${token}`).send({ pausedUntil: until })).status).toBe(200);
    const set = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: id, action: "BOT_PAUSE_SET" } }));
    expect(set).toMatchObject({ agentId: directorId, meta: { pausedUntil: until } });
    expect((await request(app).post(`/api/v1/conversations/${id}/resume`).set("Authorization", `Bearer ${token}`).send()).status).toBe(200);
    expect(await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: id, action: "BOT_PAUSE_CLEARED" } }))).toMatchObject({ agentId: directorId });
  });

  it("«Вернуть боту» сбрасывает отметку тревоги «бот на паузе»: на новой паузе тревога срабатывает снова, а не через сутки", async () => {
    const { runBotPauseWatchTick } = await import("../src/lib/botPauseWatch.js");
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botPauseWatchEnabled: true, botPauseAlertHours: true, botPauseEscalateHours: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { botPauseWatchEnabled: true, botPauseAlertHours: 24, botPauseEscalateHours: 72 } });
    try {
      const hourAgo = new Date(Date.now() - 3600_000);
      const id = await conversation("INSTAGRAM", { messages: [{ role: "user", content: "Алло?", at: new Date(Date.now() - 30 * 3600_000).toISOString() }],
        lastMessageAt: new Date(Date.now() - 30 * 3600_000), pausedUntil: new Date(Date.now() + 3600_000), botPausedAt: hourAgo, pauseAlertSentAt: hourAgo });
      const auth = { Authorization: `Bearer ${token}` };
      expect((await request(app).post(`/api/v1/conversations/${id}/resume`).set(auth).send()).status).toBe(200);
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { pauseAlertSentAt: true } })).pauseAlertSentAt).toBeNull();
      // Новая пауза: тревога доступна сразу (раньше старая отметка глушила её сутки).
      await prisma.botConversation.update({ where: { id }, data: { pauseAlertSentAt: hourAgo } });
      expect((await request(app).post(`/api/v1/conversations/${id}/pause`).set(auth).send({ pausedUntil: new Date(Date.now() + 2 * 3600_000).toISOString() })).status).toBe(200);
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { pauseAlertSentAt: true } })).pauseAlertSentAt).toBeNull();
      await runBotPauseWatchTick(new Date());
      const after = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { pauseAlertSentAt: true } });
      expect(after.pauseAlertSentAt && after.pauseAlertSentAt.getTime() > hourAgo.getTime()).toBe(true);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: settings });
    }
  });
});
