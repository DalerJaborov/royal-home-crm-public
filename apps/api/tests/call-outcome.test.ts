import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent }));
// Эскалация «не отвечает» (lib/noAnswerStreak.ts) теперь ставит пуш руководству
// в общую очередь алармов (07.09.2026, часы алармов) — тест не должен плавать
// в зависимости от того, в какой час реально запущен прогон.
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinAlarmHours: async () => true,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { sendHourBeforeReminders } = await import("../src/lib/meetingReminders.js");
const { flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");

/** «Итог звонка»: исход «не ответил» сам ставит перезвон через 15 минут,
 *  три подряд — уведомление руководству (решение владельца 30.07). */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let directorId: string;
let clientId: string;
let token: string;

async function addInteraction(body: Record<string, unknown>) {
  const res = await request(app)
    .post(`/api/v1/clients/${clientId}/interactions`)
    .set("Authorization", `Bearer ${token}`)
    .send({ notes: "Звонок", type: "CALL", ...body });
  expect(res.status).toBe(201);
  return res.body as { id: string; nextAction: string | null; nextActionDate: string | null };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Агент дозвона", phone: `+992939${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор дозвона", phone: `+992938${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент дозвона ${runId}`,
        phone: `+992937${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

beforeEach(() => sendPushToAgent.mockClear());

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.$disconnect();
});

describe("Исход «не ответил»", () => {
  it("сам ставит перезвон через 15 минут", async () => {
    const created = await addInteraction({ outcome: "NO_ANSWER" });
    expect(created.nextAction).toContain("Перезвонить");
    const minutes = (new Date(created.nextActionDate!).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(13);
    expect(minutes).toBeLessThan(16);
  });

  /**
   * НАПОМИНАНИЕ ПРИХОДИТ В СРОК, А НЕ СРАЗУ ПОСЛЕ НЕДОЗВОНА.
   *
   * Тест раньше звал sendHourBeforeReminders() сразу после недозвона и ждал пуш —
   * и получал его, потому что ступень стояла «за 15 минут до», а перезвон
   * назначается через те же 15 минут. То есть тест закреплял ошибку: агенту
   * говорили «пора перезвонить» в ту секунду, когда он положил трубку, а к моменту
   * настоящего звонка не напоминали вовсе. Исправлено 14.08.2026 (ступень «в срок»),
   * тест переписан под то, что и должно проверяться.
   */
  it("сразу после недозвона не напоминает — звонить ещё рано", async () => {
    await addInteraction({ outcome: "NO_ANSWER" });
    await sendHourBeforeReminders();
    const calls = sendPushToAgent.mock.calls as unknown as [string, Record<string, string>][];
    expect(calls.find(([to]) => to === agentId)).toBeUndefined();
  });

  /**
   * Обратная половина — «в срок напоминание приходит» — проверяется в
   * tests/showing-reminders.test.ts, на своих отдельных записях. Здесь её
   * воспроизвести нельзя: в этом файле недозвоны идут подряд по одному клиенту,
   * и третий из них по правилу цепочки уже эскалируется руководителю, задачи
   * агенту не оставляя, — то есть напоминать было бы нечего и некому.
   */

  it("свой срок перезвона не перетирается", async () => {
    const own = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const created = await addInteraction({ outcome: "NO_ANSWER", nextAction: "Позвонить вечером", nextActionDate: own });
    expect(created.nextAction).toBe("Позвонить вечером");
    expect(new Date(created.nextActionDate!).getHours()).toBe(new Date(own).getHours());
  });

  it("три подряд (лимит по умолчанию) — руководство получает уведомление", async () => {
    // Первые два «не ответил» уже созданы выше; добиваем до трёх подряд.
    // notifyNoAnswerEscalation (lib/noAnswerStreak.ts) шлёт ОДНИМ пакетом на всех
    // супервизоров сразу (sendPushToAgents), а не по одному, как раньше.
    await addInteraction({ outcome: "NO_ANSWER" });
    // Ждём фонового уведомления: оно намеренно не блокирует ответ на запрос.
    await new Promise((r) => setTimeout(r, 400));
    // Пуш руководству теперь идёт через общую очередь (07.09.2026) — сначала
    // ставится в очередь, доставляет отдельный сборщик в часы алармов.
    await flushDirectorAlertQueue();
    const calls = sendPushToAgent.mock.calls as unknown as [string[], Record<string, string>][];
    const escalation = calls.find(([, p]) => p.title?.includes("не отвечает"));
    expect(escalation).toBeDefined();
    expect(escalation![0]).toContain(directorId);

    // Текст задачи руководителю берёт число попыток из Настроек, а не зашит
    // константой (было расхождение при кастомном noAnswerMaxAttempts).
    // Запись ОДНА и системная (П-10, 17.09.2026): раньше на каждого руководителя
    // заводилась своя копия с его agentId, теперь это один след actorKind=SYSTEM
    // с agentId=null, а адресаты получают пуш и колокольчик отдельно (проверено
    // выше). Поэтому ищем без agentId — с ним запрос не находил ничего.
    const task = await prisma.interaction.findFirst({
      where: { clientId, actorKind: "SYSTEM", type: "SYSTEM", notes: { contains: "недозвон" } },
    });
    expect(task?.notes).toContain("3 недозвона подряд");
  });

  it("состоявшийся разговор обнуляет счёт — уведомления больше нет", async () => {
    await addInteraction({ outcome: "WAITING_CALL", notes: "Дозвонился, ждёт звонка завтра" });
    sendPushToAgent.mockClear();
    await addInteraction({ outcome: "NO_ANSWER" });
    await new Promise((r) => setTimeout(r, 400));
    await flushDirectorAlertQueue();
    const calls = sendPushToAgent.mock.calls as unknown as [string[], Record<string, string>][];
    expect(calls.find(([, p]) => p.title?.includes("не отвечает"))).toBeUndefined();
  });
});

describe("Новые исходы ожидания", () => {
  it("принимаются сервером и сохраняются", async () => {
    for (const outcome of ["WAITING_CALL", "WAITING_OPTIONS", "WAITING_SHOWING"]) {
      // WAITING_SHOWING без даты и времени показа сервер теперь отклоняет —
      // см. tests/waiting-showing-requires-date.test.ts.
      const created = await addInteraction(
        outcome === "WAITING_SHOWING"
          ? { outcome, nextActionDate: new Date(Date.now() + 24 * 3600_000).toISOString() }
          : { outcome }
      );
      const saved = await prisma.interaction.findUnique({ where: { id: created.id } });
      expect(saved?.outcome).toBe(outcome);
    }
  });
});
