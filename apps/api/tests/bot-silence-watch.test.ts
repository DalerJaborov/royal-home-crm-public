// Сторож «бот замолчал» (владелец 27.11.2026; инцидент 26.11: бот не отвечал с 16:00 до 20:22, узнали по телефону).
// Чистые решения — без базы; тик целиком — на PostgreSQL, на собственном прошлом времени (2021 год), чтобы переписки
// соседних тестов в «последние 6 часов» не попадали.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  channelsInWords,
  decideBotSilence,
  lastBotAnswerIn,
  runBotSilenceWatchTick,
  silenceAlertText,
  silenceRecoveredText,
  silentChannels,
  SILENCE_MIN_CUSTOMERS,
  SILENCE_REMIND_MS,
  type OpenIncident,
  type SilenceSnapshot,
  type WaitingCustomer,
} from "../src/lib/botSilenceWatch.js";

const MIN = 60_000;
/** 10.03.2021 11:00 UTC = 16:00 по Душанбе, среда. */
const T = new Date(Date.UTC(2021, 2, 10, 11, 0, 0));
const at = (ms: number) => new Date(T.getTime() + ms);
const iso = (ms: number) => at(ms).toISOString();
const w = (key: string, channel: WaitingCustomer["channel"], ms: number): WaitingCustomer => ({ key, channel, since: at(ms) });

/** Служебные следы, которых не должно быть в тексте человеку: коды, английские слова, id, названия каналов капсом. */
const TECHNICAL = /[a-z]+_[a-z_]+|current_artifact|revision|mismatch|[0-9a-f]{8}-[0-9a-f]{4}|[Яя]дро|[Вв]ерси|INSTAGRAM|WHATSAPP|FACEBOOK|WEBSITE/;

describe("silentChannels: канал замолчал = трое ждут И бот с тех пор не ответил никому", () => {
  it("трое ждут, бот отвечал только раньше — замолчал", () => {
    const s: SilenceSnapshot = { waiting: [w("a", "INSTAGRAM", -30 * MIN), w("b", "INSTAGRAM", -25 * MIN), w("c", "INSTAGRAM", -20 * MIN)],
      lastBotAnswerAt: { INSTAGRAM: at(-60 * MIN) } };
    expect(silentChannels(s).get("INSTAGRAM")?.length).toBe(3);
  });
  it("бот ответил кому-то после первого из ждущих — не поломка (считаются только пришедшие после ответа)", () => {
    const s: SilenceSnapshot = { waiting: [w("a", "INSTAGRAM", -30 * MIN), w("b", "INSTAGRAM", -25 * MIN), w("c", "INSTAGRAM", -20 * MIN)],
      lastBotAnswerAt: { INSTAGRAM: at(-22 * MIN) } };
    expect(silentChannels(s).size).toBe(0);
  });
  it("двое ждут — ещё не тревога (это сторож «клиент ждёт ответа»)", () => {
    expect(SILENCE_MIN_CUSTOMERS).toBe(3);
    const s: SilenceSnapshot = { waiting: [w("a", "WHATSAPP", -30 * MIN), w("b", "WHATSAPP", -25 * MIN)], lastBotAnswerAt: {} };
    expect(silentChannels(s).size).toBe(0);
  });
  it("каналы считаются порознь: трое в разных каналах — не тревога", () => {
    const s: SilenceSnapshot = { waiting: [w("a", "WHATSAPP", -30 * MIN), w("b", "INSTAGRAM", -25 * MIN), w("c", "FACEBOOK", -20 * MIN)], lastBotAnswerAt: {} };
    expect(silentChannels(s).size).toBe(0);
  });
});

