import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «АГЕНТ НАБЕРЁТ» — ВСЕГДА С ИСПОЛНИТЕЛЕМ (09.10.2026, аудит робота перед первым
 * клиентом, docs/robot-audit-2026-10-09-persona.md, P0-2 и P1-8).
 *
 * Робот обещает звонок вслух — промтом и подсказкой каждого отказа функции, — а задача
 * «перезвонить» ставилась только своему клиенту. Незнакомцу при разборе «модель не
 * уверена» (обычное дело на плохой линии) не доставалось ни задачи, ни пуша.
 */

const sendPushToAgent = vi.fn(async (..._args: unknown[]) => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));

const extractIncomingCallLead = vi.fn();
vi.mock("../src/ai/incomingCallLead.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/incomingCallLead.js")>()),
  extractIncomingCallLead,
}));
// Воскресенье — выходной консультанта: «скоро/утром» не должно зависеть от дня прогона.
vi.mock("../src/lib/alarmCalendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/alarmCalendar.js")>()),
  isAlarmDayOff: () => false,
}));

const { prisma } = await import("../src/db.js");
const { finishIncomingCall, markIncomingBridged, seedLiveIncoming, awaitIncomingReady, resetIncomingCalls, setConsultantCallEndedHook } =
  await import("../src/lib/telephony/incomingCalls.js");
const consultant = await import("../src/lib/telephony/liveVoiceConsultant.js");
const { finishConsultantCall, onConsultantCallEnded, resetInboundConsultantCalls, handleConsultantTool, callbackPromisedInTranscript, AGENT_NOT_RUNG_TRIGGER } =
  consultant;
const { newPropertyCallMemory } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor, waitForSettled } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const tail = String(Date.now()).slice(-7);
const CONSULTANT_CHANNEL = "UnicastRTP/10.9.0.1:40801-0x7f00000003";
const agentIds: string[] = [];
const channelIds: string[] = [];
let settingsBefore: Record<string, unknown> | null = null;
let dutyAgent = "";
let director = "";
let phoneSeq = 0;

const SETTINGS_FIELDS = {
  workHoursStart: true,
  workHoursEnd: true,
  liveVoiceTransferAgentId: true,
  callbackOperatorAgentId: true,
  incomingAutoCreateClient: true,
} as const;

beforeAll(async () => {
  dutyAgent = await createTestAgent("Дилшод Обещанный");
  director = await createTestAgent("Руководитель Жалоб", "DIRECTOR");
  agentIds.push(dutyAgent, director);
  settingsBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: SETTINGS_FIELDS })) as Record<string, unknown>;
});

beforeEach(async () => {
  sendPushToAgent.mockClear();
  extractIncomingCallLead.mockReset();
  // «Модель не уверена» — тот самый исход, при котором раньше задачи не было.
  extractIncomingCallLead.mockResolvedValue({ kind: "OTHER", confident: false, jobSeeker: false });
  resetInboundConsultantCalls();
  setConsultantCallEndedHook(onConsultantCallEnded);
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { workHoursStart: "00:00", workHoursEnd: "24:00", liveVoiceTransferAgentId: dutyAgent, callbackOperatorAgentId: null, incomingAutoCreateClient: true },
  });
});

afterEach(() => {
  resetIncomingCalls();
  setConsultantCallEndedHook(null);
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  const calls = await prisma.incomingCall.findMany({ where: { channelId: { in: channelIds } }, select: { phone: true } });
  await prisma.incomingCall.deleteMany({ where: { channelId: { in: channelIds } } });
  const phones = calls.map((c) => c.phone);
  const clients = await prisma.client.findMany({ where: { phone: { in: phones } }, select: { id: true } });
  await prisma.callbackRequest.deleteMany({ where: { clientId: { in: clients.map((c) => c.id) } } });
  await prisma.client.deleteMany({ where: { id: { in: clients.map((c) => c.id) } } });
  await deleteAgentsWithTraces(agentIds);
});

function nextPhone(): string {
  phoneSeq += 1;
  return `+992${String(phoneSeq + 60).padStart(2, "0")}${tail}`;
}

async function strangerCall(transcript: string[], prepare?: (st: Parameters<typeof finishConsultantCall>[0]) => Promise<void>) {
  const phone = nextPhone();
  const channelId = `lv-promise-${runId}-${channelIds.length}`;
  channelIds.push(channelId);
  const row = await prisma.incomingCall.create({
    data: { channelId, phone, startedAt: new Date(Date.now() - 60_000) },
    select: { id: true },
  });
  seedLiveIncoming({ channelId, phone, recordId: row.id });
  markIncomingBridged(channelId, CONSULTANT_CHANNEL);
  await awaitIncomingReady(channelId);
  const st = {
    channelId,
    direction: "inbound" as const,
    contactProfileId: null,
    name: "Фарход",
    otherPhone: null,
    summary: "просит подобрать квартиру",
    incomingCallId: row.id,
    promisedSoon: true,
    properties: newPropertyCallMemory({ callerPhone: phone, clientId: null }),
  };
  if (prepare) await prepare(st);
  const finishing = finishIncomingCall(channelId);
  await finishConsultantCall(st, { channelId, transcript, reason: "model_ended_call: попрощались", clientSpoke: true, recordingKey: null });
  await finishing;
  const call = await waitFor(
    () => prisma.incomingCall.findUnique({ where: { id: row.id }, select: { autoLeadStatus: true, clientId: true, phone: true } }).then((c) => (c?.autoLeadStatus ? c : null)),
    { label: "разбор звонка" }
  );
  const card = call.clientId ?? (await prisma.client.findFirst({ where: { phone }, select: { id: true } }))?.id ?? null;
  return { card, phone, callId: row.id };
}

