// «Бот отвечает всегда», вторая волна (15.11.2026, В4 владельца + задача 5):
//  - Telegram-бот и Telegram Direct: клиент без ответа 30 минут — та же дверь alertClientWaiting;
//  - вебхук WhatsApp замолчал при живом номере — тревога руководству с причиной из Graph;
//  - сообщение без чата CRM (тикет ядра без conversationId, непереданное без записи) — пуш «Ответьте вручную».
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.SETTINGS_ENCRYPTION_KEY ??= "ab".repeat(32); // test-only key: the ticket input is AES-GCM encrypted

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
}));
const logSystemError = vi.fn(async () => undefined);
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));
const metaOverrides = { channelOn: true };
vi.mock("../src/messengers/meta.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/messengers/meta.js")>();
  return {
    ...real,
    isMetaChannelEnabled: vi.fn(async () => metaOverrides.channelOn),
    loadCredentials: vi.fn(async () => ({ ...(await real.loadCredentials()), waPhoneId: "wa-phone-test", waToken: "test-wa-token" })),
  };
});

const { prisma } = await import("../src/db.js");
const { runClientSilenceSweep, CLIENT_WAITING_MINUTES } = await import("../src/lib/clientWaitingAlert.js");
const wa = await import("../src/lib/whatsappWebhookWatch.js");
const held = await import("../src/lib/customerHeldMessage.js");
const { reportUnansweredCustomerTurn } = await import("../src/lib/customerTurnSilence.js");
const payloadLib = await import("../src/lib/customerIngressPayload.js");

const runId = Date.now().toString(36);
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const ids = { agent: "", director: "", clients: [] as string[], tg: [] as string[], td: [] as string[], bot: [] as string[] };
let saved: Record<string, unknown> | null = null;

