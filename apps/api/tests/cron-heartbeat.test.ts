import { describe, it, expect, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { cronIntervalMs, nextCronRun, scheduleTracked, checkCronHeartbeats } from "../src/lib/cronHeartbeat.js";

/**
 * Пульс крон-тиков (26.08.2026, ревью, пункт 9): интервал из выражения,
 * запрет дублей имён, тревога сторожа по молчанию и её кулдаун.
 *
 * 17.09.2026: месячные тики (`monthly-report`, `monthly-problem-report`,
 * расписание `dom=1`) считались через `cronIntervalMs` как недельные —
 * «молчит 3 недели» будило директора ложной тревогой каждое утро, хотя
 * следующий запуск честно только 1-го числа. Тесты ниже (`nextCronRun`,
 * блок «месячный тик») закрывают именно этот случай.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

afterAll(async () => {
  await prisma.cronHeartbeat.deleteMany({ where: { name: { startsWith: "test-" } } });
  await prisma.errorLog.deleteMany({ where: { source: "cron", message: { contains: "test-" } } });
  await prisma.$disconnect();
});

describe("cronIntervalMs", () => {
  it("узнаёт основные формы расписаний", () => {
    expect(cronIntervalMs("*/5 * * * *")).toBe(5 * MINUTE);
    expect(cronIntervalMs("* * * * *")).toBe(MINUTE);
    expect(cronIntervalMs("7 * * * *")).toBe(60 * MINUTE);
    expect(cronIntervalMs("0 18 * * *")).toBe(24 * 60 * MINUTE);
    expect(cronIntervalMs("0 9 * * 1")).toBe(7 * 24 * 60 * MINUTE);
  });
});

describe("nextCronRun", () => {
  it("месячный тик (расписание директора, реальный симптом 17.09): следующий запуск — 1-е число, а не через неделю", () => {
    // Асия/Душанбе +5: 09:10 по Душанбе = 04:10 UTC — ровно как в упавшем алерте.
    const after = new Date("2026-09-01T04:10:00.000Z");
    const next = nextCronRun("10 9 1 * *", after, "Asia/Dushanbe");
    expect(next.toISOString()).toBe("2026-10-01T04:10:00.000Z");
  });

  it("недельный тик: следующий понедельник, не 1-е число", () => {
    const after = new Date("2026-09-08T09:00:00.000Z"); // сам понедельник, сразу после срабатывания
    const next = nextCronRun("0 9 * * 1", after);
    expect(next.toISOString()).toBe("2026-09-14T09:00:00.000Z");
  });

  it("ежечасный тик: следующий час", () => {
    const after = new Date("2026-09-17T08:00:00.000Z");
    const next = nextCronRun("0 * * * *", after);
    expect(next.toISOString()).toBe("2026-09-17T09:00:00.000Z");
  });
});

describe("scheduleTracked", () => {
  it("дубль имени — ошибка программиста, а не тихая слепота сторожа", () => {
    const task = scheduleTracked("test-dup", "*/5 * * * *", () => {});
    try {
      expect(() => scheduleTracked("test-dup", "*/5 * * * *", () => {})).toThrow(/занято/);
    } finally {
      task.stop();
    }
  });
});

