import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * ВОПРОСЫ АГЕНТУ О ПОКАЗЕ (владелец 22.11.2026): «Договорились о показе?» и «У вас был
 * показ?» — кнопками в Шабнам, страховка пушем и карточкой в CRM. Ответ в одном месте
 * закрывает вопрос в другом (одна дверь lib/showingQuestions.ts).
 *
 * Время тестов — «завтра в 12:00 по Душанбе» (NOW): внутри часов агента 08:00–22:00
 * при любом часе прогона. Telegram и пуши подменены — проверяем, ЧТО и КОМУ ушло.
 */

const { sendHtmlMessage, editHtmlMessage, answerCallbackQuery } = vi.hoisted(() => {
  let id = 7000;
  return {
    sendHtmlMessage: vi.fn(async (_c: string, _h: string, _r?: number, _b?: unknown) => ({ message_id: ++id })),
    editHtmlMessage: vi.fn(async (_c: string, _m: number, _h: string, _b?: unknown) => undefined),
    answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
  };
});
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendHtmlMessage,
  editHtmlMessage,
  answerCallbackQuery,
}));

const sendPushToAgent = vi.fn(async (_agentId: string, _payload: unknown) => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const switchesOff = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return { ...actual, automationSwitchOn: async (...a: Parameters<typeof actual.automationSwitchOn>) => (switchesOff.has(a[0]) ? false : actual.automationSwitchOn(...a)) };
});

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { dushanbeStartOfToday } = await import("../src/lib/dushanbeTime.js");
const {
  answerShowingQuestion, askShowingAgreement, closedByFact, listShowingQuestions, loadQuestionDetails, planShowingOutcomeQuestions,
} = await import("../src/lib/showingQuestions.js");
const { handleShowingQuestionCallback, renderShowingQuestion, runShowingQuestionsTick, showingQuestionContext } = await import(
  "../src/telegram/showingQuestionNotice.js"
);

const PASSWORD = "testpass123";
const runId = String(Date.now()).slice(-7);
const HOUR = 3600_000;
/** Завтра 12:00 по Душанбе — внутри часов агента при любом часе прогона. */
const NOW = new Date(dushanbeStartOfToday().getTime() + 36 * HOUR);
/** Послезавтра в 15:00 по Душанбе — допустимое время показа от NOW. */
const DAY_AFTER_15 = new Date(dushanbeStartOfToday().getTime() + 48 * HOUR + 15 * HOUR);

let districtId = "";
const agents: Record<"tg" | "plain" | "other" | "boss", { id: string; phone: string; chat?: string }> = {
  tg: { id: "", phone: "" }, plain: { id: "", phone: "" }, other: { id: "", phone: "" }, boss: { id: "", phone: "" },
};
const clientIds: string[] = [];
const propertyIds: string[] = [];
let cb = 0;
const callbackId = () => `sq-${runId}-${++cb}`;

async function mkAgent(key: keyof typeof agents, role: "AGENT" | "HEAD_OF_SALES", telegram: boolean) {
  const chat = String(880_000_000 + Number(runId) * 10 + Object.keys(agents).indexOf(key));
  const phone = `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;
  const agent = await prisma.agent.create({
    data: {
      fullName: `Показ-вопрос ${key} ${runId}`,
      phone,
      role,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      ...(telegram ? { telegramChatId: chat, telegramUserId: chat } : {}),
    },
  });
  agents[key] = { id: agent.id, phone, ...(telegram ? { chat } : {}) };
}

async function mkClient(agentId: string) {
  const client = await prisma.client.create({
    data: {
      fullName: `Покупатель вопроса ${runId}-${clientIds.length}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      desiredDistrictId: districtId,
    },
  });
  clientIds.push(client.id);
  return client;
}

