import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПЕРЕВОД С ОФИСНОГО ТЕЛЕФОНА АГЕНТУ ОБЪЕКТА (24.09.2026, решение Dan).
 *
 * Оператор нажимает «Перевод» и набирает 7+номер объекта, станция отдаёт канал
 * звонящего в Stasis-приложение CRM. Станция подменена: проверяем, ЧТО CRM ей
 * отдаёт (кому звонить, сколько, куда вернуть, какую подсказку играть), что
 * пишется в карточку и за кем остаётся клиент, когда агент взял трубку. Пуша нет
 * (Dan: «меньше пуша») — стережём.
 */

const station = vi.hoisted(() => ({
  dial: { target: "1044", viaMobile: false } as { target: string; viaMobile: boolean } | null,
  ariVars: [] as [string, string, string][],
  ariContinue: [] as { id: string; target: unknown }[],
  hungUp: [] as string[],
  linkedid: null as string | null,
  whisperEnabled: true,
  /** Вызывается внутри continueInDialplan — пока HTTP-ответ станции ещё не вернулся. */
  onContinue: null as null | ((id: string) => Promise<void>),
}));
const pushes = vi.hoisted(() => ({ sent: [] as unknown[] }));

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: async (...args: unknown[]) => (pushes.sent.push(args), 1),
  sendPushToAgents: async (...args: unknown[]) => (pushes.sent.push(args), 1),
}));
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  setChannelVariable: async (_c: unknown, id: string, name: string, value: string) => {
    station.ariVars.push([id, name, value]);
    return { ok: true };
  },
  continueInDialplan: async (_c: unknown, id: string, target: unknown) => {
    station.ariContinue.push({ id, target });
    if (station.onContinue && target) await station.onContinue(id);
    return { ok: true };
  },
  hangupCall: async (_c: unknown, id: string) => {
    station.hungUp.push(id);
    return { ok: true };
  },
  readChannelVariable: async () => station.linkedid,
}));
vi.mock("../src/lib/telephony/amiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/amiClient.js")>()),
  loadAmiCredentials: async () => ({ host: "station", port: 5038, username: "u", secret: "s" }),
}));
vi.mock("../src/lib/telephony/inboundRouting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/inboundRouting.js")>()),
  resolveDialTarget: async () => station.dial,
  stationHasRouteContext: async () => ({ present: true }),
}));
// Подсказки в агентстве включены — общий переключатель в Настройках не трогаем:
// его читают соседние файлы на той же базе.
vi.mock("../src/lib/telephony/whisperSync.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/telephony/whisperSync.js")>();
  return {
    ...real,
    loadWhisperSettings: async () => ({ ...(await real.loadWhisperSettings()), enabled: station.whisperEnabled, language: "tg" }),
  };
});

const { prisma } = await import("../src/db.js");
const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const { isDeskTransferStart, resetDeskTransfers, DESK_TRANSFER_RING_SECONDS } = await import(
  "../src/lib/telephony/deskTransfer.js"
);
const { propertyWhisperParts, propertyFeaturesText } = await import("../src/lib/telephony/propertyWhisper.js");
const { seedLiveIncoming, resetIncomingCalls } = await import("../src/lib/telephony/incomingCalls.js");
const { ROUTE_CONTEXT } = await import("../src/lib/telephony/inboundRouting.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { reserveExtensionBase } = await import("./helpers/extensionBase.js");

const runId = Date.now().toString(36);
let owner = "";
let other = "";
let propertyId = "";
let shortId = 0;
const clientIds: string[] = [];
const callIds: string[] = [];

const randomPhone = () => `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;

beforeAll(async () => {
  owner = await createTestAgent("Умед Объектов");
  other = await createTestAgent("Шахло Своя");
  const base = await reserveExtensionBase(2);
  await prisma.agent.update({ where: { id: owner }, data: { sipExtension: String(base), whisperLanguage: "ru" } });
  const p = await prisma.property.create({
    data: {
      title: `Перевод с аппарата ${runId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 64.4,
      floor: 5,
      totalFloors: 9,
      address: "улица Айни 45",
      landmark: "Садбарг",
      price: 85_000,
      currency: "USD",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: owner,
    },
    select: { id: true, shortId: true },
  });
  propertyId = p.id;
  shortId = p.shortId;
});

