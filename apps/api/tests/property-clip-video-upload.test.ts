import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { headOfQueueRunAt } from "./helpers/queueHead.js";

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
 * Короткий сжатый ролик карточки объекта (docs/plan-18-08-private-listings-and-video.md
 * §3, POST /properties/:id/clip-video). ffmpeg/ffprobe в песочнице нет (проверено —
 * бинарники не найдены), поэтому spawn мокается: тесты покрывают маршрутизацию,
 * авторизацию и проверку длительности, а не реальное перекодирование.
 */

type FakeSpawnBehavior = { stdout?: string; exitCode: number };
let nextProbeBehavior: FakeSpawnBehavior = { stdout: "5.0", exitCode: 0 };
let nextCompressExitCode = 0;

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string) => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      if (cmd === "ffprobe") {
        if (nextProbeBehavior.stdout !== undefined) proc.stdout.emit("data", Buffer.from(nextProbeBehavior.stdout));
        proc.emit("close", nextProbeBehavior.exitCode);
      } else {
        proc.emit("close", nextCompressExitCode);
      }
    });
    return proc;
  }),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
// Обработчики фоновой очереди регистрируются ТОЛЬКО worker-процессом
// (jobs/handlers.ts — см. докстринг registry.ts про разрыв цикла импортов).
// Без этого импорта runBackgroundJobsTick() находит задание типа "clip-compress"
// без обработчика и молча откладывает его (jobs/runner.ts::runOne) — статус
// навсегда остаётся PROCESSING, как и было до этой правки.
await import("../src/jobs/handlers.js");
const { runBackgroundJobsTick } = await import("../src/jobs/runner.js");

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let agentToken: string;
let otherAgentId: string;
let otherAgentToken: string;
const propertyIds: string[] = [];
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/**
 * Джоб ставится роутом через `void enqueueBackgroundJob(...)` — намеренно без
 * await, чтобы вставка в очередь не тормозила HTTP-ответ 202 (см. комментарий в
 * routes/properties/videos.ts). Значит между 202 и тем, как строка реально
 * появится в БД, есть окно фоновой INSERT-транзакции: сначала дожидаемся своей
 * строки, и только потом тикаем.
 *
 * ЧУЖИЕ PENDING УБИРАЕМ ПЕРЕД ТИКОМ — тот же приём и та же причина, что уже
 * документируют у себя background-jobs.test.ts и video-handoff.test.ts.
 * Прежний вариант (тикать общую очередь, пока свой тип не уйдёт из PENDING)
 * от чужих заданий не спасал, а против таймаута теста работал против нас:
 * `claimBatch` берёт десять САМЫХ СТАРЫХ по runAt заданий ПО ВСЕЙ таблице, а
 * `clip-compress` — HEAVY_TYPES, и тяжёлое исполняется в партии ПОСЛЕДНИМ
 * (jobs/runner.ts). В полном прогоне (два процесса на одной базе, сотни файлов)
 * прикладной код соседей оставляет свои PENDING-строки: тест проверил HTTP-ответ
 * и тик сам не звал. Наше задание — самое молодое, поэтому каждый тик сначала
 * исполнял чужие задания целиком, и двадцать секунд теста уходили на чужую
 * работу. Падало ровно по таймауту (20 000 мс), в одиночку файл при этом
 * зелёный: воспроизведено тремя полными прогонами подряд 22.09.2026 на разных
 * коммитах main.
 *
 * Своё задание ищем по payload.propertyId: у `clip-compress` дедуп-ключа НЕТ
 * нарочно (routes/properties/videos.ts — повторная загрузка обязана ставить
 * новое задание), поэтому отличить своё от чужого больше нечем.
 */
async function findOwnClipJob(propertyId: string, attempts = 20, delayMs = 50): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const job = await prisma.backgroundJob.findFirst({
      where: {
        type: "clip-compress",
        status: "PENDING",
        payload: { path: ["propertyId"], equals: propertyId },
      },
      select: { id: true },
    });
    if (job) return job.id;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`задание clip-compress для ${propertyId} так и не появилось в очереди`);
}

/**
 * Один заход очереди по СВОЕМУ заданию: своё задание ставим в начало очереди,
 * тикаем, пока оно не будет взято в работу. «Взято» — это либо уход из PENDING
 * (DONE/GIVEN_UP), либо выросший счётчик попыток: упавшее задание возвращается
 * в PENDING с бэкоффом, и ждать от него другого статуса бессмысленно.
 *
 * ЧУЖИЕ СТРОКИ БОЛЬШЕ НЕ УДАЛЯЕМ (24.09.2026). Здесь стоял
 * `deleteMany({ status: "PENDING", id: { not: jobId } })` — «чужие ожидающие
 * строки убираем». С правки #608 тесты сервера идут в два процесса на ОДНОЙ
 * базе, и «чужие» — это живые задания соседнего файла, идущего прямо сейчас:
 * их сносило посреди его прогона, и красным становился не тот, кто менял код
 * (тот самый класс, что описан в CLAUDE.md про `deleteMany` по общей таблице).
 * Нужного тут добивается очередь сама: `claimBatch` берёт партию `ORDER BY
 * "runAt"`, поэтому достаточно отодвинуть СВОЙ `runAt` в прошлое — задание
 * окажется первым в каждой партии, а чужие строки останутся нетронутыми.
 */
