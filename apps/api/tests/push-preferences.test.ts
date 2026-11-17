import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Новые поводы для push и личные настройки по видам (решение владельца 11.08.2026).
 *
 * Проверяется главное: сотрудник может выключить ОДИН вид, не выключая остальные
 * (до этого было «всё или ничего» на устройство, и агент, которому мешали
 * сообщения клиентов, отключал заодно и новые лиды), пороги частоты действительно
 * гасят пачку, а служебные уведомления без вида не выключаются вовсе.
 *
 * РЕГРЕСС-ЩИТ: с пустым списком выключенного всё уходит как раньше.
 */

const sendNotification = vi.fn(async () => ({}) as unknown);
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...args: unknown[]) => sendNotification(...(args as [])) },
}));

// Без ключей VAPID src/push.ts выключает отправку целиком ещё при загрузке модуля —
// и любая проверка ниже была бы зелёной впустую, ничего не отправив. Сам web-push
// замокан выше, поэтому ключи нужны только как признак «push настроен». На соседей
// эти переменные не влияют: tests/setup.ts возвращает process.env к исходному
// состоянию после каждого файла (весь прогон идёт в одном процессе).
process.env.VAPID_PUBLIC_KEY = "тестовый-открытый-ключ";
process.env.VAPID_PRIVATE_KEY = "тестовый-закрытый-ключ";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { sendPushToAgent } = await import("../src/push.js");
const { recordScoreEvent } = await import("../src/lib/scoreJournal.js");
const { notifyAgentOfClientMessage, resetClientMessageThrottle } = await import("../src/lib/clientMessageAlert.js");

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let agentToken: string;
let savedScoreOn: boolean;
let savedScoreThrottle: number;
let savedMessageThrottle: number;

/** Сколько раз web-push реально дёрнули — то есть сколько уведомлений уехало. */
const sentCount = () => sendNotification.mock.calls.length;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент настроек push ${runId}`, phone: `+992961${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  agentToken = res.body.accessToken;

  // Одна подписка: без неё отправлять некуда и любой тест был бы зелёным впустую.
  await prisma.pushSubscription.create({
    data: {
      agentId,
      endpoint: `https://example.test/push/${runId}`,
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=",
      auth: "tBHItJI5svbpez7KI4CCXg==", // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    },
  });

  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  savedScoreOn = settings.pushOnScoreChange;
  savedScoreThrottle = settings.pushScoreThrottleMinutes;
  savedMessageThrottle = settings.pushMessageThrottleMinutes;
});

beforeEach(async () => {
  sendNotification.mockClear();
  await prisma.agent.update({ where: { id: agentId }, data: { pushMuted: [] } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { pushOnScoreChange: true, pushScoreThrottleMinutes: 10 },
  });
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      pushOnScoreChange: savedScoreOn,
      pushScoreThrottleMinutes: savedScoreThrottle,
      pushMessageThrottleMinutes: savedMessageThrottle,
    },
  });
  await prisma.pushSubscription.deleteMany({ where: { agentId } });
  await prisma.agent.delete({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Личные настройки по видам", () => {
  it("отдают полный список видов, все включены по умолчанию", async () => {
    const res = await request(app).get("/api/v1/push/preferences").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.kinds.length).toBeGreaterThan(3);
    expect(res.body.kinds.every((k: { enabled: boolean }) => k.enabled)).toBe(true);
  });

  it("выключенный вид не доходит, а остальные продолжают доходить", async () => {
    await request(app)
      .patch("/api/v1/push/preferences")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ kind: "message", enabled: false })
      .expect(200);

    await sendPushToAgent(agentId, { kind: "message", title: "т", body: "т" });
    expect(sentCount()).toBe(0);

    // Ровно то, ради чего всё делалось: лиды продолжают приходить.
    await sendPushToAgent(agentId, { kind: "lead", title: "т", body: "т" });
    expect(sentCount()).toBe(1);
  });

  it("служебное уведомление без вида выключить нельзя", async () => {
    await prisma.agent.update({
      where: { id: agentId },
      data: { pushMuted: ["lead", "message", "showing", "task", "score"] },
    });
    await sendPushToAgent(agentId, { title: "Ключ не возвращён", body: "т" });
    expect(sentCount()).toBe(1);
  });

  it("вид уведомления не уезжает на устройство — он нужен только серверу", async () => {
    await sendPushToAgent(agentId, { kind: "lead", title: "т", body: "т" });
    const payload = JSON.parse(sendNotification.mock.calls[0][1] as unknown as string);
    expect(payload.title).toBe("т");
    expect(payload.kind).toBeUndefined();
  });

  it("несуществующий вид не принимается", async () => {
    const res = await request(app)
      .patch("/api/v1/push/preferences")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ kind: "чего-нибудь", enabled: false });
    expect(res.status).toBe(400);
  });

  it("регресс-щит: с пустым списком выключенного уходит всё", async () => {
    for (const kind of ["lead", "message", "showing", "task", "score"] as const) {
      await sendPushToAgent(agentId, { kind, title: "т", body: "т" });
    }
    expect(sentCount()).toBe(5);
  });
});

describe("Изменение Royal Score телефон не будит", () => {
  /**
   * Владелец 20.09.2026, дословно: «Royal Score удалить». Начисления идут
   * пачками с ночных разборов, и агент получал подряд несколько вибраций про
   * баллы. Сам счёт и полная история с причинами остались в кабинете агента.
   *
   * Тест идёт через recordScoreEvent, а не через удалённый notifyScoreChange:
   * проверять надо именно то, что запись балла больше НИКОГО не будит, откуда
   * бы её ни позвали.
   */
  it("записанный балл не шлёт ни одного push", async () => {
    await recordScoreEvent({
      agentId,
      kind: "task_overdue",
      delta: -5,
      reason: "Показ не проведён и не отмечен",
      sourceId: `score-push-${runId}`,
    });
    // recordScoreEvent пишет событие в фоне — даём очереди промисов отработать.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sentCount()).toBe(0);
    const event = await prisma.royalScoreEvent.findFirst({ where: { sourceId: `score-push-${runId}` } });
    expect(event, "сам балл записываться не перестал").toBeTruthy();
  });
});

describe("Пачка сообщений клиента", () => {
  let clientId: string;

  beforeAll(async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент пачки ${runId}`,
        phone: `+992962${runId}`,
        source: "WHATSAPP",
        assignedAgentId: agentId,
      },
    });
    clientId = client.id;
  });

  afterAll(async () => {
    await prisma.interaction.deleteMany({ where: { clientId } });
    await prisma.client.delete({ where: { id: clientId } });
  });

  it("три сообщения подряд дают одно уведомление", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { pushMessageThrottleMinutes: 3 } });
    await notifyAgentOfClientMessage(clientId, "здравствуйте");
    await notifyAgentOfClientMessage(clientId, "а можно рассрочку?");
    await notifyAgentOfClientMessage(clientId, "и ещё вопрос");
    expect(sentCount()).toBe(1);
  });

  it("порог — константа 3 минуты с 01.11.2026: ноль в колонке Settings антиспам не снимает", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { pushMessageThrottleMinutes: 0 } });
    resetClientMessageThrottle(); // окно предыдущего теста живёт в памяти процесса
    try {
      await notifyAgentOfClientMessage(clientId, "раз");
      await notifyAgentOfClientMessage(clientId, "два");
      expect(sentCount()).toBe(1);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { pushMessageThrottleMinutes: 3 } });
    }
  });
});
