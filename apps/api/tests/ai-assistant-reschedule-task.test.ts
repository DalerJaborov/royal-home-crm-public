import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";

/**
 * reschedule_task (17.11.2026): описание обещало перенос БЛИЖАЙШЕЙ задачи, а код брал самую
 * дальнюю. Теперь: одна незавершённая задача — переносится; несколько — инструмент ничего не
 * двигает и возвращает короткий список (дата + суть) с просьбой уточнить, а модель повторяет вызов
 * с taskId. Перенос оставляет след в журнале клиента тем же способом, что create_task (запись
 * SYSTEM от помощника без nextAction — новой задачей она не становится).
 */

const { prisma } = await import("../src/db.js");
const { runTool } = await import("../src/ai/assistant.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = String(Date.now()).slice(-7);
let agentId = "";
let otherAgentId = "";
const clientIds: string[] = [];
let n = 0;

const actor = () => ({
  id: agentId,
  role: "AGENT",
  canViewAllClients: false,
  canViewPhone: false,
  canViewReports: false,
  canViewFinance: false,
  canViewAllDeals: false,
  canAssignClients: false,
  canEditForeignProperties: false,
  canModerate: false,
  canRequestChange: false,
});

const day = (d: number) => new Date(Date.UTC(2031, 4, d, 7));
const dayText = (d: number) => `2031-05-${String(d).padStart(2, "0")}`;

async function mkClient() {
  const client = await prisma.client.create({
    data: {
      fullName: `Перенос задач ${runId}-${++n}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    } as never,
  });
  clientIds.push(client.id);
  return client;
}

function mkTask(clientId: string, nextAction: string, date: Date, extra: Record<string, unknown> = {}) {
  return prisma.interaction.create({
    data: { clientId, type: "SYSTEM", actorKind: "AI", subjectAgentId: agentId, notes: "Тест переноса", nextAction, nextActionDate: date, ...extra } as never,
  });
}

const dateOf = async (id: string) => (await prisma.interaction.findUniqueOrThrow({ where: { id } })).nextActionDate?.getTime();
const journal = (clientId: string) =>
  prisma.interaction.findMany({ where: { clientId, nextActionDate: null, notes: { startsWith: "Перенос задачи (ИИ-ассистент)" } } });

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  const mk = async (name: string) =>
    (await prisma.agent.create({ data: { fullName: `${name} ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: "AGENT", passwordHash } })).id;
  agentId = await mk("Перенос Шабнам");
  otherAgentId = await mk("Перенос Шабнам чужой");
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await cleanupAssistantActionAgents([agentId, otherAgentId]);
  await prisma.$disconnect();
});

