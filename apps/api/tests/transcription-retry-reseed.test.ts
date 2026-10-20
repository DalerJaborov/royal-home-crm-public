import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  scheduleTranscriptionRetry,
  TRANSCRIPTION_RETRY_MAX_ATTEMPTS,
  TRANSCRIPTION_RETRY_DELAYS_MS,
} from "../src/lib/telephony/callRecordings.js";

/**
 * «После того как всё поднялось — расшифровка по-прежнему будет работать?»
 * (владелец 19.08.2026). Ответ первой версии — костыль досева in-memory
 * очереди при старте процесса. С 27.08.2026 (чертёж Б3) очередь повторов —
 * BackgroundJob в Postgres: перезапуск переживает сама, досев удалён. Здесь
 * проверяется контракт постановки; исполнение — в ai/call-конвейере
 * (call-recordings.test.ts) и общей механике очереди (background-jobs.test.ts).
 */

const settle = () => new Promise((r) => setTimeout(r, 100));
const INTERACTION_ID = "test-transcription-reseed-1";
const KEY = `transcription-retry:${INTERACTION_ID}`;

beforeEach(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: KEY } });
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: KEY } });
  await prisma.$disconnect();
});

describe("scheduleTranscriptionRetry (персистентная очередь)", () => {
  it("создаёт задание с отступом первой попытки и переживаемым процессом сроком", async () => {
    scheduleTranscriptionRetry(INTERACTION_ID);
    await settle();
    const job = await prisma.backgroundJob.findUnique({ where: { dedupeKey: KEY } });
    expect(job).not.toBeNull();
    expect(job!.type).toBe("transcription-retry");
    expect(job!.status).toBe("PENDING");
    expect(job!.maxAttempts).toBe(TRANSCRIPTION_RETRY_MAX_ATTEMPTS);
    expect(job!.payload).toEqual({ interactionId: INTERACTION_ID });
    // Первая попытка — не раньше чем через ~5 минут (первая ступень лесенки).
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + TRANSCRIPTION_RETRY_DELAYS_MS[0] - 60_000);
  });

  it("лесенка переживает многочасовой простой поставщика ИИ", () => {
    // 21.09.2026: Gemini отдавал 402 ~1,5 часа, а окно было ~85 минут — два
    // звонка сдались за минуты до восстановления. Попыток ровно по числу
    // ступеней, суммарное окно — не меньше шести часов.
    expect(TRANSCRIPTION_RETRY_MAX_ATTEMPTS).toBe(TRANSCRIPTION_RETRY_DELAYS_MS.length);
    const windowMs = TRANSCRIPTION_RETRY_DELAYS_MS.reduce((sum, d) => sum + d, 0);
    expect(windowMs).toBeGreaterThanOrEqual(6 * 60 * 60_000);
  });

  it("повторная постановка того же разговора не плодит второго задания", async () => {
    scheduleTranscriptionRetry(INTERACTION_ID);
    await settle();
    scheduleTranscriptionRetry(INTERACTION_ID);
    await settle();
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: KEY } })).toBe(1);
  });

  it("после DONE новый отказ заводит задание заново", async () => {
    scheduleTranscriptionRetry(INTERACTION_ID);
    await settle();
    await prisma.backgroundJob.update({ where: { dedupeKey: KEY }, data: { status: "DONE" } });
    scheduleTranscriptionRetry(INTERACTION_ID);
    await settle();
    const job = await prisma.backgroundJob.findUnique({ where: { dedupeKey: KEY } });
    expect(job!.status).toBe("PENDING");
    expect(job!.attempts).toBe(0);
  });
});
