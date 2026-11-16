import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));

/** Запись разговора с АТС здесь не нужна — важно, что её просят привязать к ПРАВИЛЬНОЙ записи хронологии. */
const ingestCallRecording = vi.fn(async () => undefined);
vi.mock("../src/lib/telephony/callRecordings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/callRecordings.js")>()),
  ingestCallRecording,
}));

/**
 * Станции в тесте нет: перевод звонка подменён. `routeResult` задаёт каждый тест — «переведён» или причина отказа.
 * Сам перевод (короткий звонок, запасной путь «очередь», без парковки) — tests/inbound-routing.test.ts.
 */
type RouteReq = { archiveReviewerId?: string; clientId?: string };
let routeResult: { routed: true; agentId: string; extension: string; dialTarget: string; viaMobile: boolean } | { routed: false; reason: string } = {
  routed: false,
  reason: "agent_busy",
};
const routeCalls: RouteReq[] = [];
vi.mock("../src/lib/telephony/inboundRouting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/inboundRouting.js")>()),
  routeIncomingToAssignedAgent: vi.fn(async (req: RouteReq) => {
    routeCalls.push(req);
    return routeResult;
  }),
  releaseChannelToOperator: vi.fn(async () => undefined),
  holdKnownClientAwayFromOperator: vi.fn(async () => false),
}));

const { prisma } = await import("../src/db.js");
const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
const { resetIncomingCalls } = await import("../src/lib/telephony/incomingCalls.js");
const { resetCalls } = await import("../src/lib/telephony/callTracker.js");

/**
 * ПЕРЕЗВОН КЛИЕНТА ИЗ КОРЗИНЫ ТОМУ, КТО ЕМУ ЗВОНИЛ ДЛЯ «РАЗБОРА» (владелец 16–17.11.2026).
 * Тут — часть вокруг перевода: кому звонок и пуш, ложится ли разговор (и его звук) в хронологию удалённой
 * карточки с отметкой archiveReview ТОЛЬКО когда ответил именно звонивший, живой владелец номера, окно 72 часа,
 * права и заморозка проверяются в момент звонка.
 */
const runId = Date.now();
const phone = `+99297${String(runId).slice(-7)}`;
const REVIEWER_EXT = `9${String(runId).slice(-4)}`;
const OPERATOR_EXT = `8${String(runId).slice(-4)}`;
let reviewerId = "";
let plainAgentId = "";
let operatorId = "";
let deletedId = "";
let liveId = "";

const ARCHIVE_GRANTS = { granted: ["clients.callArchived", "archive.view", "clients.viewAll"], revoked: [] };

beforeAll(async () => {
  const mk = async (name: string, p: string, role: "HEAD_OF_SALES" | "AGENT", extension: string | null, permissions?: object) =>
    (
      await prisma.agent.create({
        data: { fullName: name, phone: p, role, passwordHash: "x", sipExtension: extension, ...(permissions ? { permissions } : {}) },
      })
    ).id;
  reviewerId = await mk(`РОП перезвон ${runId}`, `+992981${String(runId).slice(-6)}`, "HEAD_OF_SALES", REVIEWER_EXT);
  plainAgentId = await mk(`Агент перезвон ${runId}`, `+992982${String(runId).slice(-6)}`, "AGENT", null);
  operatorId = await mk(`Оператор перезвон ${runId}`, `+992983${String(runId).slice(-6)}`, "AGENT", OPERATOR_EXT);
  deletedId = (
    await prisma.client.create({
      data: { fullName: `Удалённый перезвон ${runId}`, phone, source: "PHONE_CALL", deletedAt: new Date(), assignedAgentId: null },
    })
  ).id;
});

afterEach(async () => {
  vi.useRealTimers();
  resetIncomingCalls();
  resetCalls();
  sendPushToAgent.mockClear();
  ingestCallRecording.mockClear();
  routeCalls.length = 0;
  routeResult = { routed: false, reason: "agent_busy" };
  await prisma.agent.update({ where: { id: reviewerId }, data: { frozenAt: null, permissions: {} } });
  await prisma.incomingCall.deleteMany({ where: { phone } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [deletedId, liveId].filter(Boolean) } } });
  if (liveId) {
    await prisma.client.delete({ where: { id: liveId } }).catch(() => {});
    liveId = "";
  }
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: deletedId } });
  await prisma.agent.deleteMany({ where: { id: { in: [reviewerId, plainAgentId, operatorId] } } });
  await prisma.$disconnect();
});

/** Звонок разбора РОПа: «исходящая» запись удалённой карточки (так её заводит POST /clients/:id/call). */
async function reviewCall(agentId: string, when = new Date(), notes = "Разбор удалённого клиента: тест") {
  await prisma.interaction.create({
    data: { clientId: deletedId, agentId, actorKind: "AGENT", type: "CALL", notes, archiveReview: true, createdAt: when },
  });
}

