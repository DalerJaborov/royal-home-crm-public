import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * КОНСУЛЬТАНТ ВМЕСТО АВТООТВЕТЧИКА (24.09.2026, робозвонок, правка 5).
 *
 * Станция отдаёт настоящий входящий консультанту (оператор не взял, ночь). Что
 * стерегут тесты — путь звонка по CRM, а не голос (голос живёт на станции):
 *  - мост с каналом звука консультанта — это не ответ оператора: звонок не
 *    пропущен (ни «перезвонить — не дозвонился», ни пуша о пропущенном), но и
 *    «поговорил с оператором» в карточке не пишется;
 *  - разговор консультанта ложится в ту же запись звонка (расшифровка, запись);
 *  - звонок уходит в тот же разбор, что звонок оператору: незнакомец — в раздачу
 *    лидов, свой клиент — задача его агенту перезвонить с сутью разговора;
 *  - перевод агенту: что было до агента, агент видит в карточке сразу, а когда
 *    агент взял трубку, его разговор разбирается обычным путём.
 *
 * Модель разбора и пуши подменены: речь о решениях вокруг них.
 */

const sendPushToAgent = vi.fn(async (..._args: unknown[]) => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));

const extractIncomingCallLead = vi.fn();
vi.mock("../src/ai/incomingCallLead.js", () => ({ extractIncomingCallLead }));
// Воскресенье — выходной консультанта (lib/telephony/consultantHours.ts): тесты про часы
// и про «скоро/утром» не должны зависеть от дня недели, на который попал прогон. Сами
// воскресные правила — live-voice-robot3-crm.test.ts.
vi.mock("../src/lib/alarmCalendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/alarmCalendar.js")>()),
  isAlarmDayOff: () => false,
}));

const { prisma } = await import("../src/db.js");
const { finishIncomingCall, markIncomingBridged, seedLiveIncoming, awaitIncomingReady, resetIncomingCalls, setConsultantCallEndedHook } =
  await import("../src/lib/telephony/incomingCalls.js");
const { finishConsultantCall, onConsultantCallEnded, resetInboundConsultantCalls } = await import(
  "../src/lib/telephony/liveVoiceConsultant.js"
);
const { newPropertyCallMemory } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const tail = String(Date.now()).slice(-7);
const CONSULTANT_CHANNEL = "UnicastRTP/10.9.0.1:40800-0x7f00000001";

let agentId = "";
const clientIds: string[] = [];
const channelIds: string[] = [];

let hoursBefore: { workHoursStart: string; workHoursEnd: string } | null = null;

beforeAll(async () => {
  // This file tests the daytime callback, not the closing-hour policy. A 24:00
  // end still defers during the final hour; freeze only Date, keeping I/O timers
  // real. Night/closing-window behavior has its own callback/calendar tests.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T07:00:00Z"));
  agentId = await createTestAgent("Мадина Входящая");
  // Рабочее окно на все сутки: вне часов задача «перезвонить» ставится на утро и без
  // пуша (consultantCallbackTarget.ts) — тест про дневной путь, и он не должен
  // зависеть от часа прогона.
  hoursBefore = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
});

beforeEach(() => {
  sendPushToAgent.mockClear();
  extractIncomingCallLead.mockReset();
  resetInboundConsultantCalls();
  setConsultantCallEndedHook(onConsultantCallEnded);
});

afterEach(() => {
  resetIncomingCalls();
  setConsultantCallEndedHook(null);
});

afterAll(async () => {
  if (hoursBefore) await prisma.settings.update({ where: { id: "singleton" }, data: hoursBefore });
  await prisma.incomingCall.deleteMany({ where: { channelId: { in: channelIds } } });
  const phones = (await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { phone: true } })).map((c) => c.phone);
  await prisma.client.deleteMany({ where: { OR: [{ id: { in: clientIds } }, { phone: { in: phones } }] } });
  await deleteAgentsWithTraces([agentId]);
  vi.useRealTimers();
});

/** Входящий, который станция уже завела в журнал (как startIncomingCall). */
async function liveCall(phone: string, clientId: string | null): Promise<{ channelId: string; callId: string }> {
  const channelId = `lv-in-${runId}-${channelIds.length}`;
  channelIds.push(channelId);
  const row = await prisma.incomingCall.create({
    data: { channelId, phone, startedAt: new Date(Date.now() - 60_000), clientId },
    select: { id: true },
  });
  seedLiveIncoming({ channelId, phone, recordId: row.id, ...(clientId ? { clientId } : {}) });
  return { channelId, callId: row.id };
}

