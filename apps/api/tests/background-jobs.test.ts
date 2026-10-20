import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../src/db.js";
import { enqueueBackgroundJob } from "../src/jobs/enqueue.js";
import { runBackgroundJobsTick } from "../src/jobs/runner.js";
import { headOfQueueRunAt } from "./helpers/queueHead.js";
import { registerJobHandler, type JobHandler } from "../src/jobs/registry.js";

/**
 * Очередь BackgroundJob (чертёж §2, коммит Б1): захват, ретрай с лесенкой,
 * громкий give-up, дедуп постановки с перезаводом после DONE, подбор зависших
 * RUNNING. Тестовый обработчик подсаживается в реестр напрямую — реестр
 * ReadonlyMap только для прикладного кода.
 */

const calls: unknown[] = [];
let failTimes = 0;
const gaveUp: unknown[] = [];

const testHandler: JobHandler<{ n: number }> = {
  type: "test-job",
  schema: z.object({ n: z.number() }),
  backoff: () => 0, // ретрай сразу — тест не ждёт лесенку
  async run(payload) {
    calls.push(payload);
    if (failTimes > 0) {
      failTimes--;
      throw new Error("нарочный отказ");
    }
  },
  async onGiveUp(payload) {
    gaveUp.push(payload);
  },
};
registerJobHandler(testHandler);

/** Медленное задание со своим сроком: попытка живёт дольше, чем её ждут. */
const slowHandler: JobHandler<{ n: number }> = {
  type: "test-slow",
  schema: z.object({ n: z.number() }),
  backoff: () => 0,
  timeoutMs: 300,
  async run() {
    await new Promise((r) => setTimeout(r, 1_000));
  },
  async onGiveUp() {},
};
registerJobHandler(slowHandler);

const OWN_TYPES = ["test-job", "test-ghost", "test-slow"] as const;

/**
 * СВОЁ ЗАДАНИЕ — В НАЧАЛО ОЧЕРЕДИ, ЧУЖИЕ СТРОКИ НЕ ТРОГАЕМ (24.09.2026).
 *
 * claimBatch (jobs/runner.ts) не различает тип: берёт до 10 due-заданий по
 * `ORDER BY runAt`, чей бы тип это ни был. Прод-код за один тик обрабатывает
 * настоящие "geocode"/"reels-montage"/"ai-reply-retry" и т.п. — их заводят
 * десятки других файлов через реальные роуты (создание объекта и т.д.), и
 * ничто их не подчищает. К моменту этого файла в таблице копится больше 10
 * чужих PENDING-строк со `runAt` СТАРШЕ только что заведённого "test-job" —
 * батч вычерпывает их первыми, и своё задание тест не видит вовсе (done
 * всё равно ≥1, а `calls` остаётся пустым).
 *
 * Здесь раньше стоял `deleteMany({ where: { status: "PENDING" } })` — чистый
 * лист по всей таблице. Живое падение 24.09.2026:
 * `stuck-conversations-retry.test.ts` ставил "ai-reply-retry", этот файл его
 * удалял, и тест падал «expected undefined to be defined» на коде, который в
 * одиночку проходит 7 из 7.
 *
 * КТО ТАКИЕ «ЧУЖИЕ» (уточнено 24.09.2026 — ходившее здесь объяснение было
 * НЕВЕРНЫМ). Писали «тесты идут в ДВА процесса на одной базе (#608), удаление
 * уносит живые задания соседнего шарда». Это не так: `tests/dbPerWorker.ts`
 * даёт КАЖДОМУ процессу vitest СВОЮ базу (копией шаблона), а внутри процесса
 * файлы идут строго последовательно (`singleFork`, `fileParallelism: false`).
 * Соседнего шарда в своей базе нет вовсе. Чужие строки — это брошенные задания
 * ПРОШЕДШИХ файлов своего же процесса. Снос был, стало быть, не опасен, а
 * НЕДОСТАТОЧЕН: он маскировал настоящую причину, по которой своё задание не
 * исполнялось.
 *
 * Нужного добивается сама очередь: раз партия идёт `ORDER BY "runAt"`,
 * достаточно отодвинуть СВОИ строки в прошлое — они уходят в голову, а чужие
 * остаются на месте (общее правило и почему сдвиг именно такой — в
 * helpers/queueHead.ts). Двигаем только УЖЕ НАСТУПИВШИЕ (`runAt <= now`):
 * иначе проверка «срок runAt уважается» получила бы своё задание раньше срока.
 */