beforeAll(async () => {
  saved = await prisma.settings.findUnique({ where: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true, telegramSilenceWatchEnabled: true, whatsappWebhookWatchEnabled: true, metaWaBusinessAccountId: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00", telegramSilenceWatchEnabled: true } });
  ids.agent = (await prisma.agent.create({ data: { fullName: `Агент TG ${runId}`, phone: `+99294${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash: "x" } })).id;
  ids.director = (await prisma.agent.create({ data: { fullName: `Директор ${runId}`, phone: `+99295${String(Date.now()).slice(-7)}`, role: "DIRECTOR", passwordHash: "x" } })).id;
});

beforeEach(() => {
  sendPushToAgent.mockReset().mockResolvedValue(1);
  sendPushToAgents.mockReset().mockResolvedValue(1);
  logSystemError.mockClear();
});

afterAll(async () => {
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  const tags = [...ids.tg.map((id) => `client-waiting-tg_${id}`), ...ids.td.map((id) => `client-waiting-td_${id}`)];
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: tags } } });
  await prisma.processedMessage.deleteMany({ where: { channel: { in: ["client-waiting-telegram", "customer-unrecorded-notify"] } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: ids.tg } } });
  await prisma.telegramDirectConversation.deleteMany({ where: { id: { in: ids.td } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: ids.bot } } });
  await prisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ids.agent, ids.director] } } });
});

async function tgChat(messages: object[], opts: { agent?: boolean; direct?: boolean } = {}) {
  let clientId: string | null = null;
  if (opts.agent) {
    const c = await prisma.client.create({ data: { fullName: `TG клиент ${runId}-${ids.clients.length}`,
      phone: `+99296${String(Date.now() + ids.clients.length).slice(-7)}`, source: "TELEGRAM", assignedAgentId: ids.agent } });
    clientId = c.id;
    ids.clients.push(c.id);
  }
  const n = ids.tg.length + ids.td.length;
  if (opts.direct) {
    const row = await prisma.telegramDirectConversation.create({ data: { chatId: `tgd-${runId}-${n}`, topicId: "t1", username: `direct_${n}`,
      messages, lastMessageAt: new Date(), ...(clientId ? { clientId } : {}) } });
    ids.td.push(row.id);
    return row.id;
  }
  const row = await prisma.telegramConversation.create({ data: { chatId: `tg-${runId}-${n}`, username: `tg_${n}`, messages,
    lastMessageAt: new Date(), ...(clientId ? { clientId } : {}) } });
  ids.tg.push(row.id);
  return row.id;
}
const pushesFor = (openId: string) => sendPushToAgent.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === `client-waiting-${openId}`);

describe("Telegram: клиент без ответа — та же дверь, что у Meta", () => {
  it("Telegram-бот: реплика без ответа дольше 30 минут — пуш агенту клиента, один раз на эпизод, ссылка открывает переписку", async () => {
    const id = await tgChat([{ role: "assistant", content: "Здравствуйте" }, { role: "user", content: "Цена?", at: minutesAgo(CLIENT_WAITING_MINUTES + 5) }], { agent: true });
    await runClientSilenceSweep();
    const first = pushesFor(`tg_${id}`);
    expect(first).toHaveLength(1);
    expect(first[0][0]).toBe(ids.agent);
    expect((first[0][1] as { url: string }).url).toBe(`/messages?open=tg_${id}`);
    await runClientSilenceSweep();
    expect(pushesFor(`tg_${id}`)).toHaveLength(1);
  });

  it("свежая реплика (меньше 30 минут) и отвеченная — не тревожим", async () => {
    const fresh = await tgChat([{ role: "user", content: "Привет", at: minutesAgo(5) }], { agent: true });
    const answered = await tgChat([{ role: "user", content: "Цена?", at: minutesAgo(90) }, { role: "assistant", content: "100" }], { agent: true });
    await runClientSilenceSweep();
    expect(pushesFor(`tg_${fresh}`)).toHaveLength(0);
    expect(pushesFor(`tg_${answered}`)).toHaveLength(0);
  });

  it("Telegram Direct без агента — руководству, с подсказкой отвечать в Telegram (из CRM туда не ответить)", async () => {
    const id = await tgChat([{ role: "user", content: "Есть 3-комн.?", at: minutesAgo(45) }], { direct: true });
    await runClientSilenceSweep();
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `client-waiting-td_${id}` } });
    expect(alert).not.toBeNull();
    expect(alert!.body).toContain("в Telegram");
    expect(alert!.url).toBe(`/messages?open=td_${id}`);
  });

  it("пуш не ушёл — отметка эпизода снимается, следующий тик пробует снова", async () => {
    const id = await tgChat([{ role: "user", content: "Алло", at: minutesAgo(60) }], { agent: true });
    sendPushToAgent.mockRejectedValueOnce(new Error("push down"));
    await runClientSilenceSweep();
    expect(await prisma.processedMessage.count({ where: { channel: "client-waiting-telegram", messageId: { startsWith: `telegram:${id}:` } } })).toBe(0);
    await runClientSilenceSweep();
    expect(pushesFor(`tg_${id}`).length).toBe(2); // первая попытка упала, вторая ушла
  });

  it("рубильник выключен — Telegram не проверяется", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { telegramSilenceWatchEnabled: false } });
    const id = await tgChat([{ role: "user", content: "Ау", at: minutesAgo(50) }], { agent: true });
    await runClientSilenceSweep();
    expect(pushesFor(`tg_${id}`)).toHaveLength(0);
    await prisma.settings.update({ where: { id: "singleton" }, data: { telegramSilenceWatchEnabled: true } });
  });
});

describe("WhatsApp: вебхук замолчал", () => {
  const window = { start: "09:30", end: "18:00" };
  // 14.11.2026 по Душанбе (UTC+5): 10:00 = 05:00Z.
  const at = (day: number, hhmm: string) => new Date(`2026-11-${String(day).padStart(2, "0")}T${hhmm}:00+05:00`);

  it("обычная пауза считается только в рабочие часы: ночь не в счёт", () => {
    const times = [at(13, "10:00"), at(13, "11:00"), at(13, "17:00"), at(14, "10:30")];
    // 11:00→17:00 = 6 ч; ночь 17:00→10:30 не считается, от начала окна 09:30 до 10:30 — 1 ч.
    expect(wa.longestWorkGapMs(times, window)).toBe(6 * 3_600_000);
  });

  it("порог — обычная пауза ×1,5 в пределах 3–8 ч; тишина сегодня — от начала окна", () => {
    expect(wa.silenceThresholdMs(60 * 60_000)).toBe(wa.WA_SILENCE_MIN_MS);
    expect(wa.silenceThresholdMs(4 * 3_600_000)).toBe(6 * 3_600_000);
    expect(wa.silenceThresholdMs(20 * 3_600_000)).toBe(wa.WA_SILENCE_MAX_MS);
    expect(wa.workSilenceMs(at(13, "22:00"), at(14, "12:30"), window)).toBe(3 * 3_600_000);
    expect(wa.workSilenceMs(at(14, "11:30"), at(14, "12:30"), window)).toBe(3_600_000);
  });

  it("причина из Graph: номер не подключён / приложение не подписано / всё живо — ключ в текст не попадает", async () => {
    const graph = (phone: unknown, apps: unknown) => vi.fn(async (url: string) =>
      ({ ok: true, json: async () => (url.includes("subscribed_apps") ? apps : phone) }));
    const input = { phoneId: "p1", token: "secret-token-xyz", businessAccountId: "waba1" };
    expect(await wa.diagnoseWhatsappNumber(input, graph({ status: "DISCONNECTED" }, { data: [{}] }))).toContain("не подключён");
    expect(await wa.diagnoseWhatsappNumber(input, graph({ status: "CONNECTED" }, { data: [] }))).toContain("НЕ подписано");
    const alive = await wa.diagnoseWhatsappNumber(input, graph({ status: "CONNECTED" }, { data: [{ id: "app" }] }));
    expect(alive).toContain("адрес вебхука");
    expect(alive).not.toContain("secret-token-xyz");
    expect(await wa.diagnoseWhatsappNumber(input, graph({ error: { code: 190 } }, {}))).toContain("код Meta 190");
  });

  it("в рабочие часы входящих нет дольше обычного — тревога руководству; пришло сообщение — тишины нет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "09:30", workHoursEnd: "18:00",
      whatsappWebhookWatchEnabled: true, metaWaBusinessAccountId: "waba-test" } });
    // Неделя по 5 сообщений в день с 10:00 до 14:00 (пауза 1 ч), сегодня с утра — ни одного.
    const now = new Date(Date.now() - 24 * 3_600_000);
    const day = (offset: number, hh: number) => {
      const d = new Date(now.getTime() - offset * 24 * 3_600_000);
      const wall = new Date(d.getTime() + 5 * 3_600_000);
      return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hh - 5, 0));
    };
    const nowAt = (() => { const d = day(0, 17); return d; })(); // сегодня 17:00 по Душанбе
    const messages = [];
    for (let offset = 6; offset >= 1; offset--) for (const hh of [10, 11, 12, 13, 14]) messages.push({ role: "user", content: "?", at: day(offset, hh).toISOString() });
    const conv = await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: `992900${runId}`, messages,
      lastMessageAt: day(1, 14) } });
    ids.bot.push(conv.id);
    const get = vi.fn(async (url: string) => ({ ok: true, json: async () => (url.includes("subscribed_apps") ? { data: [] } : { status: "CONNECTED" }) }));

    const silent = await wa.runWhatsappWebhookWatch(nowAt, get);
    expect(silent.alarmed).toBe(true);
    expect(silent.silenceMs).toBeGreaterThanOrEqual(silent.thresholdMs);
    const text = String(logSystemError.mock.calls.find(([, msg]) => String(msg).startsWith("WhatsApp молчит"))?.[1]);
    expect(text).toContain("НЕ подписано");
    expect(text).not.toContain("test-wa-token");

    await prisma.botConversation.update({ where: { id: conv.id }, data: {
      messages: [...messages, { role: "user", content: "сегодня", at: new Date(nowAt.getTime() - 30 * 60_000).toISOString() }], lastMessageAt: nowAt } });
    expect((await wa.runWhatsappWebhookWatch(nowAt, get)).alarmed).toBe(false);

    // Рубильник выключен или канал выключен — не судим.
    await prisma.settings.update({ where: { id: "singleton" }, data: { whatsappWebhookWatchEnabled: false } });
    expect((await wa.runWhatsappWebhookWatch(nowAt, get)).skipped).toBe("off");
    await prisma.settings.update({ where: { id: "singleton" }, data: { whatsappWebhookWatchEnabled: true } });
    metaOverrides.channelOn = false;
    expect((await wa.runWhatsappWebhookWatch(nowAt, get)).skipped).toBe("channel_off");
    metaOverrides.channelOn = true;
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
  });
});

describe("Сообщение без чата CRM — пуш «Ответьте вручную», а не строка в журнале (задача 5)", () => {
  it("тикет ядра без переписки: кто и где — из зашифрованного входа тикета; один пуш на человека за окно", async () => {
    const source = { path: "entry.0.changes.0", frameHash: "c".repeat(64) };
    const payload = { version: 1 as const, channel: "WHATSAPP" as const, peer: "992900111222", accountExternalId: "wa-phone-test",
      eventKind: "message" as const, eventId: `wamid.${runId}`, inputText: "Сколько стоит квартира?", source,
      observations: { providerEcho: false, referralOnly: false }, media: [], propertyEvidence: [] };
    const context = { version: 1 as const, eventKey: "d".repeat(64), order: "7", scopeKey: "e".repeat(64), endpointScopeId: randomUUID(),
      payloadHash: payloadLib.customerIngressPayloadHash(payload) };
    const ciphertext = payloadLib.encryptCustomerIngressPayload(context, payload, { version: 1, classification: "PENDING_ENVELOPE",
      provenance: "meta_signature", assurance: "protected_namespace", issuerSource: "account_secret", accountId: null,
      endpointScopeId: context.endpointScopeId, scopeRevision: "0", policyRevision: "0", issuedAt: 0, source, verifierCredential: null });
    const ticketRow = { conversationId: null, channel: null, peer: null, excerpt: null, answered: false, chatDeleted: false,
      order: 7n, scopeKey: context.scopeKey, endpointScopeId: context.endpointScopeId, payloadVersion: 1, payloadCiphertext: ciphertext,
      payloadHash: context.payloadHash };
    const query = vi.spyOn(prisma, "$queryRaw");
    query.mockResolvedValueOnce([ticketRow] as never);
    await reportUnansweredCustomerTurn(context.eventKey, "sender_read_unavailable");
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    const [recipients, push] = sendPushToAgents.mock.calls[0] as unknown as [string[], { title: string; body: string; level: string }];
    expect(recipients).toContain(ids.director);
    expect(push.title).toContain("+992900111222");
    expect(push.body).toContain("Сколько стоит квартира?");
    expect(push.level).toBe("CRITICAL");

    // Тот же человек ещё раз в том же окне — второго пуша нет.
    query.mockResolvedValueOnce([ticketRow] as never);
    await reportUnansweredCustomerTurn(context.eventKey, "sender_read_unavailable");
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);

    // Чат удалил сотрудник — его решение, человека не зовём.
    query.mockResolvedValueOnce([{ ...ticketRow, peer: null, chatDeleted: true }] as never);
    await prisma.processedMessage.deleteMany({ where: { channel: "customer-unrecorded-notify" } });
    await reportUnansweredCustomerTurn(context.eventKey, "sender_read_unavailable");
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    query.mockRestore();
  });

  it("непереданное сообщение без записи в чат (scope_denied) — пуш; удалённый сотрудником чат — только журнал", async () => {
    await held.notifyHeldCustomerMessages([
      { reason: "owned_subject_stopped", channel: "INSTAGRAM", peer: `ig-${runId}`, accountExternalId: null, conversationId: null,
        excerpt: "Здравствуйте", unrecorded: "scope_denied" },
      { reason: "owned_subject_stopped", channel: "INSTAGRAM", peer: `ig2-${runId}`, accountExternalId: null, conversationId: null,
        excerpt: "", unrecorded: "chat_deleted" },
    ]);
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    expect((sendPushToAgents.mock.calls[0] as unknown as [string[], { body: string }])[1].body).toContain("Здравствуйте");
  });

  it("пуш не ушёл — отметка снимается, следующий раз скажем", async () => {
    sendPushToAgents.mockRejectedValueOnce(new Error("push down"));
    const hold = { channel: "FACEBOOK", peer: `fb-${runId}`, accountExternalId: null, excerpt: "Есть?", why: "бот не смог" };
    expect(await held.pushStaffAboutUnrecorded(hold)).toBe("skipped");
    expect(await held.pushStaffAboutUnrecorded(hold)).toBe("sent");
  });
});