describe("decideBotSilence: один эпизод, напоминание раз в час, восстановление по ответу бота", () => {
  const silent: SilenceSnapshot = { waiting: [w("a", "INSTAGRAM", -30 * MIN), w("b", "INSTAGRAM", -25 * MIN), w("c", "INSTAGRAM", -20 * MIN),
    w("d", "WHATSAPP", -40 * MIN), w("e", "WHATSAPP", -35 * MIN), w("f", "WHATSAPP", -12 * MIN)], lastBotAnswerAt: {} };
  const open = (lastAlertMs: number): OpenIncident => ({ id: "x", channels: ["INSTAGRAM", "WHATSAPP"], startedAt: at(-40 * MIN),
    lastAlertAt: at(lastAlertMs), missedKeys: ["a", "b", "c", "d", "e", "f"] });

  it("нет эпизода — открыть с самого раннего ждущего, оба канала, шестеро", () => {
    const d = decideBotSilence(silent, null, T);
    expect(d).toMatchObject({ kind: "open", waiting: 6, startedAt: at(-40 * MIN) });
    expect(d.kind === "open" && [...d.channels].sort()).toEqual(["INSTAGRAM", "WHATSAPP"]);
  });
  it("эпизод открыт 5 минут назад — без нового уведомления", () => {
    expect(decideBotSilence(silent, open(-5 * MIN), T)).toMatchObject({ kind: "update", remind: false });
  });
  it("прошёл час — напоминание", () => {
    expect(decideBotSilence(silent, open(-SILENCE_REMIND_MS), T)).toMatchObject({ kind: "update", remind: true });
  });
  it("тревоги нет, но бот ещё никому не ответил (людям ответили вручную) — эпизод не закрывается", () => {
    expect(decideBotSilence({ waiting: [], lastBotAnswerAt: { INSTAGRAM: at(-1 * MIN) } }, open(-5 * MIN), T)).toEqual({ kind: "none" });
  });
  it("бот ответил в каждом замолчавшем канале — восстановление, сколько пропустили и сколько ещё ждут", () => {
    const d = decideBotSilence({ waiting: [w("a", "INSTAGRAM", -30 * MIN)], lastBotAnswerAt: { INSTAGRAM: at(-1 * MIN), WHATSAPP: at(-2 * MIN) } },
      open(-5 * MIN), T);
    expect(d).toEqual({ kind: "recover", missed: 6, stillWaiting: 1 });
  });
  it("канал выключен аварийным рубильником — о нём не тревожим и его «восстановления» не ждём", () => {
    expect(decideBotSilence(silent, null, T, new Set(["INSTAGRAM", "WHATSAPP"]))).toEqual({ kind: "none" });
    const d = decideBotSilence({ waiting: [], lastBotAnswerAt: { INSTAGRAM: at(-1 * MIN) } }, open(-5 * MIN), T, new Set(["WHATSAPP"]));
    expect(d.kind).toBe("recover");
    // Все замолчавшие каналы выключили намеренно — «бот снова отвечает» было бы неправдой: эпизод закрывается молча.
    expect(decideBotSilence({ waiting: [], lastBotAnswerAt: {} }, open(-5 * MIN), T, new Set(["INSTAGRAM", "WHATSAPP"]))).toEqual({ kind: "close" });
  });
});

describe("lastBotAnswerIn: ответ бота — его реплика сразу после реплики клиента", () => {
  it("ответ сотрудника, недоставленный ответ и сообщение без реплики клиента перед ним — не ответ бота", () => {
    expect(lastBotAnswerIn([
      { role: "user", content: "?", at: iso(-30 * MIN) },
      { role: "assistant", content: "ответ", at: iso(-29 * MIN), by: { kind: "agent", agentId: "a" } },
      { role: "user", content: "?", at: iso(-20 * MIN) },
      { role: "assistant", content: "ответ", at: iso(-19 * MIN), deliveryStatus: "failed" },
      { role: "assistant", content: "напоминание", at: iso(-10 * MIN), by: { kind: "bot" } },
    ])).toBeNull();
  });
  it("ответ бота после клиента — есть", () => {
    expect(lastBotAnswerIn([{ role: "user", content: "?", at: iso(-3 * MIN) }, { role: "assistant", content: "да", at: iso(-2 * MIN), by: { kind: "bot" } }]))
      .toEqual(at(-2 * MIN));
  });
});

