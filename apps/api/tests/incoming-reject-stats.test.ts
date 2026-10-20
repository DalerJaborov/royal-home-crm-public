import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * ВИДИМАЯ ОТБРАКОВКА ВХОДЯЩИХ.
 *
 * Класс бага, ради которого всё это писалось: реальный контекст диалплана станции не
 * совпал с тем, что зашит в код, — и CRM неделю не записывала НИ ОДНОГО входящего
 * звонка, никому об этом не сказав (11.08.2026, `from-trunk-sip-out` не подошёл под
 * голое `from-trunk`). По журналам «звонков не было» и «все звонки отброшены»
 * выглядели одинаково.
 *
 * Здесь закрепляется три вещи: у отбраковки есть ЯВНАЯ причина, каждая отбраковка
 * считается и видна на дашборде, а список контекстов живёт в Настройках — то есть
 * чинится без выката кода.
 */

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const {
  classifyInboundChannel,
  isInboundContext,
  isInboundChannel,
  noteRejectedInbound,
  refreshInboundContexts,
  rejectedInboundStats,
  resetRejectedInboundStats,
  resetIncomingCalls,
  isTrackedIncoming,
} = await import("../src/lib/telephony/incomingCalls.js");

const runId = Date.now();

function channel(over: {
  id?: string;
  name?: string;
  context?: string;
  number?: string;
}) {
  return {
    id: over.id ?? "c-1",
    name: over.name ?? "SIP/out-00000030",
    state: "Ring",
    caller: { number: over.number ?? "992880001007" },
    dialplan: { context: over.context ?? "ext-queues", exten: "1000" },
  };
}

beforeEach(() => {
  resetRejectedInboundStats();
  resetIncomingCalls();
  sendPushToAgent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  // Settings — singleton на всю базу, а тестовые файлы идут по очереди: файл,
  // оставивший свою правку, ломает соседей (см. incoming-calls.test.ts).
  await prisma.settings.updateMany({ where: { id: "singleton" }, data: { incomingInboundContexts: [] } });
  await refreshInboundContexts();
  await prisma.incomingCall.deleteMany({ where: { channelId: { startsWith: `rej-${runId}` } } });
  await prisma.agent.deleteMany({ where: { fullName: `Директор отбраковки ${runId}` } });
  await prisma.$disconnect();
});

describe("Причина отбраковки называется явно", () => {
  it("чужой контекст диалплана — reason context", () => {
    expect(classifyInboundChannel(channel({ context: "from-pjsip-trunk-out" }))).toEqual({
      inbound: false,
      reason: "context",
    });
  });

  it("Local-канал очереди — reason local-channel, и проверяется ПОСЛЕ контекста", () => {
    // Порядок важен: Local-каналы очереди в счётчике — полезный сигнал «очередь
    // жива». Если бы они отсеивались до контекста, этот сигнал пропал бы.
    expect(classifyInboundChannel(channel({ name: "Local/1001@from-queue-0000000f;1" }))).toEqual({
      inbound: false,
      reason: "local-channel",
    });
  });

  it("в определителе не телефон — reason short-number", () => {
    expect(classifyInboundChannel(channel({ number: "123" }))).toEqual({
      inbound: false,
      reason: "short-number",
    });
  });

  it("настоящий входящий — inbound, и старая isInboundChannel отвечает так же", () => {
    expect(classifyInboundChannel(channel({}))).toEqual({ inbound: true });
    expect(isInboundChannel(channel({}))).toBe(true);
    expect(isInboundChannel(channel({ context: "from-internal", number: "6501414" }))).toBe(false);
    // Канала в событии нет вовсе — считать и логировать нечего.
    expect(classifyInboundChannel(undefined)).toBeNull();
    expect(isInboundChannel(undefined)).toBe(false);
  });
});

