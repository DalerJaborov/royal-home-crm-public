import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПЕРЕВОД ЖИВОГО ЗВОНКА АГЕНТУ (24.09.2026, робозвонок-консультант, правка 4).
 *
 * Кому переводит — по базе (агент объекта → агент клиента → дежурный). Разговор со
 * станцией и мост подменены: живой станции у тестов нет, а проверить нужно, ЧТО
 * консультант отдаёт станции (кому звонить, сколько, куда вернуть) и что слышит
 * модель при отказе.
 */

const station = vi.hoisted(() => ({
  withinHours: true,
  dial: { target: "1044", viaMobile: false } as { target: string; viaMobile: boolean } | null,
  transfer: "ok" as "ok" | "failed" | "gone",
  continued: [] as Record<string, unknown>[],
  ariVars: [] as [string, string][],
  ariContinue: [] as unknown[],
  varFails: false,
  redirected: [] as Record<string, unknown>[],
  /** Что делать в момент, когда мост уже начал перевод (до move). */
  duringMove: null as (() => void) | null,
  /** Мост «не успел»: перевод стоит, пока тест не отпустит. */
  holdMove: null as Promise<void> | null,
}));

// Пуша в телефон при переводе нет (Dan 24.09 «меньше пуша») — стережём.
const pushes = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: async (...args: unknown[]) => (pushes.sent.push(args), 1),
  sendPushToAgents: async (...args: unknown[]) => (pushes.sent.push(args), 1),
}));

// Воскресенье — выходной консультанта (lib/telephony/consultantHours.ts): тесты про часы
// и про «скоро/утром» не должны зависеть от дня недели, на который попал прогон. Сами
// воскресные правила — live-voice-robot3-crm.test.ts.
vi.mock("../src/lib/alarmCalendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/alarmCalendar.js")>()),
  isAlarmDayOff: () => false,
}));
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinWorkingHours: async () => station.withinHours,
}));
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  setChannelVariable: async (_c: unknown, _id: string, name: string, value: string) => {
    station.ariVars.push([name, value]);
    return station.varFails ? { ok: false, error: "404" } : { ok: true };
  },
  continueInDialplan: async (_c: unknown, id: string, target: unknown) => {
    station.ariContinue.push({ id, target });
    return { ok: true };
  },
}));
vi.mock("../src/lib/telephony/amiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/amiClient.js")>()),
  loadAmiCredentials: async () => ({ host: "station", port: 5038, username: "u", secret: "s" }),
}));
vi.mock("../src/lib/telephony/inboundRouting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/inboundRouting.js")>()),
  resolveDialTarget: async () => station.dial,
  stationHasRouteContext: async () => ({ present: true }),
  redirectChannelToAgent: async (input: Record<string, unknown> & { isAnswered: () => boolean }) => {
    station.redirected.push({ ...input, answeredCheck: input.isAnswered() });
    return { ok: true };
  },
}));
vi.mock("../src/lib/telephony/liveVoiceBridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/liveVoiceBridge.js")>()),
  transferLiveVoiceCall: async (channelId: string, move: (id: string) => Promise<boolean>) => {
    if (station.transfer !== "ok") return station.transfer;
    station.duringMove?.();
    if (station.holdMove) await station.holdMove;
    await move(channelId);
    return "ok";
  },
}));