async function mkProperty(suffix: string) {
  const p = await prisma.property.create({
    data: {
      title: `Объект вопроса ${runId}-${suffix}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 50000,
      currency: "TJS",
      districtId,
      address: `Тестовая вопроса, ${suffix}`,
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: agents.tg.id,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

async function mkShowing(clientId: string, agentId: string, propertyId: string, at: Date) {
  return prisma.interaction.create({
    data: { clientId, agentId, type: "SHOWING", propertyId, notes: "Показ объекта", nextAction: "Показ объекта", nextActionDate: at, createdAt: new Date(at.getTime() - 2 * 24 * HOUR) },
  });
}

async function mkOutcomeQuestion(agentId: string, opts: { telegram?: boolean } = {}) {
  const client = await mkClient(agentId);
  const property = await mkProperty(`p${clientIds.length}`);
  const showing = await mkShowing(client.id, agentId, property.id, new Date(NOW.getTime() - 90 * 60_000));
  await planShowingOutcomeQuestions(NOW);
  const q = await prisma.showingQuestion.findUniqueOrThrow({ where: { dedupKey: `outcome:${showing.id}` } });
  if (opts.telegram) {
    await prisma.showingQuestion.update({ where: { id: q.id }, data: { telegramSentAt: NOW, telegramChatId: "555", telegramMessageId: 42 } });
  }
  return { client, property, showing, q };
}

/** Кнопки Шабнам и маршрут живут по настоящим часам: показ должен быть в прошлом от «сейчас», иначе он «перенесён». */
async function showingInRealPast(showingId: string) {
  await prisma.interaction.update({ where: { id: showingId }, data: { nextActionDate: new Date(Date.now() - 2 * HOUR) } });
}

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-вопрос-показа-${runId}` } })).id;
  await mkAgent("tg", "AGENT", true);
  await mkAgent("plain", "AGENT", false);
  await mkAgent("other", "AGENT", true);
  await mkAgent("boss", "HEAD_OF_SALES", false);
});

beforeEach(() => {
  sendHtmlMessage.mockClear();
  editHtmlMessage.mockClear();
  answerCallbackQuery.mockClear();
  sendPushToAgent.mockClear();
  switchesOff.clear();
});