const routedTo = (agentId: string) => ({ routed: true as const, agentId, extension: REVIEWER_EXT, dialTarget: REVIEWER_EXT, viaMobile: false });

const ring = (id: string) =>
  handleAriEvent({
    type: "ChannelCreated",
    channel: { id, name: `SIP/out-${id}`, state: "Ring", caller: { number: phone.slice(-9) }, dialplan: { context: "ext-queues", exten: "1000" } },
  });
const hangup = (id: string) =>
  handleAriEvent({ type: "ChannelDestroyed", channel: { id, name: `SIP/out-${id}`, state: "Up", caller: { number: "0" }, dialplan: { context: "ext-queues", exten: "1000" } } });
const bridge = (id: string, extension: string) =>
  handleAriEvent({
    type: "ChannelEnteredBridge",
    channel: { id: `op-${extension}`, name: `SIP/${extension}-00000012`, state: "Up", caller: {} },
    bridge: { id: `b-${id}`, channels: [id, `op-${extension}`] },
  });

type Pushed = [string, { url: string; body: string }];
const pushes = () => sendPushToAgent.mock.calls as unknown as Pushed[];
const pushTargets = () => pushes().map(([agent]) => agent);
const settle = () => new Promise((r) => setTimeout(r, 400));
const callbackRows = () =>
  prisma.interaction.findMany({ where: { clientId: deletedId, archiveReview: true, notes: { contains: "клиент перезвонил" } } });

