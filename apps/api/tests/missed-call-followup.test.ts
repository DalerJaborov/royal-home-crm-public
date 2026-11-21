import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));

/** Payom подменён: настоящая отправка не выходит в сеть, строка журнала пишется как у настоящей. */
const sendSmsMock = vi.fn();
vi.mock("../src/lib/sms/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/sms/index.js")>();
  return {
    ...actual,
    smsConfigured: async () => true,
    sendSms: (...args: unknown[]) => sendSmsMock(...args),
  };
});

const { prisma } = await import("../src/db.js");
const { waitFor } = await import("./helpers/waitFor.js");
const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const { resetIncomingCalls } = await import("../src/lib/telephony/incomingCalls.js");
const { resetCalls } = await import("../src/lib/telephony/callTracker.js");
const {
  sendMissedCallSms,
  normalizeMissedCallSmsText,
  closeMissedCallTasksAnsweredInWhatsapp,
  countMissedCallSmsSent,
  MISSED_CALL_SMS_DAILY_CAP,
} = await import("../src/lib/telephony/missedCallFollowup.js");
const { isTajikMobileNumber, tajikNationalNumber } = await import("@royal-home/shared");
const { evaluateFunctions } = await import("../src/lib/functionStatus.js");

/**
 * Пропущенный входящий звонок не теряется (18.11.2026): рубильник А (СМС со ссылкой на WhatsApp) и
 * рубильник Б (карточка и общая задача по незнакомому пропущенному). Каждое условие отдельно.
 */

const runId = Date.now();
let seq = 0;
/** Уникальный мобильный номер (9 цифр, начинается с 9). */
const mobile = () => `9${String(runId + ++seq * 7919).slice(-8)}`;
const full = (national: string) => `+992${national}`;
const sms = (national: string) => `992${national}`;

const DEFAULT_TEXT =
  "Салом. Шумо занг задед, мо ҷавоб дода натавонистем. Ба WhatsApp нависед: https://wa.me/992777776001 Вы звонили, мы не успели ответить. Напишите нам в WhatsApp.";

let saved: { missedCallSmsEnabled: boolean; missedCallSmsText: string; missedCallCallbackTaskEnabled: boolean; incomingAutoCreateClient: boolean } | null = null;
let agentId = "";
let directorId = "";
const phones: string[] = [];
const track = (national: string) => {
  phones.push(national);
  return national;
};

async function setSettings(data: Record<string, unknown>) {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: data, create: { id: "singleton", ...data } });
}