const { prisma } = await import("../src/db.js");
const { handleTransferTool, pickTransferAgent, TRANSFER_RING_SECONDS, resetTransfersInFlight } = await import(
  "../src/lib/telephony/liveVoiceTransfer.js"
);
const { continueStasisChannelToAgent, ROUTE_CONTEXT, ROUTE_EXTEN } = await import("../src/lib/telephony/inboundRouting.js");
const { seedLiveIncoming, liveIncomingByRecordId, resetIncomingCalls } = await import("../src/lib/telephony/incomingCalls.js");
const { newPropertyCallMemory } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { resolveConsultantCall } = await import("../src/lib/telephony/liveVoiceConsultant.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now().toString(36);
const agents: Record<"owner" | "clientAgent" | "duty" | "frozen", string> = { owner: "", clientAgent: "", duty: "", frozen: "" };
let propertyNumber = 0;
let frozenPropertyNumber = 0;
let clientId = "";
let dutyBefore: string | null = null;

beforeAll(async () => {
  agents.owner = await createTestAgent("Умед Объектов");
  agents.clientAgent = await createTestAgent("Шахло Клиентова");
  agents.duty = await createTestAgent("Фарзона Дежурная");
  agents.frozen = await createTestAgent("Замороженный Агент");
  // Номера аппаратов из полосы тестов, чтобы не столкнуться с живыми номерами соседей.
  await prisma.agent.update({ where: { id: agents.owner }, data: { sipExtension: `9${runId.slice(-3)}1` } });
  await prisma.agent.update({ where: { id: agents.clientAgent }, data: { sipExtension: `9${runId.slice(-3)}2` } });
  await prisma.agent.update({ where: { id: agents.frozen }, data: { frozenAt: new Date() } });

  const base = { type: "APARTMENT", areaSqm: 60, price: 500_000, currency: "TJS", condition: "GOOD", status: "AVAILABLE" } as const;
  const p = await prisma.property.create({ data: { ...base, title: `Перевод-${runId}`, intakeAgentId: agents.owner }, select: { shortId: true } });
  propertyNumber = p.shortId;
  const pf = await prisma.property.create({ data: { ...base, title: `Перевод-мороз-${runId}`, intakeAgentId: agents.frozen }, select: { shortId: true } });
  frozenPropertyNumber = pf.shortId;
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент перевода ${runId}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      source: "PHONE_CALL",
      assignedAgentId: agents.clientAgent,
      acceptedAt: new Date(),
    },
    select: { id: true },
  });
  clientId = c.id;

  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceTransferAgentId: true } });
  dutyBefore = s?.liveVoiceTransferAgentId ?? null;
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceTransferAgentId: agents.duty } });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceTransferAgentId: dutyBefore } });
  await prisma.property.deleteMany({ where: { title: { contains: runId } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces(Object.values(agents));
});

beforeEach(() => {
  station.withinHours = true;
  station.dial = { target: "1044", viaMobile: false };
  station.transfer = "ok";
  station.continued.length = 0;
  station.ariVars.length = 0;
  station.ariContinue.length = 0;
  station.varFails = false;
  station.redirected.length = 0;
  station.duringMove = null;
  station.holdMove = null;
  pushes.sent.length = 0;
  resetTransfersInFlight();
});

describe("кому переводить", () => {
  it("названный объект — агенту, который его ведёт, даже если у клиента свой агент", async () => {
    const picked = await pickTransferAgent({ clientId }, propertyNumber);
    expect(picked).toMatchObject({ because: "property", agent: { id: agents.owner } });
  });

  it("без объекта — своему агенту клиента", async () => {
    expect(await pickTransferAgent({ clientId }, null)).toMatchObject({ because: "client", agent: { id: agents.clientAgent } });
  });

  it("агент объекта заморожен — не ему, а дальше по порядку", async () => {
    expect(await pickTransferAgent({ clientId }, frozenPropertyNumber)).toMatchObject({ because: "client" });
  });

  it("незнакомец без объекта — дежурному из Настроек «Живой голос»", async () => {
    expect(await pickTransferAgent({ clientId: null }, null)).toMatchObject({ because: "duty", agent: { id: agents.duty } });
  });

  /**
   * Аудит 09.10.2026, P1-4: в режиме «после оператора» звонок пришёл к роботу потому, что
   * оператор первой линии не взял трубку. Дежурный для перевода не задан — «дежурный
   * оператор обратных звонков» (тот же оператор) НЕ берётся; у кнопки оператора — берётся.
   */
  it("режим «после оператора»: дежурный не задан — оператора обратных звонков консультант не берёт", async () => {
    const before = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { liveVoiceTransferAgentId: true, callbackOperatorAgentId: true, liveVoiceInboundMode: true },
    });
    try {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { liveVoiceTransferAgentId: null, callbackOperatorAgentId: agents.duty, liveVoiceInboundMode: "no_answer" },
      });
      expect(await pickTransferAgent({ clientId: null }, null, { skipOperatorWhenNoAnswer: true })).toBeNull();
      // Оператор с кнопкой «передать» — как раньше.
      expect(await pickTransferAgent({ clientId: null }, null)).toMatchObject({ because: "duty", agent: { id: agents.duty } });
      // Режим «всегда первым»: оператору не звонили — его можно.
      await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceInboundMode: "always" } });
      expect(await pickTransferAgent({ clientId: null }, null, { skipOperatorWhenNoAnswer: true })).toMatchObject({ agent: { id: agents.duty } });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: before! });
    }
  });
});

