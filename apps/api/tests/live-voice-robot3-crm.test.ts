import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * РОБОТ, СТОРОНА CRM: ТРЕТИЙ АУДИТ (02.10.2026, audit3-crm.md).
 *
 * Каждый тест падает без своей правки:
 *  п.1  «ответ» агента после перевода короче порога и без добавочного — автоответчик
 *       сотового: звонок пропущен, лид в общую раздачу, кредит агенту не пишется;
 *  п.2  отметка «ответил консультант» ложится в базу в момент соединения (рестарт);
 *  п.3  робот упал посреди содержательного разговора — расшифровка и лид не пропадают;
 *  п.4  воскресенье — выходной: «утром» не на воскресенье, перевода в воскресенье нет;
 *  п.5  конец звонка ждёт итог сессии дольше цепочки завершения моста; второй итог тоже;
 *  п.6  известный клиент молча бросил трубку — не «поговорил», а пропущенный;
 *  п.9  автор записи и владелец лида не расходятся;
 *  п.10 пустой итог сессии и звонок короче порога — карточка по номеру не заводится;
 *  п.16 замороженный руководитель не получает «ответственного нет»;
 *  п.18 «скоро» обещано на старте звонка — задача не уходит на утро, если звонок перевалил.
 */

const sendPushToAgent = vi.fn(async (..._args: unknown[]) => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));

const extractIncomingCallLead = vi.fn();
vi.mock("../src/ai/incomingCallLead.js", () => ({ extractIncomingCallLead }));

const { prisma } = await import("../src/db.js");
const incoming = await import("../src/lib/telephony/incomingCalls.js");
const {
  finishIncomingCall,
  markIncomingBridged,
  seedLiveIncoming,
  awaitIncomingReady,
  resetIncomingCalls,
  setConsultantCallEndedHook,
  noteConsultantTransfer,
  noteConsultantReturned,
  noteConsultantSession,
  liveIncomingByRecordId,
  closeOrphanedIncomingCalls,
  TRANSFER_ANSWER_MIN_SECONDS,
} = incoming;
const consultant = await import("../src/lib/telephony/liveVoiceConsultant.js");
const { finishConsultantCall, onConsultantCallEnded, resetInboundConsultantCalls, resolveConsultantCall } = consultant;
const { newPropertyCallMemory } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { callbackDueAt, pickCallbackAgent } = await import("../src/lib/telephony/consultantCallbackTarget.js");
const { isWithinConsultantHours } = await import("../src/lib/telephony/consultantHours.js");
const { CONSULTANT_SESSION_WAIT_MS } = await import("../src/lib/telephony/liveVoiceTimings.js");
const { processNoAnswerTailAnchors } = await import("../src/lib/noAnswerStreak.js");
const { recordCallbackRequest } = await import("../src/lib/callbackRequests.js");
const { logTimeline } = await import("../src/lib/timeline.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { reserveExtensionBase } = await import("./helpers/extensionBase.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const tail = String(Date.now()).slice(-7);
const CONSULTANT_CHANNEL = "UnicastRTP/10.9.0.1:40900-0x7f00000003";
const MOBILE_CHANNEL = "PJSIP/trunk-mobile-00000def";

const agentIds: string[] = [];
const clientIds: string[] = [];
const channelIds: string[] = [];
let settingsBefore: Record<string, unknown> | null = null;
let mainAgent = "";
let transferAgent = "";
let otherAgent = "";
let otherExtension = "";
let phoneSeq = 0;

const SETTINGS_FIELDS = { workHoursStart: true, workHoursEnd: true, liveVoiceTransferAgentId: true, callbackOperatorAgentId: true } as const;

async function setHours(start: string, end: string): Promise<void> {
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: start, workHoursEnd: end } });
}

beforeAll(async () => {
  mainAgent = await createTestAgent("Мадина Третья");
  transferAgent = await createTestAgent("Умед Третий");
  otherAgent = await createTestAgent("Шахло Перехватчица");
  const base = await reserveExtensionBase(1);
  otherExtension = String(base);
  await prisma.agent.update({ where: { id: otherAgent }, data: { sipExtension: otherExtension } });
  agentIds.push(mainAgent, transferAgent, otherAgent);
  settingsBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: SETTINGS_FIELDS })) as Record<string, unknown>;
});

beforeEach(async () => {
  sendPushToAgent.mockClear();
  extractIncomingCallLead.mockReset();
  resetInboundConsultantCalls();
  setConsultantCallEndedHook(onConsultantCallEnded);
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { workHoursStart: "00:00", workHoursEnd: "24:00", liveVoiceTransferAgentId: null, callbackOperatorAgentId: null },
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetIncomingCalls();
  setConsultantCallEndedHook(null);
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.callbackRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.incomingCall.deleteMany({ where: { channelId: { in: channelIds } } });
  const phones = (await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { phone: true } })).map((c) => c.phone);
  const extra = await prisma.client.findMany({ where: { phone: { in: phones } }, select: { id: true } });
  await prisma.client.deleteMany({ where: { id: { in: [...clientIds, ...extra.map((c) => c.id)] } } });
  await deleteAgentsWithTraces(agentIds);
});