/**
 * ЗАПАС ПО ЧАСАМ, А НЕ ПО ТИКАМ (24.09.2026, живое падение на полном прогоне).
 *
 * Предел vitest — 20 секунд, а `runBackgroundJobsTick()` выполняет партию
 * ЦЕЛИКОМ: до десяти заданий, среди которых могут быть тяжёлые чужие
 * (clip-compress и прочий ffmpeg, оставленные прошедшими файлами этого же
 * процесса). Одного такого тика хватает, чтобы перебрать двадцать секунд, а
 * тесты ниже делают их до трёх подряд. В одиночку файл проходит за секунду —
 * то есть падение выглядит поломкой кода, ею не являясь.
 *
 * Тот же приём уже применён в `stuck-work.test.ts` (правка #855). Гасить
 * проверку нельзя, ускорить чужую партию отсюда невозможно — значит тесту
 * нужен честный запас по времени.
 */
const QUEUE_TEST_TIMEOUT_MS = 90_000;

async function tickOwnFirst(): Promise<number> {
  await prisma.backgroundJob.updateMany({
    where: { type: { in: [...OWN_TYPES] }, status: "PENDING", runAt: { lte: new Date() } },
    data: { runAt: headOfQueueRunAt() },
  });
  return runBackgroundJobsTick();
}

beforeEach(async () => {
  calls.length = 0;
  gaveUp.length = 0;
  failTimes = 0;
  // ТОЛЬКО СВОИ типы и ЛЮБОГО статуса. Своих — потому что чужие строки нам не
  // принадлежат (см. докстринг tickOwnFirst); чужих здесь не трогаем вовсе, а
  // от их старшинства в очереди защищает tickOwnFirst.
  // Любого статуса — потому что findFirst ниже по файлу идёт без orderBy и
  // иначе цеплял бы DONE/GIVEN_UP строку от ПРЕДЫДУЩЕГО теста этого же файла.
  await prisma.backgroundJob.deleteMany({ where: { type: { in: [...OWN_TYPES] } } });
});

afterAll(async () => {
  // Только свои типы: `deleteMany({})` уносил бы задания соседнего шарда
  // (два процесса на одной базе с правки #608) — см. докстринг tickOwnFirst.
  await prisma.backgroundJob.deleteMany({ where: { type: { in: [...OWN_TYPES] } } });
  await prisma.errorLog.deleteMany({ where: { source: "background-jobs", message: { contains: "test-job" } } });
  await prisma.$disconnect();
});

