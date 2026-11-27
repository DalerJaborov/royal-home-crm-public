// Сторож «бот замолчал» (владелец 27.11.2026; инцидент 26.11: бот не отвечал с 16:00 до 20:22, узнали по телефону).
// Чистые решения — без базы; тик целиком — на PostgreSQL, на собственном прошлом времени (2021 год): снимок берёт
// строки только «не позже now», так что переписки соседних тестов и параллельных прогонов в него не попадают.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const switches = vi.hoisted(() => ({ value: { WHATSAPP: true, INSTAGRAM: true, FACEBOOK: true, WEBSITE: true } as Record<string, boolean> }));
// Рубильники бота подменяем, чтобы не трогать общую строку Настроек на базе соседних тестов; сама дверь проверена ниже.
vi.mock("../src/messengers/botChannels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/botChannels.js")>()),
  loadBotAnswerSwitches: async () => ({ ...switches.value }),
}));

const {
  decideBotSilence, groupKey, groupsInWords, lastBotAnswerIn, offGroupsOf, runBotSilenceWatchTick, silenceAlertText,
  silenceRecoveredText, silentGroups, SILENCE_MIN_CUSTOMERS, SILENCE_REMIND_MS, SILENCE_STALE_CLOSE_MS,
} = await import("../src/lib/botSilenceWatch.js");
type Snapshot = import("../src/lib/botSilenceWatch.js").SilenceSnapshot;
type Open = import("../src/lib/botSilenceWatch.js").OpenIncident;
const { prisma } = await import("../src/db.js");

const MIN = 60_000;
/** 10.03.2021 11:00 UTC = 16:00 по Душанбе, среда. */
const T = new Date(Date.UTC(2021, 2, 10, 11, 0, 0));
const at = (ms: number) => new Date(T.getTime() + ms);
const iso = (ms: number) => at(ms).toISOString();
const IG = "INSTAGRAM:main";
const WA = "WHATSAPP:main";
const w = (key: string, group: string, ms: number) => ({ key, group, since: at(ms) });
const LABELS = { [IG]: "Instagram", [WA]: "WhatsApp", "INSTAGRAM:arv": "Instagram Арван", "WEBSITE:main": "чате на сайте", "FACEBOOK:main": "Facebook" };
const snap = (s: Partial<Snapshot>): Snapshot => ({ waiting: [], lastBotAnswerAt: {}, lastHumanAnswerAt: {}, offGroups: new Set(), labels: LABELS, ...s });

/** Служебные следы, которых не должно быть в тексте человеку: коды, английские слова, id, названия каналов капсом. */
const TECHNICAL = /[a-z]+_[a-z_]+|current_artifact|revision|mismatch|[0-9a-f]{8}-[0-9a-f]{4}|[Яя]дро|[Вв]ерси|INSTAGRAM|WHATSAPP|FACEBOOK|WEBSITE|:main/;

describe("silentGroups: группа замолчала = трое ждут И бот с тех пор не ответил там никому", () => {
  it("трое ждут, бот отвечал только раньше — замолчала", () => {
    expect(silentGroups(snap({ waiting: [w("a", IG, -30 * MIN), w("b", IG, -25 * MIN), w("c", IG, -20 * MIN)],
      lastBotAnswerAt: { [IG]: at(-60 * MIN) } })).get(IG)?.length).toBe(3);
  });
  it("бот ответил кому-то после первого из ждущих — не поломка", () => {
    expect(silentGroups(snap({ waiting: [w("a", IG, -30 * MIN), w("b", IG, -25 * MIN), w("c", IG, -20 * MIN)],
      lastBotAnswerAt: { [IG]: at(-22 * MIN) } })).size).toBe(0);
  });
  it("двое ждут — ещё не тревога (это сторож «клиент ждёт ответа»)", () => {
    expect(SILENCE_MIN_CUSTOMERS).toBe(3);
    expect(silentGroups(snap({ waiting: [w("a", WA, -30 * MIN), w("b", WA, -25 * MIN)] })).size).toBe(0);
  });
  it("живой аккаунт не прячет мёртвый: второй аккаунт Instagram отвечает, первый молчит — тревога по первому", () => {
    const g = silentGroups(snap({ waiting: [w("a", IG, -30 * MIN), w("b", IG, -25 * MIN), w("c", IG, -20 * MIN)],
      lastBotAnswerAt: { "INSTAGRAM:arv": at(-1 * MIN) } }));
    expect([...g.keys()]).toEqual([IG]);
  });
  it("выключенная группа — не тревога", () => {
    expect(silentGroups(snap({ waiting: [w("a", IG, -30 * MIN), w("b", IG, -25 * MIN), w("c", IG, -20 * MIN)], offGroups: new Set([IG]) })).size).toBe(0);
  });
});