describe("Счётчик отбраковок", () => {
  it("отброшенный звонок не пропадает бесследно: счётчик растёт, в журнал он не попадает", async () => {
    const channelId = `rej-${runId}-1`;
    await handleAriEvent({
      type: "ChannelCreated",
      channel: channel({ id: channelId, context: "from-pjsip-trunk-out" }),
    });

    const stats = rejectedInboundStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ reason: "context", context: "from-pjsip-trunk-out", count: 1 });
    expect(stats[0].sampleChannelName).toBe("SIP/out-00000030");

    // Звонком он при этом не стал: ни строки в журнале, ни живой записи в памяти.
    expect(isTrackedIncoming(channelId)).toBe(false);
    expect(await prisma.incomingCall.findUnique({ where: { channelId } })).toBeNull();
  });

  it("самое частое — сверху, каждая причина считается отдельно", () => {
    noteRejectedInbound(channel({ name: "Local/1001@from-queue-1;1" }), "local-channel");
    noteRejectedInbound(channel({ name: "Local/1002@from-queue-2;1" }), "local-channel");
    noteRejectedInbound(channel({ context: "from-neizvestno" }), "context");

    const stats = rejectedInboundStats();
    expect(stats[0]).toMatchObject({ reason: "local-channel", count: 2 });
    expect(stats[1]).toMatchObject({ reason: "context", count: 1 });
  });

  it("консоль дросселируется: не чаще раза в минуту на причину", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T10:00:00.000Z"));
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // Local-каналы отбраковываются по два на каждый звонок — без дросселя журнал
    // контейнера утонул бы в них.
    noteRejectedInbound(channel({ name: "Local/1001@from-queue-1;1" }), "local-channel");
    noteRejectedInbound(channel({ name: "Local/1001@from-queue-1;2" }), "local-channel");
    expect(spy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-08-12T10:01:01.000Z"));
    noteRejectedInbound(channel({ name: "Local/1001@from-queue-1;1" }), "local-channel");
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it("станция с уникальными контекстами не съедает память: лишнее сворачивается в «прочие»", () => {
    for (let i = 0; i < 200; i += 1) {
      noteRejectedInbound(channel({ context: `from-random-${i}` }), "context");
    }
    const stats = rejectedInboundStats();
    // Потолок ключей плюс один общий — дальше счётчик не растёт, сколько бы
    // уникальных контекстов станция ни придумала.
    expect(stats.length).toBeLessThanOrEqual(51);
    expect(stats.some((s) => s.context === "<прочие>")).toBe(true);
    expect(stats.find((s) => s.context === "<прочие>")?.count).toBe(150);
  });
});

describe("Список входящих контекстов — настройка, а не константа", () => {
  it("свой список полностью заменяет встроенный", async () => {
    await prisma.settings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", incomingInboundContexts: ["from-custom"] },
      update: { incomingInboundContexts: ["from-custom"] },
    });
    await refreshInboundContexts();

    expect(isInboundContext("from-custom")).toBe(true);
    // Префикс работает так же, как у встроенных: from-custom-sip-<имя транка>.
    expect(isInboundContext("from-custom-sip-x")).toBe(true);
    // Переопределение ПОЛНОЕ: ext-queues при своём списке надо вписывать руками.
    expect(isInboundContext("ext-queues")).toBe(false);

    await prisma.settings.updateMany({ where: { id: "singleton" }, data: { incomingInboundContexts: [] } });
    await refreshInboundContexts();
    expect(isInboundContext("ext-queues")).toBe(true);
    expect(isInboundContext("from-trunk-sip-out")).toBe(true);
    expect(isInboundContext("from-custom")).toBe(false);
  });
});

describe("Дашборд телефонии показывает отбраковку", () => {
  it("счётчик виден и честно помечен «с момента запуска процесса»", async () => {
    const director = await prisma.agent.create({
      data: {
        fullName: `Директор отбраковки ${runId}`,
        phone: `+99277${String(runId).slice(-7)}`,
        role: "DIRECTOR",
        passwordHash: "x",
      },
    });
    const token = signAccessToken({ sub: director.id, role: "DIRECTOR" });

    noteRejectedInbound(channel({ context: "from-pjsip-trunk-out" }), "context");

    const res = await request(app)
      .get("/api/v1/calls/telephony/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Признак обязателен: счётчик живёт в памяти процесса и обнуляется деплоем —
    // без этой пометки обнуление примут за «проблема ушла».
    expect(res.body.rejected.sinceProcessStart).toBe(true);
    expect(res.body.rejected.items[0]).toMatchObject({
      reason: "context",
      context: "from-pjsip-trunk-out",
      count: 1,
    });
    // Номера звонивших в диагностику не утекают — там только имя канала.
    expect(JSON.stringify(res.body.rejected)).not.toContain("992880001007");
  });
});