function callbackTask(clientId: string) {
  return prisma.interaction.findFirst({
    where: { clientId, autoTaskKind: "consultant_callback", nextAction: { not: null } },
    select: { subjectAgentId: true, nextAction: true },
  });
}

describe("P0-2: незнакомцу обещан звонок — задача и пуш дежурному", () => {
  it("робот сказал «агент наберёт», разбор «модель не уверена» — задача дежурному и пуш ему", async () => {
    const { card } = await strangerCall([
      "Бот: Royal Home, здравствуйте!",
      "Клиент: Алло, мне квартиру бы, плохо слышно.",
      "Бот: Поняла. Агент вам сегодня наберёт и всё подберёт.",
    ]);
    expect(card).not.toBeNull();
    const task = await waitFor(() => callbackTask(card!), { label: "задача перезвонить незнакомцу" });
    expect(task.subjectAgentId).toBe(dutyAgent);
    expect(task.nextAction).toContain("Новый звонящий");
    expect(sendPushToAgent).toHaveBeenCalledWith(dutyAgent, expect.objectContaining({ title: expect.stringContaining("новому звонящему") }));
    // Закон о владении: задача — не передача клиента, владелец карточки не назначается.
    const client = await prisma.client.findUnique({ where: { id: card! }, select: { assignedAgentId: true } });
    expect(client?.assignedAgentId).toBeNull();
  });

  // 10.10.2026: робот дважды не разобрал таджикскую речь (расшифровка — арабская вязь) и
  // ушёл на перезвон (liveVoicePoorLine.ts) — задача дежурному с пометкой о линии и языке.
  it("плохая слышимость — задача «перезвонить» с пометкой «плохая слышимость, язык: таджикский»", async () => {
    const { poorLineTranscriptLine } = await import("../src/lib/telephony/liveVoicePoorLine.js");
    const { card } = await strangerCall([
      "Бот: Ассалому алейкум, Royal Home, здравствуйте, слушаю вас.",
      "Клиент: میں آپ کو بتا رہا ہوں گھر",
      "Бот: Бубахшед, як бори дигар гӯед?",
      "Клиент: میں آپ کو بتا رہا ہوں",
      poorLineTranscriptLine("tg"),
    ]);
    expect(card).not.toBeNull();
    const task = await waitFor(() => callbackTask(card!), { label: "задача после плохой слышимости" });
    expect(task.subjectAgentId).toBe(dutyAgent);
    expect(task.nextAction).toContain("плохая слышимость, язык: таджикский");
    // Реплики клиента записаны мусором — итог помечен «сверить основным распознаванием».
    expect(task.nextAction).toContain("Расшифровка Live ненадёжна");
  });

  it("звонка не обещали — задачи «перезвонить» от консультанта нет (лишних задач не плодим)", async () => {
    const { card } = await strangerCall([
      "Бот: Royal Home, здравствуйте!",
      "Клиент: Ой, я ошибся номером, извините.",
      "Бот: Ничего страшного, всего хорошего.",
    ]);
    expect(card).not.toBeNull();
    await waitForSettled(() => callbackTask(card!).then((t) => (t ? 1 : 0)));
    expect(await callbackTask(card!)).toBeNull();
  });

  it("escalate_to_human у незнакомца (карточки ещё нет) — задача появляется после заведения карточки", async () => {
    const { card } = await strangerCall(["Бот: Royal Home, здравствуйте!", "Клиент: Мне по квартире."], async (st) => {
      await handleConsultantTool(st, { id: "e1", name: "escalate_to_human", args: { reason: "просит живого человека" } });
    });
    const task = await waitFor(() => callbackTask(card!), { label: "задача после эскалации" });
    expect(task.subjectAgentId).toBe(dutyAgent);
  });

  it("нет ни дежурного, ни карточки (автосоздание выключено) — пуш руководству со ссылкой на «Звонки»", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceTransferAgentId: null, incomingAutoCreateClient: false } });
    const { card } = await strangerCall(["Бот: Royal Home, здравствуйте!", "Клиент: Мне по квартире.", "Бот: Хорошо, коллега вам перезвонит."]);
    expect(card).toBeNull();
    await waitFor(
      () => sendPushToAgent.mock.calls.find((c) => c[0] === director && (c[1] as { url?: string }).url === "/calls") ?? null,
      { label: "пуш руководству без карточки" }
    );
  });
});