function nextPhone(): string {
  phoneSeq += 1;
  // Две цифры на номер в файле и семь на прогон — все номера одной длины.
  return `+992${String(40 + phoneSeq).padStart(2, "0")}${tail}`;
}

async function ownClient(phone: string, agentId: string | null = mainAgent): Promise<string> {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент третьего аудита ${runId}`,
      phone,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
      acceptedAt: agentId ? new Date() : null,
    },
    select: { id: true },
  });
  clientIds.push(c.id);
  return c.id;
}

async function liveCall(phone: string, clientId: string | null): Promise<{ channelId: string; callId: string }> {
  const channelId = `lv-a3-${runId}-${channelIds.length}`;
  channelIds.push(channelId);
  const row = await prisma.incomingCall.create({
    data: { channelId, phone, startedAt: new Date(Date.now() - 60_000), clientId },
    select: { id: true },
  });
  seedLiveIncoming({ channelId, phone, recordId: row.id, ...(clientId ? { clientId } : {}) });
  return { channelId, callId: row.id };
}

function state(channelId: string, callId: string, clientId: string | null, summary: string | null) {
  return {
    channelId,
    direction: "inbound" as const,
    contactProfileId: null,
    name: "Фарход",
    otherPhone: null,
    summary,
    incomingCallId: callId,
    properties: newPropertyCallMemory({ callerPhone: null, clientId }),
  };
}

const TRANSCRIPT = [
  "Бот: Royal Home, здравствуйте!",
  "Клиент: Здравствуйте, я ищу двухкомнатную квартиру в Сино до четырёхсот тысяч сомони.",
  "Бот: Поняла, подберу варианты и передам агенту.",
];

const lead = {
  kind: "BUYER",
  confident: true,
  fullName: "Фарход",
  requirementsNotes: "Ищет двушку в Сино",
  desiredDistrictId: null,
  desiredRooms: 2,
  desiredType: "APARTMENT",
  budgetMin: null,
  budgetMax: 400_000,
};

/** Робот поговорил, перевёл звонок, и «агент ответил»: bridgedAt отодвигается назад на talk секунд. */
async function transferredCall(opts: { phone: string; clientId: string | null; bridgeAs: string; talkSeconds: number }) {
  const { channelId, callId } = await liveCall(opts.phone, opts.clientId);
  markIncomingBridged(channelId, CONSULTANT_CHANNEL);
  await awaitIncomingReady(channelId);
  await finishConsultantCall(state(channelId, callId, opts.clientId, "ищет двушку в Сино"), {
    channelId,
    transcript: TRANSCRIPT,
    reason: "transferred",
    clientSpoke: true,
    recordingKey: null,
    transferred: true,
  });
  noteConsultantTransfer(channelId, { id: transferAgent, extension: "1999" });
  markIncomingBridged(channelId, opts.bridgeAs);
  liveIncomingByRecordId(callId)!.bridgedAt = new Date(Date.now() - opts.talkSeconds * 1000);
  const finished = await finishIncomingCall(channelId);
  return { channelId, callId, finished };
}

describe("п.1: «ответ» агента после перевода — только если это был разговор", () => {
  it("автоответчик сотового (мост есть, секунды, добавочного нет): звонок пропущен, кредита агенту нет", async () => {
    const phone = nextPhone();
    const clientId = await ownClient(phone);
    const contactBefore = (await prisma.client.findUnique({ where: { id: clientId } }))?.lastContactAt;
    const { callId, finished } = await transferredCall({ phone, clientId, bridgeAs: MOBILE_CHANNEL, talkSeconds: 4 });
    expect(finished).toMatchObject({ answered: false });
    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(row).toMatchObject({ answered: false, callbackAgentId: mainAgent });
    expect(row?.routeDecision).not.toBe("consultant_transfer_answered");
    expect(row?.routedToId).not.toBe(transferAgent);
    const interaction = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! } });
    expect(interaction?.notes).toContain("разговора не вышло");
    expect(interaction?.callAttempt).toBeNull();
    expect(interaction?.agentId).toBeNull();
    // Клиент с агентом: «перезвонить» и пуш — его агенту, как у любого пропущенного.
    expect(interaction?.nextAction).toContain("Перезвонить");
    expect(sendPushToAgent).toHaveBeenCalledWith(mainAgent, expect.objectContaining({ title: expect.stringContaining("Пропущенный") }));
    // Контактом это не считается: отметка не сдвинулась.
    expect((await prisma.client.findUnique({ where: { id: clientId } }))?.lastContactAt?.getTime()).toBe(contactBefore?.getTime());
  });

  it("незнакомый номер: «пропущенный» не отрезает лид — разговор с роботом разобран, лид в общую раздачу", async () => {
    extractIncomingCallLead.mockResolvedValue(lead);
    const phone = nextPhone();
    const { callId } = await transferredCall({ phone, clientId: null, bridgeAs: MOBILE_CHANNEL, talkSeconds: 3 });
    const row = await waitFor(
      () => prisma.incomingCall.findUnique({ where: { id: callId } }).then((r) => (r?.autoLeadStatus ? r : null)),
      { label: "разбор разговора с роботом" }
    );
    expect(row.autoLeadStatus).toBe("qualified");
    expect(row.answered).toBe(false);
    expect(row.routeDecision).not.toBe("consultant_transfer_answered");
    const card = await prisma.client.findFirst({ where: { phone }, select: { id: true, assignedAgentId: true, acceptedAt: true } });
    expect(card).not.toBeNull();
    clientIds.push(card!.id);
    // Принятым за агентом, которого человек не слышал, лид не закреплён: «принято» только у
    // того, кто ответил сам (общая раздача ждёт «Принять»).
    expect(card!.acceptedAt).toBeNull();
  });

  it("агент говорил дольше порога — кредит ему (прежнее поведение)", async () => {
    const phone = nextPhone();
    const clientId = await ownClient(phone, null);
    const { callId, finished } = await transferredCall({
      phone,
      clientId,
      bridgeAs: MOBILE_CHANNEL,
      talkSeconds: TRANSFER_ANSWER_MIN_SECONDS + 20,
    });
    expect(finished).toMatchObject({ answered: true });
    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(row).toMatchObject({ routeDecision: "consultant_transfer_answered", routedToId: transferAgent });
  });

  it("п.9: станция назвала добавочный ДРУГОГО человека — кредит перевода не пишется, автор и владелец лида не расходятся", async () => {
    const phone = nextPhone();
    const clientId = await ownClient(phone, null);
    const { callId, finished } = await transferredCall({
      phone,
      clientId,
      bridgeAs: `PJSIP/${otherExtension}-00000aaa`,
      talkSeconds: 60,
    });
    expect(finished).toMatchObject({ answered: true });
    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(row?.answeredBy).toBe(otherExtension);
    expect(row?.routeDecision).not.toBe("consultant_transfer_answered");
    const interaction = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! } });
    expect(interaction?.agentId).toBe(otherAgent);
  });
});

describe("п.2: отметка «ответил консультант» — в момент соединения", () => {
  it("рестарт посреди разговора с роботом: строку закрывает уборщик как ОТВЕЧЕННУЮ", async () => {
    const phone = nextPhone();
    const { channelId, callId } = await liveCall(phone, null);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    const mid = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(mid).toMatchObject({ answeredByConsultant: true, endedAt: null, answered: false });
    // Отметка не создаёт карточку: робот берёт каждый звонок.
    expect(await prisma.client.findFirst({ where: { phone } })).toBeNull();

    // Процесс перезапущен: живой памяти нет, строка висит открытой дольше срока.
    resetIncomingCalls();
    await prisma.incomingCall.update({ where: { id: callId }, data: { startedAt: new Date(Date.now() - 5 * 3600_000) } });
    await closeOrphanedIncomingCalls();
    const closed = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(closed?.endedAt).not.toBeNull();
    expect(closed?.answered).toBe(true);
  });
});

describe("п.3: робот упал посреди содержательного разговора", () => {
  it("незнакомый звонящий проговорил, сессия оборвалась (gemini_closed): расшифровка в карточке и лид, «пропущенный» остаётся", async () => {
    extractIncomingCallLead.mockResolvedValue(lead);
    const phone = nextPhone();
    const { channelId, callId } = await liveCall(phone, null);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    const finishing = finishIncomingCall(channelId);
    await finishConsultantCall(state(channelId, callId, null, "ищет двушку в Сино"), {
      channelId,
      transcript: TRANSCRIPT,
      reason: "gemini_closed",
      clientSpoke: true,
      recordingKey: null,
    });
    const finished = await finishing;
    expect(finished).toMatchObject({ answered: false, byConsultant: false });

    const row = await waitFor(
      () => prisma.incomingCall.findUnique({ where: { id: callId } }).then((r) => (r?.autoLeadStatus ? r : null)),
      { label: "разбор оборванного разговора" }
    );
    expect(row.autoLeadStatus).toBe("qualified");
    expect(row.answered).toBe(false);
    const card = await prisma.client.findFirst({ where: { phone }, select: { id: true } });
    expect(card).not.toBeNull();
    clientIds.push(card!.id);
    const interaction = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! } });
    expect(interaction?.transcript).toContain("двухкомнатную квартиру");
    expect(interaction?.notes).toContain("не смог принять звонок");
  });

  it("известный клиент: расшифровка в записи, а задача «перезвонить» одна — не две", async () => {
    extractIncomingCallLead.mockResolvedValue(lead);
    const phone = nextPhone();
    const clientId = await ownClient(phone);
    const { channelId, callId } = await liveCall(phone, clientId);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    const finishing = finishIncomingCall(channelId);
    await finishConsultantCall(state(channelId, callId, clientId, "просил перезвонить"), {
      channelId,
      transcript: TRANSCRIPT,
      reason: "gemini_closed",
      clientSpoke: true,
      recordingKey: null,
    });
    const finished = await finishing;
    await waitFor(
      () => prisma.incomingCall.findUnique({ where: { id: callId } }).then((r) => (r?.autoLeadStatus ? r : null)),
      { label: "разбор" }
    );
    const interaction = await waitFor(
      () => prisma.interaction.findUnique({ where: { id: finished!.interactionId! } }).then((i) => (i?.transcript ? i : null)),
      { label: "расшифровка в записи" }
    );
    expect(interaction.transcript).toContain("двухкомнатную квартиру");
    expect(await prisma.interaction.count({ where: { clientId, autoTaskKind: "consultant_callback" } })).toBe(0);
    expect(await prisma.interaction.count({ where: { clientId, autoTaskKind: "inbound_missed_callback" } })).toBe(1);
  });

  it("звонящий молчал, робот упал — по-прежнему не трогаем (звонок может заговорить на автоответчике)", async () => {
    const phone = nextPhone();
    const { channelId, callId } = await liveCall(phone, null);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    const finishing = finishIncomingCall(channelId);
    await finishConsultantCall(state(channelId, callId, null, null), {
      channelId,
      transcript: [],
      reason: "gemini_error",
      clientSpoke: false,
      recordingKey: null,
    });
    await finishing;
    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(row?.autoLeadAt).toBeNull();
  });
});

/**
 * С 11.10.2026 выходные — из Настроек (владелец: «у нас нет никаких выходных»). Прежнее
 * «воскресенье — выходной» — это теперь общий выходной `companyDaysOff: [0]`; блок ниже
 * держит его поведение, следующий — поведение по умолчанию и личный выходной агента.
 */
describe("п.4: общий выходной в воскресенье (Настройки)", () => {
  // По Душанбе (UTC+5): суббота 19:00 = 14:00Z, воскресенье 12:00 = 07:00Z.
  const saturdayEvening = new Date("2026-10-03T14:00:00Z");
  const sundayNoon = new Date("2026-10-04T07:00:00Z");
  const mondayMorning = new Date("2026-10-05T04:30:00Z"); // 09:30 в Душанбе
  beforeEach(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: [0] } });
  });
  afterEach(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: [] } });
  });

  it("callbackDueAt: суббота вечером → «утром» это понедельник, не воскресенье", async () => {
    await setHours("09:30", "18:00");
    expect(await callbackDueAt(saturdayEvening)).toEqual({ at: mondayMorning, deferredToMorning: true });
  });

  it("callbackDueAt: воскресенье днём — не «через 15 минут», а понедельник утром без пуша", async () => {
    await setHours("09:30", "18:00");
    expect(await callbackDueAt(sundayNoon)).toEqual({ at: mondayMorning, deferredToMorning: true });
  });

  it("callbackDueAt: суббота днём — рабочий день, +15 минут", async () => {
    await setHours("09:30", "18:00");
    const saturdayNoon = new Date("2026-10-03T07:00:00Z");
    expect(await callbackDueAt(saturdayNoon)).toEqual({ at: new Date("2026-10-03T07:15:00Z"), deferredToMorning: false });
  });

  it("рабочее время консультанта: воскресенье — нет, будни и суббота — да", async () => {
    await setHours("00:00", "24:00");
    expect(await isWithinConsultantHours(sundayNoon)).toBe(false);
    expect(await isWithinConsultantHours(new Date("2026-10-03T07:00:00Z"))).toBe(true);
    expect(await isWithinConsultantHours(new Date("2026-10-02T07:00:00Z"))).toBe(true);
  });

  it("в воскресенье днём перевод агенту недоступен: функции в списке нет, промт знает про нерабочее время", async () => {
    await setHours("00:00", "24:00");
    vi.useFakeTimers({ toFake: ["Date"], now: sundayNoon });
    const phone = nextPhone();
    const { channelId } = await liveCall(phone, null);
    const task = await resolveConsultantCall({ channelId, direction: "inbound", callerNumber: phone, settings: null });
    expect(task.tools?.some((t) => t.name === "transfer_to_agent")).toBe(false);
    vi.setSystemTime(new Date("2026-10-02T07:00:00Z"));
    const weekday = await resolveConsultantCall({ channelId, direction: "inbound", callerNumber: phone, settings: null });
    expect(weekday.tools?.some((t) => t.name === "transfer_to_agent")).toBe(true);
  });
});

describe("выходные по умолчанию и личный выходной агента (владелец 11.10.2026)", () => {
  const sundayNoon = new Date("2026-10-04T07:00:00Z");
  // 07.10.2026 — среда; 12:00 по Душанбе.
  const wednesdayNoon = new Date("2026-10-07T07:00:00Z");
  const thursdayMorning = new Date("2026-10-08T04:30:00Z"); // 09:30 в Душанбе

  it("по умолчанию воскресенье рабочее: днём перезвон через 15 минут, консультант в рабочем времени", async () => {
    await setHours("09:30", "18:00");
    expect(await callbackDueAt(sundayNoon)).toEqual({ at: new Date("2026-10-04T07:15:00Z"), deferredToMorning: false });
    expect(await isWithinConsultantHours(sundayNoon)).toBe(true);
  });

  it("личный выходной агента в среду: задача ему же — на его следующий рабочий день (четверг), без пуша", async () => {
    await setHours("09:30", "18:00");
    expect(await callbackDueAt(wednesdayNoon, { agentDaysOff: [3] })).toEqual({ at: thursdayMorning, deferredToMorning: true });
    // «Скоро» обещано на старте звонка — но агенту в его выходной «через 15 минут» нет.
    expect(await callbackDueAt(wednesdayNoon, { promisedSoon: true, agentDaysOff: [3] })).toEqual({
      at: thursdayMorning,
      deferredToMorning: true,
    });
    // У агента без выходных — как раньше.
    expect(await callbackDueAt(wednesdayNoon, { agentDaysOff: [] })).toEqual({
      at: new Date("2026-10-07T07:15:00Z"),
      deferredToMorning: false,
    });
  });

  it("личный выходной: консультант в часах компании, но не в часах этого агента", async () => {
    await setHours("00:00", "24:00");
    expect(await isWithinConsultantHours(wednesdayNoon)).toBe(true);
    expect(await isWithinConsultantHours(wednesdayNoon, [3])).toBe(false);
  });
});

describe("п.18: «скоро» обещано на старте звонка", () => {
  it("звонок перевалил за закрытие — задача всё равно через 15 минут; обещавший «утром» (окно закрыто) — на утро", async () => {
    await setHours("09:30", "18:00");
    const after = new Date("2026-10-02T13:05:00Z"); // 18:05 в Душанбе, пятница
    expect(await callbackDueAt(after, { promisedSoon: true })).toEqual({ at: new Date("2026-10-02T13:20:00Z"), deferredToMorning: false });
    expect(await callbackDueAt(after, { promisedSoon: false })).toMatchObject({ deferredToMorning: true });
    expect(await callbackDueAt(after)).toMatchObject({ deferredToMorning: true });
  });
});

describe("п.16: замороженный руководитель", () => {
  it("«ответственного нет» — только работающим руководителям", async () => {
    const director = await createTestAgent("Руководитель Работает", "DIRECTOR");
    const frozenDirector = await createTestAgent("Руководитель В отпуске", "DIRECTOR");
    agentIds.push(director, frozenDirector);
    await prisma.agent.update({ where: { id: frozenDirector }, data: { frozenAt: new Date() } });
    const target = await pickCallbackAgent({ namedAgentId: null, assignedAgentId: null });
    expect(target.source).toBe("management");
    expect(target.supervisorIds).toContain(director);
    expect(target.supervisorIds).not.toContain(frozenDirector);
  });
});

describe("п.5: конец звонка ждёт итог сессии, пока цепочка завершения моста не кончилась", () => {
  it("ожидание не короче записи разговора + записи итога в базу (числа сверяются с мостом)", () => {
    const bridge = readFileSync(new URL("../src/lib/telephony/liveVoiceBridge.ts", import.meta.url), "utf8");
    const num = (name: string): number => {
      const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(bridge);
      expect(m, `${name} не найден в liveVoiceBridge.ts`).not.toBeNull();
      return Number(m![1].replace(/_/g, ""));
    };
    const recording = num("RECORDING_WAIT_MS");
    const dbWrite = num("DB_WRITE_TIMEOUT_MS");
    expect(CONSULTANT_SESSION_WAIT_MS).toBeGreaterThan(recording + dbWrite);
  });

  it("звонок вернулся от агента: конец звонка ждёт итог ВТОРОЙ сессии, а не снимается первым", async () => {
    const phone = nextPhone();
    const { channelId } = await liveCall(phone, null);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    // Первая сессия отчиталась (перевела), агент не взял, звонок вернулся к роботу.
    await noteConsultantSession(channelId, { spoke: true, handedBack: false });
    noteConsultantReturned(channelId);

    const finishing = finishIncomingCall(channelId);
    const early = await Promise.race([finishing.then(() => "finished"), new Promise((r) => setTimeout(() => r("waiting"), 400))]);
    expect(early).toBe("waiting");
    // Вторая сессия отчиталась: робот отдал звонок станции после сбоя.
    await noteConsultantSession(channelId, { spoke: true, handedBack: true });
    const finished = await finishing;
    expect(finished).toMatchObject({ answered: false, byConsultant: false });
  });

  it("сессия без строки журнала (incomingCallId пуст) всё равно отчитывается — конец звонка не ждёт зря", async () => {
    const phone = nextPhone();
    const { channelId } = await liveCall(phone, null);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    const finishing = finishIncomingCall(channelId);
    await finishConsultantCall({ ...state(channelId, "", null, null), incomingCallId: null }, {
      channelId,
      transcript: ["Бот: Royal Home, слушаю вас"],
      reason: "channel_ended",
      clientSpoke: false,
      recordingKey: null,
    });
    const finished = await Promise.race([finishing, new Promise<null>((r) => setTimeout(() => r(null), 3_000))]);
    expect(finished).not.toBeNull();
  });
});

describe("п.6: известный клиент молча бросил трубку", () => {
  it("робот ответил, клиент ничего не сказал: не «поговорил», а пропущенный — задача и пуш его агенту", async () => {
    const phone = nextPhone();
    const clientId = await ownClient(phone);
    const contactBefore = (await prisma.client.findUnique({ where: { id: clientId } }))?.lastContactAt;
    const { channelId, callId } = await liveCall(phone, clientId);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    const finishing = finishIncomingCall(channelId);
    await finishConsultantCall(state(channelId, callId, clientId, null), {
      channelId,
      transcript: ["Бот: Royal Home, слушаю вас"],
      reason: "channel_ended",
      clientSpoke: false,
      recordingKey: null,
    });
    const finished = await finishing;
    expect(finished).toMatchObject({ answered: false });
    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(row).toMatchObject({ answered: false, callbackAgentId: mainAgent });
    const interaction = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! } });
    expect(interaction?.callAttempt).toBeNull();
    expect(interaction?.nextAction).toContain("Перезвонить");
    expect(sendPushToAgent).toHaveBeenCalledWith(mainAgent, expect.objectContaining({ title: expect.stringContaining("Пропущенный") }));
    expect((await prisma.client.findUnique({ where: { id: clientId } }))?.lastContactAt?.getTime()).toBe(contactBefore?.getTime());
    // Разобран как «никто не говорил»: лид не заводится, а noAnswerStreak его контактом не считает.
    const skipped = await waitFor(
      () => prisma.incomingCall.findUnique({ where: { id: callId } }).then((r) => (r?.autoLeadStatus ? r : null)),
      { label: "разбор молчания" }
    );
    expect(skipped.autoLeadStatus).toBe("skipped");
  });

  // Итог без признака botSpoke (сессия старого формата): сказал ли робот хоть слово,
  // неизвестно — прежнее «отвечен консультантом». Мост с 09.10 шлёт botSpoke всегда;
  // «робот поздоровался, человек промолчал» — блок «11.10» в конце файла.
  it("незнакомый номер, сброс через секунду, итог без botSpoke — по-прежнему «отвечен консультантом», без пуша руководству", async () => {
    const phone = nextPhone();
    const { channelId, callId } = await liveCall(phone, null);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    const finishing = finishIncomingCall(channelId);
    await finishConsultantCall(state(channelId, callId, null, null), {
      channelId,
      transcript: ["Бот: Royal Home, слушаю вас"],
      reason: "channel_ended",
      clientSpoke: false,
      recordingKey: null,
    });
    expect(await finishing).toMatchObject({ answered: true, byConsultant: true });
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("noAnswerStreak: молчаливый сброс — не выход на связь, обычный входящий — выход", async () => {
    const mkAnchor = async (clientId: string) =>
      logTimeline({
        clientId,
        actor: { kind: "system", source: "noAnswerStreak.tail", subjectAgentId: mainAgent },
        type: "SYSTEM",
        notes: "noAnswerTail:1",
        nextActionDate: new Date(Date.now() - 60_000),
        createdAt: new Date(Date.now() - 2 * 24 * 3600_000),
      });
    const tasksOf = (clientId: string) =>
      prisma.interaction.count({ where: { clientId, autoTaskKind: "no_answer_tail_retry", nextAction: { not: null } } });
    const mkCall = async (clientId: string, autoLeadStatus: string | null) => {
      const channelId = `lv-a3-tail-${runId}-${channelIds.length}`;
      channelIds.push(channelId);
      await prisma.incomingCall.create({
        data: { channelId, phone: nextPhone(), clientId, startedAt: new Date(Date.now() - 3600_000), answered: true, autoLeadStatus },
      });
    };

    const silent = await ownClient(nextPhone());
    await mkAnchor(silent);
    await mkCall(silent, "skipped");
    const talked = await ownClient(nextPhone());
    await mkAnchor(talked);
    await mkCall(talked, null);
    await processNoAnswerTailAnchors();
    expect(await tasksOf(silent)).toBe(1);
    expect(await tasksOf(talked)).toBe(0);
  });
});

describe("п.10: итог сессии не пришёл, звонок короткий", () => {
  it("карточка по номеру разбором не заводится: звонок помечен разобранным (skipped)", async () => {
    const phone = nextPhone();
    const { channelId, callId } = await liveCall(phone, null);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    // Итог сессии так и не пришёл: ждём недолго нельзя — подменяем срок вручную, отдав
    // станции конец звонка через уже известный хук и пустой итог.
    onConsultantCallEnded({ channelId, callId, interactionId: null, clientId: null, byConsultant: true, spoke: false, talkSeconds: 5 });
    // Ожидание итога по таймеру не запускается: parts пуст и последней части нет — итог
    // доводит конец звонка, как только придёт; здесь проверяем само решение «короткий и без слов».
    const { finalizeInboundCall } = consultant;
    await finalizeInboundCall(channelId);
    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(row?.autoLeadStatus).toBe("skipped");
    expect(await prisma.client.findFirst({ where: { phone } })).toBeNull();
  });
});

describe("п.17: эскалация живого голоса — одна на звонящего и при ПАРАЛЛЕЛЬНЫХ вызовах", () => {
  it("модель позвала функцию дважды в одном ходу — запись одна", async () => {
    const clientId = await ownClient(nextPhone());
    const ask = () =>
      recordCallbackRequest({ clientId, channel: "LIVE_VOICE", topic: "Живой голос: просит человека", autoConnect: false, byClientRequest: true });
    await Promise.all([ask(), ask(), ask()]);
    expect(await prisma.callbackRequest.count({ where: { clientId } })).toBe(1);
  });
});

/**
 * РОБОТ НЕ СКАЗАЛ НИ СЛОВА (09.10.2026, docs/robot-audit-2026-10-09-pipeline.md, п.3).
 * Трубку снял робот, а в линию не ушло ни слова (Gemini не подключился, звук не дошёл,
 * модель зависла): человек слышал тишину. Раньше это был «отвечен ИИ» — у незнакомого
 * номера не оставалось ни карточки, ни задачи.
 */
describe("п.3 аудита 09.10: робот промолчал — звонок пропущенный", () => {
  it("незнакомый номер ждал в тишине — пропущенный, карточка и задача «Перезвонить»", async () => {
    const phone = nextPhone();
    const { channelId, callId } = await liveCall(phone, null);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    // Человек провёл в тишине 10 с — не сброс через секунду.
    liveIncomingByRecordId(callId)!.consultantAt = new Date(Date.now() - 10_000);
    const finishing = finishIncomingCall(channelId);
    await finishConsultantCall(state(channelId, callId, null, null), {
      channelId,
      transcript: [],
      reason: "channel_ended",
      clientSpoke: false,
      botSpoke: false,
      recordingKey: null,
    });
    const finished = await finishing;
    expect(finished).toMatchObject({ answered: false, byConsultant: false });
    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(row?.answered).toBe(false);
    expect(row?.clientId).toBeTruthy();
    clientIds.push(row!.clientId!);
    const interaction = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! } });
    expect(interaction?.nextAction).toContain("Перезвонить");
  });

  // «Робот поздоровался, человек молча положил трубку» до 11.10 было «отвечен консультантом»
  // — с 11.10 у незнакомого номера это пропущенный (блок ниже).
});

/**
 * ЗВОНЯЩИЙ ПРОМОЛЧАЛ ПОСЛЕ ПРИВЕТСТВИЯ РОБОТА (11.10.2026, живой звонок 13:47, 9 с).
 * Незнакомый номер, робот поздоровался, человек не сказал ни слова и положил трубку.
 * Раньше — «отвечен ИИ», ни карточки, ни задачи: возможно живой клиент терялся бесследно.
 * Теперь — пропущенный: карточка, общая задача «Перезвонить» с пометкой и пуш руководству.
 */
describe("11.10: незнакомый промолчал после приветствия робота", () => {
  /** Робот поздоровался (botSpoke), звонящий говорил или нет, звонок длился seconds. */
  async function greetedCall(opts: { phone: string; clientId: string | null; seconds: number; spoke: boolean }) {
    const { channelId, callId } = await liveCall(opts.phone, opts.clientId);
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    liveIncomingByRecordId(callId)!.consultantAt = new Date(Date.now() - opts.seconds * 1000);
    const finishing = finishIncomingCall(channelId);
    await finishConsultantCall(state(channelId, callId, opts.clientId, opts.spoke ? "ищет двушку в Сино" : null), {
      channelId,
      transcript: opts.spoke ? TRANSCRIPT : ["Бот: Royal Home, здравствуйте!"],
      reason: "channel_ended",
      clientSpoke: opts.spoke,
      botSpoke: true,
      recordingKey: null,
    });
    const finished = await finishing;
    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    if (row?.clientId && !clientIds.includes(row.clientId)) clientIds.push(row.clientId);
    return { finished, row: row!, callId };
  }

  const missedTasks = (clientId: string) =>
    prisma.interaction.count({ where: { clientId, autoTaskKind: "inbound_missed_callback", nextAction: { not: null } } });

  it("молчал 9 с — пропущенный: карточка, общая задача «Перезвонить» с пометкой, пуш руководству, не «отвечен ИИ»", async () => {
    const phone = nextPhone();
    const { finished, row } = await greetedCall({ phone, clientId: null, seconds: 9, spoke: false });
    expect(finished).toMatchObject({ answered: false, byConsultant: false });
    expect(row).toMatchObject({ answered: false, answeredByConsultant: false });
    expect(row.clientId).toBeTruthy();
    const card = await prisma.client.findUnique({ where: { id: row.clientId! }, select: { assignedAgentId: true } });
    expect(card?.assignedAgentId).toBeNull();
    const interaction = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! } });
    expect(interaction?.autoTaskKind).toBe("inbound_missed_callback");
    expect(interaction?.nextAction).toContain("молчал после приветствия робота");
    expect(interaction?.notes).toContain("услышав робота");
    expect(interaction?.callAttempt).toBeNull();
    expect(await missedTasks(row.clientId!)).toBe(1);
    expect(sendPushToAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "📞 Пропущенный звонок" }));
  });

  it("звонящий заговорил — как раньше: «отвечен консультантом», задачи «перезвонить» нет", async () => {
    extractIncomingCallLead.mockResolvedValue(lead);
    const phone = nextPhone();
    const { finished, row, callId } = await greetedCall({ phone, clientId: null, seconds: 9, spoke: true });
    expect(finished).toMatchObject({ answered: true, byConsultant: true });
    expect(row).toMatchObject({ answered: true, answeredByConsultant: true });
    await waitFor(
      () => prisma.incomingCall.findUnique({ where: { id: callId } }).then((r) => (r?.autoLeadStatus ? r : null)),
      { label: "разбор разговора" }
    );
    const card = await prisma.client.findFirst({ where: { phone }, select: { id: true } });
    if (card && !clientIds.includes(card.id)) clientIds.push(card.id);
    expect(card).not.toBeNull();
    expect(await missedTasks(card!.id)).toBe(0);
    expect(sendPushToAgent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "📞 Пропущенный звонок" }));
  });

  it("закреплённый клиент промолчал — прежняя ветка: задача и пуш его агенту, без пометки про робота", async () => {
    const phone = nextPhone();
    const clientId = await ownClient(phone);
    const { finished, row } = await greetedCall({ phone, clientId, seconds: 9, spoke: false });
    expect(finished).toMatchObject({ answered: false });
    // Прежнее поведение silentKnown: «ответил консультант» в отметке, пропущенный по итогу.
    expect(row).toMatchObject({ answered: false, answeredByConsultant: true, callbackAgentId: mainAgent });
    const interaction = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! } });
    expect(interaction?.notes).toContain("клиент ничего не сказал");
    expect(interaction?.nextAction).toContain("не дозвонился");
    expect(interaction?.nextAction).not.toContain("робота");
    expect(await missedTasks(clientId)).toBe(1);
    expect(sendPushToAgent).toHaveBeenCalledWith(mainAgent, expect.objectContaining({ title: expect.stringContaining("Пропущенный") }));
  });

  it("два молчаливых звонка подряд с одного номера — задача одна", async () => {
    const phone = nextPhone();
    const first = await greetedCall({ phone, clientId: null, seconds: 9, spoke: false });
    const cardId = first.row.clientId!;
    expect(cardId).toBeTruthy();
    // Второй звонок: станция уже знает номер (карточка без ответственного).
    const second = await greetedCall({ phone, clientId: cardId, seconds: 6, spoke: false });
    expect(second.finished).toMatchObject({ answered: false, byConsultant: false });
    expect(second.row.clientId).toBe(cardId);
    expect(await prisma.client.count({ where: { phone } })).toBe(1);
    expect(await missedTasks(cardId)).toBe(1);
    expect(await prisma.interaction.count({ where: { clientId: cardId, type: "CALL" } })).toBe(2);
  });

  it("слушал робота дольше минуты и ушёл молча — по-прежнему «отвечен консультантом»", async () => {
    const phone = nextPhone();
    const { finished, row } = await greetedCall({ phone, clientId: null, seconds: 90, spoke: false });
    expect(finished).toMatchObject({ answered: true, byConsultant: true });
    expect(row).toMatchObject({ answered: true, answeredByConsultant: true, clientId: null });
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });
});
