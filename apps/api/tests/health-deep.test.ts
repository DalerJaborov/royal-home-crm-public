import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deepHealth, WORKER_STALE_MS } from "../src/lib/deepHealth.js";

/**
 * Глубокая проверка здоровья для сторожа на сервере (аудит 23.09, №77; просьба
 * Dan 25.09 «сторож, который будит сервер, если он завис»). Обычный `/health`
 * отвечает «жив» и при мёртвом фоновом процессе; эта — нет.
 *
 * Пульс в общей тестовой базе пишут и другие файлы, поэтому правило свежести
 * проверяется на подставленной отметке, а чтение из базы — своей свежей строкой.
 * Отметок из будущего в базу не кладём: пульс читают и другие экраны.
 */

const name = `health-deep-${Date.now()}`;
const at = (d: number) => async () => new Date(d);

afterAll(async () => {
  await prisma.cronHeartbeat.deleteMany({ where: { name } });
});

describe("глубокая проверка здоровья", () => {
  it("пульс фонового процесса старше 10 минут — worker не здоров, ответ не ok", async () => {
    const now = Date.now();
    const report = await deepHealth({ now, readLastBeat: at(now - WORKER_STALE_MS - 60_000) });
    expect(report).toMatchObject({ ok: false, db: true, worker: false });
    expect(report.workerLastBeatSec).toBe(WORKER_STALE_MS / 1000 + 60);
  });

  it("пульса нет вовсе — worker не здоров", async () => {
    expect(await deepHealth({ readLastBeat: async () => null })).toMatchObject({
      ok: false,
      worker: false,
      workerLastBeatSec: null,
    });
  });

  it("свежий пульс — worker здоров", async () => {
    const now = Date.now();
    expect(await deepHealth({ now, readLastBeat: at(now - 60_000) })).toMatchObject({
      ok: true,
      db: true,
      worker: true,
      workerLastBeatSec: 60,
    });
  });

  it("из базы берётся самая свежая отметка, и пропуск выключенного модуля тоже считается", async () => {
    await prisma.cronHeartbeat.create({ data: { name, expr: "*/2 * * * *", lastSkippedAt: new Date() } });
    const report = await deepHealth();
    expect(report).toMatchObject({ ok: true, db: true, worker: true });
    expect(report.workerLastBeatSec).toBeLessThanOrEqual(5);
  });

  it("адрес отвечает без входа: 200 и что здорово", async () => {
    await prisma.cronHeartbeat.update({ where: { name }, data: { lastRunAt: new Date() } });
    const res = await request(app).get("/api/v1/health/deep");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: true, worker: true });
  });
});