describe("тексты: по-человечески, без кодов, с числом и временем по Душанбе", () => {
  it("первое уведомление", () => {
    const { title, body } = silenceAlertText({ channels: ["WHATSAPP", "INSTAGRAM"], since: at(-55 * MIN), waiting: 7, reminder: false, now: T });
    expect(title).toBe("Бот перестал отвечать клиентам");
    expect(body).toBe("Бот перестал отвечать клиентам в Instagram и WhatsApp с 15:05. Без ответа уже 7 человек. " +
      "Пока бот молчит, ответьте им вручную в CRM → Чаты и сообщите разработчику.");
    expect(`${title} ${body}`).not.toMatch(TECHNICAL);
  });
  it("напоминание и падежи числа", () => {
    expect(silenceAlertText({ channels: ["INSTAGRAM"], since: at(-55 * MIN), waiting: 3, reminder: true, now: T }).body)
      .toContain("Бот всё ещё не отвечает клиентам в Instagram с 15:05. Без ответа уже 3 человека.");
    expect(silenceAlertText({ channels: ["INSTAGRAM"], since: at(-55 * MIN), waiting: 21, reminder: true, now: T }).body).toContain("21 человек.");
  });
  it("молчание началось вчера — с датой", () => {
    expect(silenceAlertText({ channels: ["FACEBOOK"], since: at(-17 * 60 * MIN), waiting: 4, reminder: false, now: T }).body).toContain("с 09.03 в 23:00");
  });
  it("восстановление", () => {
    const text = silenceRecoveredText({ channels: ["INSTAGRAM", "WHATSAPP", "FACEBOOK", "WEBSITE"], since: at(-4 * 60 * MIN), missed: 9, stillWaiting: 4, now: T });
    expect(text.title).toBe("Бот снова отвечает клиентам");
    expect(text.body).toBe("Бот снова отвечает клиентам в Instagram, WhatsApp, Facebook и чате на сайте. Пока он молчал (с 12:00), " +
      "без ответа остались 9 человек. Ещё ждут ответа: 4 человека, ответьте им в CRM → Чаты.");
    expect(`${text.title} ${text.body}`).not.toMatch(TECHNICAL);
    expect(silenceRecoveredText({ channels: ["INSTAGRAM"], since: at(-60 * MIN), missed: 1, stillWaiting: 0, now: T }).body)
      .toContain("без ответа остался 1 человек. Проверьте их в CRM → Чаты.");
  });
  it("названия каналов — словами", () => {
    expect(channelsInWords(["WEBSITE"])).toBe("в чате на сайте");
  });
});

const { prisma } = await import("../src/db.js");