describe("checkCronHeartbeats", () => {
  it("молчащий тик поднимает тревогу один раз, живой — не трогает", async () => {
    // Регистрируем тик с минутным интервалом и подделываем ему давний пульс.
    const silent = scheduleTracked("test-silent-tick", "* * * * *", () => {});
    const alive = scheduleTracked("test-alive-tick", "* * * * *", () => {});
    try {
      await prisma.cronHeartbeat.upsert({
        where: { name: "test-silent-tick" },
        update: { lastRunAt: new Date(Date.now() - 60 * MINUTE), alertedAt: null },
        create: { name: "test-silent-tick", expr: "* * * * *", lastRunAt: new Date(Date.now() - 60 * MINUTE) },
      });
      await prisma.cronHeartbeat.upsert({
        where: { name: "test-alive-tick" },
        update: { lastRunAt: new Date() },
        create: { name: "test-alive-tick", expr: "* * * * *", lastRunAt: new Date() },
      });

      const alerts = await checkCronHeartbeats();
      expect(alerts).toBeGreaterThanOrEqual(1);
      const logged = await prisma.errorLog.findFirst({
        where: { source: "cron", message: { contains: "test-silent-tick" } },
      });
      expect(logged).not.toBeNull();
      const aliveLogged = await prisma.errorLog.findFirst({
        where: { source: "cron", message: { contains: "test-alive-tick" } },
      });
      expect(aliveLogged).toBeNull();

      // Повторный проход по тому же молчанию — кулдаун, без второй тревоги.
      const again = await checkCronHeartbeats();
      const rows = await prisma.errorLog.count({
        where: { source: "cron", message: { contains: "test-silent-tick" } },
      });
      expect(rows).toBe(1);
      expect(again).toBe(0);
    } finally {
      silent.stop();
      alive.stop();
    }
  });

  it("месячный тик: через 20 дней после запуска НЕ тревожит (ждём 1-е число)", async () => {
    const lastRun = new Date("2026-09-01T04:10:00.000Z"); // 09:10 по Душанбе, как в реальном алерте
    const now = lastRun.getTime() + 20 * DAY;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const task = scheduleTracked("test-monthly-tick-20d", "10 9 1 * *", () => {}, { timezone: "Asia/Dushanbe" });
    try {
      await prisma.cronHeartbeat.upsert({
        where: { name: "test-monthly-tick-20d" },
        update: { lastRunAt: lastRun, alertedAt: null },
        create: { name: "test-monthly-tick-20d", expr: "10 9 1 * *", lastRunAt: lastRun },
      });
      // Не проверяем общий счётчик `alerts`: registry — общий модульный
      // синглтон на весь файл тестов, в нём к этому моменту уже есть записи
      // других тестов (test-silent-tick и т.п.) — их тревоги (или отсутствие)
      // тут ни при чём. Важно только поведение ИМЕННО этого тика.
      await checkCronHeartbeats();
      const logged = await prisma.errorLog.findFirst({
        where: { source: "cron", message: { contains: "test-monthly-tick-20d" } },
      });
      expect(logged).toBeNull();
    } finally {
      nowSpy.mockRestore();
      task.stop();
    }
  });

  it("месячный тик: через 33 дня без запуска — тревожит (1-е число уже прошло)", async () => {
    const lastRun = new Date("2026-09-01T04:10:00.000Z");
    const now = lastRun.getTime() + 33 * DAY;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const task = scheduleTracked("test-monthly-tick-33d", "10 9 1 * *", () => {}, { timezone: "Asia/Dushanbe" });
    try {
      await prisma.cronHeartbeat.upsert({
        where: { name: "test-monthly-tick-33d" },
        update: { lastRunAt: lastRun, alertedAt: null },
        create: { name: "test-monthly-tick-33d", expr: "10 9 1 * *", lastRunAt: lastRun },
      });
      const alerts = await checkCronHeartbeats();
      const logged = await prisma.errorLog.findFirst({
        where: { source: "cron", message: { contains: "test-monthly-tick-33d" } },
      });
      expect(logged).not.toBeNull();
      expect(logged?.message).toContain("следующий ожидался");
      expect(alerts).toBeGreaterThanOrEqual(1);
    } finally {
      nowSpy.mockRestore();
      task.stop();
    }
  });

  it("ежечасный тик: через 3 часа без запуска — тревожит (частые тики не сломаны)", async () => {
    const lastRun = new Date("2026-09-17T08:00:00.000Z");
    const now = lastRun.getTime() + 3 * 60 * MINUTE;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const task = scheduleTracked("test-hourly-tick-3h", "0 * * * *", () => {});
    try {
      await prisma.cronHeartbeat.upsert({
        where: { name: "test-hourly-tick-3h" },
        update: { lastRunAt: lastRun, alertedAt: null },
        create: { name: "test-hourly-tick-3h", expr: "0 * * * *", lastRunAt: lastRun },
      });
      const alerts = await checkCronHeartbeats();
      const logged = await prisma.errorLog.findFirst({
        where: { source: "cron", message: { contains: "test-hourly-tick-3h" } },
      });
      expect(logged).not.toBeNull();
      expect(alerts).toBeGreaterThanOrEqual(1);
    } finally {
      nowSpy.mockRestore();
      task.stop();
    }
  });
});

/**
 * №171 (ночная проверка 24.09): тики, которые живут в процессе api
 * (live-calls-sweep и три робозвонка живым голосом, 28.09.2026), не стоят в
 * реестре worker'а — а сторож пульса идёт в worker и смотрел только свой
 * реестр. Такой тик мог тихо умереть без единой строки в журнале, хотя его
 * строка пульса в базе честно стареет. Теперь сторож знает их по общему списку
 * (lib/apiProcessTicks.ts) и судит по строке пульса в базе.
 */
describe("checkCronHeartbeats — тики процесса api", () => {
  it("live-calls-sweep молчит час, в этом процессе он не запущен — тревога всё равно есть", async () => {
    const { API_PROCESS_TICKS } = await import("../src/lib/apiProcessTicks.js");
    expect(Object.keys(API_PROCESS_TICKS)).toContain("live-calls-sweep");
    const before = await prisma.cronHeartbeat.findUnique({ where: { name: "live-calls-sweep" } });
    try {
      await prisma.cronHeartbeat.upsert({
        where: { name: "live-calls-sweep" },
        update: { expr: "*/5 * * * *", lastRunAt: new Date(Date.now() - 60 * MINUTE), lastSkippedAt: null, alertedAt: null },
        create: { name: "live-calls-sweep", expr: "*/5 * * * *", lastRunAt: new Date(Date.now() - 60 * MINUTE) },
      });
      await prisma.errorLog.deleteMany({ where: { source: "cron", message: { contains: "«live-calls-sweep» молчит" } } });

      await checkCronHeartbeats();

      const logged = await prisma.errorLog.findFirst({
        where: { source: "cron", message: { contains: "«live-calls-sweep» молчит" } },
      });
      expect(logged).not.toBeNull();
    } finally {
      await prisma.errorLog.deleteMany({ where: { source: "cron", message: { contains: "«live-calls-sweep» молчит" } } });
      if (before) {
        const { name: _name, ...rest } = before;
        void _name;
        await prisma.cronHeartbeat.update({ where: { name: "live-calls-sweep" }, data: rest });
      } else {
        await prisma.cronHeartbeat.deleteMany({ where: { name: "live-calls-sweep" } });
      }
    }
  });

  it("список тиков api совпадает с тем, что реально ставит процесс api", async () => {
    const { API_PROCESS_TICKS } = await import("../src/lib/apiProcessTicks.js");
    const { LIVE_VOICE_SCENARIO_TICKS } = await import("../src/lib/telephony/liveVoiceScenarioTicks.js");
    for (const name of LIVE_VOICE_SCENARIO_TICKS) expect(Object.keys(API_PROCESS_TICKS)).toContain(name);
  });
});