const ctx = () => ({
  channelId: `lv-${runId}`,
  clientId,
  callerName: "Фарход",
  properties: newPropertyCallMemory({ callerPhone: null, clientId }),
});
const call = (args: Record<string, unknown>) => ({ id: "t", name: "transfer_to_agent", args });

describe("перевод", () => {
  it("удачный: станции уходят адрес, время звонка и возврат к консультанту; агенту — строка в ленте с приметами объекта, без пуша", async () => {
    // Незакреплённый звонящий (11.10.2026: возврат к консультанту — только для таких).
    const c = { ...ctx(), clientId: null, properties: newPropertyCallMemory({ callerPhone: null, clientId: null }) };
    c.properties.discussedShortIds.push(propertyNumber);
    const reply = await handleTransferTool(c, call({ property_number: propertyNumber, summary: "Фарход, хочет посмотреть двушку" }));
    expect(reply).toEqual({ response: { ok: true, transferred_to: "Умед" }, scheduling: "SILENT" });
    expect(station.ariVars).toEqual([
      ["RH_ROUTE_TARGET", "1044"],
      ["RH_ROUTE_MOBILE", "0"],
      ["RH_ROUTE_TIMEOUT", String(TRANSFER_RING_SECONDS)],
      ["RH_ROUTE_FALLBACK", "ai"],
    ]);
    expect(station.ariContinue).toEqual([{ id: c.channelId, target: { context: ROUTE_CONTEXT, extension: ROUTE_EXTEN, priority: 1 } }]);
    const note = await prisma.notification.findFirst({
      where: { agentId: agents.owner, tag: `live-voice-transfer-${c.channelId}` },
      select: { title: true, body: true },
    });
    expect(note?.title).toContain("по вашему объекту");
    expect(note?.body).toContain("хочет посмотреть двушку");
    // Приметы, а не голый номер: агент номер не помнит.
    expect(note?.body).toContain("60 м²");
    expect(note?.body).toContain("500 000 сомони");
    expect(note?.body).toContain(`№${propertyNumber}`);
    expect(pushes.sent).toEqual([]);
  });

  /**
   * Владелец 11.10.2026: «робот НЕ отвечает клиентам агента — даже если агент не
   * отвечает, он сам перезвонит». Звонящий — клиент работающего агента: перевели
   * его агенту ИЛИ агенту объекта — не взял, голосовая почта, а не назад к роботу.
   */
  it("звонящий — клиент агента: не взял агент — голосовая почта, к консультанту не возвращается", async () => {
    const own = ctx();
    await handleTransferTool(own, call({ summary: "соедините с моим агентом" }));
    expect(station.ariVars).toContainEqual(["RH_ROUTE_FALLBACK", "voicemail"]);
    expect(station.ariVars).not.toContainEqual(["RH_ROUTE_FALLBACK", "ai"]);

    station.ariVars.length = 0;
    resetTransfersInFlight();
    const byProperty = { ...ctx(), channelId: `lv-${runId}-own-prop` };
    byProperty.properties.discussedShortIds.push(propertyNumber);
    await handleTransferTool(byProperty, call({ property_number: propertyNumber, summary: "по объекту" }));
    expect(station.ariVars).toContainEqual(["RH_ROUTE_FALLBACK", "voicemail"]);
  });

  it("transferFallback: незакреплённый или клиент замороженного агента — к консультанту, клиент работающего агента — почта", async () => {
    const { transferFallback } = await import("../src/lib/telephony/liveVoiceTransfer.js");
    expect(await transferFallback(null, "duty")).toBe("ai");
    expect(await transferFallback(null, "property")).toBe("ai");
    expect(await transferFallback(clientId, "property")).toBe("voicemail");
    expect(await transferFallback(clientId, "client")).toBe("voicemail");
    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: agents.frozen } });
    try {
      expect(await transferFallback(clientId, "property")).toBe("ai");
    } finally {
      await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: agents.clientAgent } });
    }
  });

  it("номер объекта, о котором в звонке НЕ говорили, — не к агенту объекта, а обычным путём (02.10.2026)", async () => {
    // Звонящий назвал номер из каталога сам, консультант этот объект не обсуждал:
    // иначе любой мог бы дозвониться до любого агента по выбору.
    const c = ctx();
    const reply = await handleTransferTool(c, call({ property_number: propertyNumber, summary: "соедините по объекту" }));
    expect(reply).toEqual({ response: { ok: true, transferred_to: "Шахло" }, scheduling: "SILENT" });
    const toOwner = await prisma.notification.findFirst({
      where: { agentId: agents.owner, tag: `live-voice-transfer-${c.channelId}`, body: { contains: "соедините по объекту" } },
    });
    expect(toOwner).toBeNull();
    const toClientAgent = await prisma.notification.findFirst({
      where: { agentId: agents.clientAgent, tag: `live-voice-transfer-${c.channelId}`, body: { contains: "соедините по объекту" } },
      select: { title: true },
    });
    expect(toClientAgent?.title).toContain("ваш клиент");
  });

  it("отметка «кому отдали звонок» стоит ДО перевода, а при отказе снимается (третий аудит, п.8)", async () => {
    // Раньше отметка ставилась после возврата transferLiveCallToAgent, а он ждёт конец
    // сессии моста (запись разговора до 20 с): агент, ответивший сразу, не получал кредит.
    const c = { ...ctx(), channelId: `lv-${runId}-mark` };
    const recordId = `rid-${runId}`;
    seedLiveIncoming({ channelId: c.channelId, phone: "+992900000001", recordId });
    let seenDuringMove: string | undefined;
    station.duringMove = () => {
      seenDuringMove = liveIncomingByRecordId(recordId)?.transferAgent?.id;
    };
    await handleTransferTool(c, call({ summary: "соедините" }));
    expect(seenDuringMove).toBe(agents.clientAgent);
    expect(liveIncomingByRecordId(recordId)?.transferAgent?.id).toBe(agents.clientAgent);

    // Агент не на связи: перевод не вышел — отметки быть не должно.
    station.dial = null;
    resetTransfersInFlight();
    await handleTransferTool(c, call({ summary: "соедините" }));
    expect(liveIncomingByRecordId(recordId)?.transferAgent).toBeUndefined();
    resetIncomingCalls();
  });

  it("второй вызов «соедини» с ДРУГИМ агентом, пока первый перевод идёт, — отказ; с тем же — тот же итог без второй ленты", async () => {
    const c = { ...ctx(), channelId: `lv-${runId}-twice` };
    c.properties.discussedShortIds.push(propertyNumber);
    let release: () => void = () => {};
    station.holdMove = new Promise<void>((r) => (release = r));
    // Первый вызов — к агенту объекта (Умед); мост «думает».
    const first = handleTransferTool(c, call({ property_number: propertyNumber, summary: "по объекту" }));
    await new Promise((r) => setTimeout(r, 100));
    // Второй — без объекта: выбрался бы агент клиента (Шахло). Канал уходит к Умеду, а CRM
    // записала бы передачу и ленту Шахло.
    const second = await handleTransferTool({ ...ctx(), channelId: c.channelId }, call({ summary: "нет, по другому" }));
    expect((second?.response as { ok: boolean }).ok).toBe(false);
    // Тот же агент повторно — ждёт тот же итог.
    const again = handleTransferTool(c, call({ property_number: propertyNumber, summary: "ещё раз" }));
    release();
    expect(await again).toEqual(await first);
    const toClientAgent = await prisma.notification.findFirst({ where: { agentId: agents.clientAgent, tag: `live-voice-transfer-${c.channelId}` } });
    expect(toClientAgent).toBeNull();
    expect(await prisma.notification.count({ where: { agentId: agents.owner, tag: `live-voice-transfer-${c.channelId}` } })).toBe(1);
  });

  it("нерабочее время — не переводит, модель слышит «агент перезвонит утром»", async () => {
    station.withinHours = false;
    const reply = await handleTransferTool(ctx(), call({ summary: "x" }));
    expect(reply?.response).toMatchObject({ ok: false });
    expect(String(reply?.response.error)).toContain("утром");
    expect(station.ariContinue).toEqual([]);
  });

  it("агент не на связи — не переводит, звонок остаётся с консультантом", async () => {
    station.dial = null;
    const reply = await handleTransferTool(ctx(), call({ summary: "x" }));
    expect(String(reply?.response.error)).toContain("Шахло");
    expect(station.ariContinue).toEqual([]);
  });

  it("у агента нет аппарата в CRM — честный отказ, а не гудки в пустоту", async () => {
    const reply = await handleTransferTool({ ...ctx(), clientId: null }, call({ summary: "x" }));
    expect(reply?.response).toMatchObject({ ok: false });
  });

  it("станция не приняла перевод — модель слышит отказ и продолжает разговор", async () => {
    station.transfer = "failed";
    const reply = await handleTransferTool(ctx(), call({ summary: "x" }));
    expect(reply).toMatchObject({ response: { ok: false }, scheduling: "INTERRUPT" });
  });

  it("чужие функции — null", async () => {
    expect(await handleTransferTool(ctx(), { id: "x", name: "end_call", args: {} })).toBeNull();
  });
});