describe("runBotSilenceWatchTick: на базе", () => {
  const runId = Date.now().toString(36);
  const convIds: string[] = [];
  const eventKeys: string[] = [];
  let n = 0;

  /** Переписка: клиент написал `waitMs` назад (от T), ответа нет. Тикет ядра с причиной `heldCode`, если задана. */
  async function waitingChat(opts: { channel?: string; waitMs?: number; heldCode?: string | null; paused?: boolean; optedOut?: boolean;
    humanAnsweredMs?: number; messages?: unknown[]; ticketMs?: number } = {}) {
    const i = n++;
    const waitMs = opts.waitMs ?? -30 * MIN;
    const eventKey = `${runId}bsw${i}`.padEnd(64, "0").slice(0, 64);
    const history: unknown[] = opts.messages ?? [
      ...(opts.humanAnsweredMs !== undefined ? [{ role: "user", content: "здравствуйте", at: iso(opts.humanAnsweredMs - MIN) },
        { role: "assistant", content: "Добрый день", at: iso(opts.humanAnsweredMs), by: { kind: "agent", agentId: "x" } }] : []),
      { role: "user", content: "Есть двушка в центре?", at: iso(waitMs), ...(opts.heldCode !== undefined ? { customerPropertyAdmission: { eventKey } } : {}) },
    ];
    const conv = await prisma.botConversation.create({ data: { channel: opts.channel ?? "INSTAGRAM", subscriberId: `bsw-${runId}-${i}`,
      lastMessageAt: at(opts.ticketMs ?? waitMs), messages: history as never,
      ...(opts.paused ? { pausedUntil: new Date(Date.now() + 24 * 60 * MIN) } : {}),
      ...(opts.optedOut ? { optedOutAt: at(-2 * 60 * MIN) } : {}) } });
    convIds.push(conv.id);
    if (opts.heldCode !== undefined) {
      eventKeys.push(eventKey);
      await prisma.customerPropertyIngressTicket.create({ data: { eventKey, scopeKey: `bsw-scope-${runId}-${i}`, conversationId: conv.id,
        receivedAt: at(opts.ticketMs ?? waitMs), processingState: "HELD", errorCode: opts.heldCode,
        payloadVersion: 1, payloadCiphertext: "test-ciphertext", payloadHash: "c".repeat(64) } });
    }
    return conv.id;
  }

  /** Бот ответил клиенту в этом канале в момент `ms`. */
  async function botAnswered(channel: string, ms: number) {
    await waitingChat({ channel, messages: [{ role: "user", content: "цена?", at: iso(ms - MIN) },
      { role: "assistant", content: "Цена 50 000 $", at: iso(ms), by: { kind: "bot" } }], ticketMs: ms - MIN });
  }

  async function alertsOf(prefix: string) {
    return prisma.pendingDirectorAlert.findMany({ where: { tag: { startsWith: prefix } }, orderBy: { createdAt: "asc" } });
  }

  beforeEach(async () => {
    await prisma.botSilenceIncident.deleteMany({});
  });
  afterEach(async () => {
    const incidents = await prisma.botSilenceIncident.findMany({ select: { id: true } });
    await prisma.pendingDirectorAlert.deleteMany({ where: { OR: incidents.flatMap(({ id }) => [{ tag: `bot-silence-${id}` }, { tag: `bot-silence-ok-${id}` }]) } });
    await prisma.botSilenceIncident.deleteMany({});
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: eventKeys } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
    convIds.length = 0;
    eventKeys.length = 0;
    delete process.env.CUSTOMER_AGENT_CHANNEL_OFF;
  });

  it("бот замолчал (ход ядра удержан остановленной версией) — одно уведомление директору и администратору простыми словами", async () => {
    await botAnswered("INSTAGRAM", -70 * MIN);
    await waitingChat({ waitMs: -30 * MIN, heldCode: "current_artifact_revision_mismatch" });
    await waitingChat({ waitMs: -25 * MIN, heldCode: "current_artifact_revision_mismatch" });
    await waitingChat({ waitMs: -20 * MIN, heldCode: "current_artifact_revision_mismatch" });
    // Ещё не 10 минут ждёт — не считается.
    await waitingChat({ waitMs: -5 * MIN, heldCode: "current_artifact_revision_mismatch" });

    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "open", alerted: true });
    const incident = await prisma.botSilenceIncident.findFirstOrThrow({ where: { recoveredAt: null } });
    expect(incident.channels).toEqual(["INSTAGRAM"]);
    const [alert] = await alertsOf(`bot-silence-${incident.id}`);
    expect(alert).toMatchObject({ title: "Бот перестал отвечать клиентам", url: "/messages", level: "CRITICAL", urgent: true,
      recipientRoles: ["DIRECTOR", "ADMIN"] });
    expect(alert.body).toBe("Бот перестал отвечать клиентам в Instagram с 15:30. Без ответа уже 3 человека. " +
      "Пока бот молчит, ответьте им вручную в CRM → Чаты и сообщите разработчику.");
    expect(alert.body).not.toMatch(TECHNICAL);
  });

  it("текст клиента не лёг в переписку (поломка раньше записи) — сторож видит его по сообщению ядра", async () => {
    const greeting = [{ role: "assistant", content: "Здравствуйте", at: iso(-5 * 60 * MIN), by: { kind: "bot" } }];
    for (const ms of [-40, -30, -20]) await waitingChat({ channel: "WHATSAPP", messages: greeting, heldCode: "turn_unavailable", ticketMs: ms * MIN });
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "open", alerted: true });
    const incident = await prisma.botSilenceIncident.findFirstOrThrow({ where: { recoveredAt: null } });
    expect(incident.channels).toEqual(["WHATSAPP"]);
    expect((await alertsOf(`bot-silence-${incident.id}`))[0].body).toContain("в WhatsApp с 15:20. Без ответа уже 3 человека.");
  });

  it("бот отвечал кому-то после первого ждущего — не тревога", async () => {
    await waitingChat({ waitMs: -30 * MIN, heldCode: "round_limit" });
    await waitingChat({ waitMs: -25 * MIN, heldCode: "round_limit" });
    await waitingChat({ waitMs: -20 * MIN, heldCode: "round_limit" });
    await botAnswered("INSTAGRAM", -15 * MIN);
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "none", alerted: false });
  });

  it("пауза бота, отписка, намеренное молчание, переписка сотрудника — не считаются", async () => {
    await waitingChat({ waitMs: -30 * MIN, paused: true });
    await waitingChat({ waitMs: -28 * MIN, optedOut: true });
    await waitingChat({ waitMs: -26 * MIN, heldCode: "own_account" });
    await waitingChat({ waitMs: -24 * MIN, heldCode: "spam_muted_no_reply" });
    await waitingChat({ waitMs: -22 * MIN, humanAnsweredMs: -3 * 60 * MIN });
    // Двое настоящих — ниже порога.
    await waitingChat({ waitMs: -20 * MIN, heldCode: "round_limit" });
    await waitingChat({ waitMs: -18 * MIN });
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "none", alerted: false });
    expect(await prisma.botSilenceIncident.count()).toBe(0);
  });

  it("канал выключен аварийным рубильником — тревоги нет", async () => {
    process.env.CUSTOMER_AGENT_CHANNEL_OFF = "instagram";
    for (const ms of [-30, -25, -20]) await waitingChat({ waitMs: ms * MIN, heldCode: "customer_channel_off" });
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "none", alerted: false });
  });

  it("один эпизод — одно уведомление; напоминание через час; «бот снова отвечает» после ответа бота", async () => {
    for (const ms of [-30, -25, -20]) await waitingChat({ waitMs: ms * MIN, heldCode: "current_artifact_revision_mismatch" });
    expect((await runBotSilenceWatchTick(T)).action).toBe("open");
    const incident = await prisma.botSilenceIncident.findFirstOrThrow({ where: { recoveredAt: null } });
    const tag = `bot-silence-${incident.id}`;

    // Тот же эпизод через 5 и 30 минут: новых уведомлений нет, четвёртый клиент попадает в счёт пропущенных.
    expect(await runBotSilenceWatchTick(at(5 * MIN))).toEqual({ action: "update", alerted: false });
    await waitingChat({ waitMs: 10 * MIN, heldCode: "current_artifact_revision_mismatch" });
    expect(await runBotSilenceWatchTick(at(30 * MIN))).toEqual({ action: "update", alerted: false });
    expect(await alertsOf(tag)).toHaveLength(1);

    // Через час — напоминание с числом тех, кто ждёт сейчас.
    expect(await runBotSilenceWatchTick(at(61 * MIN))).toEqual({ action: "update", alerted: true });
    const alerts = await alertsOf(tag);
    expect(alerts).toHaveLength(2);
    expect(alerts[1].title).toBe("Бот всё ещё не отвечает клиентам");
    expect(alerts[1].body).toContain("с 15:30. Без ответа уже 4 человека.");

    // Бот снова ответил новому клиенту; троим ответили вручную, один ещё ждёт.
    await botAnswered("INSTAGRAM", 70 * MIN);
    await prisma.botConversation.updateMany({ where: { id: { in: convIds.slice(0, 3) } }, data: { pausedUntil: new Date(Date.now() + 60 * MIN) } });
    for (const id of convIds.slice(0, 3)) {
      const chat = await prisma.botConversation.findUniqueOrThrow({ where: { id } });
      await prisma.botConversation.update({ where: { id }, data: { messages: [...(chat.messages as unknown[]),
        { role: "assistant", content: "Ответили вручную", at: iso(65 * MIN), by: { kind: "agent", agentId: "x" } }] as never } });
    }
    expect(await runBotSilenceWatchTick(at(75 * MIN))).toEqual({ action: "recover", alerted: true });
    const [ok] = await alertsOf(`bot-silence-ok-${incident.id}`);
    expect(ok.title).toBe("Бот снова отвечает клиентам");
    expect(ok.body).toBe("Бот снова отвечает клиентам в Instagram. Пока он молчал (с 15:30), без ответа остались 4 человека. " +
      "Ещё ждут ответа: 1 человек, ответьте им в CRM → Чаты.");
    expect(ok.urgent).toBe(true);
    expect(ok.body).not.toMatch(TECHNICAL);
    expect((await prisma.botSilenceIncident.findUniqueOrThrow({ where: { id: incident.id } })).recoveredAt).toEqual(at(75 * MIN));

    // После восстановления тихо.
    expect(await runBotSilenceWatchTick(at(80 * MIN))).toEqual({ action: "none", alerted: false });
  });

  it("рубильник выключен — сторож молчит", async () => {
    const before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botSilenceWatchEnabled: true } });
    if (!before) return; // без строки настроек рубильник включён (проверено в automation-switches.test.ts)
    for (const ms of [-30, -25, -20]) await waitingChat({ waitMs: ms * MIN, heldCode: "round_limit" });
    await prisma.settings.update({ where: { id: "singleton" }, data: { botSilenceWatchEnabled: false } });
    try {
      expect(await runBotSilenceWatchTick(T)).toEqual({ action: "off", alerted: false });
      expect(await prisma.botSilenceIncident.count()).toBe(0);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { botSilenceWatchEnabled: before.botSilenceWatchEnabled } });
    }
  });
});
