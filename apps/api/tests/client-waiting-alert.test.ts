import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

// Выключатель «Клиент ждёт ответа» (19.11.2026): подмена только в этом файле, строку Settings тест не трогает.
const switchesOff = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return { ...actual, automationSwitchOn: async (...a: Parameters<typeof actual.automationSwitchOn>) => (switchesOff.has(a[0]) ? false : actual.automationSwitchOn(...a)) };
});

const { prisma } = await import("../src/db.js");
const { alertClientWaiting, runClientSilenceSweep, waitingEpisodeOf, CLIENT_WAITING_MINUTES, repeatClientWaiting, CLIENT_WAITING_REPEAT_MINUTES } = await import(
  "../src/lib/clientWaitingAlert.js"
);

/**
 * «КЛИЕНТ НАПИСАЛ — ЕМУ НИКТО НЕ ОТВЕТИЛ» (14.11.2026, аудит скрытых механизмов №4).
 * Сторож молчания (крон `client-silence-sweep`) и одна дверь `alertClientWaiting`,
 * которую зовёт и ядро бота при «передать сотруднику» без ответа.
 */

const runId = Date.now().toString(36);
const minutesAgo = (n: number, from = new Date()) => new Date(from.getTime() - n * 60_000).toISOString();
let agentId = "";
let inactiveAgentId = "";
const clientIds: string[] = [];
const convIds: string[] = [];
let savedHours: { workHoursStart: string | null; workHoursEnd: string | null } | null = null;

async function conversation(messages: object[], opts: { clientAgentId?: string | null; noClient?: boolean } = {}) {
  let clientId: string | null = null;
  if (!opts.noClient) {
    const client = await prisma.client.create({
      data: {
        fullName: `Ждущий клиент ${runId}-${convIds.length}`,
        phone: `+99291${String(Date.now() + convIds.length).slice(-7)}`,
        source: "INSTAGRAM",
        assignedAgentId: opts.clientAgentId ?? agentId,
      },
    });
    clientId = client.id;
    clientIds.push(client.id);
  }
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `client-waiting-${runId}-${convIds.length}`,
      messages,
      lastMessageAt: new Date(),
      ...(clientId ? { clientId } : {}),
    },
  });
  convIds.push(conv.id);
  return conv.id;
}

const ownPush = (convId: string) =>
  sendPushToAgent.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === `client-waiting-${convId}`);