describe("очередь фоновых заданий", () => {
  it("ставит, исполняет и помечает DONE", async () => {
    await enqueueBackgroundJob({ type: "test-job", payload: { n: 1 }, maxAttempts: 3 });
    const done = await tickOwnFirst();
    expect(done).toBeGreaterThanOrEqual(1);
    expect(calls).toEqual([{ n: 1 }]);
    const job = await prisma.backgroundJob.findFirst({ where: { type: "test-job" } });
    expect(job?.status).toBe("DONE");
  }, QUEUE_TEST_TIMEOUT_MS);

  it("ошибка → ретрай; попытки исчерпаны → GIVEN_UP + onGiveUp + журнал", async () => {
    failTimes = 99; // падает всегда
    await enqueueBackgroundJob({ type: "test-job", payload: { n: 2 }, maxAttempts: 3 });
    await tickOwnFirst(); // 1-я попытка
    await tickOwnFirst(); // 2-я
    await tickOwnFirst(); // 3-я — предел
    const job = await prisma.backgroundJob.findFirst({ where: { type: "test-job" } });
    expect(job?.status).toBe("GIVEN_UP");
    expect(job?.attempts).toBe(3);
    expect(job?.lastError).toContain("нарочный отказ");
    expect(gaveUp).toEqual([{ n: 2 }]);
    const logged = await prisma.errorLog.findFirst({
      where: { source: "background-jobs", message: { contains: "test-job" } },
    });
    expect(logged).not.toBeNull();
  }, QUEUE_TEST_TIMEOUT_MS);

  it("dedupeKey: ждущее задание не дублируется, после DONE перезаводится", async () => {
    await enqueueBackgroundJob({ type: "test-job", payload: { n: 3 }, dedupeKey: "test:dedupe", maxAttempts: 3 });
    await enqueueBackgroundJob({ type: "test-job", payload: { n: 4 }, dedupeKey: "test:dedupe", maxAttempts: 3 });
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: "test:dedupe" } })).toBe(1);
    // Ждущее не перезаписано вторым payload.
    const pending = await prisma.backgroundJob.findFirst({ where: { dedupeKey: "test:dedupe" } });
    expect(pending?.payload).toEqual({ n: 3 });

    await tickOwnFirst();
    await enqueueBackgroundJob({ type: "test-job", payload: { n: 5 }, dedupeKey: "test:dedupe", maxAttempts: 3 });
    const requeued = await prisma.backgroundJob.findFirst({ where: { dedupeKey: "test:dedupe" } });
    expect(requeued?.status).toBe("PENDING");
    expect(requeued?.payload).toEqual({ n: 5 });
    expect(requeued?.attempts).toBe(0);
  }, QUEUE_TEST_TIMEOUT_MS);

  it("dedupeKey живёт всю лестницу попыток: повторная постановка во время ретраев отбрасывается", async () => {
    failTimes = 99; // падает всегда — задержится на PENDING (ретрай), не дойдёт до GIVEN_UP
    await enqueueBackgroundJob({ type: "test-job", payload: { n: 8 }, dedupeKey: "test:ladder", maxAttempts: 5 });
    await tickOwnFirst(); // 1-я попытка: ошибка → назад в PENDING, ключ должен остаться
    const afterFirstAttempt = await prisma.backgroundJob.findFirst({ where: { dedupeKey: "test:ladder" } });
    expect(afterFirstAttempt?.status).toBe("PENDING");
    expect(afterFirstAttempt?.attempts).toBe(1);

    // Крон здоровья (или любой другой потребитель) ставит то же задание снова,
    // пока лестница ещё не кончилась, — раньше ключ уже был снят при захвате,
    // и это создавало дубликат строки.
    const second = await enqueueBackgroundJob({ type: "test-job", payload: { n: 9 }, dedupeKey: "test:ladder", maxAttempts: 5 });
    expect(second).toEqual({ enqueued: true }); // best-effort no-op, не ошибка
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: "test:ladder" } })).toBe(1);
    const stillOriginal = await prisma.backgroundJob.findFirst({ where: { dedupeKey: "test:ladder" } });
    expect(stillOriginal?.payload).toEqual({ n: 8 }); // второй payload не подмешался
    expect(stillOriginal?.attempts).toBe(1);
  }, QUEUE_TEST_TIMEOUT_MS);

  it("dedupeKey свободен после GIVEN_UP — новая постановка заводит новую строку", async () => {
    failTimes = 99; // падает всегда
    await enqueueBackgroundJob({ type: "test-job", payload: { n: 10 }, dedupeKey: "test:giveup", maxAttempts: 2 });
    await tickOwnFirst(); // 1-я попытка
    await tickOwnFirst(); // 2-я — предел, GIVEN_UP
    const gone = await prisma.backgroundJob.findFirst({ where: { dedupeKey: "test:giveup" } });
    expect(gone).toBeNull(); // ключ снят при переходе в GIVEN_UP
    const givenUpRow = await prisma.backgroundJob.findFirst({ where: { type: "test-job", payload: { path: ["n"], equals: 10 } } });
    expect(givenUpRow?.status).toBe("GIVEN_UP");
    expect(givenUpRow?.dedupeKey).toBeNull();

    failTimes = 0;
    await enqueueBackgroundJob({ type: "test-job", payload: { n: 11 }, dedupeKey: "test:giveup", maxAttempts: 2 });
    const requeued = await prisma.backgroundJob.findFirst({ where: { dedupeKey: "test:giveup" } });
    expect(requeued?.status).toBe("PENDING");
    expect(requeued?.payload).toEqual({ n: 11 });
    expect(requeued?.attempts).toBe(0);
  }, QUEUE_TEST_TIMEOUT_MS);

  it("зависший RUNNING восстанавливается один раз после старших заданий", async () => {
    const createdIds: string[] = [];
    const noiseType = `test-stale-noise-${randomUUID()}`;
    registerJobHandler({
      type: noiseType,
      schema: z.object({ n: z.number() }),
      backoff: () => 0,
      async run() {},
      async onGiveUp() {},
    });
    try {
      const head = headOfQueueRunAt();
      // Отдельный OWN тип: tickOwnFirst не сдвигает шум в ту же очередь
      // приоритетов. Девять более старых строк занимают лёгкую партию целиком.
      for (let n = 0; n < 9; n++) {
        const noise = await prisma.backgroundJob.create({
          data: { type: noiseType, payload: { n }, maxAttempts: 3,
            runAt: new Date(head.getTime() - 60_000) },
        });
        createdIds.push(noise.id);
      }
      const stale = await prisma.backgroundJob.create({
        data: { type: "test-job", payload: { n: 6 }, status: "RUNNING", maxAttempts: 3,
          runAt: head, lockedAt: new Date(Date.now() - 20 * 60_000), lockedBy: "dead-container" },
      });
      createdIds.push(stale.id);
      const live = await prisma.backgroundJob.create({
        data: { type: "test-job", payload: { n: 7 }, status: "RUNNING", maxAttempts: 3,
          runAt: head, lockedAt: new Date(), lockedBy: "live-container" },
      });
      createdIds.push(live.id);
      const future = await prisma.backgroundJob.create({
        data: { type: "test-job", payload: { n: 8 }, maxAttempts: 3,
          runAt: new Date(Date.now() + 60 * 60_000) },
      });
      createdIds.push(future.id);
      expect(stale.status).toBe("RUNNING");
      expect(stale.attempts).toBe(0);
      expect(stale.lockedAt!.getTime()).toBeLessThan(Date.now() - 15 * 60_000);

      await runBackgroundJobsTick();
      const afterFirst = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: stale.id } });
      expect(afterFirst.status).toBe("RUNNING");
      expect(afterFirst.attempts).toBe(0);
      expect(afterFirst.lockedAt).toEqual(stale.lockedAt);
      expect(calls).toEqual([]);
      // Сдвиг на час не гарантирует первый тик (helpers/queueHead.ts):
      // ожидаем именно свою строку, ограниченно, не удаляя чужой backlog.
      for (let tick = 0; tick < 19; tick++) {
        const own = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: stale.id } });
        if (own.status !== "RUNNING" && own.status !== "PENDING") break;
        await runBackgroundJobsTick();
      }
      expect(calls).toEqual([{ n: 6 }]);
      const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: stale.id } });
      expect(job.id).toBe(stale.id);
      expect(job.status).toBe("DONE");
      expect(job.attempts).toBe(1);
      const liveAfter = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: live.id } });
      expect(liveAfter.status).toBe("RUNNING");
      expect(liveAfter.attempts).toBe(0);
      expect(liveAfter.lockedAt).toEqual(live.lockedAt);
      const futureAfter = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: future.id } });
      expect(futureAfter.status).toBe("PENDING");
      expect(futureAfter.attempts).toBe(0);
      expect(futureAfter.runAt).toEqual(future.runAt);
    } finally {
      await prisma.backgroundJob.deleteMany({ where: { id: { in: createdIds } } });
    }
  }, QUEUE_TEST_TIMEOUT_MS);

  it("неизвестный тип (джоб из будущей версии) откладывается, а не падает", async () => {
    await prisma.backgroundJob.create({
      data: { type: "test-ghost", payload: {}, maxAttempts: 3 },
    });
    await tickOwnFirst();
    const job = await prisma.backgroundJob.findFirst({ where: { type: "test-ghost" } });
    expect(job?.status).toBe("PENDING");
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
  }, QUEUE_TEST_TIMEOUT_MS);

  it("срок runAt уважается: раннее задание тик не берёт", async () => {
    await enqueueBackgroundJob({
      type: "test-job",
      payload: { n: 7 },
      runAt: new Date(Date.now() + 60 * 60_000),
      maxAttempts: 3,
    });
    await tickOwnFirst();
    expect(calls).toEqual([]);
    const job = await prisma.backgroundJob.findFirst({ where: { type: "test-job" } });
    expect(job?.status).toBe("PENDING");
  }, QUEUE_TEST_TIMEOUT_MS);

  it("срок попытки задаёт обработчик; снятая по сроку попытка не повторяется, пока может ещё работать (23.09.2026)", async () => {
    // Снятая с ожидания попытка продолжает работать (Promise.race её не
    // останавливает). Повтор сразу же — два ответа клиенту одновременно.
    await enqueueBackgroundJob({ type: "test-slow", payload: { n: 8 }, maxAttempts: 3 });
    const startedAt = Date.now();
    await tickOwnFirst();
    const tickMs = Date.now() - startedAt;
    // Ждали срок обработчика (300 мс), а не общую минуту и не всю секунду работы.
    expect(tickMs).toBeLessThan(900);
    const job = await prisma.backgroundJob.findFirst({ where: { type: "test-slow" } });
    expect(job?.status).toBe("PENDING");
    expect(job?.lastError).toContain("снято с ожидания");
    // Лесенка обработчика — 0 мс, но следующая попытка не раньше срока попытки.
    expect(job!.runAt.getTime() - job!.updatedAt.getTime()).toBeGreaterThanOrEqual(250);
  }, QUEUE_TEST_TIMEOUT_MS);

  it("повтор хода бота ждёт попытку дольше окна модели (75 с)", async () => {
    const { aiReplyRetryJob } = await import("../src/jobs/aiReplyRetry.js");
    const { telegramReplyRetryJob } = await import("../src/jobs/telegramReplyRetry.js");
    for (const h of [aiReplyRetryJob, telegramReplyRetryJob]) {
      expect(h.timeoutMs ?? 60_000).toBeGreaterThan(75_000);
    }
  });

  // №169 (ночная проверка 24.09): повтор ответа в личных сообщениях
  // Telegram-канала — тот же ход бота, что у двух соседей выше, но остался с
  // общей минутой: удавшийся долгий ход засчитывался сорвавшейся попыткой.
  it("повтор ответа в личных сообщениях Telegram-канала ждёт ход бота так же, как соседи", async () => {
    const { telegramDirectReplyRetryJob } = await import("../src/jobs/telegramDirectReplyRetry.js");
    const { BOT_TURN_JOB_TIMEOUT_MS } = await import("../src/jobs/aiReplyRetryPolicy.js");
    expect(telegramDirectReplyRetryJob.timeoutMs ?? 60_000).toBeGreaterThan(75_000);
    expect(telegramDirectReplyRetryJob.timeoutMs).toBe(BOT_TURN_JOB_TIMEOUT_MS);
  });
});