describe("станция: вывод канала из консультанта", () => {
  it("адрес не принят — перевода нет, в диалплан канал не уходит", async () => {
    station.varFails = true;
    const ok = await continueStasisChannelToAgent({
      channelId: "c1",
      dialTarget: "1044",
      viaMobile: false,
      ringSeconds: 30,
      fallback: "ai",
      failLabel: "тест",
    });
    expect(ok).toBe(false);
    expect(station.ariContinue).toEqual([]);
  });
});

/**
 * Оператор передаёт идущий разговор агенту объекта (кнопка в «Входящих», 24.09.2026):
 * та же общая часть, что у консультанта, только канал уводится AMI Redirect, а
 * не агент — назад в очередь операторов, а не к консультанту.
 */
describe("общий перевод: оператор передаёт агенту", () => {
  it("канал в мосте с оператором — уводится Redirect, не взял агент — очередь", async () => {
    const { transferLiveCallToAgent } = await import("../src/lib/telephony/liveCallTransfer.js");
    const picked = await pickTransferAgent({ clientId }, propertyNumber);
    const outcome = await transferLiveCallToAgent({
      channel: { kind: "operator", channelName: "SIP/trunk-0000beef" },
      agent: picked!.agent,
      clientId,
      ringSeconds: 25,
      fallback: "queue",
      requireWorkingHours: false,
    });
    expect(outcome).toEqual({ ok: true });
    expect(station.redirected).toEqual([
      expect.objectContaining({
        channelName: "SIP/trunk-0000beef",
        dialTarget: "1044",
        ringSeconds: 25,
        fallback: "queue",
        // Оператор уже говорит — «уже отвечен» не повод отказать.
        answeredCheck: false,
      }),
    ]);
    expect(station.ariContinue).toEqual([]);
  });

  it("ночью оператору можно, консультанту — нет", async () => {
    const { transferLiveCallToAgent } = await import("../src/lib/telephony/liveCallTransfer.js");
    station.withinHours = false;
    const picked = await pickTransferAgent({ clientId }, propertyNumber);
    const base = { agent: picked!.agent, clientId, ringSeconds: 25, fallback: "queue" as const };
    expect(
      await transferLiveCallToAgent({ ...base, channel: { kind: "consultant", channelId: "c" }, requireWorkingHours: true })
    ).toEqual({ ok: false, reason: "after_hours" });
    expect(
      await transferLiveCallToAgent({ ...base, channel: { kind: "operator", channelName: "SIP/x" }, requireWorkingHours: false })
    ).toEqual({ ok: true });
  });
});

describe("звонок вернулся от агента", () => {
  it("консультант не здоровается заново и второй раз туда же не соединяет", async () => {
    const task = await resolveConsultantCall({
      channelId: `ret-${runId}`,
      direction: "inbound",
      callerNumber: null,
      settings: null,
      returnedFromAgent: true,
    });
    expect(task.greetingTrigger).toContain("не взял трубку");
    expect(task.tools?.map((t) => t.name)).not.toContain("transfer_to_agent");
  });
});
