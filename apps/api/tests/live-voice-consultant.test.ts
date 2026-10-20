import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  CONSULTANT_GREETING_TRIGGERS,
  CONSULTANT_OUTBOUND_GREETING_TRIGGERS,
} from "../src/ai/liveVoiceConsultantPersona.js";
import {
  finishConsultantCall,
  handleConsultantTool,
  identifyCaller,
  resolveConsultantCall,
  type ConsultantCallState,
} from "../src/lib/telephony/liveVoiceConsultant.js";
import { handlePropertyTool, newPropertyCallMemory } from "../src/lib/telephony/liveVoicePropertyTools.js";
import { attachContactProfile, identitiesForMessengerChannel, setContactSelfName } from "../src/lib/contactProfiles.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Консультант на телефоне (24.09.2026): узнаёт звонящего по номеру и пишет в ОБЩЕЕ
 * с чат-ботом досье. Проверяется по базе: карточка, её агент, досье, имя и язык.
 */

// Рабочие часы — рычаг теста, а не время прогона: в нерабочее время перевод
// агенту консультанту не даётся вовсе (02.10.2026).
const hours = vi.hoisted(() => ({ open: true }));
// Воскресенье — выходной консультанта (lib/telephony/consultantHours.ts): тесты про часы
// и про «скоро/утром» не должны зависеть от дня недели, на который попал прогон. Сами
// воскресные правила — live-voice-robot3-crm.test.ts.
vi.mock("../src/lib/alarmCalendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/alarmCalendar.js")>()),
  isAlarmDayOff: () => false,
}));
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinWorkingHours: async () => hours.open,
}));

// Девять цифр после 992 — свои на каждый прогон, одной длины в пределах файла.
const tail = () => String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
const KNOWN = tail();
const TRASHED = tail();
const STRANGER = tail();
const WA_WRITER = tail();

const agentIds: string[] = [];

const stateFor = (channelId: string, contactProfileId: string | null): ConsultantCallState => ({
  channelId,
  direction: "test",
  contactProfileId,
  name: null,
  otherPhone: null,
  properties: newPropertyCallMemory({ callerPhone: null, clientId: null }),
});
const clientIds: string[] = [];
const profilePhones = [KNOWN, TRASHED, STRANGER, WA_WRITER];