describe("reschedule_task: ближайшая задача и список при нескольких", () => {
  it("одна незавершённая задача — переносится; завершённая и отменённая не мешают; в журнале след, новой задачей он не становится", async () => {
    const client = await mkClient();
    const done = await mkTask(client.id, "Закрытая", day(2), { completedAt: new Date() });
    const cancelled = await mkTask(client.id, "Отменённая", day(3), { taskCancelledAt: new Date() });
    const open = await mkTask(client.id, "Позвонить по договору", day(10));

    const res = (await runTool("reschedule_task", { clientId: client.id, newDate: dayText(20) }, actor())) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: true, newDate: dayText(20) });
    expect(await dateOf(open.id)).not.toBe(day(10).getTime());
    expect(await dateOf(done.id)).toBe(day(2).getTime());
    expect(await dateOf(cancelled.id)).toBe(day(3).getTime());

    const rows = await waitFor(async () => {
      const found = await journal(client.id);
      return found.length > 0 ? found : null;
    });
    expect(rows).toHaveLength(1);
    expect(rows![0].type).toBe("SYSTEM");
    expect(rows![0].actorKind).toBe("AI");
    expect(rows![0].nextAction).toBeNull();
    expect(rows![0].notes).toContain("Позвонить по договору");
    expect(rows![0].notes).toContain(`с ${dayText(10)} на ${dayText(20)}`);
  });

  it("несколько задач — ничего не переносится, возвращается список от ближайшей к дальней и просьба уточнить", async () => {
    const client = await mkClient();
    // Дальняя заведена ПЕРВОЙ: раньше брали именно её.
    const far = await mkTask(client.id, "Встреча у нотариуса", day(25));
    const near = await mkTask(client.id, "Показ квартиры", day(12));

    const res = (await runTool("reschedule_task", { clientId: client.id, newDate: dayText(28) }, actor())) as {
      needClarification?: boolean;
      message?: string;
      tasks?: Array<{ taskId: string; date: string; task: string }>;
      ok?: boolean;
    };
    expect(res.ok).toBeUndefined();
    expect(res.needClarification).toBe(true);
    expect(res.message).toMatch(/taskId/);
    expect(res.tasks?.map((t) => t.taskId)).toEqual([near.id, far.id]);
    expect(res.tasks?.map((t) => t.date)).toEqual([dayText(12), dayText(25)]);
    expect(res.tasks?.[0].task).toContain("Показ квартиры");
    expect(await dateOf(near.id)).toBe(day(12).getTime());
    expect(await dateOf(far.id)).toBe(day(25).getTime());
    expect(await journal(client.id)).toHaveLength(0);

    // Уточнили — повторный вызов с taskId двигает именно выбранную и ничью больше.
    const picked = (await runTool("reschedule_task", { clientId: client.id, newDate: dayText(28), taskId: far.id }, actor())) as { ok?: boolean };
    expect(picked.ok).toBe(true);
    expect(await dateOf(far.id)).not.toBe(day(25).getTime());
    expect(await dateOf(near.id)).toBe(day(12).getTime());
    expect(await journal(client.id)).toHaveLength(1);
  });

  it("в списке не больше пяти задач, остальные — признаком more", async () => {
    const client = await mkClient();
    for (let d = 1; d <= 7; d++) await mkTask(client.id, `Задача ${d}`, day(d));
    const res = (await runTool("reschedule_task", { clientId: client.id, newDate: dayText(30) }, actor())) as { tasks?: unknown[]; more?: boolean };
    expect(res.tasks).toHaveLength(5);
    expect(res.more).toBe(true);
  });

  it("taskId чужой, закрытый или от другого клиента — «не найдена», ничего не тронуто", async () => {
    const client = await mkClient();
    const mine = await mkTask(client.id, "Своя", day(14));
    const foreign = await mkTask(client.id, "Чужая", day(15), { subjectAgentId: otherAgentId });
    const closed = await mkTask(client.id, "Закрытая", day(16), { completedAt: new Date() });
    const another = await mkClient();
    const elsewhere = await mkTask(another.id, "Другой клиент", day(17));

    for (const taskId of [foreign.id, closed.id, elsewhere.id, "не-id"]) {
      const res = (await runTool("reschedule_task", { clientId: client.id, newDate: dayText(27), taskId }, actor())) as { error?: string };
      expect(res.error, taskId).toMatch(/Такой задачи/);
    }
    expect(await dateOf(mine.id)).toBe(day(14).getTime());
    expect(await dateOf(foreign.id)).toBe(day(15).getTime());
    expect(await dateOf(elsewhere.id)).toBe(day(17).getTime());
  });

  it("задачи другого агента в списке не видны: агент с одной своей задачей переносит её без вопросов", async () => {
    const client = await mkClient();
    await mkTask(client.id, "Чужая", day(5), { subjectAgentId: otherAgentId });
    const mine = await mkTask(client.id, "Своя", day(9));
    const res = (await runTool("reschedule_task", { clientId: client.id, newDate: dayText(26) }, actor())) as { ok?: boolean };
    expect(res.ok).toBe(true);
    expect(await dateOf(mine.id)).not.toBe(day(9).getTime());
  });

  it("повторный вызов с той же датой — без изменения и без второй записи в журнале", async () => {
    const client = await mkClient();
    const task = await mkTask(client.id, "Позвонить", day(6));
    await runTool("reschedule_task", { clientId: client.id, newDate: dayText(21), taskId: task.id }, actor());
    const again = await runTool("reschedule_task", { clientId: client.id, newDate: dayText(21), taskId: task.id }, actor());
    expect(again).toMatchObject({ ok: true, alreadyDone: true });
    expect(await journal(client.id)).toHaveLength(1);
  });
});
