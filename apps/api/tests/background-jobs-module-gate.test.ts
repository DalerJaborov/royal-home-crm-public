import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { prisma } from "../src/db.js";
import { enqueueBackgroundJob } from "../src/jobs/enqueue.js";
import { runBackgroundJobsTick } from "../src/jobs/runner.js";
import { headOfQueueRunAt } from "./helpers/queueHead.js";
import { registerJobHandler, type JobHandler } from "../src/jobs/registry.js";
import { invalidatePultModuleCache } from "../src/lib/pultModules.js";

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
 * Гейт очереди по модулю пульта (аудит 02.09.2026 §4). Карта «тип → модуль» в
 * проде пуста намеренно (jobs/jobModules.ts), поэтому подменяем её: один тип
 * привязан к модулю video, второй — вне карты и исполняется всегда.
 */
vi.mock("../src/jobs/jobModules.js", () => ({
  JOB_PULT_MODULES: { "test-gated-job": "video" },
  pultModuleOfJob: (type: string) => (type === "test-gated-job" ? "video" : null),
}));

const TYPES = ["test-gated-job", "test-free-job"] as const;
const ran: string[] = [];

function handler(type: string): JobHandler<{ n: number }> {
  return {
    type,
    schema: z.object({ n: z.number() }),
    backoff: () => 0,
    async run() {
      ran.push(type);
    },
    async onGiveUp() {},
  };
}
registerJobHandler(handler("test-gated-job"));
registerJobHandler(handler("test-free-job"));

async function setVideoModule(enabled: boolean) {
  await prisma.pultModule.upsert({ where: { id: "video" }, update: { enabled }, create: { id: "video", enabled } });
  invalidatePultModuleCache();
}

beforeAll(async () => {
  await setVideoModule(true);
});

beforeEach(async () => {
  ran.length = 0;
  // Чужие PENDING-строки уходят в партию раньше наших — но удалять их НЕЛЬЗЯ:
  // очередь общая на два процесса (#608), и такое удаление уносило живые
  // задания соседнего шарда. Вместо этого своё двигаем в голову очереди —
  // см. tickUntilSettled ниже и helpers/queueHead.ts.
  await prisma.backgroundJob.deleteMany({ where: { type: { in: [...TYPES] } } });
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { type: { in: [...TYPES] } } });
  await prisma.pultModule.deleteMany({ where: { id: "video" } });
  invalidatePultModuleCache();
  await prisma.$disconnect();
});

/**
 * ТИКАЕМ, ПОКА НАШИ ЗАДАНИЯ НЕ РАЗОЙДУТСЯ ПО КОНЕЧНЫМ СОСТОЯНИЯМ (22.09.2026).
 *
 * `runBackgroundJobsTick` берёт не больше десятка самых старых заданий, а
 * очередь общая: с правки #608 серверные тесты идут в два процесса на ОДНОЙ
 * базе, и чужие PENDING-строки соседнего файла законно съедают тик целиком.
 * «Один тик — наши задания исполнились» верно только в одиночном прогоне; в
 * общем проверка падала бы на чужой нагрузке, а красным становился бы не тот,
 * кто менял код (ровно так упал stuck-work.test.ts 22.09.2026).
 */
async function tickUntilSettled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const pending = await prisma.backgroundJob.count({
      where: { type: { in: [...TYPES] }, status: "PENDING" },
    });
    if (pending === 0) return;
    // Свои — в голову очереди, чужие не трогаем (helpers/queueHead.ts).
    await prisma.backgroundJob.updateMany({
      where: { type: { in: [...TYPES] }, status: "PENDING", runAt: { lte: new Date() } },
      data: { runAt: headOfQueueRunAt() },
    });
    await runBackgroundJobsTick();
  }
  throw new Error("наши задания так и остались PENDING за 20 тиков");
}

describe("гейт очереди по модулю пульта", () => {
  it("модуль включён — оба задания ставятся и исполняются", async () => {
    await setVideoModule(true);
    expect(await enqueueBackgroundJob({ type: "test-gated-job", payload: { n: 1 }, maxAttempts: 1 })).toEqual({ enqueued: true });
    expect(await enqueueBackgroundJob({ type: "test-free-job", payload: { n: 1 }, maxAttempts: 1 })).toEqual({ enqueued: true });
    await tickUntilSettled();
    expect(ran.sort()).toEqual(["test-free-job", "test-gated-job"]);
    const rows = await prisma.backgroundJob.findMany({ where: { type: { in: [...TYPES] } } });
    expect(rows.map((r) => r.status)).toEqual(["DONE", "DONE"]);
  });

  it("модуль выключен — задание модуля не ставится, задание вне карты ставится", async () => {
    await setVideoModule(false);
    expect(await enqueueBackgroundJob({ type: "test-gated-job", payload: { n: 2 }, maxAttempts: 1 })).toEqual({
      enqueued: false,
      skipped: "module:off",
    });
    expect(await enqueueBackgroundJob({ type: "test-free-job", payload: { n: 2 }, maxAttempts: 1 })).toEqual({ enqueued: true });
    expect(await prisma.backgroundJob.count({ where: { type: "test-gated-job" } })).toBe(0);
    await tickUntilSettled();
    expect(ran).toEqual(["test-free-job"]);
  });

  it("модуль выключили, пока задание ждало — исполнитель переводит его в SKIPPED, не в ошибку", async () => {
    await setVideoModule(true);
    await enqueueBackgroundJob({ type: "test-gated-job", payload: { n: 3 }, maxAttempts: 1 });
    await setVideoModule(false);
    await tickUntilSettled();
    expect(ran).toEqual([]);
    const job = await prisma.backgroundJob.findFirst({ where: { type: "test-gated-job" } });
    expect(job?.status).toBe("SKIPPED");
    expect(job?.lastError).toBe("module:video:off");
    expect(job?.lockedAt).toBeNull();
    const logged = await prisma.errorLog.findFirst({
      where: { source: "background-jobs", message: { contains: "test-gated-job" } },
    });
    expect(logged).toBeNull();
  });
});