describe("offGroupsOf: намеренно выключенное не тревожит никогда (одна дверь рубильников бота)", () => {
  const all = { WHATSAPP: true, INSTAGRAM: true, FACEBOOK: true, WEBSITE: true };
  const acc = (id: string, over: Partial<{ enabled: boolean; accessLostAt: Date | null; brandName: string | null }> = {}) =>
    ({ id, channel: "INSTAGRAM", enabled: true, accessLostAt: null, brandName: null, title: id, ...over });
  it("рубильник канала выключен — канал и все его аккаунты", () => {
    const off = offGroupsOf({ ...all, INSTAGRAM: false }, [acc("x")], {});
    expect(off.has(IG) && off.has("INSTAGRAM:x")).toBe(true);
    expect(off.has(WA)).toBe(false);
  });
  it("аккаунт выключен или Meta отозвала доступ — только он", () => {
    const off = offGroupsOf(all, [acc("x", { enabled: false }), acc("y", { accessLostAt: T }), acc("z")], {});
    expect([...off].sort()).toEqual(["INSTAGRAM:x", "INSTAGRAM:y"]);
  });
  it("аварийный рубильник: канал и бренд «arvan»", () => {
    expect(offGroupsOf(all, [], { CUSTOMER_AGENT_CHANNEL_OFF: "whatsapp" }).has(WA)).toBe(true);
    const off = offGroupsOf(all, [acc("x", { brandName: "Арван" }), acc("z")], { CUSTOMER_AGENT_CHANNEL_OFF: "arvan" });
    expect(off.has("INSTAGRAM:x")).toBe(true);
    expect(off.has("INSTAGRAM:z")).toBe(false);
  });
});