beforeAll(async () => {
  const row = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = {
    missedCallSmsEnabled: row.missedCallSmsEnabled,
    missedCallSmsText: row.missedCallSmsText,
    missedCallCallbackTaskEnabled: row.missedCallCallbackTaskEnabled,
    incomingAutoCreateClient: row.incomingAutoCreateClient,
  };
  agentId = (await prisma.agent.create({ data: { fullName: `Агент СМС ${runId}`, phone: `+99295${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" } })).id;
  directorId = (await prisma.agent.create({ data: { fullName: `Директор СМС ${runId}`, phone: `+99296${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash: "x" } })).id;
});

afterEach(async () => {
  resetIncomingCalls();
  resetCalls();
  sendPushToAgent.mockClear();
  sendSmsMock.mockReset();
  sendSmsMock.mockImplementation(async (p: { phone: string; text: string; purpose: string; clientId?: string | null }) => {
    const row = await prisma.smsMessage.create({
      data: { phone: p.phone, purpose: p.purpose, text: p.text, status: "SENT", provider: "payom", parts: 3, clientId: p.clientId ?? null },
    });
    return { ok: true, id: row.id, parts: 3 };
  });
  await setSettings({ missedCallSmsEnabled: true, missedCallSmsText: DEFAULT_TEXT, missedCallCallbackTaskEnabled: false, incomingAutoCreateClient: true });
});

afterAll(async () => {
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  const tails = phones.map((p) => p);
  await prisma.smsMessage.deleteMany({ where: { OR: [{ phone: { in: tails.map(sms) } }, { text: { startsWith: "FUSE" } }] } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: { in: tails.map(sms) } } });
  const clients = await prisma.client.findMany({ where: { OR: tails.map((t) => ({ phone: { endsWith: t } })) }, select: { id: true } });
  const ids = clients.map((c) => c.id);
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.incomingCall.deleteMany({ where: { OR: tails.map((t) => ({ phone: { endsWith: t } })) } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.$disconnect();
});

beforeAll(() => {
  sendSmsMock.mockImplementation(async () => ({ ok: true, id: "x", parts: 3 }));
});

const smsCount = (national: string) => prisma.smsMessage.count({ where: { phone: sms(national), purpose: "MISSED_CALL_WA" } });

describe("общее правило номера (packages/shared)", () => {
  it("мобильный таджикский: три записи номера, городской и иностранный не проходят", () => {
    expect(tajikNationalNumber("+992 90 123 45 67")).toBe("901234567");
    expect(tajikNationalNumber("0901234567")).toBe("901234567");
    expect(isTajikMobileNumber("901234567")).toBe(true);
    expect(isTajikMobileNumber("+992777776001")).toBe(true);
    expect(isTajikMobileNumber("+992446501414")).toBe(false);
    expect(isTajikMobileNumber("+79161234567")).toBe(false);
    expect(isTajikMobileNumber("")).toBe(false);
  });
});

describe("рубильник А: СМС после пропущенного звонка", () => {
  it("выключено: ничего не отправляется", async () => {
    await setSettings({ missedCallSmsEnabled: false });
    const n = track(mobile());
    expect((await sendMissedCallSms({ phone: full(n) })).status).toBe("disabled");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("включено: одна СМС на двух языках, ровно утверждённый текст, причина MISSED_CALL_WA", async () => {
    const n = track(mobile());
    const res = await sendMissedCallSms({ phone: full(n) });
    expect(res.status).toBe("sent");
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    const arg = sendSmsMock.mock.calls[0][0] as { phone: string; text: string; purpose: string };
    expect(arg).toMatchObject({ phone: sms(n), purpose: "MISSED_CALL_WA", text: DEFAULT_TEXT });
    expect(arg.text.startsWith("Салом. ")).toBe(true);
    expect(arg.text).toContain("https://wa.me/992777776001 ");
    expect(arg.text).not.toContain("?text=");
    expect(arg.text).not.toMatch(/[‒-―−]/);
    expect(Array.from(arg.text).length).toBe(159);
    expect(await smsCount(n)).toBe(1);
  });

  it("умолчание в базе совпадает с утверждённым текстом", async () => {
    const fresh = await prisma.$queryRaw<{ d: string }[]>`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'Settings' AND column_name = 'missedCallSmsText'`;
    expect(fresh[0].d).toContain(DEFAULT_TEXT);
    const off = await prisma.$queryRaw<{ d: string }[]>`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'Settings' AND column_name IN ('missedCallSmsEnabled', 'missedCallCallbackTaskEnabled')`;
    expect(off.map((r) => r.d)).toEqual(["false", "false"]);
  });

  it("длинное тире в тексте заменяется дефисом перед отправкой", async () => {
    expect(normalizeMissedCallSmsText("Салом — вы звонили – пишите")).toBe("Салом - вы звонили - пишите");
    await setSettings({ missedCallSmsText: "Салом — пишите https://wa.me/992777776001" });
    const n = track(mobile());
    await sendMissedCallSms({ phone: full(n) });
    expect((sendSmsMock.mock.calls[0][0] as { text: string }).text).not.toMatch(/[‒-―−]/);
  });

  it("клиент с закреплённым агентом получает СМС тоже, а в хронологии карточки остаётся строка", async () => {
    const n = track(mobile());
    const client = await prisma.client.create({
      data: { fullName: `Клиент с агентом ${runId}`, phone: full(n), source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
    });
    const res = await sendMissedCallSms({ phone: full(n), clientId: client.id });
    expect(res.status).toBe("sent");
    const row = await prisma.interaction.findFirst({ where: { clientId: client.id, notes: { contains: "отправили СМС" } } });
    expect(row).not.toBeNull();
    expect(row?.nextAction).toBeNull();
  });

  it("не чаще одной СМС на номер за 24 часа; через сутки снова можно", async () => {
    const n = track(mobile());
    expect((await sendMissedCallSms({ phone: full(n) })).status).toBe("sent");
    expect((await sendMissedCallSms({ phone: full(n) })).status).toBe("cooldown");
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    await prisma.smsMessage.updateMany({ where: { phone: sms(n) }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    expect((await sendMissedCallSms({ phone: full(n) })).status).toBe("sent");
  });

  it("два звонка подряд одновременно: СМС одна", async () => {
    const n = track(mobile());
    const [a, b] = await Promise.all([sendMissedCallSms({ phone: full(n) }), sendMissedCallSms({ phone: full(n) })]);
    expect([a.status, b.status].sort()).toEqual(["in_flight", "sent"].sort());
    expect(await smsCount(n)).toBe(1);
  });

  it("номер без возможности доставки: городской, иностранный, обрывок, пустой", async () => {
    expect((await sendMissedCallSms({ phone: "+992446501414" })).status).toBe("not_mobile");
    expect((await sendMissedCallSms({ phone: "+79161234567" })).status).toBe("no_phone");
    expect((await sendMissedCallSms({ phone: "12345" })).status).toBe("no_phone");
    expect((await sendMissedCallSms({ phone: null })).status).toBe("no_phone");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("номер сотрудника и номер самой компании исключены", async () => {
    const staff = track(mobile());
    const agent = await prisma.agent.create({ data: { fullName: `Сотрудник ${runId}`, phone: full(staff), role: "AGENT", passwordHash: "x" } });
    try {
      expect((await sendMissedCallSms({ phone: full(staff) })).status).toBe("staff");
    } finally {
      await prisma.agent.delete({ where: { id: agent.id } });
    }
    // 777776001 — WhatsApp компании, он же в ссылке текста: звонок с него «свой».
    expect((await sendMissedCallSms({ phone: "+992777776001" })).status).toBe("company_number");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("служебный номер (дважды «не по делу») исключён", async () => {
    const n = track(mobile());
    await prisma.incomingCall.createMany({
      data: [1, 2].map((i) => ({ channelId: `svc-${runId}-${n}-${i}`, phone: full(n), irrelevant: true })),
    });
    expect((await sendMissedCallSms({ phone: full(n) })).status).toBe("service_number");
  });

  it("писал нам в WhatsApp за последние 24 часа: не шлём; писал давно: шлём", async () => {
    const recent = track(mobile());
    await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: sms(recent), lastMessageAt: new Date(Date.now() - 3 * 3600_000) } });
    expect((await sendMissedCallSms({ phone: full(recent) })).status).toBe("wrote_whatsapp");

    const old = track(mobile());
    await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: sms(old), lastMessageAt: new Date(Date.now() - 30 * 3600_000) } });
    expect((await sendMissedCallSms({ phone: full(old) })).status).toBe("sent");
    // Диалог в Instagram с тем же идентификатором номером не считается.
    const ig = track(mobile());
    await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: sms(ig), lastMessageAt: new Date() } });
    expect((await sendMissedCallSms({ phone: full(ig) })).status).toBe("sent");
  });

  it("отказ Payom: звонок не ломается, повтора нет, следующая попытка только через сутки", async () => {
    const n = track(mobile());
    sendSmsMock.mockImplementationOnce(async (p: { phone: string; text: string; purpose: string }) => {
      await prisma.smsMessage.create({ data: { phone: p.phone, purpose: p.purpose, text: p.text, status: "FAILED", provider: "payom", error: "refused" } });
      return { ok: false, error: "refused" };
    });
    expect((await sendMissedCallSms({ phone: full(n) })).status).toBe("failed");
    expect((await sendMissedCallSms({ phone: full(n) })).status).toBe("cooldown");
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    // Исключение транспорта тоже не вылетает наружу.
    const m = track(mobile());
    sendSmsMock.mockRejectedValueOnce(new Error("сеть"));
    expect((await sendMissedCallSms({ phone: full(m) })).status).toBe("error");
  });

  it("предохранитель: больше суточного предела СМС не уходит", async () => {
    const before = await prisma.smsMessage.count({ where: { purpose: "MISSED_CALL_WA", createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } });
    const need = Math.max(0, MISSED_CALL_SMS_DAILY_CAP - before);
    await prisma.smsMessage.createMany({
      data: Array.from({ length: need }, (_, i) => ({ phone: `99200${String(i).padStart(7, "0")}`, purpose: "MISSED_CALL_WA", text: "FUSE", status: "SENT" })),
    });
    try {
      const n = track(mobile());
      expect((await sendMissedCallSms({ phone: full(n) })).status).toBe("daily_cap");
      expect(sendSmsMock).not.toHaveBeenCalled();
    } finally {
      await prisma.smsMessage.deleteMany({ where: { text: "FUSE" } });
    }
  });

  it("реестр функций: выключено, и «включено, отправлено N за 7 дней»", async () => {
    const n = track(mobile());
    await sendMissedCallSms({ phone: full(n) });
    const sent = await countMissedCallSmsSent();
    expect(sent).toBeGreaterThanOrEqual(1);
    const base = {
      now: new Date(),
      env: {},
      spend: null,
      heartbeats: [],
      errors: [],
    };
    const settings = (on: boolean, taskOn: boolean) =>
      ({
        botPauseWatchEnabled: true, botPauseAlertHours: 24, botPauseEscalateHours: 72, botCanSendPhotos: true, botPhotosPerOffer: 3,
        botCanSendVoiceReplies: false, botLeadOnlyMode: false, liveVoiceEnabled: false, liveVoiceInboundMode: "off", liveVoiceProvider: "google",
        telegramPortalAlertsPaused: true, groundedSearchEnabled: false, narrationAutoGenerate: false, alarmHoursStart: "09:50", alarmHoursEnd: "14:45",
        geminiSpareKeyInSettings: false, openaiEnabled: false, missedCallSmsEnabled: on, missedCallSmsSent7d: 4, missedCallCallbackTaskEnabled: taskOn,
      }) as Parameters<typeof evaluateFunctions>[0]["settings"];
    const off = evaluateFunctions({ ...base, settings: settings(false, false) }).items;
    expect(off.find((i) => i.key === "missed-call-sms")?.state).toBe("off");
    expect(off.find((i) => i.key === "missed-call-callback-task")?.state).toBe("off");
    const on = evaluateFunctions({ ...base, settings: settings(true, true) }).items;
    expect(on.find((i) => i.key === "missed-call-sms")).toMatchObject({ state: "working" });
    expect(on.find((i) => i.key === "missed-call-sms")?.reason).toContain("4");
    expect(on.find((i) => i.key === "missed-call-callback-task")?.state).toBe("working");
  });
});

/** События станции, как в incoming-calls.test.ts. */
function inboundChannel(id: string, callerNumber: string) {
  return { id, name: `SIP/out-${id}`, state: "Ring", caller: { number: callerNumber }, dialplan: { context: "ext-queues", exten: "1000" } };
}
const ring = (id: string, caller: string) => handleAriEvent({ type: "ChannelCreated", channel: inboundChannel(id, caller) });
const hangup = (id: string) => handleAriEvent({ type: "ChannelDestroyed", channel: inboundChannel(id, "0") });
async function bridge(channelId: string) {
  await handleAriEvent({
    type: "ChannelEnteredBridge",
    channel: { id: "op-1", name: "SIP/1001-00000012", state: "Up", caller: {} },
    bridge: { id: `b-${channelId}`, channels: [channelId, "op-1"] },
  });
}

describe("рубильник А: на настоящем звонке станции", () => {
  it("неотвеченный входящий: СМС сразу, в любое время суток; отвеченный: ничего", async () => {
    const missed = track(mobile());
    await ring(`ms-${runId}-a`, missed);
    await hangup(`ms-${runId}-a`);
    await waitFor(async () => (await smsCount(missed)) === 1);
    expect(await smsCount(missed)).toBe(1);

    const answered = track(mobile());
    await ring(`ms-${runId}-b`, answered);
    await bridge(`ms-${runId}-b`);
    await new Promise((r) => setTimeout(r, 1200));
    await hangup(`ms-${runId}-b`);
    await new Promise((r) => setTimeout(r, 500));
    expect(await smsCount(answered)).toBe(0);
  });

  it("рубильник выключен: тот же звонок СМС не даёт, пуш руководству остаётся", async () => {
    await setSettings({ missedCallSmsEnabled: false });
    const n = track(mobile());
    await ring(`ms-${runId}-off`, n);
    await hangup(`ms-${runId}-off`);
    await new Promise((r) => setTimeout(r, 700));
    expect(await smsCount(n)).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
    const record = await prisma.incomingCall.findUnique({ where: { channelId: `ms-${runId}-off` } });
    expect(record?.answered).toBe(false);
  });

  it("клиент с агентом: задача и пуш агенту остаются как были, и СМС тоже уходит", async () => {
    const n = track(mobile());
    const client = await prisma.client.create({ data: { fullName: `Клиент агента ${runId}-${n}`, phone: full(n), source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() } });
    await ring(`ms-${runId}-ag`, n);
    await hangup(`ms-${runId}-ag`);
    await waitFor(async () => (await smsCount(n)) === 1);
    const record = await prisma.incomingCall.findUnique({ where: { channelId: `ms-${runId}-ag` } });
    expect(record?.callbackAgentId).toBe(agentId);
    const task = await prisma.interaction.findFirst({ where: { clientId: client.id, autoTaskKind: "inbound_missed_callback", nextAction: { not: null } } });
    expect(task).not.toBeNull();
    const agentPush = sendPushToAgent.mock.calls.filter((c) => (c[1] as { title?: string })?.title === "📞 Пропущенный звонок клиента");
    expect(agentPush).toHaveLength(1);
  });
});

/** Канал шлюза WhatsApp на станции (lib/telephony/callSource.ts, 18.11.2026). */
function whatsappChannel(id: string, callerNumber: string) {
  return { id, name: `PJSIP/whatsapp-gw-${id}`, state: "Ring", caller: { number: callerNumber, name: "WhatsApp" }, dialplan: { context: "from-trunk-whatsapp", exten: "6501414" } };
}

describe("рубильник А: звонок из WhatsApp СМС не получает (владелец 18.11.2026)", () => {
  it("одна дверь: callSource=whatsapp — отказ whatsapp_call без отправки; phone и без источника — как раньше", async () => {
    const wa = track(mobile());
    expect((await sendMissedCallSms({ phone: full(wa), callSource: "whatsapp" })).status).toBe("whatsapp_call");
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(await smsCount(wa)).toBe(0);

    const line = track(mobile());
    expect((await sendMissedCallSms({ phone: full(line), callSource: "phone" })).status).toBe("sent");
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    const legacy = track(mobile());
    expect((await sendMissedCallSms({ phone: full(legacy) })).status).toBe("sent");
  });

  it("на событиях станции: пропущенный через шлюз WhatsApp — без СМС; пропущенный с линии — СМС уходит", async () => {
    const wa = track(mobile());
    const waId = `ms-${runId}-wa`;
    await handleAriEvent({ type: "ChannelCreated", channel: whatsappChannel(waId, wa) });
    await handleAriEvent({ type: "ChannelDestroyed", channel: whatsappChannel(waId, "0") });
    const record = await waitFor(() => prisma.incomingCall.findFirst({ where: { channelId: waId, endedAt: { not: null } } }));
    expect(record?.source).toBe("whatsapp");
    expect(record?.answered).toBe(false);

    const line = track(mobile());
    await ring(`ms-${runId}-line`, line);
    await hangup(`ms-${runId}-line`);
    await waitFor(async () => (await smsCount(line)) === 1);
    // Звонок с линии дошёл до СМС — значит, и звонок из WhatsApp свою развилку уже прошёл.
    expect(await smsCount(wa)).toBe(0);
    expect(sendSmsMock.mock.calls.map((c) => (c[0] as { phone: string }).phone)).toEqual([sms(line)]);
  });

  it("без СМС задача «перезвонить» остаётся: клиент с агентом — агенту и пуш агенту", async () => {
    const n = track(mobile());
    const client = await prisma.client.create({ data: { fullName: `Клиент WA агента ${runId}-${n}`, phone: full(n), source: "WHATSAPP", assignedAgentId: agentId, acceptedAt: new Date() } });
    const id = `ms-${runId}-wa-ag`;
    await handleAriEvent({ type: "ChannelCreated", channel: whatsappChannel(id, n) });
    await handleAriEvent({ type: "ChannelDestroyed", channel: whatsappChannel(id, "0") });
    const task = await waitFor(() =>
      prisma.interaction.findFirst({ where: { clientId: client.id, autoTaskKind: "inbound_missed_callback", nextAction: { not: null } } })
    );
    expect(task?.notes).toBe("Входящий звонок клиента из WhatsApp: до оператора не дозвонился");
    const record = await prisma.incomingCall.findUnique({ where: { channelId: id } });
    expect(record?.callbackAgentId).toBe(agentId);
    await waitFor(() => sendPushToAgent.mock.calls.some((c) => (c[1] as { title?: string })?.title === "📞 Пропущенный звонок клиента"));
    expect(await smsCount(n)).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("без СМС задача «перезвонить» остаётся: незнакомый номер — карточка и общая задача", async () => {
    await setSettings({ missedCallCallbackTaskEnabled: true });
    const n = track(mobile());
    const id = `ms-${runId}-wa-new`;
    await handleAriEvent({ type: "ChannelCreated", channel: whatsappChannel(id, n) });
    await handleAriEvent({ type: "ChannelDestroyed", channel: whatsappChannel(id, "0") });
    const client = await waitFor(async () => (await prisma.client.findFirst({ where: { phone: { endsWith: n } } })) ?? false);
    const clientId = (client as { id: string }).id;
    const waTasks = () =>
      prisma.interaction.findMany({ where: { clientId, autoTaskKind: "inbound_missed_callback", nextAction: { not: null }, completedAt: null } });
    await waitFor(async () => (await waTasks()).length === 1);
    expect((await waTasks())[0].subjectAgentId).toBeNull();
    expect((client as { source: string }).source).toBe("WHATSAPP");
    expect(await smsCount(n)).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});

describe("рубильник Б: задача по незнакомому пропущенному", () => {
  const openTasks = (clientId: string) =>
    prisma.interaction.findMany({ where: { clientId, autoTaskKind: "inbound_missed_callback", nextAction: { not: null }, completedAt: null } });

  it("выключено: карточки и задачи нет, как раньше", async () => {
    await setSettings({ missedCallSmsEnabled: false, missedCallCallbackTaskEnabled: false });
    const n = track(mobile());
    await ring(`mt-${runId}-off`, n);
    await hangup(`mt-${runId}-off`);
    await new Promise((r) => setTimeout(r, 700));
    expect(await prisma.client.count({ where: { phone: { endsWith: n } } })).toBe(0);
  });

  it("включено: карточка и ОДНА общая задача; повторный пропущенный её поднимает, а не плодит", async () => {
    await setSettings({ missedCallSmsEnabled: false, missedCallCallbackTaskEnabled: true });
    const n = track(mobile());
    await ring(`mt-${runId}-1`, n);
    await hangup(`mt-${runId}-1`);
    const client = await waitFor(async () => (await prisma.client.findFirst({ where: { phone: { endsWith: n } } })) ?? false);
    expect(client).toBeTruthy();
    const clientId = (client as { id: string }).id;
    await waitFor(async () => (await openTasks(clientId)).length === 1);
    const first = (await openTasks(clientId))[0];
    expect(first.subjectAgentId).toBeNull();
    // Руководству ушёл пуш (прежний механизм notifyMissed).
    expect(sendPushToAgent.mock.calls.some((c) => (c[1] as { title?: string })?.title === "📞 Пропущенный звонок")).toBe(true);

    await ring(`mt-${runId}-2`, n);
    await hangup(`mt-${runId}-2`);
    await new Promise((r) => setTimeout(r, 900));
    const again = await openTasks(clientId);
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(first.id);
    expect(await prisma.client.count({ where: { phone: { endsWith: n } } })).toBe(1);
  });

  it("задача закрывается сама, когда номер дозвонился", async () => {
    await setSettings({ missedCallSmsEnabled: false, missedCallCallbackTaskEnabled: true });
    const n = track(mobile());
    await ring(`mt-${runId}-c1`, n);
    await hangup(`mt-${runId}-c1`);
    const client = (await waitFor(async () => (await prisma.client.findFirst({ where: { phone: { endsWith: n } } })) ?? false)) as { id: string };
    await waitFor(async () => (await openTasks(client.id)).length === 1);
    await ring(`mt-${runId}-c2`, n);
    await bridge(`mt-${runId}-c2`);
    await new Promise((r) => setTimeout(r, 1200));
    await hangup(`mt-${runId}-c2`);
    await waitFor(async () => (await openTasks(client.id)).length === 0);
    expect(await openTasks(client.id)).toHaveLength(0);
  });

  it("задача закрывается, когда человек сам написал в WhatsApp", async () => {
    await setSettings({ missedCallSmsEnabled: false, missedCallCallbackTaskEnabled: true });
    const n = track(mobile());
    await ring(`mt-${runId}-w1`, n);
    await hangup(`mt-${runId}-w1`);
    const client = (await waitFor(async () => (await prisma.client.findFirst({ where: { phone: { endsWith: n } } })) ?? false)) as { id: string };
    await waitFor(async () => (await openTasks(client.id)).length === 1);
    // Написал ДО задачи: не считается.
    await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: sms(n), lastMessageAt: new Date(Date.now() - 6 * 3600_000) } });
    await closeMissedCallTasksAnsweredInWhatsapp();
    expect(await openTasks(client.id)).toHaveLength(1);
    // Написал ПОСЛЕ задачи: закрыта.
    await prisma.botConversation.updateMany({ where: { subscriberId: sms(n) }, data: { lastMessageAt: new Date(Date.now() + 1000) } });
    await closeMissedCallTasksAnsweredInWhatsapp();
    expect(await openTasks(client.id)).toHaveLength(0);
  });

  it("иностранный номер и городской без WhatsApp-повода: карточка по иностранному не заводится", async () => {
    await setSettings({ missedCallSmsEnabled: false, missedCallCallbackTaskEnabled: true });
    await ring(`mt-${runId}-fr`, "+79161230000");
    await hangup(`mt-${runId}-fr`);
    await new Promise((r) => setTimeout(r, 700));
    expect(await prisma.client.count({ where: { phone: { contains: "79161230000" } } })).toBe(0);
  });

  it("А и Б вместе: СМС уходит, в хронологии новой карточки есть строка о ней", async () => {
    await setSettings({ missedCallSmsEnabled: true, missedCallCallbackTaskEnabled: true });
    const n = track(mobile());
    await ring(`mt-${runId}-ab`, n);
    await hangup(`mt-${runId}-ab`);
    await waitFor(async () => (await smsCount(n)) === 1);
    const client = (await waitFor(async () => (await prisma.client.findFirst({ where: { phone: { endsWith: n } } })) ?? false)) as { id: string };
    await waitFor(async () => (await prisma.interaction.count({ where: { clientId: client.id, notes: { contains: "отправили СМС" } } })) === 1);
  });
});
