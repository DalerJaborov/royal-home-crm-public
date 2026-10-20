import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * «ЧТО НЕ ДОЕХАЛО» (владелец 21.09.2026) — экран /stuck-work,
 * lib/stuckWork.ts, jobs/runner.ts (уведомление хозяину при GIVEN_UP).
 *
 * Обработчики фоновой очереди регистрируются ТОЛЬКО worker-процессом
 * (handlers.ts — см. докстринг registry.ts про разрыв цикла импортов); свой
 * тестовый обработчик подсаживается напрямую, как в background-jobs.test.ts.
 */
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { registerJobHandler } = await import("../src/jobs/registry.js");
const { runBackgroundJobsTick } = await import("../src/jobs/runner.js");

let failAlways = false;
registerJobHandler({
  type: "stuck-test-job",
  schema: z.object({ n: z.number() }),
  backoff: () => 0,
  async run() {
    if (failAlways) throw new Error("нарочный отказ для теста «Что не доехало»");
  },
  async onGiveUp() {
    // намеренно пусто — уведомление проверяет notifyStuckWorkGivenUp, не этот хук
  },
});

const runId = Date.now().toString(36);
const password = "testpass123";
let directorToken = "";
let directorId = "";
let agentToken = "";
let agentId = "";
let clientId = "";
const jobIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: "Тест Директор Что не доехало", phone: `+992967${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  directorToken = await login(director.phone);

  const agent = await prisma.agent.create({
    data: { fullName: "Тест Агент Что не доехало", phone: `+992968${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  agentToken = await login(agent.phone);

  const client = await prisma.client.create({
    data: {
      fullName: "Тест Клиент Что не доехало",
      phone: `+992969${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: [directorId, agentId] } } });
  await prisma.errorLog.deleteMany({ where: { source: "background-jobs", message: { contains: "stuck-test-job" } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces([directorId, agentId]);
  await prisma.$disconnect();
});

beforeEach(() => {
  failAlways = false;
});

afterEach(async () => {
  if (jobIds.length > 0) {
    await prisma.backgroundJob.deleteMany({ where: { id: { in: jobIds } } });
    jobIds.length = 0;
  }
});

describe("GET /api/v1/stuck-work", () => {
  it("без права auditLog.view — 403", async () => {
    const res = await request(app).get("/api/v1/stuck-work").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("отдаёт GIVEN_UP и зависшие, но не обычное свежее задание", async () => {
    const givenUp = await prisma.backgroundJob.create({
      data: {
        type: "stuck-test-job",
        payload: { n: 1 },
        status: "GIVEN_UP",
        attempts: 3,
        maxAttempts: 3,
        lastError: "нарочный отказ для теста",
      },
    });
    const hangingPending = await prisma.backgroundJob.create({
      data: {
        type: "stuck-test-job",
        payload: { n: 2 },
        status: "PENDING",
        attempts: 1,
        maxAttempts: 5,
        runAt: new Date(Date.now() - 20 * 60_000), // просрочен на 20 минут
      },
    });
    const freshPending = await prisma.backgroundJob.create({
      data: { type: "stuck-test-job", payload: { n: 3 }, status: "PENDING", maxAttempts: 5 },
    });
    jobIds.push(givenUp.id, hangingPending.id, freshPending.id);

    const res = await request(app).get("/api/v1/stuck-work").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);

    const givenUpIds = res.body.givenUp.map((i: { id: string }) => i.id);
    const hangingIds = res.body.hanging.map((i: { id: string }) => i.id);
    expect(givenUpIds).toContain(givenUp.id);
    expect(hangingIds).toContain(hangingPending.id);
    expect(givenUpIds).not.toContain(freshPending.id);
    expect(hangingIds).not.toContain(freshPending.id);
  });

  // 02.10.2026: на экране висели 172 отказа месячной давности и счётчик «200».
  it("сдавшееся старше двух недель с экрана уходит, счётчик — честный", async () => {
    const old = await prisma.backgroundJob.create({
      data: { type: "stuck-test-job", payload: { n: 5 }, status: "GIVEN_UP", attempts: 3, maxAttempts: 3 },
    });
    jobIds.push(old.id);
    await prisma.$executeRaw`UPDATE "BackgroundJob" SET "updatedAt" = now() - interval '20 days' WHERE id = ${old.id}`;

    const res = await request(app).get("/api/v1/stuck-work").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.givenUp.map((i: { id: string }) => i.id)).not.toContain(old.id);
    expect(res.body.counts.givenUp).toBeGreaterThanOrEqual(res.body.givenUp.length);
  });

  // 02.10.2026 «нет кнопки пагинации»: экран растит предел кнопкой «Показать ещё».
  it("givenUpLimit растит список сдавшихся, счётчик от него не зависит", async () => {
    const rows = await Promise.all(
      [6, 7].map((n) =>
        prisma.backgroundJob.create({
          data: { type: "stuck-test-job", payload: { n }, status: "GIVEN_UP", attempts: 3, maxAttempts: 3 },
        })
      )
    );
    jobIds.push(...rows.map((r) => r.id));

    const one = await request(app).get("/api/v1/stuck-work?givenUpLimit=1").set("Authorization", `Bearer ${directorToken}`);
    expect(one.status).toBe(200);
    expect(one.body.givenUp).toHaveLength(1);
    expect(one.body.counts.givenUp).toBeGreaterThanOrEqual(2);

    const two = await request(app).get("/api/v1/stuck-work?givenUpLimit=2").set("Authorization", `Bearer ${directorToken}`);
    expect(two.body.givenUp).toHaveLength(2);
    // Первая строка та же: порядок (updatedAt, id) не прыгает между запросами.
    expect(two.body.givenUp[0].id).toBe(one.body.givenUp[0].id);

    const bad = await request(app).get("/api/v1/stuck-work?givenUpLimit=0").set("Authorization", `Bearer ${directorToken}`);
    expect(bad.status).toBe(400);
  });
});

describe("описание заданий seller-facts/seller-photo-insight (ночная проверка 24.09.2026)", () => {
  it("показывает клиента и хозяина, а не голую строку типа", async () => {
    const factsJob = await prisma.backgroundJob.create({
      data: {
        type: "seller-facts",
        payload: { clientId },
        status: "GIVEN_UP",
        attempts: 2,
        maxAttempts: 2,
        lastError: "нарочный отказ для теста",
      },
    });
    const photoJob = await prisma.backgroundJob.create({
      data: {
        type: "seller-photo-insight",
        payload: { clientId },
        status: "GIVEN_UP",
        attempts: 2,
        maxAttempts: 2,
        lastError: "нарочный отказ для теста",
      },
    });
    jobIds.push(factsJob.id, photoJob.id);

    const res = await request(app).get("/api/v1/stuck-work").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);

    const items = res.body.givenUp as { id: string; type: string; label: string; ownerAgentId: string | null }[];
    const factsItem = items.find((i) => i.id === factsJob.id);
    const photoItem = items.find((i) => i.id === photoJob.id);
    expect(factsItem?.label).not.toBe("seller-facts");
    expect(factsItem?.label).toContain("Тест Клиент Что не доехало");
    expect(factsItem?.ownerAgentId).toBe(agentId);
    expect(photoItem?.label).not.toBe("seller-photo-insight");
    expect(photoItem?.label).toContain("Тест Клиент Что не доехало");
    expect(photoItem?.ownerAgentId).toBe(agentId);
  });
});

describe("POST /api/v1/stuck-work/:id/retry", () => {
  it("без права auditLog.view — 403", async () => {
    const job = await prisma.backgroundJob.create({
      data: { type: "stuck-test-job", payload: { n: 4 }, status: "GIVEN_UP", attempts: 3, maxAttempts: 3 },
    });
    jobIds.push(job.id);
    const res = await request(app).post(`/api/v1/stuck-work/${job.id}/retry`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("возвращает GIVEN_UP обратно в очередь: попытки и лизинг сброшены, runAt — сейчас", async () => {
    const job = await prisma.backgroundJob.create({
      data: {
        type: "stuck-test-job",
        payload: { n: 5 },
        status: "GIVEN_UP",
        attempts: 3,
        maxAttempts: 3,
        lockedBy: "старый-контейнер",
      },
    });
    jobIds.push(job.id);

    const before = Date.now();
    const res = await request(app)
      .post(`/api/v1/stuck-work/${job.id}/retry`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(204);

    const updated = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe("PENDING");
    expect(updated.attempts).toBe(0);
    expect(updated.lockedAt).toBeNull();
    expect(updated.lockedBy).toBeNull();
    expect(updated.runAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("обычное свежее задание кнопка не трогает — 409", async () => {
    const job = await prisma.backgroundJob.create({
      data: { type: "stuck-test-job", payload: { n: 6 }, status: "PENDING", maxAttempts: 5 },
    });
    jobIds.push(job.id);

    const res = await request(app)
      .post(`/api/v1/stuck-work/${job.id}/retry`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(409);

    const unchanged = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(unchanged.status).toBe("PENDING");
  });

  it("несуществующее задание — 404", async () => {
    const res = await request(app)
      .post("/api/v1/stuck-work/does-not-exist/retry")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(404);
  });
});

/**
 * ТИК, ПОКА ЗАДАНИЕ НЕ ДОЙДЁТ ДО НУЖНОГО СОСТОЯНИЯ (22.09.2026).
 *
 * `runBackgroundJobsTick` берёт из очереди не больше десятка самых старых
 * заданий, и очередь общая: с правки #608 серверные тесты идут в два процесса
 * на ОДНОЙ базе, и чужие PENDING-строки соседнего файла законно съедают тик
 * целиком. «Один тик — одна попытка нашего задания» верно только в одиночном
 * прогоне; в общем наш job оставался PENDING, проверка падала «ожидался
 * GIVEN_UP», и красным становился не тот, кто менял код. Поэтому тикаем, пока
 * попытка реально не случится, с потолком — вечного цикла на настоящей поломке
 * быть не должно.
 *
 * ПОТОЛОК В ТИКАХ НЕ ОГРАНИЧИВАЕТ ВРЕМЯ (24.09.2026). Тик выполняет чужую
 * партию ЦЕЛИКОМ, включая тяжёлые задания соседнего файла (clip-compress и
 * прочий ffmpeg), поэтому два-три тика способны занять больше двадцати секунд —
 * стандартного предела vitest. Полный прогон main на be85ed18 уронил этот тест
 * ровно так: «Test timed out in 20000ms», притом что в одиночку файл проходит
 * за 0,6 секунды и семь проверок из семи. Считать это поломкой кода нельзя,
 * гасить проверку — тем более: тесту нужен честный запас по часам, он ниже,
 * третьим аргументом `it`.
 */
async function tickUntil(jobId: string, done: (job: { status: string; attempts: number }) => boolean, label: string) {
  for (let i = 0; i < 20; i += 1) {
    const job = await prisma.backgroundJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, attempts: true },
    });
    if (done(job)) return job;
    await runBackgroundJobsTick();
  }
  const last = await prisma.backgroundJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { status: true, attempts: true },
  });
  throw new Error(`${label}: не дождались за 20 тиков, последнее состояние ${last.status}/${last.attempts}`);
}

describe("уведомление при GIVEN_UP — один раз, не на каждую попытку", () => {
  it("директор получает ровно одну строку в ленте на всю лестницу попыток", async () => {
    failAlways = true;
    const job = await prisma.backgroundJob.create({
      data: { type: "stuck-test-job", payload: { n: 7 }, status: "PENDING", maxAttempts: 2 },
    });
    jobIds.push(job.id);

    // 1-я попытка — ошибка, назад в PENDING (backoff 0), уведомления ещё нет.
    await tickUntil(job.id, (j) => j.attempts >= 1, "первая попытка");
    const afterFirst = await prisma.notification.count({
      where: { agentId: directorId, tag: `background-job-given-up:${job.id}` },
    });
    expect(afterFirst).toBe(0);

    // 2-я попытка — предел, GIVEN_UP.
    const finalJob = await tickUntil(job.id, (j) => j.status === "GIVEN_UP", "сдача задания");
    expect(finalJob.status).toBe("GIVEN_UP");

    const notifications = await prisma.notification.findMany({
      where: { agentId: directorId, tag: `background-job-given-up:${job.id}` },
    });
    expect(notifications).toHaveLength(1);
    // Сырой код типа в тексте для человека не показывается (№240): незнакомый тип — общее слово.
    expect(notifications[0].body).not.toContain("stuck-test-job");
    expect(notifications[0].body).toContain("«Фоновое задание»");

    // Повторный тик (например, ручной «Повторить», снова упавший) не должен
    // размножить строку — тот же tag только обновляет существующую (count++),
    // а не создаёт вторую.
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: "PENDING", attempts: 0, runAt: new Date() },
    });
    await tickUntil(job.id, (j) => j.status === "GIVEN_UP", "повторная сдача задания");
    const notificationsAfterRetry = await prisma.notification.findMany({
      where: { agentId: directorId, tag: `background-job-given-up:${job.id}` },
    });
    expect(notificationsAfterRetry).toHaveLength(1);
    // Запас по часам, а не по тикам: три `tickUntil` подряд, и каждый тик может
    // увезти чужую тяжёлую партию (см. докстринг `tickUntil`).
  }, 90_000);
});