beforeAll(async () => {
  savedHours = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент ждущих ${runId}`, phone: `+99292${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  inactiveAgentId = (
    await prisma.agent.create({
      data: { fullName: `Уволенный ${runId}`, phone: `+99293${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash: "x", isActive: false },
    })
  ).id;
});

beforeEach(() => sendPushToAgent.mockClear());

afterAll(async () => {
  if (savedHours) await prisma.settings.update({ where: { id: "singleton" }, data: savedHours });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: convIds.map((id) => `client-waiting-${id}`) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, inactiveAgentId] } } });
});

describe("waitingEpisodeOf — хвост неотвеченных реплик", () => {
  it("начало эпизода — ПЕРВАЯ неотвеченная реплика, а не последняя", () => {
    const ep = waitingEpisodeOf([
      { role: "user", content: "старое", at: "2026-11-14T05:00:00Z" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "вопрос", at: "2026-11-14T06:00:00Z", customerPropertyAdmission: { eventKey: "k1" } },
      { role: "user", content: "алло?", at: "2026-11-14T06:20:00Z" },
    ]);
    expect(ep?.since.toISOString()).toBe("2026-11-14T06:00:00.000Z");
    expect(ep?.eventKeys).toEqual(["k1"]);
    expect(ep?.untracked).toBe(1);
  });
  it("последней ответили — молчания нет", () => {
    expect(waitingEpisodeOf([{ role: "user", at: "2026-11-14T06:00:00Z" }, { role: "assistant", content: "да" }])).toBeNull();
  });
  it("недоставленный ответ бота — молчание продолжается", () => {
    const ep = waitingEpisodeOf([
      { role: "user", at: "2026-11-14T06:00:00Z" },
      { role: "assistant", content: "не дошло", deliveryStatus: "failed" },
    ]);
    expect(ep?.since.toISOString()).toBe("2026-11-14T06:00:00.000Z");
  });
  it("реплика, записанная самим кодом (тихий приём номера), эпизод не начинает", () => {
    expect(waitingEpisodeOf([{ role: "assistant", content: "ок" }, { role: "user", at: "2026-11-14T06:00:00Z", silentCapture: true }])).toBeNull();
  });
  it("без отметки времени начало не доказать — молчим", () => {
    expect(waitingEpisodeOf([{ role: "user", content: "старая запись" }])).toBeNull();
    expect(waitingEpisodeOf("not-an-array")).toBeNull();
  });
});

describe("runClientSilenceSweep — сторож молчания", () => {
  it("клиент ждёт дольше порога — пуш закреплённому агенту, один раз на эпизод", async () => {
    const firstAsk = { role: "user", content: "есть 2-комн.?", at: minutesAgo(CLIENT_WAITING_MINUTES + 10) };
    const id = await conversation([firstAsk]);
    await runClientSilenceSweep();
    const first = ownPush(id);
    expect(first).toHaveLength(1);
    expect(first[0][0]).toBe(agentId);
    expect((first[0][1] as { url?: string }).url).toBe(`/messages?open=${id}`);

    // Второй тик — тот же эпизод, сигнала нет.
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(1);

    // Клиент дописал ещё — эпизод тот же.
    await prisma.botConversation.update({
      where: { id },
      data: { messages: [firstAsk, { role: "user", content: "алло", at: minutesAgo(1) }] },
    });
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(1);

    // Ответили, потом снова молчание дольше порога — новый эпизод, новый сигнал.
    await prisma.botConversation.update({
      where: { id },
      data: {
        messages: [
          { role: "user", content: "есть 2-комн.?", at: minutesAgo(200) },
          { role: "assistant", content: "Да, есть" },
          { role: "user", content: "а цена?", at: minutesAgo(CLIENT_WAITING_MINUTES + 5) },
        ],
      },
    });
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(2);
  });

  it("моложе порога — рано", async () => {
    const id = await conversation([{ role: "user", content: "привет", at: minutesAgo(CLIENT_WAITING_MINUTES - 10) }]);
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(0);
  });

  it("агента нет (или он уволен) — срочная тревога руководству, мимо часов алармов", async () => {
    const noClient = await conversation([{ role: "user", content: "здравствуйте", at: minutesAgo(45) }], { noClient: true });
    const firedAgent = await conversation([{ role: "user", content: "здравствуйте", at: minutesAgo(45) }], { clientAgentId: inactiveAgentId });
    await runClientSilenceSweep();
    for (const id of [noClient, firedAgent]) {
      expect(ownPush(id)).toHaveLength(0);
      const row = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `client-waiting-${id}` } });
      expect(row?.urgent).toBe(true);
      expect(row?.level).toBe("CRITICAL");
    }
  });

  it("агент позвонил клиенту после его реплики — разговор был, сигнала нет", async () => {
    const id = await conversation([{ role: "user", content: "перезвоните", at: minutesAgo(50) }]);
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { clientId: true } });
    await prisma.interaction.create({
      data: { clientId: conv.clientId!, agentId, type: "CALL", outcome: "POSITIVE", notes: "дозвонился", createdAt: new Date(Date.now() - 20 * 60_000) },
    });
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(0);
    await prisma.interaction.deleteMany({ where: { clientId: conv.clientId! } });
  });

  it("ядро промолчало намеренно (чужой ролик без вопроса) — сигнала нет", async () => {
    const key = `intentional-${runId}`;
    const id = await conversation([{ role: "user", content: "[reel]", at: minutesAgo(50), customerPropertyAdmission: { eventKey: key } }]);
    const spy = vi
      .spyOn(prisma.customerPropertyIngressTicket, "findMany")
      .mockResolvedValueOnce([{ eventKey: key, errorCode: "foreign_share_no_reply" }] as never);
    await runClientSilenceSweep();
    spy.mockRestore();
    expect(ownPush(id)).toHaveLength(0);
  });

  it("вне часов раздачи сторож молчит", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "03:00", workHoursEnd: "03:01" } });
    try {
      const res = await runClientSilenceSweep(new Date("2026-11-14T12:00:00Z")); // 17:00 Душанбе
      expect(res.skippedOffHours).toBe(true);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
    }
  });
});

describe("alertClientWaiting — «передать сотруднику» без ответа", () => {
  it("эскалация из ядра зовёт агента сразу, повтор того же эпизода (сторож) — молчит и говорит «уже сказали» (R1-2)", async () => {
    const id = await conversation([{ role: "user", content: "позовите человека", at: minutesAgo(1) }]);
    expect(await alertClientWaiting({ conversationId: id, trigger: "escalate" })).toBe("agent");
    const pushed = ownPush(id);
    expect(pushed).toHaveLength(1);
    expect((pushed[0][1] as { body: string }).body).toContain("нужен сотрудник");
    expect(await alertClientWaiting({ conversationId: id, trigger: "silence" })).toBe("already");
    expect(ownPush(id)).toHaveLength(1);
  });

  it("отписка глушит только напоминания бота (silence, follow_up); клиент в корзине — `excluded` (ревью 0e463b02 N5)", async () => {
    const id = await conversation([{ role: "user", content: "стоп", at: minutesAgo(40) }]);
    await prisma.botConversation.update({ where: { id }, data: { optedOutAt: new Date() } });
    expect(await alertClientWaiting({ conversationId: id, trigger: "silence" })).toBe("excluded");
    const trashed = await conversation([{ role: "user", content: "алло", at: minutesAgo(40) }]);
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: trashed }, select: { clientId: true } });
    await prisma.client.update({ where: { id: row.clientId! }, data: { deletedAt: new Date() } });
    expect(await alertClientWaiting({ conversationId: trashed, trigger: "handover", why: "x" })).toBe("excluded");
    expect(ownPush(id)).toHaveLength(0);
    expect(ownPush(trashed)).toHaveLength(0);
  });

  it("отписавшийся клиент, который сам ждёт человека (handover), — сигнал сотруднику идёт: отписка = «бот не пишет первым»", async () => {
    const id = await conversation([{ role: "user", content: "позвоните, хочу посмотреть квартиру", at: minutesAgo(1) }]);
    await prisma.botConversation.update({ where: { id }, data: { optedOutAt: new Date() } });
    expect(["agent", "director"]).toContain(await alertClientWaiting({ conversationId: id, trigger: "handover", why: "x" }));
  });

  /**
   * Review 0e463b02 N4: the core door and the watchdog at the same moment. The loser hears `already` and tells the customer
   * «передал сотруднику» (that line closes the episode, no later tick); the winner's send fails and it clears the mark. Before:
   * one channel-wide log entry per 10 minutes for ALL chats, so a second chat was swallowed. Now: the winner logs THIS chat.
   */
  it("гонка: проигравший слышит `already`, у победителя отправка падает — запись в журнале по КАЖДОМУ такому чату", async () => {
    const raced = async () => {
      const id = await conversation([{ role: "user", content: "есть 2-комн.?", at: minutesAgo(CLIENT_WAITING_MINUTES + 5) }]);
      let loser: string | null = null;
      sendPushToAgent.mockImplementationOnce(async () => {
        loser = await alertClientWaiting({ conversationId: id, trigger: "handover", why: "бот передал разговор сотруднику" });
        throw new Error("push down");
      });
      expect(await alertClientWaiting({ conversationId: id, trigger: "silence" })).toBe("skipped");
      expect(loser).toBe("already");
      return id;
    };
    const first = await raced();
    const second = await raced(); // within the same 10 minutes: its own entry, not swallowed by the first chat's
    const entries = (id: string) => prisma.errorLog.count({ where: { dedupKey: `client-waiting-alert-failed:${id}` } });
    await vi.waitFor(async () => {
      expect(await entries(first)).toBe(1);
      expect(await entries(second)).toBe(1);
    });
    const logged = await prisma.errorLog.findFirstOrThrow({ where: { dedupKey: `client-waiting-alert-failed:${second}` } });
    expect(logged.message).toContain("передал сотруднику");
    expect(logged.url).toBe(`/messages?open=${second}`);
    for (const id of [first, second]) await prisma.errorLog.deleteMany({ where: { dedupKey: `client-waiting-alert-failed:${id}` } });
  });
});

/**
 * ВЗЯЛ ЧАТ И НЕ ОТВЕТИЛ (16.11.2026, аудит молчания: Arvan, клиентка ответила агенту «700 та дорем Ака»,
 * «Ягон варянт боша мегуфте» 15.11 13:48 — бот на паузе, первый пуш один раз, 19 часов тишины).
 * Второй, последний сигнал — ответственному и руководству; паузу бота сторож не трогает.
 */
describe("repeatClientWaiting — человек взял переписку и молчит", () => {
  const repeatPush = (convId: string) =>
    sendPushToAgent.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === `client-waiting-repeat-${convId}`);
  afterAll(async () => {
    await prisma.processedMessage.deleteMany({ where: { channel: { in: ["client-waiting-repeat", "client-waiting-repeat-armed"] },
      OR: convIds.map((id) => ({ messageId: { startsWith: `${id}:` } })) } });
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: convIds.map((id) => `client-waiting-repeat-${id}`) } } });
  });

  it("первый пуш, потом через 2 часа — повтор агенту и руководству, один раз; пауза бота остаётся", async () => {
    const t0 = new Date();
    const ask = { role: "user", content: "Ягон варянт боша мегуфте Ака", at: minutesAgo(40, t0) };
    const id = await conversation([{ role: "assistant", content: "Бюджети шумо чанд аст?", by: { kind: "manual" } }, ask]);
    const pausedUntil = new Date(t0.getTime() + 10 * 365 * 24 * 3600_000);
    await prisma.botConversation.update({ where: { id }, data: { pausedUntil } });

    await runClientSilenceSweep(t0); // первый сигнал эпизода (#174)
    expect(ownPush(id)).toHaveLength(1);
    await runClientSilenceSweep(new Date(t0.getTime() + 10 * 60_000)); // сторож увидел сигнал — таймер взведён
    expect(repeatPush(id)).toHaveLength(0);
    await runClientSilenceSweep(new Date(t0.getTime() + 60 * 60_000)); // рано
    expect(repeatPush(id)).toHaveLength(0);

    const later = new Date(t0.getTime() + (10 + CLIENT_WAITING_REPEAT_MINUTES) * 60_000);
    await runClientSilenceSweep(later);
    const pushed = repeatPush(id);
    expect(pushed).toHaveLength(1);
    expect(pushed[0][0]).toBe(agentId);
    expect((pushed[0][1] as { body: string }).body).toContain("взял сотрудник");
    const director = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `client-waiting-repeat-${id}` } });
    expect(director).toMatchObject({ urgent: true, excludeAgentId: agentId });

    await runClientSilenceSweep(new Date(later.getTime() + 3 * 3600_000)); // тот же эпизод — больше не зовём
    expect(repeatPush(id)).toHaveLength(1);
    expect(ownPush(id)).toHaveLength(1);
    const after = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { pausedUntil: true } });
    expect(after.pausedUntil?.getTime()).toBe(pausedUntil.getTime());
  });

  it("бот не на паузе — повтора нет; человек ответил — повтора нет; прямой вызов без паузы — не «sent» и после таймера (М-1)", async () => {
    const t0 = new Date();
    const notPaused = await conversation([{ role: "assistant", content: "Нарх?", by: { kind: "manual" } }, { role: "user", content: "Нарх 550000с", at: minutesAgo(40, t0) }]);
    const answered = await conversation([{ role: "user", content: "Дар н Рудаки", at: minutesAgo(40, t0) }]);
    await prisma.botConversation.update({ where: { id: answered }, data: { pausedUntil: new Date(t0.getTime() + 12 * 3600_000) } });
    await runClientSilenceSweep(t0);
    await runClientSilenceSweep(new Date(t0.getTime() + 10 * 60_000));
    await prisma.botConversation.update({ where: { id: answered }, data: { messages: [
      { role: "user", content: "Дар н Рудаки", at: minutesAgo(40, t0) },
      { role: "assistant", content: "Хуб, ман занг мезанам", at: minutesAgo(1, new Date(t0.getTime() + 60 * 60_000)), by: { kind: "manual" } },
    ] } });
    await runClientSilenceSweep(new Date(t0.getTime() + (20 + CLIENT_WAITING_REPEAT_MINUTES) * 60_000));
    expect(repeatPush(notPaused)).toHaveLength(0);
    expect(repeatPush(answered)).toHaveLength(0);
    const since = new Date(minutesAgo(40, t0));
    expect(await repeatClientWaiting({ conversationId: notPaused, since, now: new Date(t0.getTime() + 60_000) })).toBe("armed");
    expect(await repeatClientWaiting({ conversationId: notPaused, since, now: new Date(t0.getTime() + 5 * 3600_000) })).toBe("skipped");
  });

  it("паузу поставил сам бот (щит, оффтопик) — «взял сотрудник» не пишем (ревью #205, С-1)", async () => {
    const t0 = new Date();
    const id = await conversation([{ role: "assistant", content: "Чӣ хизмат карда метавонем?" }, { role: "user", content: "Ягон варянт боша", at: minutesAgo(40, t0) }]);
    await prisma.botConversation.update({ where: { id }, data: { pausedUntil: new Date(t0.getTime() + 6 * 3600_000) } });
    await runClientSilenceSweep(t0);
    await runClientSilenceSweep(new Date(t0.getTime() + 10 * 60_000));
    await runClientSilenceSweep(new Date(t0.getTime() + (20 + CLIENT_WAITING_REPEAT_MINUTES) * 60_000));
    expect(ownPush(id)).toHaveLength(1);
    expect(repeatPush(id)).toHaveLength(0);
  });

  it("старая пауза (эпизод старше суток) не будит никого после выкатки; рубильник сторожа пауз выключает повтор (С-2)", async () => {
    const t0 = new Date();
    const since = new Date(t0.getTime() - 25 * 3600_000);
    const old = await conversation([{ role: "assistant", content: "Бюджет?", by: { kind: "manual" } }, { role: "user", content: "700 та дорем Ака", at: since.toISOString() }]);
    await prisma.botConversation.update({ where: { id: old }, data: { pausedUntil: new Date(t0.getTime() + 3600_000), silenceAlertFor: since } });
    expect(await repeatClientWaiting({ conversationId: old, since, now: t0 })).toBe("armed");
    expect(await repeatClientWaiting({ conversationId: old, since, now: new Date(t0.getTime() + 3 * 3600_000) })).toBe("skipped");

    const fresh = await conversation([{ role: "assistant", content: "Бюджет?", by: { kind: "manual" } }, { role: "user", content: "700 та дорем Ака", at: minutesAgo(40, t0) }]);
    await prisma.botConversation.update({ where: { id: fresh }, data: { pausedUntil: new Date(t0.getTime() + 12 * 3600_000) } });
    const saved = await prisma.$queryRaw<{ v: boolean | null }[]>`SELECT "botPauseWatchEnabled" AS v FROM "Settings" WHERE id='singleton'`;
    await prisma.$executeRaw`UPDATE "Settings" SET "botPauseWatchEnabled"=false WHERE id='singleton'`;
    try {
      await runClientSilenceSweep(t0);
      await runClientSilenceSweep(new Date(t0.getTime() + 10 * 60_000));
      await runClientSilenceSweep(new Date(t0.getTime() + (20 + CLIENT_WAITING_REPEAT_MINUTES) * 60_000));
      expect(ownPush(fresh)).toHaveLength(1);
      expect(repeatPush(fresh)).toHaveLength(0);
    } finally {
      await prisma.$executeRaw`UPDATE "Settings" SET "botPauseWatchEnabled"=${saved[0]?.v ?? null} WHERE id='singleton'`;
    }
  });
});

describe("follow_up — звонок агента считается ответом (ревью #205, С-4)", () => {
  it("второе обещание «это скажет агент» после звонка агента доходит; без звонка и ответа — нет", async () => {
    const t0 = Date.now();
    const id = await conversation([{ role: "user", content: "Чавоб метиен?", at: new Date(t0 - 30 * 60_000).toISOString() }]);
    expect(await alertClientWaiting({ conversationId: id, trigger: "follow_up", since: new Date(t0 - 30 * 60_000) })).toBe("agent");
    expect(await alertClientWaiting({ conversationId: id, trigger: "follow_up", since: new Date(t0 - 20 * 60_000) })).toBe("skipped");
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { clientId: true } });
    await prisma.interaction.create({ data: { clientId: conv.clientId!, agentId, type: "CALL", outcome: "POSITIVE", notes: "позвонил",
      createdAt: new Date(t0 - 10 * 60_000) } });
    try {
      expect(await alertClientWaiting({ conversationId: id, trigger: "follow_up", since: new Date(t0 - 5 * 60_000) })).toBe("agent");
      expect(ownPush(id)).toHaveLength(2);
    } finally {
      await prisma.interaction.deleteMany({ where: { clientId: conv.clientId! } });
    }
  });
});

describe("выключатель «Клиент ждёт ответа» (19.11.2026)", () => {
  it("выключен — сторож и дверь молчат, эпизод не занят; включён — тот же эпизод сигналит как раньше", async () => {
    const id = await conversation([{ role: "user", content: "позовите человека", at: minutesAgo(CLIENT_WAITING_MINUTES + 10) }]);
    switchesOff.add("notifyClientWaitingEnabled");
    try {
      const sweep = await runClientSilenceSweep();
      expect(sweep).toEqual({ checked: 0, alerted: 0, skippedOffHours: false });
      // «already», а не «skipped»: вызывающие читают его как «сигнал уже есть» и идут дальше без тревоги в журнал.
      expect(await alertClientWaiting({ conversationId: id, trigger: "escalate" })).toBe("already");
      expect(await repeatClientWaiting({ conversationId: id, since: new Date(), now: new Date() })).toBe("skipped");
      expect(ownPush(id)).toHaveLength(0);
      expect(await prisma.pendingDirectorAlert.count({ where: { tag: `client-waiting-${id}` } })).toBe(0);
    } finally {
      switchesOff.delete("notifyClientWaitingEnabled");
    }
    // Включили обратно — эпизод не был «съеден», сигнал уходит.
    expect(await alertClientWaiting({ conversationId: id, trigger: "escalate" })).toBe("agent");
    expect(ownPush(id)).toHaveLength(1);
  });

  it("клиент в корзине при выключенном выключателе остаётся `excluded` (тишина дверей канала не меняется)", async () => {
    const id = await conversation([{ role: "user", content: "стоп", at: minutesAgo(40) }]);
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { clientId: true } });
    await prisma.client.update({ where: { id: conv.clientId! }, data: { deletedAt: new Date() } });
    switchesOff.add("notifyClientWaitingEnabled");
    try {
      expect(await alertClientWaiting({ conversationId: id, trigger: "escalate" })).toBe("excluded");
    } finally {
      switchesOff.delete("notifyClientWaitingEnabled");
    }
  });
});