describe("decideBotSilence: один эпизод, напоминание раз в час, восстановление по ответу бота, закрытие", () => {
  const silent = snap({ waiting: [w("a", IG, -30 * MIN), w("b", IG, -25 * MIN), w("c", IG, -20 * MIN),
    w("d", WA, -40 * MIN), w("e", WA, -35 * MIN), w("f", WA, -12 * MIN)] });
  const open = (lastAlertMs: number, lastActiveMs = lastAlertMs): Open => ({ id: "x", groups: [IG, WA], startedAt: at(-40 * MIN),
    lastAlertAt: at(lastAlertMs), lastActiveAt: at(lastActiveMs), missedKeys: ["a", "b", "c", "d", "e", "f"] });

  it("нет эпизода — открыть с самого раннего ждущего, обе группы, шестеро", () => {
    const d = decideBotSilence(silent, null, T);
    expect(d).toMatchObject({ kind: "open", waiting: 6, startedAt: at(-40 * MIN) });
    expect(d.kind === "open" && [...d.groups].sort()).toEqual([IG, WA]);
  });
  it("эпизод открыт 5 минут назад — без нового уведомления; прошёл час — напоминание", () => {
    expect(decideBotSilence(silent, open(-5 * MIN), T)).toMatchObject({ kind: "update", remind: false });
    expect(decideBotSilence(silent, open(-SILENCE_REMIND_MS), T)).toMatchObject({ kind: "update", remind: true });
  });
  it("людям ответили вручную, бот никому — эпизод не закрывается и не шумит", () => {
    expect(decideBotSilence(snap({ lastBotAnswerAt: { [IG]: at(-1 * MIN) } }), open(-5 * MIN), T)).toEqual({ kind: "none" });
  });
  it("бот ответил в каждой группе — восстановление; кому ответил сотрудник, тот не «остался без ответа»", () => {
    const d = decideBotSilence(snap({ waiting: [w("a", IG, -30 * MIN)], lastBotAnswerAt: { [IG]: at(-1 * MIN), [WA]: at(-2 * MIN) },
      lastHumanAnswerAt: { b: at(-10 * MIN), c: at(-60 * MIN) } }), open(-5 * MIN), T);
    expect(d).toEqual({ kind: "recover", missed: 5, stillWaiting: 1 });
  });
  it("все замолчавшие группы потом выключили — закрыть молча («бот снова отвечает» было бы неправдой)", () => {
    expect(decideBotSilence(snap({ offGroups: new Set([IG, WA]) }), open(-5 * MIN), T)).toEqual({ kind: "close", why: "off" });
  });
  it("никто не ждёт 6 часов — закрыть молча; кто-то ждёт ниже порога — эпизод жив", () => {
    expect(decideBotSilence(snap({}), open(-SILENCE_STALE_CLOSE_MS), T)).toEqual({ kind: "close", why: "stale" });
    expect(decideBotSilence(snap({}), open(-SILENCE_STALE_CLOSE_MS + MIN), T)).toEqual({ kind: "none" });
    expect(decideBotSilence(snap({ waiting: [w("a", IG, -30 * MIN)] }), open(-SILENCE_STALE_CLOSE_MS), T)).toMatchObject({ kind: "update", active: true, remind: false });
  });
});

describe("lastBotAnswerIn: ответ бота — его реплика сразу после реплики клиента", () => {
  it("ответ сотрудника, недоставленный ответ, сообщение не после клиента и ответ «из будущего» — не ответ бота", () => {
    expect(lastBotAnswerIn([
      { role: "user", content: "?", at: iso(-30 * MIN) },
      { role: "assistant", content: "ответ", at: iso(-29 * MIN), by: { kind: "agent", agentId: "a" } },
      { role: "user", content: "?", at: iso(-20 * MIN) },
      { role: "assistant", content: "ответ", at: iso(-19 * MIN), deliveryStatus: "failed" },
      { role: "assistant", content: "напоминание", at: iso(-10 * MIN), by: { kind: "bot" } },
      { role: "user", content: "?", at: iso(4 * MIN) },
      { role: "assistant", content: "позже now", at: iso(5 * MIN), by: { kind: "bot" } },
    ], T)).toBeNull();
  });
  it("ответ бота после клиента — есть", () => {
    expect(lastBotAnswerIn([{ role: "user", content: "?", at: iso(-3 * MIN) }, { role: "assistant", content: "да", at: iso(-2 * MIN), by: { kind: "bot" } }], T))
      .toEqual(at(-2 * MIN));
  });
});

