import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НОМЕР ДЛЯ СВЯЗИ, КОТОРЫЙ ЗВОНЯЩИЙ ПРОДИКТОВАЛ КОНСУЛЬТАНТУ (02.10.2026, аудит
 * надёжности робозвонка). save_contact принимал «звоните на другой номер», а в
 * карточку номер не попадал: итог звонка (finalizeInboundCall) поля для него не
 * имел. Теперь номер ложится в запасные номера карточки тем же путём, что второй
 * номер в переписке (pickFreeExtraPhones), а чужой номер не дописывается.
 *
 * Плюс голос незнакомцу и замок на русский — консультант и мост не должны
 * противоречить друг другу.
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
const { finishConsultantCall, onConsultantCallEnded, resetInboundConsultantCalls, saveCallbackPhone, handleConsultantTool, consultantVoiceName } =
  await import("../src/lib/telephony/liveVoiceConsultant.js");
const { newPropertyCallMemory } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { LIVE_VOICE_RUSSIAN_ONLY_OVERRIDE } = await import("../src/ai/liveVoicePersona.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const tail = String(Date.now()).slice(-7);
const CONSULTANT_CHANNEL = "UnicastRTP/10.9.0.1:40800-0x7f00000002";

let agentId = "";
const clientIds: string[] = [];
const channelIds: string[] = [];

beforeAll(async () => {
  agentId = await createTestAgent("Мадина Номерова");
});

beforeEach(() => {
  sendPushToAgent.mockClear();
  extractIncomingCallLead.mockReset();
  resetInboundConsultantCalls();
  setConsultantCallEndedHook(onConsultantCallEnded);
});

afterAll(async () => {
  resetIncomingCalls();
  setConsultantCallEndedHook(null);
  await prisma.incomingCall.deleteMany({ where: { channelId: { in: channelIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId]);
});

async function ownClient(phone: string, assigned = true): Promise<string> {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент номера ${runId}`,
      phone,
      source: "PHONE_CALL",
      kind: "SELLER",
      ...(assigned ? { assignedAgentId: agentId, acceptedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  clientIds.push(c.id);
  return c.id;
}

describe("номер, продиктованный консультанту", () => {
  it("свой клиент просил перезвонить на другой номер — номер в запасных карточки, в записи звонка заметка без цифр", async () => {
    const phone = `+99290${tail}`;
    const clientId = await ownClient(phone);
    const channelId = `lv-cb-${runId}-1`;
    channelIds.push(channelId);
    const row = await prisma.incomingCall.create({
      data: { channelId, phone, startedAt: new Date(Date.now() - 60_000), clientId },
      select: { id: true },
    });
    seedLiveIncoming({ channelId, phone, recordId: row.id, clientId });
    markIncomingBridged(channelId, CONSULTANT_CHANNEL);
    await awaitIncomingReady(channelId);
    // Конец звонка ждёт итог сессии консультанта (incomingCalls.ts, 02.10.2026): идём параллельно.
    const finishing = finishIncomingCall(channelId);

    const state = {
      channelId,
      direction: "inbound" as const,
      contactProfileId: null,
      name: null,
      otherPhone: null as string | null,
      summary: "Просит перезвонить вечером на рабочий",
      incomingCallId: row.id,
      properties: newPropertyCallMemory({ callerPhone: phone, clientId }),
    };
    // Модель вызывает save_contact так, как велит её описание: номер словами-цифрами.
    const other = `93 ${tail.slice(0, 3)} ${tail.slice(3, 5)} ${tail.slice(5, 7)}`;
    expect(await handleConsultantTool(state, { name: "save_contact", args: { name: "Фарход", phone: other } } as never)).toMatchObject({
      response: { ok: true },
    });
    await finishConsultantCall(state, {
      channelId,
      transcript: ["Бот: Royal Home, слушаю вас", "Клиент: Перезвоните мне на рабочий номер"],
      reason: "model_ended_call: попрощались",
      clientSpoke: true,
      recordingKey: null,
    });
    const finished = await finishing;

    const client = await waitFor(
      () => prisma.client.findUnique({ where: { id: clientId }, select: { extraPhones: true } }).then((c) => (c?.extraPhones.length ? c : null)),
      { label: "номер в запасных" }
    );
    expect(client.extraPhones).toEqual([`+99293${tail}`]);
    const interaction = await waitFor(
      () => prisma.interaction.findUnique({ where: { id: finished!.interactionId! } }).then((i) => (i?.nextAction ? i : null)),
      { label: "задача агенту" }
    );
    expect(interaction.notes).toContain("записан в карточку запасным");
    expect(interaction.notes).not.toContain(tail);
    expect(interaction.nextAction).toContain("просил на другой номер");
  });

  it("номер уже записан за другой карточкой — не дописывается (один номер — один хозяин)", async () => {
    const mine = await ownClient(`+99291${tail}`);
    await ownClient(`+99292${tail}`, false);
    expect(await saveCallbackPhone(mine, `92${tail}`)).toBe("taken");
    expect(await saveCallbackPhone(mine, `91${tail}`)).toBe("already");
    expect(await saveCallbackPhone(mine, "девяносто три")).toBe("unparsed");
    expect((await prisma.client.findUnique({ where: { id: mine }, select: { extraPhones: true } }))?.extraPhones).toEqual([]);
  });
});

describe("язык консультанта: голос и замок на русский заодно", () => {
  const voices = { liveVoiceVoiceName: "Kore", liveVoiceVoiceNameTajik: "Aoede", liveVoiceForceRussianOnly: false };

  it("незнакомцу без замка — таджикский голос: приветствие у него начинается по-таджикски", () => {
    expect(consultantVoiceName(voices, null)).toBe("Aoede");
    expect(consultantVoiceName(voices, "ru")).toBe("Kore");
    // Замок или незаданный таджикский голос — как раньше, основной.
    expect(consultantVoiceName({ ...voices, liveVoiceForceRussianOnly: true }, null)).toBe("Kore");
    expect(consultantVoiceName({ ...voices, liveVoiceVoiceNameTajik: null }, null)).toBe("Kore");
  });

  it("замок на русский не велит модели «Давайте продолжим по-русски» поперёк таджикского извинения моста", () => {
    expect(LIVE_VOICE_RUSSIAN_ONLY_OVERRIDE).not.toContain("Давайте продолжим по-русски");
    expect(LIVE_VOICE_RUSSIAN_ONLY_OVERRIDE).toContain("фраза-извинение на таджикском");
    expect(LIVE_VOICE_RUSSIAN_ONLY_OVERRIDE).toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
  });
});
