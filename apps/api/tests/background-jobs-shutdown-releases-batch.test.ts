import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { z } from "zod";
import { prisma } from "../src/db.js";
import { enqueueBackgroundJob } from "../src/jobs/enqueue.js";
import { runBackgroundJobsTick, stopBackgroundJobs } from "../src/jobs/runner.js";
import { headOfQueueRunAt } from "./helpers/queueHead.js";
import { registerJobHandler, type JobHandler } from "../src/jobs/registry.js";

/**
 * ЗАПАС ПО ЧАСАМ, А НЕ ПО ТИКАМ.
 *
 * Потолки ожидания в этом файле стоят в ТИКАХ, а предел vitest — в СЕКУНДАХ, и
 * друг про друга они не знают: один `runBackgroundJobsTick()` выполняет партию
 * ЦЕЛИКОМ, до десяти заданий, среди которых бывают тяжёлые чужие
 * (`clip-compress` и прочий ffmpeg, оставленные прошедшими файлами этого же
 * процесса). На засорённой очереди нескольких тиков хватает, чтобы перебрать
 * двадцать секунд, и тест падает «Test timed out in 20000ms» при исправном
 * коде — в одиночку тот же файл проходит за секунды. Живые падения 24.09.2026:
 * `stuck-work.test.ts` (#855), `background-jobs.test.ts`.
 *
 * Гасить проверку нельзя, ускорить чужую партию отсюда невозможно — значит
 * нужен честный запас по времени, и даётся он всему файлу, а не отдельным
 * тестам: до очереди дотягиваются и те, что зовут её через помощников.
 */
vi.setConfig({ testTimeout: 90_000 });


/**
 * ВЫХОД ПРОЦЕССА НЕ ДОЛЖЕН БРОСАТЬ ЗАХВАЧЕННУЮ ПАРТИЮ (22.09.2026).
 *
 * Партия исполняется последовательно, и SIGTERM посреди неё (деплой — до
 * двух десятков раз в день) оставлял ещё НЕ НАЧАТЫЕ задания в RUNNING. Цена:
 * пятнадцать минут ожидания вместо минуты, лишний attempts на каждом подборе
 * зависшего (claimBatch доращивает его) — вплоть до GIVEN_UP с неверным
 * «роняло процесс», и строка в «Что не доехало» у владельца на ровном месте.
 *
 * Файл отдельный намеренно: `stopping` в runner.ts взводится навсегда, и в
 * общем background-jobs.test.ts он погасил бы следующие тесты. Изоляция
 * модулей у vitest — пофайловая (см. vitest.config.ts).
 */

const started: number[] = [];

const handler: JobHandler<{ n: number }> = {
  type: "test-shutdown-job",
  schema: z.object({ n: z.number() }),
  backoff: () => 0,
  async run(payload) {
    started.push(payload.n);
    // Первое же задание партии ловит SIGTERM — остальные не должны начаться.
    stopBackgroundJobs();
  },
  async onGiveUp() {},
};
registerJobHandler(handler);

beforeEach(async () => {
  started.length = 0;
  // Чужие PENDING вычерпали бы партию раньше своих — но удалять их НЕЛЬЗЯ:
  // очередь общая, а тесты сервера идут в два процесса на одной базе (#608),
  // и здесь стоял `deleteMany({ status: "PENDING" })`, уносивший живые
  // задания соседнего шарда. Вместо этого свои задания заводятся с `runAt`
  // из helpers/queueHead.ts — заведомо старше всего, что появилось за прогон,
  // поэтому партия берёт их первыми, а чужие строки остаются нетронутыми.
  await prisma.backgroundJob.deleteMany({ where: { type: "test-shutdown-job" } });
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { type: "test-shutdown-job" } });
  await prisma.$disconnect();
});

describe("выход процесса и захваченная партия", () => {
  it("возвращает не начатые задания в PENDING, не тратя попытку", async () => {
    const base = headOfQueueRunAt().getTime();
    for (const n of [1, 2, 3]) {
      await enqueueBackgroundJob({
        type: "test-shutdown-job",
        payload: { n },
        maxAttempts: 3,
        // Явный порядок: claimBatch сортирует по runAt, а без него три записи
        // получили бы почти одинаковый now() базы. Отсчёт — от головы очереди
        // (helpers/queueHead.ts), чтобы чужие строки не встали перед нашими.
        runAt: new Date(base + n * 1000),
      });
    }

    await runBackgroundJobsTick();

    // Начато ровно одно — на нём и пришёл сигнал.
    expect(started).toEqual([1]);

    const rows = await prisma.backgroundJob.findMany({
      where: { type: "test-shutdown-job" },
      orderBy: { runAt: "asc" },
    });
    expect(rows.map((r) => r.status)).toEqual(["DONE", "PENDING", "PENDING"]);
    // Ни попытки, ни замка: задания не запускались.
    expect(rows.slice(1).map((r) => r.attempts)).toEqual([0, 0]);
    expect(rows.slice(1).map((r) => r.lockedAt)).toEqual([null, null]);
    expect(rows.slice(1).map((r) => r.lockedBy)).toEqual([null, null]);

    // И этот же процесс больше ничего не берёт: возвращённые задания ждут
    // следующий контейнер, а не второй заход умирающего.
    expect(await runBackgroundJobsTick()).toBe(0);
    expect(started).toEqual([1]);
  });
});