describe("тексты: по-человечески, без кодов, с аккаунтом, числом и временем по Душанбе", () => {
  it("первое уведомление — заголовок не совпадает с тревогой «бот остановился после обновления»", () => {
    const { title, body } = silenceAlertText({ groups: [WA, "INSTAGRAM:arv"], labels: LABELS, since: at(-55 * MIN), waiting: 7, reminder: false, now: T });
    expect(title).toBe("Клиенты ждут: бот не отвечает");
    expect(body).toBe("Бот перестал отвечать клиентам в Instagram Арван и WhatsApp с 15:05. Без ответа уже 7 человек. " +
      "Пока бот молчит, ответьте им вручную в CRM → Чаты и сообщите разработчику.");
    expect(`${title} ${body}`).not.toMatch(TECHNICAL);
  });
  it("напоминание и падежи числа", () => {
    expect(silenceAlertText({ groups: [IG], labels: LABELS, since: at(-55 * MIN), waiting: 3, reminder: true, now: T }).body)
      .toContain("Бот всё ещё не отвечает клиентам в Instagram с 15:05. Без ответа уже 3 человека.");
    expect(silenceAlertText({ groups: [IG], labels: LABELS, since: at(-55 * MIN), waiting: 21, reminder: true, now: T }).body).toContain("21 человек.");
  });
  it("молчание началось вчера — с датой", () => {
    expect(silenceAlertText({ groups: ["FACEBOOK:main"], labels: LABELS, since: at(-17 * 60 * MIN), waiting: 4, reminder: false, now: T }).body)
      .toContain("с 09.03 в 23:00");
  });
  it("восстановление", () => {
    const text = silenceRecoveredText({ groups: [IG, WA, "FACEBOOK:main", "WEBSITE:main"], labels: LABELS, since: at(-4 * 60 * MIN), missed: 9, stillWaiting: 4, now: T });
    expect(text.title).toBe("Бот снова отвечает клиентам");
    expect(text.body).toBe("Бот снова отвечает клиентам в Instagram, WhatsApp, Facebook и чате на сайте. Пока он молчал (с 12:00), " +
      "без ответа остались 9 человек. Ещё ждут ответа: 4 человека, ответьте им в CRM → Чаты.");
    expect(`${text.title} ${text.body}`).not.toMatch(TECHNICAL);
    expect(silenceRecoveredText({ groups: [IG], labels: LABELS, since: at(-60 * MIN), missed: 1, stillWaiting: 0, now: T }).body)
      .toContain("без ответа остался 1 человек. Проверьте их в CRM → Чаты.");
    expect(silenceRecoveredText({ groups: [IG], labels: LABELS, since: at(-60 * MIN), missed: 0, stillWaiting: 0, now: T }).body)
      .toContain("всем написавшим ответили сотрудники.");
  });
  it("без подписи аккаунта — название канала словами", () => {
    expect(groupsInWords(["WEBSITE:main"], {})).toBe("в чате на сайте");
  });
});

describe("loadBotAnswerSwitches: дверь рубильников бота — то же правило, что у ядра", () => {
  it("совпадает с Настройками: общий, канальный, Meta, сайт", async () => {
    const { loadBotAnswerSwitches } = await vi.importActual<typeof import("../src/messengers/botChannels.js")>("../src/messengers/botChannels.js");
    const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botEnabled: true, metaEnabled: true,
      botWhatsappEnabled: true, botInstagramEnabled: true, botFacebookEnabled: true, botWebsiteChatEnabled: true } });
    const bot = s?.botEnabled ?? true;
    const meta = s?.metaEnabled ?? false;
    expect(await loadBotAnswerSwitches()).toEqual({ WHATSAPP: bot && meta && (s?.botWhatsappEnabled ?? true),
      INSTAGRAM: bot && meta && (s?.botInstagramEnabled ?? true), FACEBOOK: bot && meta && (s?.botFacebookEnabled ?? true),
      WEBSITE: bot && (s?.botWebsiteChatEnabled ?? true) });
  });
});