describe("P1-8: жалоба «обещали перезвонить — не перезвонили»", () => {
  it("руководству уходит пуш о жалобе", async () => {
    await strangerCall([
      "Бот: Royal Home, здравствуйте!",
      "Клиент: Мне вчера обещали позвонить, и никто не позвонил!",
      "Бот: Простите, пожалуйста, сейчас попрошу руководителя разобраться.",
    ]);
    await waitFor(
      () => sendPushToAgent.mock.calls.find((c) => c[0] === director && String((c[1] as { title?: string }).title).includes("Жалоба")) ?? null,
      { label: "пуш о жалобе" }
    );
  });
});

describe("признаки обещания по расшифровке", () => {
  it("утверждение робота — обещание; вопрос «хотите, агент наберёт?» — ещё нет; просьба о человеке — да", () => {
    expect(callbackPromisedInTranscript(["Бот: Агент наберёт вам сегодня."])).toBe(true);
    expect(callbackPromisedInTranscript(["Бот: Хотите, агент вам наберёт?"])).toBe(false);
    expect(callbackPromisedInTranscript(["Клиент: Соедините меня с человеком"])).toBe(true);
    expect(callbackPromisedInTranscript(["Бот: Всего хорошего!"])).toBe(false);
  });

  it("служебная реплика «агенту не звонили» — без «он/она» про агента (P2-1)", () => {
    expect(AGENT_NOT_RUNG_TRIGGER).not.toMatch(/(?<![\p{L}])(он|она)\s+наберёт/u);
    expect(AGENT_NOT_RUNG_TRIGGER).toContain("агент наберёт сам");
  });
});

describe("09.10: договорённости робота — задача на время человека, показ на подтверждение, условия", () => {
  const propertyIds: string[] = [];
  afterAll(async () => {
    await prisma.interaction.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  });

  it("request_callback: задача «перезвонить» ровно на выбранное время, в записи — условия и время", async () => {
    const { dushanbeDateString } = await import("../src/lib/dushanbeTime.js");
    const { dushanbeMoment } = await import("../src/lib/telephony/liveVoiceClientTools.js");
    const day = dushanbeDateString(new Date(Date.now() + 2 * 86_400_000));
    const { card } = await strangerCall(["Бот: Royal Home, здравствуйте!", "Клиент: Наберите мне послезавтра в три."], async (st) => {
      await handleConsultantTool(st, { id: "r0", name: "save_client_request", args: { intent: "buy", district: "Сино", rooms: 2 } });
      const r = await handleConsultantTool(st, { id: "r1", name: "request_callback", args: { day, time: "15:00", topic: "двушка в Сино" } });
      expect((r!.response as { ok: boolean }).ok).toBe(true);
      expect(st.callbackPromised).toBe(true);
    });
    const task = await waitFor(
      () => prisma.interaction.findFirst({ where: { clientId: card!, autoTaskKind: "consultant_callback" }, select: { nextAction: true, nextActionDate: true } }),
      { label: "задача на выбранное время" }
    );
    expect(task.nextActionDate?.toISOString()).toBe(dushanbeMoment(day, "15:00").toISOString());
    expect(task.nextAction).toContain("Просил перезвонить");
    expect(task.nextAction).toContain("Условия: покупает, 2-комн., Сино");
  });

  it("book_showing у незнакомца: показ не записан, агенту — «подтвердить показ» с объектом и временем", async () => {
    const p = await prisma.property.create({
      data: { title: `Показ-${runId}`, type: "APARTMENT", rooms: 2, areaSqm: 60, price: 50_000, currency: "USD", condition: "GOOD", status: "AVAILABLE", publishedOnSite: true, assignedAgentId: dutyAgent } as never,
      select: { id: true, shortId: true },
    });
    propertyIds.push(p.id);
    const { dushanbeDateString, dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");
    // Не воскресенье: показы в выходной робот не записывает (проверка своя, не alarmCalendar).
    let ahead = 3;
    while (dushanbeWallClock(new Date(Date.now() + ahead * 86_400_000)).getUTCDay() === 0) ahead++;
    const day = dushanbeDateString(new Date(Date.now() + ahead * 86_400_000));
    const { card } = await strangerCall(["Бот: Royal Home, здравствуйте!", "Клиент: Хочу посмотреть в четыре."], async (st) => {
      st.properties.discussedShortIds.push(p.shortId);
      const r = await handleConsultantTool(st, { id: "b1", name: "book_showing", args: { number: p.shortId, day, time: "16:00" } });
      expect(r!.response).toMatchObject({ booked: false, passed_to_agent: true });
    });
    const task = await waitFor(
      () => prisma.interaction.findFirst({ where: { clientId: card!, autoTaskKind: "consultant_callback" }, select: { nextAction: true } }),
      { label: "задача подтвердить показ" }
    );
    expect(task.nextAction).toMatch(/^Подтвердить показ и перезвонить/);
    expect(task.nextAction).toContain(`Хочет показ: объект №${p.shortId}`);
    expect(task.nextAction).toContain("в 16:00");
    expect(await prisma.interaction.count({ where: { propertyId: p.id, type: "SHOWING" } })).toBe(0);
  });
});