beforeAll(async () => {
  const agentId = await createTestAgent("Умед Консультантов");
  agentIds.push(agentId);
  const known = await prisma.client.create({
    data: { fullName: "Далер (брат Умеда)", phone: `+992${KNOWN}`, source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
    select: { id: true },
  });
  const trashed = await prisma.client.create({
    data: { fullName: "Удалённый", phone: `+992${TRASHED}`, source: "PHONE_CALL", deletedAt: new Date() },
    select: { id: true },
  });
  clientIds.push(known.id, trashed.id);
});

afterAll(async () => {
  const identities = await prisma.contactIdentity.findMany({
    where: { OR: profilePhones.map((p) => ({ value: { contains: p } })) },
    select: { profileId: true },
  });
  await prisma.contactProfile.deleteMany({ where: { id: { in: identities.map((i) => i.profileId) } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

describe("узнавание звонящего", () => {
  it("номер карточки — клиент и его агент по имени, без фамилии; ФИО карточки в приветствие не идёт", async () => {
    const who = await identifyCaller({ channelId: "t-known", direction: "test", callerNumber: KNOWN });
    expect(who.clientId).toBe(clientIds[0]);
    expect(who.caller.agentName).toBe("Умед");
    expect(who.caller.numberKnown).toBe(true);
    // «Далер (брат Умеда)» вбито агентом — это не имя, которым человек назвался сам.
    expect(who.caller.selfName).toBeNull();
    expect(who.contactProfileId).toBeTruthy();
  });

  it("карточка в Корзине — звонящий незнакомец, а не её клиент", async () => {
    const who = await identifyCaller({ channelId: "t-trash", direction: "test", callerNumber: `+992${TRASHED}` });
    expect(who.clientId).toBeNull();
    expect(who.caller.agentName).toBeNull();
  });

  it("скрытый номер — ни карточки, ни досье, консультант попросит номер", async () => {
    const who = await identifyCaller({ channelId: "t-hidden", direction: "inbound", callerNumber: null });
    expect(who).toMatchObject({ phone: null, clientId: null, contactProfileId: null });
    expect(who.caller.numberKnown).toBe(false);
  });
});

describe("память общая с чат-ботом", () => {
  it("имя, названное в разговоре, попадает в досье — следующий звонок встречают по имени", async () => {
    const first = await identifyCaller({ channelId: "t-s1", direction: "test", callerNumber: STRANGER });
    expect(first.caller.selfName).toBeNull();
    const state = stateFor("t-s1", first.contactProfileId);
    const reply = await handleConsultantTool(state, { id: "1", name: "save_contact", args: { name: "Фарход" } });
    expect(reply).toEqual({ response: { ok: true }, scheduling: "SILENT" });

    const second = await identifyCaller({ channelId: "t-s2", direction: "test", callerNumber: STRANGER });
    expect(second.contactProfileId).toBe(first.contactProfileId);
    expect(second.caller.selfName).toBe("Фарход");
    expect(second.caller.dossier).toContain("Фарход");
  });

  it("обрывок номера («88») не записывается, модель слышит, что номер неполный", async () => {
    const state = stateFor("t-s3", null);
    const reply = await handleConsultantTool(state, { id: "2", name: "save_contact", args: { name: "Фарход", phone: "88" } });
    expect(reply?.response).toMatchObject({ ok: false });
    expect(state.otherPhone).toBeNull();
  });

  it("чужие функции консультант отдаёт мосту", async () => {
    const state = stateFor("t-s4", null);
    expect(await handleConsultantTool(state, { id: "3", name: "end_call", args: { reason: "всё" } })).toBeNull();
  });

  it("итог звонка: язык звонящего ложится в досье, по которому потом выбирается голос", async () => {
    const who = await identifyCaller({ channelId: "t-s5", direction: "test", callerNumber: STRANGER });
    const state = stateFor("t-s5", who.contactProfileId);
    for (let i = 0; i < 2; i++) {
      await finishConsultantCall(state, {
        channelId: "t-s5",
        reason: "channel_ended",
        clientSpoke: true,
        transcript: ["Бот: Royal Home, салом", "Клиент: Ассалому алейкум, ман хона мехарам, ду хонагӣ дар Сино"],
      });
    }
    const row = await prisma.contactProfile.findUnique({ where: { id: who.contactProfileId! }, select: { language: true } });
    expect(row?.language).toBe("tg");
  });

  it("звонок, где человек не сказал ни слова, досье не трогает", async () => {
    const who = await identifyCaller({ channelId: "t-s6", direction: "test", callerNumber: STRANGER });
    const before = await prisma.contactProfile.findUnique({ where: { id: who.contactProfileId! }, select: { messagesIn: true } });
    await finishConsultantCall(
      stateFor("t-s6", who.contactProfileId),
      { channelId: "t-s6", reason: "channel_ended", clientSpoke: false, transcript: ["Бот: Royal Home, салом"] }
    );
    const after = await prisma.contactProfile.findUnique({ where: { id: who.contactProfileId! }, select: { messagesIn: true } });
    expect(after?.messagesIn).toBe(before?.messagesIn);
  });
});

describe("одно досье на все каналы (Dan 24.09: «чтобы клиента узнавали везде»)", () => {
  it("писал в WhatsApp — позвонил с того же номера: то же досье, консультант знает его имя", async () => {
    const waProfile = await attachContactProfile({
      existingProfileId: null,
      identities: identitiesForMessengerChannel("WHATSAPP", `992${WA_WRITER}`),
      link: async () => {},
    });
    expect(waProfile).toBeTruthy();
    await setContactSelfName(waProfile!, "Меҳрона");

    const who = await identifyCaller({ channelId: "t-wa", direction: "test", callerNumber: `+992${WA_WRITER}` });
    expect(who.contactProfileId).toBe(waProfile);
    expect(who.caller.selfName).toBe("Меҳрона");
  });

  it("что искал по телефону, ложится в досье — чат-бот увидит это в WhatsApp", async () => {
    const who = await identifyCaller({ channelId: "t-wa2", direction: "test", callerNumber: `+992${WA_WRITER}` });
    const memory = newPropertyCallMemory({ callerPhone: who.phone, clientId: null, contactProfileId: who.contactProfileId });
    await handlePropertyTool(memory, {
      id: "s",
      name: "search_properties",
      args: { district: "Фирдавси", type: "APARTMENT", rooms: 3, budget_max: 700_000, currency: "TJS" },
    });
    const again = await identifyCaller({ channelId: "t-wa3", direction: "test", callerNumber: `+992${WA_WRITER}` });
    expect(again.caller.dossier).toContain("Фирдавси");
    expect(again.caller.dossier).toContain("700000");
    const row = await prisma.contactProfile.findUnique({ where: { id: who.contactProfileId! }, select: { category: true } });
    expect(row?.category).not.toBe("UNKNOWN");
  });
});

describe("задание на звонок", () => {
  it("роль консультанта со справочником, своя первая реплика, свои функции и досье звонящего", async () => {
    const task = await resolveConsultantCall({ channelId: "t-task", direction: "inbound", callerNumber: KNOWN, settings: null });
    expect(task.systemInstruction).toContain("ОТВЕЧАЕШЬ на входящие звонки");
    expect(task.systemInstruction).toContain("<условия_работы_royal_home>");
    expect(task.systemInstruction).toContain("ЕГО ВЕДЁТ АГЕНТ Умед");
    expect(CONSULTANT_GREETING_TRIGGERS as readonly string[]).toContain(task.greetingTrigger);
    expect(task.tools?.map((t) => t.name)).toEqual([
      "save_contact",
      "search_properties",
      "get_property",
      "send_property_sms",
      // 09.10.2026 — робот решает вопрос сам (liveVoiceClientTools.ts).
      "my_status",
      "save_client_request",
      "request_callback",
      "showing_slots",
      "book_showing",
      "send_property_messenger",
      "describe_area",
      "transfer_to_agent",
      "escalate_to_human",
      "end_call",
    ]);
    expect(task.clientId).toBe(clientIds[0]);
    expect(task.contactProfileId).toBeTruthy();
  });

  // Живая проба 02.10.2026: проверочный звонок из Настроек набирает робот, а он
  // говорил человеку «вы сами нам позвонили».
  it("проверочный звонок набираем мы — консультант знает, что звонит сам", async () => {
    const task = await resolveConsultantCall({ channelId: "t-task-out", direction: "test", callerNumber: KNOWN, settings: null });
    expect(task.systemInstruction).toContain("Сейчас звонок от агентства: набрали мы");
    expect(task.systemInstruction).not.toContain("ОТВЕЧАЕШЬ на входящие звонки");
    expect(CONSULTANT_OUTBOUND_GREETING_TRIGGERS as readonly string[]).toContain(task.greetingTrigger);
  });

  // Третий аудит 02.10.2026: на «соедините» в проверочном звонке зазвонил бы настоящий агент.
  it("проверочный звонок из Настроек — функции перевода агенту нет", async () => {
    const task = await resolveConsultantCall({ channelId: "t-task-test-nt", direction: "test", callerNumber: KNOWN, settings: null });
    expect(task.tools?.map((t) => t.name)).not.toContain("transfer_to_agent");
  });

  // Аудит 02.10.2026: в нерабочее время перевод всегда отказывал, а функция была в
  // списке — модель обещала «сейчас соединю», потом говорила «агентов нет».
  it("нерабочее время — функции перевода нет, и соединение в промте не предлагается", async () => {
    hours.open = false;
    try {
      const task = await resolveConsultantCall({ channelId: "t-task-night", direction: "inbound", callerNumber: KNOWN, settings: null });
      expect(task.tools?.map((t) => t.name)).not.toContain("transfer_to_agent");
      expect(task.systemInstruction).toContain("соединение не предлагай");
      expect(task.systemInstruction).not.toContain("СОЕДИНИТЬ С АГЕНТОМ — ТОЛЬКО С СОГЛАСИЯ");
    } finally {
      hours.open = true;
    }
  });
});