async function tickOwnClipJob(jobId: string, attempts = 20): Promise<void> {
  const before = await prisma.backgroundJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { attempts: true },
  });
  await prisma.backgroundJob.updateMany({
    where: { id: jobId, status: "PENDING" },
    data: { runAt: headOfQueueRunAt() },
  });
  for (let i = 0; i < attempts; i++) {
    await runBackgroundJobsTick();
    const job = await prisma.backgroundJob.findUnique({
      where: { id: jobId },
      select: { status: true, attempts: true },
    });
    if (!job || job.status !== "PENDING" || job.attempts > before.attempts) return;
  }
  throw new Error(`задание clip-compress ${jobId} не взято очередью за ${attempts} тиков`);
}

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Объект клип-видео ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая клип-видео, 1",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agentId,
      createdById: agentId,
      assignedAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-клип-видео-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент клип-видео", phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(agentId);
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Чужой агент клип-видео", phone: `+992972${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(otherAgentId);

  agentToken = await login(`+992971${runId}`);
  otherAgentToken = await login(`+992972${runId}`);
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { type: "clip-compress" } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("POST /properties/:id/clip-video", () => {
  it("404 на несуществующий объект", async () => {
    const res = await request(app)
      .post("/api/v1/properties/00000000-0000-0000-0000-000000000000/clip-video")
      .set("Authorization", `Bearer ${agentToken}`)
      .attach("video", Buffer.from("fake"), "clip.mp4");
    expect(res.status).toBe(404);
  });

  it("403 у агента без прав на этот объект (не назначен и не создавал)", async () => {
    const p = await makeProperty();
    nextProbeBehavior = { stdout: "5.0", exitCode: 0 };
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/clip-video`)
      .set("Authorization", `Bearer ${otherAgentToken}`)
      .attach("video", Buffer.from("fake"), "clip.mp4");
    expect(res.status).toBe(403);
  });

  it("400 без файла", async () => {
    const p = await makeProperty();
    const res = await request(app).post(`/api/v1/properties/${p.id}/clip-video`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(400);
  });

  it("400 когда ffprobe не смог определить длительность", async () => {
    const p = await makeProperty();
    nextProbeBehavior = { stdout: undefined, exitCode: 1 };
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/clip-video`)
      .set("Authorization", `Bearer ${agentToken}`)
      .attach("video", Buffer.from("fake"), "clip.mp4");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/длительность/i);
  });

  it("400 и не запускает сжатие, если ролик длиннее 5 минут", async () => {
    const p = await makeProperty();
    nextProbeBehavior = { stdout: "320.5", exitCode: 0 };
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/clip-video`)
      .set("Authorization", `Bearer ${agentToken}`)
      .attach("video", Buffer.from("fake"), "clip.mp4");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/300 секунд/);

    const reloaded = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(reloaded.clipVideoStatus).toBe("NONE");
  });

  it("очередь не приняла задание: 503, статус возвращён (не залипает в PROCESSING), входной файл убран", async () => {
    const p = await makeProperty();
    nextProbeBehavior = { stdout: "12.0", exitCode: 0 };
    const spy = vi.spyOn(prisma.backgroundJob, "create").mockRejectedValueOnce(new Error("БД отказала"));
    let res;
    try {
      res = await request(app)
        .post(`/api/v1/properties/${p.id}/clip-video`)
        .set("Authorization", `Bearer ${agentToken}`)
        .attach("video", Buffer.from("fake"), "clip.mp4");
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ещё раз/);
    const reloaded = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(reloaded.clipVideoStatus).toBe("NONE");
    expect(reloaded.clipVideoPendingInput).toBeNull();
  });

  it("202 + PROCESSING сразу, затем READY после прохода очереди (чертёж Б4)", async () => {
    const p = await makeProperty();
    nextProbeBehavior = { stdout: "12.0", exitCode: 0 };
    nextCompressExitCode = 0;
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/clip-video`)
      .set("Authorization", `Bearer ${agentToken}`)
      .attach("video", Buffer.from("fake mp4 bytes"), "clip.mp4");
    expect(res.status).toBe(202);
    expect(res.body.clipVideoStatus).toBe("PROCESSING");

    // Сжатие — задание clip-compress: роут только ставит его (fire-and-forget),
    // исполняет тик очереди — как в worker-контейнере.
    await tickOwnClipJob(await findOwnClipJob(p.id));

    const reloaded = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(reloaded.clipVideoStatus).toBe("READY");
    expect(reloaded.clipVideoUrl).toMatch(/^\/uploads\/video\//);
    expect(reloaded.clipVideoDurationSec).toBe(12);
  });

  it("статус FAILED, когда ffmpeg падает на всех попытках задания", async () => {
    const p = await makeProperty();
    nextProbeBehavior = { stdout: "12.0", exitCode: 0 };
    nextCompressExitCode = 1;
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/clip-video`)
      .set("Authorization", `Bearer ${agentToken}`)
      .attach("video", Buffer.from("fake mp4 bytes"), "clip.mp4");
    expect(res.status).toBe(202);

    // Первая попытка падает и уходит на бэкофф; подтягиваем срок и добиваем
    // вторую (предельную) — give-up обязан выставить FAILED.
    const jobId = await findOwnClipJob(p.id);
    await tickOwnClipJob(jobId);
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: { runAt: new Date(Date.now() - 1000) },
    });
    await tickOwnClipJob(jobId);

    const reloaded = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(reloaded.clipVideoStatus).toBe("FAILED");
  });
});
