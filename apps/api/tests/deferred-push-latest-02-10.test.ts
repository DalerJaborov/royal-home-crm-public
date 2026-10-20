import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * E14 глубокой проверки 02.10.2026: ночной пуш откладывается до 08:00 одним
 * заданием на тему (tag), и выигрывала ПЕРВАЯ постановка за ночь. В 22:00
 * «клиент ждёт ответа», в 23:00 по той же теме уже другое — а утром приходил
 * текст 22:00. Теперь ждущее задание темы несёт последнее содержание.
 */

const { prisma } = await import("../src/db.js");
const { handledByQuietHours } = await import("../src/push.js");
const { dushanbeInputToDate } = await import("../src/lib/dushanbeTime.js");

const runId = Date.now().toString(36);
const tag = `deferred-latest-${runId}`;
const agentIds = [`агент-${runId}`];
const dedupeKey = `deferred-push:${tag}:${agentIds[0]}`;
let envBefore: string | undefined;

beforeAll(() => {
  envBefore = process.env.PUSH_QUIET_HOURS;
  process.env.PUSH_QUIET_HOURS = "on";
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(async () => {
  vi.useRealTimers();
  if (envBefore === undefined) delete process.env.PUSH_QUIET_HOURS;
  else process.env.PUSH_QUIET_HOURS = envBefore;
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey } });
  await prisma.$disconnect();
});

describe("отложенный до утра пуш — с последним содержанием темы", () => {
  it("вторая постановка за ночь по той же теме заменяет текст ждущего задания", async () => {
    vi.setSystemTime(dushanbeInputToDate("2026-10-02", "22:00"));
    expect(await handledByQuietHours(agentIds, { title: "Клиент ждёт", body: "текст 22:00", kind: "task", tag })).toBe(true);
    vi.setSystemTime(dushanbeInputToDate("2026-10-02", "23:00"));
    expect(await handledByQuietHours(agentIds, { title: "Клиент ждёт", body: "текст 23:00", kind: "task", tag })).toBe(true);

    const jobs = await prisma.backgroundJob.findMany({ where: { dedupeKey } });
    expect(jobs).toHaveLength(1);
    expect((jobs[0].payload as { payload: { body: string } }).payload.body).toBe("текст 23:00");
  });
});
