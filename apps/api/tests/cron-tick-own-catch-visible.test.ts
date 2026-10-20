import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { scheduleTracked, reportCronTickError, markCronTickFailed } from "../src/lib/cronHeartbeat.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * СБОЙ ВНУТРИ ТИКА СО СВОИМ try/catch ВИДЕН (аудит 23.09.2026, №64).
 *
 * 80 из 87 тиков ловили ошибку сами и печатали её только в консоль: для пульса
 * тик завершался успешно (lastOkAt), журнал ошибок пуст, «Здоровье» зелёное.
 */

const runId = Date.now();
const REPORTED = `test-own-catch-report-${runId}`;
const MARKED = `test-own-catch-mark-${runId}`;

afterAll(async () => {
  await prisma.cronHeartbeat.deleteMany({ where: { name: { in: [REPORTED, MARKED] } } });
  await prisma.errorLog.deleteMany({ where: { source: "cron", message: { contains: String(runId) } } });
});

async function runOnce(name: string, fn: () => Promise<void>) {
  const task = scheduleTracked(name, "*/30 * * * *", fn);
  try {
    await task.execute();
  } finally {
    await task.destroy();
  }
}

describe("тик сам поймал ошибку", () => {
  it("reportCronTickError: ошибка в пульсе тика и в журнале, «успешный запуск» не отмечен", async () => {
    await runOnce(REPORTED, async () => {
      try {
        throw new Error(`база отвалилась ${runId}`);
      } catch (err) {
        reportCronTickError("Ошибка тестовой задачи", err);
      }
    });
    const row = await waitFor(async () => {
      const r = await prisma.cronHeartbeat.findUnique({ where: { name: REPORTED } });
      return r?.lastError ? r : null;
    });
    expect(row.lastError).toContain("Ошибка тестовой задачи");
    expect(row.lastOkAt).toBeNull();
    const logged = await waitFor(() =>
      prisma.errorLog.findFirst({ where: { source: "cron", message: { contains: `база отвалилась ${runId}` } } })
    );
    expect(logged.message).toContain(REPORTED);
  });

  it("markCronTickFailed: отметка в пульсе без второй записи в журнал", async () => {
    await runOnce(MARKED, async () => {
      try {
        throw new Error(`курс не пришёл ${runId}`);
      } catch (err) {
        markCronTickFailed("Курс", err);
      }
    });
    const row = await waitFor(async () => {
      const r = await prisma.cronHeartbeat.findUnique({ where: { name: MARKED } });
      return r?.lastError ? r : null;
    });
    expect(row.lastOkAt).toBeNull();
    expect(
      await prisma.errorLog.count({ where: { source: "cron", message: { contains: `курс не пришёл ${runId}` } } })
    ).toBe(0);
  });
});