describe("перезвон клиента из Корзины: кому и что записывается", () => {
  it("звонок передан звонившему (идёт перевод) — клиентом из Корзины считается карточка, живого дубля нет", async () => {
    await prisma.agent.update({ where: { id: reviewerId }, data: { permissions: ARCHIVE_GRANTS } });
    await reviewCall(reviewerId);
    routeResult = routedTo(reviewerId);
    await ring(`cb-route-${runId}`);
    await vi.waitFor(() => expect(routeCalls).toHaveLength(1));
    expect(routeCalls[0]!.archiveReviewerId).toBe(reviewerId);
    expect(routeCalls[0]!.clientId).toBeUndefined();
  });

  it("пропущенный: пуш только звонившему в Архив, без номера; руководителям ничего", async () => {
    await prisma.agent.update({ where: { id: reviewerId }, data: { permissions: ARCHIVE_GRANTS } });
    await reviewCall(reviewerId);
    const id = `cb-miss-${runId}`;
    await ring(id);
    await hangup(id);
    await vi.waitFor(() => expect(sendPushToAgent).toHaveBeenCalled());
    await settle();
    expect(pushTargets()).toEqual([reviewerId]);
    expect(pushes()[0]![1].url).toBe("/archive");
    expect(pushes()[0]![1].body).not.toContain(phone.slice(-9));
    expect(await callbackRows()).toHaveLength(0);
  });

  it("ответил звонивший по своему внутреннему номеру: разговор в хронологии удалённой карточки, запись слышна, «без разбора» нет", async () => {
    await prisma.agent.update({ where: { id: reviewerId }, data: { permissions: ARCHIVE_GRANTS } });
    await reviewCall(reviewerId);
    routeResult = routedTo(reviewerId);
    const id = `cb-ans-${runId}`;
    await ring(id);
    await vi.waitFor(() => expect(routeCalls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    await bridge(id, REVIEWER_EXT);
    await hangup(id);
    let rowId = "";
    await vi.waitFor(async () => {
      const rows = await callbackRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.agentId).toBe(reviewerId);
      rowId = rows[0]!.id;
    });
    const card = await prisma.client.findUniqueOrThrow({ where: { id: deletedId } });
    expect(card.deletedAt).not.toBeNull();
    // Звук: запись разговора привязывается к ЭТОЙ записи, а журнал входящих знает о ней и не считает звонок «без разбора».
    await vi.waitFor(() => expect(ingestCallRecording).toHaveBeenCalledWith(expect.objectContaining({ interactionId: rowId })));
    const call = await prisma.incomingCall.findFirstOrThrow({ where: { phone } });
    expect(call.interactionId).toBe(rowId);
    expect(call.qualifiedAt).not.toBeNull();
    expect(call.autoLeadStatus).toBe("known_client");
    expect(call.clientId).toBeNull();
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("звонивший не взял, а ответил ОПЕРАТОР (по внутреннему номеру) — записи от имени звонившего нет", async () => {
    await prisma.agent.update({ where: { id: reviewerId }, data: { permissions: ARCHIVE_GRANTS } });
    await reviewCall(reviewerId);
    routeResult = routedTo(reviewerId);
    const id = `cb-op-${runId}`;
    await ring(id);
    await vi.waitFor(() => expect(routeCalls).toHaveLength(1));
    await bridge(id, OPERATOR_EXT);
    await hangup(id);
    await settle();
    expect(await callbackRows()).toHaveLength(0);
    expect(ingestCallRecording).not.toHaveBeenCalledWith(expect.objectContaining({ clientAnswered: true, interactionId: expect.any(String) }));
    const call = await prisma.incomingCall.findFirstOrThrow({ where: { phone } });
    expect(call.interactionId).toBeNull();
    expect(call.qualifiedAt).toBeNull();
  });

  it("мост поздно (после его короткого звонка, номер не назван) — это уже очередь операторов, записи нет", async () => {
    await prisma.agent.update({ where: { id: reviewerId }, data: { permissions: ARCHIVE_GRANTS } });
    await reviewCall(reviewerId);
    routeResult = routedTo(reviewerId);
    const id = `cb-late-${runId}`;
    await ring(id);
    await vi.waitFor(() => expect(routeCalls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    // Мобильный/транк: внутреннего номера в имени канала нет.
    await handleAriEvent({
      type: "ChannelEnteredBridge",
      channel: { id: "op-trunk", name: "PJSIP/trunk-00000013", state: "Up", caller: {} },
      bridge: { id: `b-${id}`, channels: [id, "op-trunk"] },
    });
    await hangup(id);
    vi.useRealTimers();
    await settle();
    expect(await callbackRows()).toHaveLength(0);
  });

  it("звонивший без права «Звонить клиентам из Корзины» — всё по-старому: перевода и пуша нет", async () => {
    await reviewCall(plainAgentId);
    const id = `cb-noperm-${runId}`;
    await ring(id);
    await hangup(id);
    await settle();
    expect(routeCalls.every((c) => !c.archiveReviewerId)).toBe(true);
    expect(pushTargets()).not.toContain(plainAgentId);
  });

  it("право снято уже после звонка разбора — в момент перезвона проверяется заново", async () => {
    await reviewCall(reviewerId); // permissions пустые: РОП по пресету имеет право, но override его снимает
    await prisma.agent.update({
      where: { id: reviewerId },
      data: { permissions: { granted: [], revoked: ["clients.callArchived"] } },
    });
    await ring(`cb-revoked-${runId}`);
    await vi.waitFor(() => expect(routeCalls).toHaveLength(1));
    expect(routeCalls[0]!.archiveReviewerId).toBeUndefined();
  });

  it("звонивший заморожен — как у незнакомого номера: к нему не переводим, пуш ему не шлём", async () => {
    await prisma.agent.update({ where: { id: reviewerId }, data: { permissions: ARCHIVE_GRANTS, frozenAt: new Date() } });
    await reviewCall(reviewerId);
    const id = `cb-frozen-${runId}`;
    await ring(id);
    await hangup(id);
    await settle();
    expect(routeCalls.every((c) => !c.archiveReviewerId)).toBe(true);
    expect(pushTargets()).not.toContain(reviewerId);
  });

  it("разбор был больше 72 часов назад — перезвон не привязывается к звонившему", async () => {
    await prisma.agent.update({ where: { id: reviewerId }, data: { permissions: ARCHIVE_GRANTS } });
    await reviewCall(reviewerId, new Date(Date.now() - 73 * 3600_000));
    const id = `cb-old-${runId}`;
    await ring(id);
    await hangup(id);
    await settle();
    expect(routeCalls.every((c) => !c.archiveReviewerId)).toBe(true);
    expect(pushTargets()).not.toContain(reviewerId);
  });

  it("запись самого перезвона окно не продлевает: старый разбор + свежая запись «клиент перезвонил» — перевода нет", async () => {
    await prisma.agent.update({ where: { id: reviewerId }, data: { permissions: ARCHIVE_GRANTS } });
    await reviewCall(reviewerId, new Date(Date.now() - 73 * 3600_000));
    await reviewCall(reviewerId, new Date(), "Разбор удалённого клиента: клиент перезвонил, разговор 2:10");
    await ring(`cb-chain-${runId}`);
    await vi.waitFor(() => expect(routeCalls).toHaveLength(1));
    expect(routeCalls[0]!.archiveReviewerId).toBeUndefined();
  });

  it("у номера есть живая карточка (дубль, номер запасной) — звонок идёт её агенту, а не звонившему из Корзины", async () => {
    await prisma.agent.update({ where: { id: reviewerId }, data: { permissions: ARCHIVE_GRANTS } });
    await reviewCall(reviewerId);
    liveId = (
      await prisma.client.create({
        data: { fullName: `Живой перезвон ${runId}`, phone: `+99299${String(runId).slice(-7)}`, extraPhones: [phone], source: "PHONE_CALL", assignedAgentId: plainAgentId, acceptedAt: new Date() },
      })
    ).id;
    await ring(`cb-live-${runId}`);
    await vi.waitFor(() => expect(routeCalls).toHaveLength(1));
    expect(routeCalls[0]!.archiveReviewerId).toBeUndefined();
    // Точное совпадение отдавало удалённую карточку (findClientByPhoneDigits) — теперь звонок «принадлежит» живой.
    expect(routeCalls[0]!.clientId).toBe(liveId);
  });
});