afterAll(async () => {
  const agentIds = Object.values(agents).map((a) => a.id);
  await prisma.showingQuestion.deleteMany({ where: { OR: [{ agentId: { in: agentIds } }, { clientId: { in: clientIds } }] } });
  await prisma.staffNotice.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.session.deleteMany({ where: { agentId: { in: agentIds } } }).catch(() => undefined);
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => undefined);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("«У вас был показ?» — заводится через час после показа", () => {
  it("прошёл час после показа — вопрос агенту показа; повтор тика второго не заводит", async () => {
    const client = await mkClient(agents.tg.id);
    const property = await mkProperty("план");
    const showing = await mkShowing(client.id, agents.tg.id, property.id, new Date(NOW.getTime() - 61 * 60_000));
    expect(await planShowingOutcomeQuestions(NOW)).toBeGreaterThanOrEqual(1);
    const q = await prisma.showingQuestion.findUnique({ where: { dedupKey: `outcome:${showing.id}` } });
    expect(q?.kind).toBe("OUTCOME");
    expect(q?.agentId).toBe(agents.tg.id);
    expect(q?.askAt.getTime()).toBe(showing.nextActionDate!.getTime() + HOUR);
    await planShowingOutcomeQuestions(NOW);
    expect(await prisma.showingQuestion.count({ where: { dedupKey: `outcome:${showing.id}` } })).toBe(1);
  });

  it("отменённый показ, показ меньше часа назад и выключенный рубильник — вопроса нет", async () => {
    const client = await mkClient(agents.tg.id);
    const property = await mkProperty("нет-вопроса");
    const declined = await mkShowing(client.id, agents.tg.id, property.id, new Date(NOW.getTime() - 2 * HOUR));
    await prisma.interaction.update({ where: { id: declined.id }, data: { declinedAt: NOW } });
    const fresh = await mkShowing(client.id, agents.tg.id, property.id, new Date(NOW.getTime() - 30 * 60_000));
    // «На день» без часа — полночь по Душанбе (12 часов до NOW): «через час после показа» у неё нет.
    const dayOnly = await mkShowing(client.id, agents.tg.id, property.id, new Date(NOW.getTime() - 12 * HOUR));
    await planShowingOutcomeQuestions(NOW);
    expect(await prisma.showingQuestion.count({ where: { dedupKey: { in: [`outcome:${declined.id}`, `outcome:${fresh.id}`, `outcome:${dayOnly.id}`] } } })).toBe(0);

    const later = await mkShowing(client.id, agents.tg.id, property.id, new Date(NOW.getTime() - 3 * HOUR));
    switchesOff.add("showingOutcomeAskEnabled");
    expect(await planShowingOutcomeQuestions(NOW)).toBe(0);
    expect(await prisma.showingQuestion.count({ where: { dedupKey: `outcome:${later.id}` } })).toBe(0);
  });
});

describe("Отправка: Шабнам, а если некуда — пуш в CRM", () => {
  it("у агента есть Telegram — вопрос с кнопками в Шабнам, без пуша", async () => {
    const { q } = await mkOutcomeQuestion(agents.tg.id);
    await runShowingQuestionsTick(NOW);
    const call = sendHtmlMessage.mock.calls.find(([chat, html, , b]) => chat === agents.tg.chat && html.includes("У вас был показ?") && JSON.stringify(b).includes(q.id));
    expect(call).toBeTruthy();
    const buttons = JSON.stringify(call![3]);
    expect(buttons).toContain(`sq:y:${q.id}`);
    expect(buttons).toContain(`sq:x:${q.id}`);
    const after = await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.telegramSentAt).not.toBeNull();
    expect(after.telegramMessageId).toBeGreaterThan(0);
    expect(sendPushToAgent.mock.calls.some(([id]) => id === agents.tg.id)).toBe(false);
  });

  it("у агента нет Telegram — тот же вопрос пушем со ссылкой на карточку клиента", async () => {
    const { q, client } = await mkOutcomeQuestion(agents.plain.id);
    await runShowingQuestionsTick(NOW);
    const push = sendPushToAgent.mock.calls.find(([id]) => id === agents.plain.id);
    expect(push).toBeTruthy();
    expect(push![1]).toMatchObject({ kind: "showing", title: "🏠 У вас был показ?", url: `/clients/${client.shortId}` });
    expect((await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } })).pushSentAt).not.toBeNull();
  });

  it("спросили в Шабнам и 3 часа нет ответа — один пуш-страховка", async () => {
    const { q } = await mkOutcomeQuestion(agents.tg.id);
    await prisma.showingQuestion.update({ where: { id: q.id }, data: { telegramSentAt: new Date(NOW.getTime() - 4 * HOUR) } });
    await runShowingQuestionsTick(NOW);
    await runShowingQuestionsTick(NOW);
    expect(sendPushToAgent.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === `showing-question-${q.id}`)).toHaveLength(1);
  });

  it("ночью (23:30) никого не будит — вопрос ждёт утра", async () => {
    const night = new Date(dushanbeStartOfToday().getTime() + 24 * HOUR + 23.5 * HOUR);
    const client = await mkClient(agents.tg.id);
    const property = await mkProperty("ночь");
    const showing = await mkShowing(client.id, agents.tg.id, property.id, new Date(night.getTime() - 2 * HOUR));
    const result = await runShowingQuestionsTick(night);
    expect(result.sent).toBe(0);
    const q = await prisma.showingQuestion.findUnique({ where: { dedupKey: `outcome:${showing.id}` } });
    expect(q?.telegramSentAt).toBeNull();
  });

  it("показ уже отмечен в календаре — вопрос снимается фактом, ничего не уходит", async () => {
    const { q, showing } = await mkOutcomeQuestion(agents.tg.id);
    await prisma.interaction.update({ where: { id: showing.id }, data: { completedAt: NOW } });
    await runShowingQuestionsTick(NOW);
    const after = await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.status).toBe("CLOSED");
    expect(after.answeredVia).toBe("fact");
    expect(sendHtmlMessage.mock.calls.some(([, html]) => html.includes(q.id))).toBe(false);
  });
});