afterAll(async () => {
  resetIncomingCalls();
  await prisma.incomingCall.deleteMany({ where: { id: { in: callIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await deleteAgentsWithTraces([owner, other]);
});

beforeEach(() => {
  station.dial = { target: "1044", viaMobile: false };
  station.ariVars.length = 0;
  station.ariContinue.length = 0;
  station.hungUp.length = 0;
  station.linkedid = null;
  station.whisperEnabled = true;
  station.onContinue = null;
  pushes.sent.length = 0;
  resetDeskTransfers();
});

/** Живой входящий, как его заводит станция: карточка по номеру, строка журнала. */
async function liveCall(opts: { assignedAgentId?: string } = {}) {
  const phone = randomPhone();
  const client = await prisma.client.create({
    data: {
      fullName: `Входящий ${phone}`,
      phone,
      source: "PHONE_CALL",
      ...(opts.assignedAgentId ? { assignedAgentId: opts.assignedAgentId, acceptedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  clientIds.push(client.id);
  const trunk = `trunk-${runId}-${Math.random().toString(36).slice(2, 8)}`;
  const call = await prisma.incomingCall.create({
    data: { channelId: trunk, phone, startedAt: new Date(), clientId: client.id, autoCreatedClient: !opts.assignedAgentId },
    select: { id: true },
  });
  callIds.push(call.id);
  seedLiveIncoming({ channelId: trunk, phone, recordId: call.id, clientId: client.id, bridgedAt: new Date() });
  // Половинка очереди, которую оператор переводит: своё у неё — только linkedid.
  const local2 = `local2-${trunk}`;
  station.linkedid = trunk;
  return { phone, clientId: client.id, callId: call.id, trunk, local2 };
}

function stasisStart(channelId: string, code: string, phone = "") {
  return {
    type: "StasisStart",
    application: "royal-home-crm",
    args: ["desk-transfer", code],
    channel: { id: channelId, name: "Local/1001@from-queue-00000abc;2", state: "Up", caller: { number: phone } },
  };
}

function dial(callerId: string, status: string, peerName = "SIP/1044-0000001f") {
  return { type: "Dial", dialstatus: status, caller: { id: callerId, name: "Local/1001@from-queue-00000abc;2", state: "Up", caller: {} }, peer: { id: "peer", name: peerName, state: "Up", caller: {} } };
}

describe("приметы объекта словами", () => {
  it("агент слышит, какой объект, а не номер", () => {
    const src = {
      type: "APARTMENT" as const,
      rooms: 2,
      areaSqm: 64.4,
      landAreaSotka: null,
      floor: 5,
      totalFloors: 9,
      address: "улица Айни 45",
      landmark: "Садбарг",
      price: 85_000,
      currency: "USD" as const,
      district: { name: "Сино" },
    };
    expect(propertyWhisperParts(src, "ru")).toEqual([
      "Клиент по объекту",
      "2-комнатная квартира",
      "64 квадрата",
      "этаж 5 из 9",
      "улица Айни 45",
      "ориентир Садбарг",
      "85 тысяч долларов",
    ]);
    expect(propertyWhisperParts(src, "tg")).toEqual([
      "Мизоҷ оид ба объект",
      "манзили 2-ҳуҷрагӣ",
      "64 метри мураббаъ",
      "ошёнаи 5 аз 9",
      "улица Айни 45",
      "ориентир Садбарг",
      "85 ҳазор доллар",
    ]);
    // Района не слышно, когда есть адрес или ориентир, — без них он единственная примета.
    expect(propertyWhisperParts({ ...src, address: null, landmark: null, price: 1_250_000, currency: "TJS" }, "ru")).toContain(
      "район Сино"
    );
    expect(propertyWhisperParts({ ...src, price: 1_250_000, currency: "TJS" }, "ru")).toContain("1,3 миллиона сомони");
    expect(propertyWhisperParts({ ...src, areaSqm: 81, price: 21_000 }, "ru")).toEqual(
      expect.arrayContaining(["81 квадрат", "21 тысяча долларов"])
    );
    expect(propertyWhisperParts({ ...src, price: 2_000_000, currency: "TJS" }, "ru")).toContain("2 миллиона сомони");
    expect(propertyFeaturesText(src)).not.toContain("Клиент по объекту");
  });

  it("чужой Stasis — не перевод", () => {
    expect(isDeskTransferStart({ type: "StasisStart", args: ["returned"] })).toBe(false);
    expect(isDeskTransferStart({ type: "StasisStart", args: ["desk-transfer", "7132"] })).toBe(true);
  });
});

describe("перевод кодом 7+номер объекта", () => {
  it("звонок уходит агенту объекта: 30 секунд, не взял — очередь, подсказка по приметам", async () => {
    const call = await liveCall();
    const file = `rh${runId}pw`;
    await prisma.propertyWhisper.create({
      data: { propertyId, language: "ru", digest: "d", fileName: file, text: "Клиент по объекту", durationMs: 1000 },
    });
    try {
      await handleAriEvent(stasisStart(call.local2, String(shortId).padStart(3, "0"), call.phone));
      expect(station.ariContinue).toEqual([{ id: call.local2, target: { context: ROUTE_CONTEXT, extension: "agent", priority: 1 } }]);
      const vars = Object.fromEntries(station.ariVars.filter(([id]) => id === call.local2).map(([, n, v]) => [n, v]));
      expect(vars).toMatchObject({
        RH_ROUTE_TARGET: "1044",
        RH_ROUTE_TIMEOUT: String(DESK_TRANSFER_RING_SECONDS),
        RH_ROUTE_FALLBACK: "queue",
        RH_WHISPER: file,
      });
    } finally {
      await prisma.propertyWhisper.deleteMany({ where: { fileName: file } });
    }
    const record = await prisma.incomingCall.findUnique({ where: { id: call.callId } });
    expect(record).toMatchObject({ routeDecision: "desk_transfer", routedToId: owner });
    const note = await prisma.interaction.findFirst({
      where: { clientId: call.clientId, notes: { contains: "Оператор перевёл звонок" } },
      select: { notes: true, propertyId: true },
    });
    expect(note?.notes).toContain("2-комнатная квартира, 64 квадрата, этаж 5 из 9, улица Айни 45, ориентир Садбарг");
    expect(note?.propertyId).toBe(propertyId);
    expect(pushes.sent).toEqual([]);
  });

  it("агент взял трубку — клиент его и сразу принятый; пуша нет", async () => {
    const call = await liveCall();
    await handleAriEvent(stasisStart(call.local2, String(shortId), call.phone));
    // Промежуточный исход и набор очереди ничего не решают.
    await handleAriEvent(dial(call.local2, "RINGING"));
    await handleAriEvent(dial(call.local2, "ANSWER"));

    const client = await prisma.client.findUnique({
      where: { id: call.clientId },
      select: { assignedAgentId: true, acceptedAt: true, workStatus: true, assignReason: true },
    });
    expect(client).toMatchObject({ assignedAgentId: owner, workStatus: "ACTIVE", assignReason: "own_property_explicit" });
    expect(client?.acceptedAt).not.toBeNull();
    expect((await prisma.incomingCall.findUnique({ where: { id: call.callId } }))?.routeDecision).toBe("desk_transfer_answered");
    expect(pushes.sent).toEqual([]);
  });

  it("CHANNEL-NEW-30: агент ответил раньше, чем вернулся HTTP continue — клиент всё равно закрепляется", async () => {
    const call = await liveCall();
    // Событие Dial ANSWER приходит по ARI WebSocket параллельно с ответом на continue.
    station.onContinue = async (id) => {
      await handleAriEvent(dial(id, "ANSWER"));
    };
    await handleAriEvent(stasisStart(call.local2, String(shortId), call.phone));

    const client = await prisma.client.findUnique({ where: { id: call.clientId }, select: { assignedAgentId: true } });
    expect(client?.assignedAgentId).toBe(owner);
    // Итог «ответил» не затирается записью «переведён», которая идёт после continue.
    expect((await prisma.incomingCall.findUnique({ where: { id: call.callId } }))?.routeDecision).toBe("desk_transfer_answered");
  });

  it("CHANNEL-NEW-30: перевод не удался — запись о нём снята, поздний Dial ANSWER клиента не закрепляет", async () => {
    const call = await liveCall();
    station.dial = null;
    await handleAriEvent(stasisStart(call.local2, String(shortId), call.phone));
    await handleAriEvent(dial(call.local2, "ANSWER"));
    const client = await prisma.client.findUnique({ where: { id: call.clientId }, select: { assignedAgentId: true } });
    expect(client?.assignedAgentId).toBeNull();
  });

  it("клиента, которого ведёт другой агент, не забирает", async () => {
    const call = await liveCall({ assignedAgentId: other });
    await handleAriEvent(stasisStart(call.local2, String(shortId), call.phone));
    await handleAriEvent(dial(call.local2, "ANSWER"));
    const client = await prisma.client.findUnique({ where: { id: call.clientId }, select: { assignedAgentId: true } });
    expect(client?.assignedAgentId).toBe(other);
    const note = await prisma.interaction.findFirst({
      where: { clientId: call.clientId, notes: { contains: "остаётся у своего агента" } },
    });
    expect(note).not.toBeNull();
  });

  it("агент не взял — звонок вернулся в очередь, в карточке почему", async () => {
    const call = await liveCall();
    await handleAriEvent(stasisStart(call.local2, String(shortId), call.phone));
    await handleAriEvent(dial(call.local2, "NOANSWER"));
    // Дальше очередь сама набирает оператора — это не ответ агента.
    await handleAriEvent(dial(call.local2, "ANSWER", "Local/1001@from-queue-00000abd;1"));

    const client = await prisma.client.findUnique({ where: { id: call.clientId }, select: { assignedAgentId: true } });
    expect(client?.assignedAgentId).toBeNull();
    expect((await prisma.incomingCall.findUnique({ where: { id: call.callId } }))?.routeDecision).toBe("desk_transfer_missed");
    const note = await prisma.interaction.findFirst({ where: { clientId: call.clientId, notes: { contains: "не взял трубку" } } });
    expect(note).not.toBeNull();
  });

  it("набрали номер несуществующего объекта — назад в очередь операторов", async () => {
    const call = await liveCall();
    await handleAriEvent(stasisStart(call.local2, "99999", call.phone));
    // Без цели — следующая строка диалплана после Stasis, то есть Queue(1000).
    expect(station.ariContinue).toEqual([{ id: call.local2, target: undefined }]);
    expect(station.ariVars).toEqual([]);
    const note = await prisma.interaction.findFirst({ where: { clientId: call.clientId, notes: { contains: "не вышло" } } });
    expect(note).not.toBeNull();
  });

  it("агент не на связи — назад в очередь, звонок не повисает", async () => {
    const call = await liveCall();
    station.dial = null;
    await handleAriEvent(stasisStart(call.local2, String(shortId), call.phone));
    expect(station.ariContinue).toEqual([{ id: call.local2, target: undefined }]);
    const note = await prisma.interaction.findFirst({ where: { clientId: call.clientId, notes: { contains: "не на связи" } } });
    expect(note).not.toBeNull();
  });

  it("перевод не клиента (оператор набрал код со своей трубки) — агенту, но без очереди в запасе", async () => {
    await handleAriEvent(stasisStart(`sip-operator-${runId}`, String(shortId), "1001"));
    const fallback = station.ariVars.find(([, n]) => n === "RH_ROUTE_FALLBACK");
    expect(fallback?.[2]).toBe("hangup");
  });

  it("подсказки выключены в агентстве — перевод всё равно идёт, без подсказки", async () => {
    station.whisperEnabled = false;
    const call = await liveCall();
    await handleAriEvent(stasisStart(call.local2, String(shortId), call.phone));
    expect(station.ariContinue[0]?.target).toMatchObject({ context: ROUTE_CONTEXT });
    expect(station.ariVars.some(([, n]) => n === "RH_WHISPER")).toBe(false);
  });
});
