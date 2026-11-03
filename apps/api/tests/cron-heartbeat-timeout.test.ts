import { describe, it, expect, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import * as heartbeat from "../src/lib/cronHeartbeat.js";

const { scheduleTracked } = heartbeat;

/**
 * Инцидент 09.09.2026: 5 тиков (no-answer-tail, buyer-thinking-slow-track,
 * seller-property-missing, inactive-traffic-light, health-automation) зависли
 * на await, замок `running` в scheduleTracked держался 75+ минут — следующие
 * срабатывания молча терялись, lastError оставался пуст.
 *
 * Проверяем: тик, который никогда не резолвится, по истечении таймаута пишет
 * в журнал (logSystemError → ErrorLog) и в lastError, снимает замок, а
 * следующее срабатывание расписания выполняется нормально.
 */

const NAME = "test-hang-tick";

afterAll(async () => {
  await prisma.cronHeartbeat.deleteMany({ where: { name: { in: [NAME, "test-active-tick", "test-stopped-tick", "test-long-tick"] } } });
  await prisma.errorLog.deleteMany({ where: { source: "cron", message: { contains: NAME } } });
  await prisma.$disconnect();
});

describe("scheduleTracked — таймаут зависшего тика", () => {
  it("тик, который никогда не резолвится, снимается с замка по таймауту, следующий проходит", async () => {
    let calls = 0;
    const task = scheduleTracked(
      NAME,
      "*/30 * * * *", // расписание не важно — тик запускается вручную через task.execute()
      async () => {
        calls++;
        if (calls === 1) {
          // Никогда не резолвится — имитирует зависший await инцидента 09.09.
          await new Promise(() => {});
        }
      },
      undefined,
      undefined,
      { timeoutMs: 200 }
    );

    try {
      // node-cron 4 (ScheduledTask.execute()) — публичный способ запустить
      // обработчик вручную, без ожидания реального срабатывания по расписанию.
      // Не ждём промис: первый вызов имитирует зависший тик и не резолвится.
      void task.execute();
      // Первый вызов зависает — ждём чуть дольше таймаута, чтобы обёртка
      // успела его снять с замка.
      await new Promise((r) => setTimeout(r, 400));

      const row = await prisma.cronHeartbeat.findUnique({ where: { name: NAME } });
      expect(row?.lastError).toMatch(/не завершил тик/);

      const logged = await prisma.errorLog.findFirst({
        where: { source: "cron", message: { contains: NAME } },
      });
      expect(logged).not.toBeNull();

      // Замок снят — следующее срабатывание должно выполниться (calls растёт).
      void task.execute();
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      // destroy, а не stop: в node-cron 4 задача остаётся в глобальном реестре
      // и держит таймер, из-за чего vitest не завершает процесс.
      await task.destroy();
    }
  });
});

describe("scheduleTracked — явный предел тика не обрезается общим потолком", () => {
  it("долгая задача (недельный обход рынка, 3,5 ч) получает свой предел, умолчание по-прежнему не выше 20 минут", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const long = scheduleTracked("test-long-tick", "30 2 * * 0", async () => {}, undefined, undefined, { timeoutMs: 3.5 * 60 * 60_000 });
    try {
      await long.execute();
      const delays = spy.mock.calls.map((c) => Number(c[1]));
      expect(delays).toContain(3.5 * 60 * 60_000); // не срезан до 20 минут: иначе крон ложно «снимался с замка»
    } finally {
      spy.mockRestore();
      await long.destroy();
    }
  });
});

/**
 * №172 (ночная проверка 24.09): выкат перезапускает процессы посреди тика.
 * Робозвонок, просьба подтвердить показ, напоминание бота — действие уже
 * сделано, отметка ещё нет; после рестарта то же самое уходило клиенту второй
 * раз. Остановка процесса теперь ждёт идущие тики (как ждёт задание очереди),
 * а новые после сигнала не начинаются. Зависший и снятый по таймауту тик не
 * считается: иначе каждый выкат ждал бы весь потолок впустую.
 */
describe("scheduleTracked — счёт идущих тиков для мягкой остановки", () => {
  it("пока тик на await — он идёт; дошёл — нет; снятый по таймауту не держит остановку", async () => {
    expect(typeof heartbeat.activeTickCount).toBe("function");
    let release: () => void = () => {};
    let hang = false;
    const task = scheduleTracked(
      "test-active-tick",
      "*/30 * * * *",
      async () => {
        if (hang) {
          await new Promise(() => {});
          return;
        }
        await new Promise<void>((r) => {
          release = r;
        });
      },
      undefined,
      undefined,
      { timeoutMs: 300 }
    );
    try {
      const before = heartbeat.activeTickCount();
      void task.execute();
      await new Promise((r) => setTimeout(r, 50));
      expect(heartbeat.activeTickCount()).toBe(before + 1);
      release();
      await new Promise((r) => setTimeout(r, 50));
      expect(heartbeat.activeTickCount()).toBe(before);

      hang = true;
      void task.execute();
      await new Promise((r) => setTimeout(r, 50));
      expect(heartbeat.activeTickCount()).toBe(before + 1);
      await new Promise((r) => setTimeout(r, 400));
      expect(heartbeat.activeTickCount()).toBe(before);
    } finally {
      await task.destroy();
    }
  });

  it("после сигнала остановки новый тик не начинается", async () => {
    let calls = 0;
    const task = scheduleTracked("test-stopped-tick", "*/30 * * * *", async () => {
      calls++;
    });
    try {
      heartbeat.stopNewTicks();
      await task.execute();
      expect(calls).toBe(0);
    } finally {
      await task.destroy();
    }
  });
});
