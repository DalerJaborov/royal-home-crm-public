import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * B4 глубокой проверки 02.10.2026, решение владельца «да, по советам»: срок
 * принять вернувшегося клиента (returnAcceptDueAt, 120 мин) и срок проверки
 * дубля (duplicateReviewDueAt, 6 ч) идут ТОЛЬКО в рабочее время — как срок
 * первого звонка. Раньше клиент, вернувшийся в 19:00, к первому утреннему тику
 * был «просрочен на 10 часов» и сразу уходил руководителю, а агент не получал
 * ни предупреждения, ни напоминания.
 */

const { prisma } = await import("../src/db.js");
const { dushanbeInputToDate } = await import("../src/lib/dushanbeTime.js");
const { reactivateClientFromLost } = await import("../src/lib/clientLifecycle.js");
const { reassignStaleReturns } = await import("../src/leads.js");
const { openDuplicateReview, remindDuplicateReviewsNearingExpiry } = await import("../src/lib/duplicateReview.js");

const runId = Date.now().toString().slice(-7);
const at = (day: string, hhmm: string) => dushanbeInputToDate(day, hhmm);
let agentId: string;
let directorId: string;
const clientIds: string[] = [];
let saved: { workHoursStart: string; workHoursEnd: string; lostReturnAcceptMinutes: number; duplicateReviewTimeoutHours: number } | null =
  null;

async function makeClient(extra: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Срок рабочих минут ${runId}-${clientIds.length}`,
      phone: `+99290${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      ...extra,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
  saved = {
    workHoursStart: s.workHoursStart,
    workHoursEnd: s.workHoursEnd,
    lostReturnAcceptMinutes: s.lostReturnAcceptMinutes,
    duplicateReviewTimeoutHours: s.duplicateReviewTimeoutHours,
  };
  // Проверяем именно ночь — окно рабочего дня фиксируем как в проде по умолчанию.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { workHoursStart: "09:30", workHoursEnd: "18:00", lostReturnAcceptMinutes: 120, duplicateReviewTimeoutHours: 6 },
  });
  const passwordHash = await bcrypt.hash("x", 4);
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент сроков ${runId}`, phone: `+99293${runId}1`, role: "AGENT", passwordHash } })
  ).id;
  directorId = (
    await prisma.agent.create({ data: { fullName: `Директор сроков ${runId}`, phone: `+99293${runId}2`, role: "DIRECTOR", passwordHash } })
  ).id;
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(async () => {
  vi.useRealTimers();
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, directorId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.updateMany({ where: { id: { in: clientIds } }, data: { duplicateReviewOfClientId: null } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
});

describe("B4: срок возврата клиента — в рабочих минутах", () => {
  it("клиент вернулся в 19:00 — срок 11:30 утра, а не 21:00; утром агенту — задача в делах (без пуша), эскалация только после ещё 120 рабочих минут", async () => {
    const client = await makeClient({ status: "LOST", workStatus: "ACTIVE", lastAgentId: agentId });

    vi.setSystemTime(at("2026-10-05", "19:00"));
    const res = await reactivateClientFromLost({ clientId: client.id, reason: "тест B4", agentId, returnTimer: true });
    expect(res.ok).toBe(true);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: client.id }, select: { returnAcceptDueAt: true } });
    expect(row.returnAcceptDueAt?.toISOString()).toBe(at("2026-10-06", "11:30").toISOString());

    // 09:35 — первый утренний тик: ни эскалации, ни предупреждения (осталось 115 из 120 минут).
    vi.setSystemTime(at("2026-10-06", "09:35"));
    const morning = await reassignStaleReturns();
    expect(morning.escalated).toBe(0);
    expect(await prisma.notification.count({ where: { agentId, tag: `return-due-warning-${client.id}` } })).toBe(0);

    // 11:05 — осталось 25 минут: предупреждения агенту НЕТ (владелец 02.10.2026:
    // напоминания про вернувшегося клиента убраны — ни пуша, ни строки в ленте).
    vi.setSystemTime(at("2026-10-06", "11:05"));
    await reassignStaleReturns();
    expect(await prisma.notification.count({ where: { agentId, tag: `return-due-warning-${client.id}` } })).toBe(0);

    // 11:35 — срок вышел: агенту заводится задача в делах (не пуш и не лента),
    // руководителю — ничего.
    vi.setSystemTime(at("2026-10-06", "11:35"));
    const due = await reassignStaleReturns();
    expect(due.escalated).toBe(0);
    expect(await prisma.notification.count({ where: { agentId, tag: `return-due-reminder-${client.id}` } })).toBe(0);
    expect(
      await prisma.interaction.count({ where: { clientId: client.id, notes: { startsWith: "[returnDueReminder]" } } })
    ).toBe(1);

    // 13:31 — ещё 120 рабочих минут сверх срока: решение у руководителя.
    vi.setSystemTime(at("2026-10-06", "13:31"));
    const late = await reassignStaleReturns();
    expect(late.escalated).toBeGreaterThanOrEqual(1);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id }, select: { assignedAgentId: true } });
    expect(after.assignedAgentId).toBe(agentId);
  });

  it("срок, поставленный ещё по простым часам (21:00), утром не эскалирует сразу — ночь не считается просрочкой", async () => {
    const client = await makeClient({
      assignedAgentId: agentId,
      acceptedAt: at("2026-10-05", "19:00"),
      returnedAt: at("2026-10-05", "19:00"),
      returnAcceptDueAt: at("2026-10-05", "21:00"),
    });
    vi.setSystemTime(at("2026-10-06", "09:35"));
    const r = await reassignStaleReturns();
    expect(r.escalated).toBe(0);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: client.id }, select: { returnAcceptDueAt: true } });
    expect(row.returnAcceptDueAt).not.toBeNull();
  });
});

describe("B4: срок проверки дубля — в рабочих часах", () => {
  it("проверка открыта в 17:00 — истекает в 14:30 следующего дня, а не в 23:00; в 09:35 агента ещё не торопят", async () => {
    const candidate = await makeClient({ assignedAgentId: agentId, acceptedAt: at("2026-10-01", "10:00") });
    const fresh = await makeClient();

    vi.setSystemTime(at("2026-10-05", "17:00"));
    const held = await openDuplicateReview(
      { id: fresh.id, fullName: fresh.fullName, phone: fresh.phone },
      { id: candidate.id, shortId: candidate.shortId, fullName: candidate.fullName, assignedAgentId: agentId },
      6
    );
    expect(held).toBe(true);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: fresh.id }, select: { duplicateReviewDueAt: true } });
    expect(row.duplicateReviewDueAt?.toISOString()).toBe(at("2026-10-06", "14:30").toISOString());

    vi.setSystemTime(at("2026-10-06", "09:35"));
    await remindDuplicateReviewsNearingExpiry(new Date());
    expect(await prisma.notification.count({ where: { agentId, tag: `duplicate-review-warning-${fresh.id}` } })).toBe(0);

    // 13:05 — осталось 85 минут из 360 (меньше четверти): предупреждение приходит.
    vi.setSystemTime(at("2026-10-06", "13:05"));
    await remindDuplicateReviewsNearingExpiry(new Date());
    expect(await prisma.notification.count({ where: { agentId, tag: `duplicate-review-warning-${fresh.id}` } })).toBe(1);
  });
});
