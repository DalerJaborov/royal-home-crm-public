import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { catchUpMissedTicks, scheduleTracked } from "../src/lib/cronHeartbeat.js";

/**
 * E7 / Ф8 глубокой проверки 02.10.2026: node-cron пропущенное не догоняет.
 * Выкат, пришедшийся на минуту суточного тика (daily-kpi 00:05, утренний отчёт
 * 08:00), терял запуск целиком: KPI за вчера не посчитан, отчёта нет, сторож
 * пульса молчит ещё двое суток.
 *
 * Теперь после старта процесса суточные и более редкие тики сверяют пульс в
 * базе с расписанием: срок прошёл недавно, а запуска после прошлого не было —
 * тик запускается сразу.
 */

const runId = Date.now();
const MINUTE = 60_000;
const tasks: Array<{ stop(): void }> = [];

afterAll(async () => {
  for (const t of tasks) t.stop();
  await prisma.cronHeartbeat.deleteMany({ where: { name: { startsWith: `test-catchup-` } } });
  await prisma.$disconnect();
});

/** Суточный тик в 00:05 по Душанбе (= 19:05 UTC предыдущего дня). */
function dailyTick(name: string) {
  const calls: number[] = [];
  tasks.push(scheduleTracked(name, "5 0 * * *", () => void calls.push(Date.now()), { timezone: "Asia/Dushanbe" }));
  return calls;
}

describe("догон пропущенных суточных тиков после рестарта", () => {
  // «Сейчас» — 00:07 по Душанбе 02.10, срок был 00:05.
  const now = new Date("2026-10-01T19:07:00.000Z");

  it("последний запуск — вчера, сегодняшний срок прошёл 2 минуты назад — тик запускается", async () => {
    const name = `test-catchup-missed-${runId}`;
    const calls = dailyTick(name);
    await prisma.cronHeartbeat.create({ data: { name, expr: "5 0 * * *", lastRunAt: new Date("2026-09-30T19:05:00.000Z") } });
    const ran = await catchUpMissedTicks(now);
    expect(ran).toContain(name);
    expect(calls).toHaveLength(1);
  });

  it("сегодня уже запускался — второй раз не запускается", async () => {
    const name = `test-catchup-done-${runId}`;
    const calls = dailyTick(name);
    await prisma.cronHeartbeat.create({ data: { name, expr: "5 0 * * *", lastRunAt: new Date("2026-10-01T19:05:01.000Z") } });
    const ran = await catchUpMissedTicks(now);
    expect(ran).not.toContain(name);
    expect(calls).toHaveLength(0);
  });

  it("срок прошёл давно (процесс лежал полдня) — не догоняется, это дело сторожа", async () => {
    const name = `test-catchup-old-${runId}`;
    const calls = dailyTick(name);
    await prisma.cronHeartbeat.create({ data: { name, expr: "5 0 * * *", lastRunAt: new Date("2026-09-30T19:05:00.000Z") } });
    const ran = await catchUpMissedTicks(new Date(now.getTime() + 12 * 60 * MINUTE));
    expect(ran).not.toContain(name);
    expect(calls).toHaveLength(0);
  });

  it("частый тик не догоняется — он и так придёт через минуты", async () => {
    const name = `test-catchup-frequent-${runId}`;
    const calls: number[] = [];
    tasks.push(scheduleTracked(name, "*/10 * * * *", () => void calls.push(1)));
    await prisma.cronHeartbeat.create({ data: { name, expr: "*/10 * * * *", lastRunAt: new Date(now.getTime() - 30 * MINUTE) } });
    const ran = await catchUpMissedTicks(now);
    expect(ran).not.toContain(name);
    expect(calls).toHaveLength(0);
  });

  it("новый тик без строки пульса — не запускается вслепую", async () => {
    const name = `test-catchup-new-${runId}`;
    const calls = dailyTick(name);
    const ran = await catchUpMissedTicks(now);
    expect(ran).not.toContain(name);
    expect(calls).toHaveLength(0);
  });

  /**
   * Журнал 28.11.2026: ночной обход рынка (до 3 ч) рвёт выкат; тик, помеченный повторяемым,
   * запускается заново, остальные оборванные — по-прежнему нет.
   */
  it("оборванный рестартом повторяемый тик (без успеха и ошибки) запускается заново, обычный — нет", async () => {
    const resumable = `test-catchup-resume-${runId}`;
    const plain = `test-catchup-noresume-${runId}`;
    const callsA: number[] = [];
    const callsB: number[] = [];
    tasks.push(scheduleTracked(resumable, "30 2 * * *", () => void callsA.push(1), { timezone: "Asia/Dushanbe" }, undefined, { rerunIfInterrupted: true, timeoutMs: 3.5 * 60 * MINUTE }));
    tasks.push(scheduleTracked(plain, "30 2 * * *", () => void callsB.push(1), { timezone: "Asia/Dushanbe" }));
    // «Сейчас» — 05:00 Душанбе, тик стартовал в 02:30 в процессе, которого уже нет (тест-процесс старше «сейчас»).
    const started = new Date(Date.now() - 2 * 60 * MINUTE);
    for (const n of [resumable, plain]) {
      await prisma.cronHeartbeat.create({ data: { name: n, expr: "30 2 * * *", lastRunAt: started, lastOkAt: new Date(started.getTime() - 24 * 60 * MINUTE) } });
    }
    // Процесс «стартовал» после запуска тика: now берём в будущее на минуту — processStartedAt уже позади started? Нет:
    // processStartedAt — момент загрузки модуля (сейчас), started — два часа назад, значит тик начат ДО старта процесса.
    const ran = await catchUpMissedTicks(new Date());
    expect(ran).toContain(resumable);
    expect(ran).not.toContain(plain);
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(0);
  });

  it("повторяемый тик с записанной ошибкой или слишком давний — не запускается", async () => {
    const withError = `test-catchup-resume-err-${runId}`;
    const stale = `test-catchup-resume-old-${runId}`;
    const calls: number[] = [];
    for (const n of [withError, stale]) {
      tasks.push(scheduleTracked(n, "30 2 * * *", () => void calls.push(1), { timezone: "Asia/Dushanbe" }, undefined, { rerunIfInterrupted: true, timeoutMs: 3.5 * 60 * MINUTE }));
    }
    await prisma.cronHeartbeat.create({ data: { name: withError, expr: "30 2 * * *", lastRunAt: new Date(Date.now() - 60 * MINUTE), lastError: "упал сам" } });
    await prisma.cronHeartbeat.create({ data: { name: stale, expr: "30 2 * * *", lastRunAt: new Date(Date.now() - 6 * 60 * MINUTE) } });
    const ran = await catchUpMissedTicks(new Date());
    expect(ran).not.toContain(withError);
    expect(ran).not.toContain(stale);
    expect(calls).toHaveLength(0);
  });
});