async function ownClient(phone: string): Promise<string> {
  const c = await prisma.client.create({
    data: {
      fullName: `Свой клиент ${runId}`,
      phone,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
    select: { id: true },
  });
  clientIds.push(c.id);
  return c.id;
}

function consultantState(channelId: string, callId: string, clientId: string | null, summary: string | null) {
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

describe("мост с консультантом — не ответ оператора", () => {
  it("свой клиент: звонок не пропущен, в карточке «ответил консультант», агенту задача перезвонить с сутью", async () => {
    const phone = `+99290${tail}`;
    const clientId = await ownClient(phone);
    const { channelId, callId } = await liveCall(phone, clientId);

    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    // Конец звонка ждёт итог сессии консультанта (02.10.2026): он приходит после отбоя
    // (запись заливается в R2), поэтому конец и итог идут параллельно.
    const finishing = finishIncomingCall(channelId);
    const state = consultantState(channelId, callId, clientId, "Фарход хочет продать квартиру, просит перезвонить после обеда");
    state.properties.discussedShortIds.push(123);
    await finishConsultantCall(state, {
      channelId,
      transcript: TRANSCRIPT,
      reason: "model_ended_call: попрощались",
      clientSpoke: true,
      recordingKey: "call-recordings/live-voice/2026/09/x.wav",
    });
    const finished = await finishing;
    expect(finished).toMatchObject({ answered: true, byConsultant: true });

    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(row).toMatchObject({ answered: true, answeredByConsultant: true, answeredBy: null });

    const interaction = await waitFor(
      () => prisma.interaction.findUnique({ where: { id: finished!.interactionId! } }).then((i) => (i?.nextAction ? i : null)),
      { label: "задача агенту перезвонить" }
    );
    expect(interaction.notes).toContain("ответил консультант");
    expect(interaction.notes).toContain("Суть: Фарход хочет продать");
    expect(interaction.notes).toContain("№123");
    expect(interaction.transcript).toContain("Консультант: Royal Home");
    expect(interaction.recordingUrl).toBe("call-recordings/live-voice/2026/09/x.wav");
    expect(interaction.nextAction).toContain("Перезвонить: клиент говорил с консультантом");
    expect(interaction.autoTaskKind).toBe("consultant_callback");
    // Не «перезвонить — не дозвонился»: человек дозвонился, ему ответили.
    expect(await prisma.interaction.count({ where: { clientId, autoTaskKind: "inbound_missed_callback" } })).toBe(0);

    expect((await prisma.incomingCall.findUnique({ where: { id: callId } }))?.autoLeadStatus).toBe("known_client");
    expect(sendPushToAgent).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ title: expect.stringContaining("ответил консультант"), body: expect.stringContaining("хочет продать") })
    );
    // Свой клиент в раздачу не идёт, и модель разбора на него не тратится.
    expect(extractIncomingCallLead).not.toHaveBeenCalled();
  });

  it("незнакомец: карточка заводится на ответ консультанта, разговор уходит в разбор лида", async () => {
    extractIncomingCallLead.mockResolvedValue({
      kind: "BUYER",
      confident: true,
      fullName: "Фарход",
      requirementsNotes: "Ищет двушку в Сино до 400 000 сомони",
      desiredDistrictId: null,
      desiredRooms: 2,
      desiredType: "APARTMENT",
      budgetMin: null,
      budgetMax: 400_000,
    });
    const phone = `+99291${tail}`;
    const { channelId, callId } = await liveCall(phone, null);

    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    // Робот снял трубку — карточки ещё нет: заводится, когда звонящий заговорил (02.10.2026).
    expect(await prisma.client.findFirst({ where: { phone }, select: { id: true } })).toBeNull();

    // Здесь наоборот: итог сессии пришёл раньше конца звонка.
    await finishConsultantCall(consultantState(channelId, callId, null, null), {
      channelId,
      transcript: TRANSCRIPT,
      reason: "model_ended_call: попрощались",
      clientSpoke: true,
      recordingKey: null,
    });
    const card = await prisma.client.findFirst({ where: { phone }, select: { id: true } });
    expect(card).not.toBeNull();
    clientIds.push(card!.id);
    await finishIncomingCall(channelId);

    const call = await waitFor(
      () => prisma.incomingCall.findUnique({ where: { id: callId } }).then((c) => (c?.autoLeadStatus ? c : null)),
      { label: "разбор звонка консультанта", timeoutMs: 5000 }
    );
    expect(call.autoLeadStatus).toBe("qualified");
    // Модель разбирала именно разговор консультанта.
    expect(String(extractIncomingCallLead.mock.calls[0]?.[0])).toContain("двухкомнатную квартиру в Сино");
    expect((await prisma.client.findUnique({ where: { id: card!.id } }))?.kind).toBe("BUYER");
  });
});

describe("перевод агенту", () => {
  it("агент взял трубку: до него — записка в карточке, дальше разговор агента идёт обычным путём", async () => {
    const phone = `+99292${tail}`;
    const clientId = await ownClient(phone);
    const { channelId, callId } = await liveCall(phone, clientId);

    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    await finishConsultantCall(consultantState(channelId, callId, clientId, "Хочет посмотреть объект №77"), {
      channelId,
      transcript: TRANSCRIPT,
      reason: "transferred",
      clientSpoke: true,
      recordingKey: null,
      transferred: true,
    });
    const note = await prisma.interaction.findFirst({
      where: { clientId, notes: { contains: "соединил с агентом" } },
      select: { notes: true, transcript: true },
    });
    expect(note?.notes).toContain("Хочет посмотреть объект №77");
    expect(note?.transcript).toContain("Клиент:");

    // Трубку взял агент — мост с его аппаратом.
    markIncomingBridged(channelId, "SIP/1044-00000abc");
    const finished = await finishIncomingCall(channelId);
    expect(finished).toMatchObject({ answered: true, byConsultant: false });
    const row = await prisma.incomingCall.findUnique({ where: { id: callId } });
    expect(row).toMatchObject({ answeredByConsultant: false, answeredBy: "1044" });
    // Разбор агентского разговора — после расшифровки записи станции, не сейчас.
    expect(row?.autoLeadStatus).toBeNull();
    const interaction = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! } });
    expect(interaction?.notes).toContain("с агентом после консультанта");
  });
});