describe("Ответ — одна дверь для CRM и Шабнам", () => {
  it("«Был» + «Думает, перезвонить» — показ отмечен, задача на выбранное время, кнопки в Шабнам сняты", async () => {
    const { q, showing, client } = await mkOutcomeQuestion(agents.tg.id, { telegram: true });
    const callbackAt = new Date(NOW.getTime() + 26 * HOUR);
    const res = await answerShowingQuestion({
      questionId: q.id, actorId: agents.tg.id, canActForOthers: false, via: "crm",
      answer: { action: "held", next: "callback", callbackAt: callbackAt.toISOString() }, now: NOW,
    });
    expect(res.ok).toBe(true);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id } })).completedAt).not.toBeNull();
    const task = await prisma.interaction.findFirst({ where: { clientId: client.id, nextAction: "Перезвонить клиенту после показа" } });
    expect(task?.nextActionDate?.getTime()).toBe(callbackAt.getTime());
    expect(task?.agentId).toBe(agents.tg.id);
    const after = await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after).toMatchObject({ status: "ANSWERED", answeredVia: "crm", answer: "held" });
    expect(editHtmlMessage).toHaveBeenCalledWith("555", 42, expect.stringContaining("ответ в CRM"), null);

    // Второй ответ (кнопка в Шабнам после ответа в CRM) — отказ, ничего второй раз не пишется.
    const again = await answerShowingQuestion({
      questionId: q.id, actorId: agents.tg.id, canActForOthers: false, via: "telegram", answer: { action: "held", next: "pick_others" }, now: NOW,
    });
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(await prisma.interaction.count({ where: { clientId: client.id, nextAction: "Подобрать другие объекты после показа" } })).toBe(0);
  });

  it("чужой вопрос рядовой агент не закрывает; руководство — может", async () => {
    const { q } = await mkOutcomeQuestion(agents.tg.id);
    const denied = await answerShowingQuestion({
      questionId: q.id, actorId: agents.other.id, canActForOthers: false, via: "crm", answer: { action: "held", next: "refused" }, now: NOW,
    });
    expect(denied).toMatchObject({ ok: false, status: 403 });
    const boss = await answerShowingQuestion({
      questionId: q.id, actorId: agents.boss.id, canActForOthers: true, via: "crm", answer: { action: "held", next: "refused" }, now: NOW,
    });
    expect(boss.ok).toBe(true);
  });

  it("«Нет → перенесли» двигает показ, «Нет → отменили» снимает его с причиной", async () => {
    const moved = await mkOutcomeQuestion(agents.tg.id);
    const res = await answerShowingQuestion({
      questionId: moved.q.id, actorId: agents.tg.id, canActForOthers: false, via: "crm", answer: { action: "reschedule", at: DAY_AFTER_15.toISOString() }, now: NOW,
    });
    expect(res.ok).toBe(true);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: moved.showing.id } })).nextActionDate?.getTime()).toBe(DAY_AFTER_15.getTime());

    const cancelled = await mkOutcomeQuestion(agents.tg.id);
    const res2 = await answerShowingQuestion({
      questionId: cancelled.q.id, actorId: agents.tg.id, canActForOthers: false, via: "crm", answer: { action: "cancelled", reason: "Клиент передумал" }, now: NOW,
    });
    expect(res2.ok).toBe(true);
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: cancelled.showing.id } });
    expect(row.nextAction === null || row.declinedAt !== null || row.taskCancelledAt !== null).toBe(true);
  });

  it("ответ не того вида («записать показ» на «Показ был?») — отказ, вопрос открыт", async () => {
    const { q, property } = await mkOutcomeQuestion(agents.tg.id);
    const res = await answerShowingQuestion({
      questionId: q.id, actorId: agents.tg.id, canActForOthers: false, via: "crm",
      answer: { action: "book", propertyId: property.id, at: DAY_AFTER_15.toISOString() }, now: NOW,
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect((await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("OPEN");
  });

  it("«Договорились» — показ записывается на выбранный объект; время вне часов показов — отказ и вопрос снова открыт", async () => {
    const client = await mkClient(agents.tg.id);
    const property = await mkProperty("договорились");
    await askShowingAgreement({ agentId: agents.tg.id, clientId: client.id, sourceType: "CALL", sourceId: `call-${client.id}`, proposedAt: null, propertyId: null, now: NOW });
    const q = await prisma.showingQuestion.findUniqueOrThrow({ where: { dedupKey: `agreement:CALL:call-${client.id}` } });

    const late = new Date(DAY_AFTER_15.getTime() + 6 * HOUR); // 21:00 — показы до 20:00
    const refused = await answerShowingQuestion({
      questionId: q.id, actorId: agents.tg.id, canActForOthers: false, via: "crm", answer: { action: "book", propertyId: property.id, at: late.toISOString() }, now: NOW,
    });
    expect(refused).toMatchObject({ ok: false, status: 422 });
    expect((await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("OPEN");

    const booked = await answerShowingQuestion({
      questionId: q.id, actorId: agents.tg.id, canActForOthers: false, via: "crm", answer: { action: "book", propertyId: property.id, at: DAY_AFTER_15.toISOString() }, now: NOW,
    });
    expect(booked.ok).toBe(true);
    const showing = await prisma.interaction.findFirst({ where: { clientId: client.id, type: "SHOWING" } });
    expect(showing?.propertyId).toBe(property.id);
    expect(showing?.nextActionDate?.getTime()).toBe(DAY_AFTER_15.getTime());
    expect((await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } })).showingId).toBe(showing?.id);
  });

  it("«Договорились?» снимается сам, если показ записали другим путём (кнопкой в карточке, помощницей)", async () => {
    const client = await mkClient(agents.tg.id);
    const property = await mkProperty("другим-путём");
    await askShowingAgreement({ agentId: agents.tg.id, clientId: client.id, sourceType: "CALL", sourceId: `call2-${client.id}`, proposedAt: null, propertyId: null, now: NOW });
    const q = await prisma.showingQuestion.findUniqueOrThrow({ where: { dedupKey: `agreement:CALL:call2-${client.id}` } });
    expect(await closedByFact(q, NOW)).toBeNull();
    await prisma.interaction.create({ data: { clientId: client.id, agentId: agents.tg.id, type: "SHOWING", propertyId: property.id, notes: "Показ объекта", nextAction: "Показ объекта", nextActionDate: DAY_AFTER_15 } });
    expect(await closedByFact(q, NOW)).toMatchObject({ answer: "booked_elsewhere" });
    expect(await listShowingQuestions(agents.tg.id, { clientId: client.id, now: new Date(NOW.getTime() + 2 * 60_000) })).toHaveLength(0);
    expect((await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("CLOSED");
  });
});

describe("Правки слепого ревью 22.11", () => {
  it("номер в имени карточки агенту не виден: ни в Шабнам, ни в CRM", async () => {
    const { q, client } = await mkOutcomeQuestion(agents.tg.id);
    await prisma.client.update({ where: { id: client.id }, data: { fullName: "Звонок +992 93 555 12 34" } });
    const { loadAgentAccess } = await import("../src/auth/middleware.js");
    expect((await loadAgentAccess(agents.tg.id))?.permissions.has("clients.viewPhone")).toBe(false);
    const details = (await loadQuestionDetails(q))!;
    const { html } = renderShowingQuestion(details);
    expect(html).not.toContain("555 12 34");
    const view = await listShowingQuestions(agents.tg.id, { clientId: client.id, now: NOW });
    expect(view[0]?.clientName).not.toContain("555 12 34");
  });

  it("«Был, перезвонить» с неверным сроком — отказ, и показ НЕ отмечен (не пишется наполовину)", async () => {
    const { q, showing, client } = await mkOutcomeQuestion(agents.tg.id);
    const res = await answerShowingQuestion({
      questionId: q.id, actorId: agents.tg.id, canActForOthers: false, via: "crm",
      answer: { action: "held", next: "callback", callbackAt: new Date(NOW.getTime() - HOUR).toISOString() }, now: NOW,
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id } })).completedAt).toBeNull();
    expect(await prisma.interaction.count({ where: { clientId: client.id, type: "SYSTEM", notes: { startsWith: "Итог показа" } } })).toBe(0);
    expect((await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("OPEN");
  });

  it("выключенный рубильник — вопрос своего вида в CRM не показывается", async () => {
    const { client } = await mkOutcomeQuestion(agents.tg.id);
    expect(await listShowingQuestions(agents.tg.id, { clientId: client.id, now: NOW })).toHaveLength(1);
    switchesOff.add("showingOutcomeAskEnabled");
    expect(await listShowingQuestions(agents.tg.id, { clientId: client.id, now: NOW })).toHaveLength(0);
  });

  it("у клиента уже есть показ на другое время — «Да» его молча не переносит", async () => {
    const client = await mkClient(agents.tg.id);
    const property = await mkProperty("другое-время");
    const existingAt = new Date(DAY_AFTER_15.getTime() + 2 * HOUR);
    const existing = await prisma.interaction.create({
      data: {
        clientId: client.id, agentId: agents.tg.id, type: "SHOWING", propertyId: property.id, notes: "Показ объекта",
        nextAction: "Показ объекта", nextActionDate: existingAt, createdAt: new Date(NOW.getTime() - 5 * 24 * HOUR),
      },
    });
    await askShowingAgreement({ agentId: agents.tg.id, clientId: client.id, sourceType: "CALL", sourceId: `call4-${client.id}`, proposedAt: DAY_AFTER_15, propertyId: property.id, now: NOW });
    const res = await answerShowingQuestion({
      questionId: (await prisma.showingQuestion.findUniqueOrThrow({ where: { dedupKey: `agreement:CALL:call4-${client.id}` } })).id,
      actorId: agents.tg.id, canActForOthers: false, via: "crm", answer: { action: "book", propertyId: property.id, at: DAY_AFTER_15.toISOString() }, now: NOW,
    });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: existing.id } })).nextActionDate?.getTime()).toBe(existingAt.getTime());
  });
});

