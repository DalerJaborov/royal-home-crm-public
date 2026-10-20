import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LIVE04 (04.10.2026): итог консультанта не теряется от временного сбоя базы.
 *
 * finalizeInboundCall стирал запись звонка из памяти ДО записи в карточку: упавшее
 * чтение базы оставляло клиента без итога и без задачи «перезвонить», повторить
 * было нечем. Теперь при сбое запись возвращается и доводится по таймеру, ограниченное
 * число раз. Станция, Gemini и внешние сервисы не вызываются: сессия подменена данными.
 */

const sendPushToAgent = vi.fn(async (..._args: unknown[]) => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));
const extractIncomingCallLead = vi.fn();
vi.mock("../src/ai/incomingCallLead.js", () => ({ extractIncomingCallLead }));
vi.mock("../src/lib/alarmCalendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/alarmCalendar.js")>()),
  isAlarmDayOff: () => false,
}));

const { prisma } = await import("../src/db.js");
const { finishIncomingCall, markIncomingBridged, seedLiveIncoming, awaitIncomingReady, resetIncomingCalls, setConsultantCallEndedHook } =
  await import("../src/lib/telephony/incomingCalls.js");
const {
  finishConsultantCall,
  onConsultantCallEnded,
  resetInboundConsultantCalls,
  finalizeInboundCall,
  INBOUND_FINALIZE_RETRY_MS,
} = await import("../src/lib/telephony/liveVoiceConsultant.js");
const { newPropertyCallMemory } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now().toString(36);
const tail = String(Date.now()).slice(-7);
const CONSULTANT_CHANNEL = "UnicastRTP/10.9.0.1:40800-0x7f00000003";

let agentId = "";
const clientIds: string[] = [];
const channelIds: string[] = [];
let settingsBefore: { workHoursStart: string; workHoursEnd: string } | null = null;

beforeAll(async () => {
  agentId = await createTestAgent("Мадина Повторная");
  settingsBefore = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
});

beforeEach(() => {
  sendPushToAgent.mockClear();
  extractIncomingCallLead.mockReset();
  resetInboundConsultantCalls();
  setConsultantCallEndedHook(onConsultantCallEnded);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetIncomingCalls();
  setConsultantCallEndedHook(null);
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.incomingCall.deleteMany({ where: { channelId: { in: channelIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId]);
});

describe("LIVE04: итог консультанта переживает временный сбой базы", () => {
  it("первое чтение карточки упало — запись звонка осталась, повтор ставит задачу «перезвонить» один раз", async () => {
    const phone = `+99277${tail}`;
    const client = await prisma.client.create({
      data: { fullName: `Клиент повтора ${runId}`, phone, source: "PHONE_CALL", kind: "SELLER", assignedAgentId: agentId, acceptedAt: new Date() },
      select: { id: true },
    });
    clientIds.push(client.id);
    const channelId = `lv-fin-${runId}`;
    channelIds.push(channelId);
    const row = await prisma.incomingCall.create({
      data: { channelId, phone, startedAt: new Date(Date.now() - 60_000), clientId: client.id },
      select: { id: true },
    });
    seedLiveIncoming({ channelId, phone, recordId: row.id, clientId: client.id });
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    const finishing = finishIncomingCall(channelId);

    // Единственное падение: чтение заметок карточки в finalizeInboundCall.
    const realFind = prisma.interaction.findUnique.bind(prisma.interaction);
    let failed = 0;
    vi.spyOn(prisma.interaction, "findUnique").mockImplementation(((args: { select?: Record<string, boolean> }) => {
      if (failed === 0 && args?.select && Object.keys(args.select).join() === "notes") {
        failed += 1;
        return Promise.reject(new Error("база временно недоступна"));
      }
      return realFind(args as never);
    }) as never);
    // Повтор по таймеру в тесте не ждём: смотрим, что он назначен, и вызываем сами.
    const timers = vi.spyOn(globalThis, "setTimeout");

    await finishConsultantCall(
      {
        channelId,
        direction: "inbound" as const,
        contactProfileId: null,
        name: "Фарход",
        otherPhone: null,
        summary: "Просит перезвонить вечером",
        incomingCallId: row.id,
        properties: newPropertyCallMemory({ callerPhone: phone, clientId: client.id }),
      },
      {
        channelId,
        transcript: ["Бот: Royal Home, слушаю", "Клиент: Перезвоните мне вечером, пожалуйста"],
        reason: "model_ended_call: попрощались",
        clientSpoke: true,
        recordingKey: null,
      }
    );
    const finished = await finishing;
    expect(failed).toBe(1);
    const before = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! }, select: { nextAction: true } });
    expect(before?.nextAction ?? null).toBeNull();
    expect(timers.mock.calls.some(([, ms]) => ms === INBOUND_FINALIZE_RETRY_MS)).toBe(true);

    await finalizeInboundCall(channelId);
    const after = await prisma.interaction.findUnique({ where: { id: finished!.interactionId! }, select: { nextAction: true, notes: true } });
    expect(after?.nextAction).toContain("Перезвонить");
    expect(after?.notes).toContain("Суть: Просит перезвонить вечером");

    // Третий вызов — уже ничего: запись снята после успеха, второй задачи нет.
    await finalizeInboundCall(channelId);
    const tasks = await prisma.interaction.count({ where: { clientId: client.id, autoTaskKind: "consultant_callback" } });
    expect(tasks).toBe(1);
  });
});