describe("runBotSilenceWatchTick: на базе", () => {
  const runId = Date.now().toString(36);
  const convIds: string[] = [];
  const eventKeys: string[] = [];
  const accountIds: string[] = [];
  let n = 0;
  let arvan = "";
  let lost = "";

  /** Переписка: клиент написал `waitMs` назад (от T), ответа нет. Тикет ядра с причиной `heldCode`, если задана. */
  async function waitingChat(opts: { channel?: string; accountId?: string; waitMs?: number; heldCode?: string; paused?: boolean; optedOut?: boolean;
    humanAnsweredMs?: number; messages?: unknown[]; ticketMs?: number; noLastMessageAt?: boolean } = {}) {
    const i = n++;
    const waitMs = opts.waitMs ?? -30 * MIN;
    const eventKey = `${runId}bsw${i}`.padEnd(64, "0").slice(0, 64);
    const history: unknown[] = opts.messages ?? [
      ...(opts.humanAnsweredMs !== undefined ? [{ role: "user", content: "здравствуйте", at: iso(opts.humanAnsweredMs - MIN) },
        { role: "assistant", content: "Добрый день", at: iso(opts.humanAnsweredMs), by: { kind: "agent", agentId: "x" } }] : []),
      { role: "user", content: "Есть двушка в центре?", at: iso(waitMs), ...(opts.heldCode ? { customerPropertyAdmission: { eventKey } } : {}) },
    ];
    const conv = await prisma.botConversation.create({ data: { channel: opts.channel ?? "INSTAGRAM", subscriberId: `bsw-${runId}-${i}`,
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      ...(opts.noLastMessageAt ? {} : { lastMessageAt: at(opts.ticketMs ?? waitMs) }), messages: history as never,
      ...(opts.paused ? { pausedUntil: new Date(Date.now() + 24 * 60 * MIN) } : {}),
      ...(opts.optedOut ? { optedOutAt: at(-2 * 60 * MIN) } : {}) } });
    convIds.push(conv.id);
    if (opts.heldCode) {
      eventKeys.push(eventKey);
      await prisma.customerPropertyIngressTicket.create({ data: { eventKey, scopeKey: `bsw-scope-${runId}-${i}`, conversationId: conv.id,
        receivedAt: at(opts.ticketMs ?? waitMs), processingState: "HELD", errorCode: opts.heldCode,
        payloadVersion: 1, payloadCiphertext: "test-ciphertext", payloadHash: "c".repeat(64) } });
    }
    return conv.id;
  }

  /** Бот ответил клиенту в этом канале (аккаунте) в момент `ms`. */
  async function botAnswered(channel: string, ms: number, accountId?: string) {
    await waitingChat({ channel, accountId, messages: [{ role: "user", content: "цена?", at: iso(ms - MIN) },
      { role: "assistant", content: "Цена 50 000 $", at: iso(ms), by: { kind: "bot" } }], ticketMs: ms - MIN });
  }

  const alertsOf = (tag: string) => prisma.pendingDirectorAlert.findMany({ where: { tag }, orderBy: { createdAt: "asc" } });
  const openIncident = () => prisma.botSilenceIncident.findFirstOrThrow({ where: { recoveredAt: null } });

  beforeAll(async () => {
    const acc = (title: string, extra: object) => prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `bsw-${runId}-${title}`,
      title, token: "test-token", ...extra } });
    arvan = (await acc("arvan", { brandName: "Арван" })).id;
    lost = (await acc("lost", { brandName: "Старый", accessLostAt: T })).id;
    accountIds.push(arvan, lost);
  });
  beforeEach(async () => {
    switches.value = { WHATSAPP: true, INSTAGRAM: true, FACEBOOK: true, WEBSITE: true };
    await prisma.botSilenceIncident.deleteMany({});
  });
  afterEach(async () => {
    const incidents = await prisma.botSilenceIncident.findMany({ select: { id: true } });
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: incidents.flatMap(({ id }) => [`bot-silence-${id}`, `bot-silence-ok-${id}`]) } } });
    await prisma.botSilenceIncident.deleteMany({});
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: eventKeys } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
    convIds.length = 0;
    eventKeys.length = 0;
    delete process.env.CUSTOMER_AGENT_CHANNEL_OFF;
  });
  afterAll(async () => {
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  });

  it("бот замолчал (ход удержан остановленной версией) — одно уведомление директору и администратору простыми словами", async () => {
    await botAnswered("INSTAGRAM", -70 * MIN);
    await waitingChat({ waitMs: -30 * MIN, heldCode: "current_artifact_revision_mismatch" });
    await waitingChat({ waitMs: -25 * MIN, heldCode: "current_artifact_revision_mismatch" });
    await waitingChat({ waitMs: -20 * MIN, heldCode: "current_artifact_revision_mismatch" });
    await waitingChat({ waitMs: -5 * MIN, heldCode: "current_artifact_revision_mismatch" }); // ждёт меньше 10 минут — не в счёт

    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "open", alerted: true });
    const incident = await openIncident();
    expect(incident.groups).toEqual([IG]);
    const [alert] = await alertsOf(`bot-silence-${incident.id}`);
    expect(alert).toMatchObject({ title: "Клиенты ждут: бот не отвечает", url: "/messages", level: "CRITICAL", urgent: true,
      recipientRoles: ["DIRECTOR", "ADMIN"] });
    expect(alert.body).toBe("Бот перестал отвечать клиентам в Instagram с 15:30. Без ответа уже 3 человека. " +
      "Пока бот молчит, ответьте им вручную в CRM → Чаты и сообщите разработчику.");
    expect(alert.body).not.toMatch(TECHNICAL);
  });

  it("второй аккаунт отвечает, а первый молчит — тревога называет молчащий аккаунт; аккаунт с отозванным доступом не в счёт", async () => {
    for (const ms of [-30, -25, -20]) await waitingChat({ accountId: arvan, waitMs: ms * MIN, heldCode: "turn_unavailable" });
    for (const ms of [-30, -25, -20]) await waitingChat({ accountId: lost, waitMs: ms * MIN, heldCode: "turn_unavailable" });
    await botAnswered("INSTAGRAM", -2 * MIN); // основной аккаунт отвечает
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "open", alerted: true });
    const incident = await openIncident();
    expect(incident.groups).toEqual([`INSTAGRAM:${arvan}`]);
    expect((await alertsOf(`bot-silence-${incident.id}`))[0].body).toContain("в Instagram Арван с 15:30. Без ответа уже 3 человека.");
  });

  it("текст не лёг в переписку, переписка новая и без даты последнего сообщения — сторож видит по сообщению ядра", async () => {
    for (const ms of [-40, -30, -20]) await waitingChat({ channel: "WHATSAPP", messages: [], noLastMessageAt: true, heldCode: "turn_unavailable", ticketMs: ms * MIN });
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "open", alerted: true });
    const incident = await openIncident();
    expect(incident.groups).toEqual([WA]);
    expect((await alertsOf(`bot-silence-${incident.id}`))[0].body).toContain("в WhatsApp с 15:20. Без ответа уже 3 человека.");
  });

  it("бот отвечал кому-то после первого ждущего — не тревога", async () => {
    for (const ms of [-30, -25, -20]) await waitingChat({ waitMs: ms * MIN, heldCode: "round_limit" });
    await botAnswered("INSTAGRAM", -15 * MIN);
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "none", alerted: false });
  });

  it("пауза бота, отписка, намеренное молчание, переписка сотрудника — не считаются", async () => {
    await waitingChat({ waitMs: -30 * MIN, paused: true });
    await waitingChat({ waitMs: -28 * MIN, optedOut: true });
    await waitingChat({ waitMs: -26 * MIN, heldCode: "own_account" });
    await waitingChat({ waitMs: -24 * MIN, heldCode: "spam_muted_no_reply" });
    await waitingChat({ waitMs: -22 * MIN, humanAnsweredMs: -3 * 60 * MIN });
    await waitingChat({ waitMs: -20 * MIN, heldCode: "round_limit" }); // двое настоящих — ниже порога
    await waitingChat({ waitMs: -18 * MIN });
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "none", alerted: false });
    expect(await prisma.botSilenceIncident.count()).toBe(0);
  });

  it("бот выключен рубильником канала в Настройках или аварийным рубильником — тревоги нет", async () => {
    for (const ms of [-30, -25, -20]) await waitingChat({ waitMs: ms * MIN, heldCode: "round_limit" });
    switches.value = { ...switches.value, INSTAGRAM: false };
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "none", alerted: false });
    switches.value = { ...switches.value, INSTAGRAM: true };
    process.env.CUSTOMER_AGENT_CHANNEL_OFF = "instagram";
    expect(await runBotSilenceWatchTick(T)).toEqual({ action: "none", alerted: false });
  });

  it("один эпизод — одно уведомление; напоминание через час; «бот снова отвечает» без тех, кому ответили сотрудники", async () => {
    for (const ms of [-30, -25, -20]) await waitingChat({ waitMs: ms * MIN, heldCode: "current_artifact_revision_mismatch" });
    expect((await runBotSilenceWatchTick(T)).action).toBe("open");
    const incident = await openIncident();
    const tag = `bot-silence-${incident.id}`;

    expect(await runBotSilenceWatchTick(at(5 * MIN))).toEqual({ action: "update", alerted: false });
    await waitingChat({ waitMs: 10 * MIN, heldCode: "current_artifact_revision_mismatch" });
    expect(await runBotSilenceWatchTick(at(30 * MIN))).toEqual({ action: "update", alerted: false });
    expect(await alertsOf(tag)).toHaveLength(1);

    expect(await runBotSilenceWatchTick(at(61 * MIN))).toEqual({ action: "update", alerted: true });
    const alerts = await alertsOf(tag);
    expect(alerts).toHaveLength(2);
    expect(alerts[1].title).toBe("Бот всё ещё не отвечает клиентам");
    expect(alerts[1].body).toContain("с 15:30. Без ответа уже 4 человека.");

    // Бот снова ответил новому клиенту; троим ответили сотрудники, один ещё ждёт.
    await botAnswered("INSTAGRAM", 70 * MIN);
    for (const id of convIds.slice(0, 3)) {
      const chat = await prisma.botConversation.findUniqueOrThrow({ where: { id } });
      await prisma.botConversation.update({ where: { id }, data: { pausedUntil: new Date(Date.now() + 60 * MIN), messages: [...(chat.messages as unknown[]),
        { role: "assistant", content: "Ответили вручную", at: iso(65 * MIN), by: { kind: "agent", agentId: "x" } }] as never } });
    }
    expect(await runBotSilenceWatchTick(at(75 * MIN))).toEqual({ action: "recover", alerted: true });
    const [ok] = await alertsOf(`bot-silence-ok-${incident.id}`);
    expect(ok.title).toBe("Бот снова отвечает клиентам");
    expect(ok.body).toBe("Бот снова отвечает клиентам в Instagram. Пока он молчал (с 15:30), без ответа остался 1 человек. " +
      "Ещё ждут ответа: 1 человек, ответьте им в CRM → Чаты.");
    expect(ok.urgent).toBe(true);
    expect(ok.body).not.toMatch(TECHNICAL);
    expect((await prisma.botSilenceIncident.findUniqueOrThrow({ where: { id: incident.id } })).recoveredAt).toEqual(at(75 * MIN));
    expect(await runBotSilenceWatchTick(at(80 * MIN))).toEqual({ action: "none", alerted: false });
  });

  it("в замолчавшей группе никто не ждёт 6 часов — эпизод закрывается молча, без «бот снова отвечает»", async () => {
    for (const ms of [-30, -25, -20]) await waitingChat({ waitMs: ms * MIN, heldCode: "round_limit" });
    expect((await runBotSilenceWatchTick(T)).action).toBe("open");
    const incident = await openIncident();
    expect(await runBotSilenceWatchTick(at(7 * 60 * MIN))).toEqual({ action: "close", alerted: false });
    expect((await prisma.botSilenceIncident.findUniqueOrThrow({ where: { id: incident.id } })).recoveredAt).not.toBeNull();
    expect(await alertsOf(`bot-silence-ok-${incident.id}`)).toHaveLength(0);
  });

  it("рубильник сторожа выключен — сторож молчит", async () => {
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