describe("Кнопки в Шабнам", () => {
  it("«Да, был» только меняет кнопки на «что дальше», «Подобрать другие» — записывает итог и задачу", async () => {
    const { q, client, showing } = await mkOutcomeQuestion(agents.tg.id);
    await showingInRealPast(showing.id);
    const message = { chat: { id: Number(agents.tg.chat) }, message_id: 77, text: "У вас был показ?" };
    const from = { id: Number(agents.tg.chat) };

    expect(await handleShowingQuestionCallback({ id: callbackId(), data: `sq:y:${q.id}`, message, from })).toBe(true);
    expect(JSON.stringify(editHtmlMessage.mock.calls.at(-1)?.[3])).toContain(`sq:s:${q.id}:p`);
    expect((await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("OPEN");

    await handleShowingQuestionCallback({ id: callbackId(), data: `sq:s:${q.id}:p`, message, from });
    const after = await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after).toMatchObject({ status: "ANSWERED", answeredVia: "telegram" });
    expect(await prisma.interaction.count({ where: { clientId: client.id, nextAction: "Подобрать другие объекты после показа" } })).toBe(1);
  });

  it("чужой агент нажал кнопку — отказ, вопрос не тронут; повторная доставка того же нажатия не исполняется", async () => {
    const { q, showing } = await mkOutcomeQuestion(agents.tg.id);
    await showingInRealPast(showing.id);
    const message = { chat: { id: Number(agents.other.chat) }, message_id: 78 };
    await handleShowingQuestionCallback({ id: callbackId(), data: `sq:s:${q.id}:r`, message, from: { id: Number(agents.other.chat) } });
    expect(answerCallbackQuery).toHaveBeenLastCalledWith(expect.any(String), "Это вопрос другого сотрудника");
    expect((await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("OPEN");

    const own = { chat: { id: Number(agents.tg.chat) }, message_id: 79 };
    const id = callbackId();
    await handleShowingQuestionCallback({ id, data: `sq:s:${q.id}:r`, message: own, from: { id: Number(agents.tg.chat) } });
    await handleShowingQuestionCallback({ id, data: `sq:s:${q.id}:r`, message: own, from: { id: Number(agents.tg.chat) } });
    expect(answerCallbackQuery.mock.calls.filter(([cid, text]) => cid === id && text === "Записала")).toHaveLength(1);
  });

  it("кнопки укладываются в 64 байта Telegram; без времени «записать показ» не предлагается", async () => {
    const client = await mkClient(agents.tg.id);
    await mkProperty("кнопки");
    await askShowingAgreement({ agentId: agents.tg.id, clientId: client.id, sourceType: "CALL", sourceId: `call3-${client.id}`, proposedAt: null, propertyId: null, now: NOW });
    const q = await prisma.showingQuestion.findUniqueOrThrow({ where: { dedupKey: `agreement:CALL:call3-${client.id}` } });
    const noTime = renderShowingQuestion((await loadQuestionDetails(q))!);
    expect(noTime.buttons.flat().map((b) => b.callback_data)).toEqual([`sq:n:${q.id}`]);
    expect(noTime.html).toContain("время не поняла");

    await prisma.showingQuestion.update({ where: { id: q.id }, data: { proposedAt: DAY_AFTER_15 } });
    const withTime = renderShowingQuestion((await loadQuestionDetails((await prisma.showingQuestion.findUniqueOrThrow({ where: { id: q.id } }))))!);
    const datas = withTime.buttons.flat().map((b) => b.callback_data ?? "");
    expect(datas.some((d) => d.startsWith(`sq:b:${q.id}:`))).toBe(true);
    for (const d of datas) expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(64);
  });

  it("справка для свободного ответа — коды и id, без имени клиента", async () => {
    const { q, client } = await mkOutcomeQuestion(agents.other.id, { telegram: true });
    const context = await showingQuestionContext(agents.other.id, NOW);
    expect(context).toContain(`clientId ${client.id}`);
    expect(context).toContain(`id показа ${q.showingId}`);
    expect(context).toContain("complete_task");
    expect(context).not.toContain(client.fullName);
  });
});

describe("Экран CRM: GET /api/v1/showing-questions и ответ", () => {
  it("агент видит свой наступивший вопрос, чужой — нет; ответ проверяется схемой", async () => {
    const { q, client } = await mkOutcomeQuestion(agents.plain.id);
    await prisma.showingQuestion.update({ where: { id: q.id }, data: { askAt: new Date(Date.now() - 60_000) } });
    // Показ «в прошлом» относительно настоящего часа — иначе вопрос снимется как перенесённый.
    await showingInRealPast(q.showingId!);

    const token = await login(agents.plain.phone);
    const list = await request(app).get(`/api/v1/showing-questions?clientId=${client.id}`).set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(q.id);
    expect(list.body.items[0]).toMatchObject({ kind: "OUTCOME", clientShortId: client.shortId });

    const otherToken = await login(agents.other.phone);
    const foreign = await request(app).get(`/api/v1/showing-questions?clientId=${client.id}`).set("Authorization", `Bearer ${otherToken}`);
    expect(foreign.body.items).toHaveLength(0);

    const bad = await request(app).post(`/api/v1/showing-questions/${q.id}/answer`).set("Authorization", `Bearer ${token}`).send({ action: "held", next: "callback" });
    expect(bad.status).toBe(400);
    const ok = await request(app).post(`/api/v1/showing-questions/${q.id}/answer`).set("Authorization", `Bearer ${token}`).send({ action: "held", next: "pick_others" });
    expect(ok.status).toBe(200);
    expect(ok.body.message).toContain("Отметила: показ был");
  });
});
