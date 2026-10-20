import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { claimBatch, effectiveJobTimeoutMs } from "../src/jobs/runner.js";

/**
 * E6 / Ф9 и E9 глубокой проверки 02.10.2026.
 *
 * E6: повторная расшифровка и повторный поиск записи шли с лёгким сроком 60 с,
 * а сами ждут станцию до 120 с и Gemini до 180 с на кусок. Попытка снималась
 * с ожидания, сжигала лестницу и продолжалась оторванной — следующая шла
 * параллельно с ней (двойная плата, упор в лимит ключа).
 *
 * E9: захват брал 10 заданий по самому старому runAt без различия типа. Пачка
 * из 15 роликов давала 10 тяжёлых в каждом захвате: выполнялось одно, девять
 * возвращались — а лёгкие (повтор ответа клиенту, отложенный пуш) с более
 * свежим runAt в захват не попадали вовсе.
 */

const ids: string[] = [];

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("срок попытки расшифровки и поиска записи", () => {
  it("не короче бюджета внешних вызовов", () => {
    expect(effectiveJobTimeoutMs("transcription-retry")).toBeGreaterThanOrEqual(8 * 60_000);
    expect(effectiveJobTimeoutMs("recording-search-retry")).toBeGreaterThanOrEqual(4 * 60_000);
  });
});

describe("захват партии: тяжёлые не вытесняют лёгкие", () => {
  it("12 старых сжатий роликов и свежий отложенный пуш — пуш попадает в партию, тяжёлое одно", async () => {
    // Чужие ожидающие задания прошлых файлов уводим в будущее, чтобы партия была про нас.
    await prisma.backgroundJob.updateMany({
      where: { status: "PENDING", runAt: { lte: new Date() } },
      data: { runAt: new Date(Date.now() + 3_600_000) },
    });
    const old = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 12; i++) {
      const job = await prisma.backgroundJob.create({
        data: { type: "clip-compress", maxAttempts: 3, payload: { videoId: `тест-${i}` }, runAt: new Date(old.getTime() + i * 1000) },
      });
      ids.push(job.id);
    }
    const light = await prisma.backgroundJob.create({
      data: { type: "deferred-push", maxAttempts: 3, payload: { x: 1 }, runAt: new Date(Date.now() - 1000) },
    });
    ids.push(light.id);

    const claimed = await claimBatch();
    try {
      expect(claimed.map((j) => j.id)).toContain(light.id);
      expect(claimed.filter((j) => j.type === "clip-compress")).toHaveLength(1);
    } finally {
      await prisma.backgroundJob.updateMany({
        where: { id: { in: claimed.map((j) => j.id) } },
        data: { status: "PENDING", lockedAt: null, lockedBy: null },
      });
    }
  });
});
