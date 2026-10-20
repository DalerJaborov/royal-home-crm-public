import { afterEach, describe, expect, it, vi } from "vitest";

const logSystemError = vi.fn(async () => undefined);
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { prisma } = await import("../src/db.js");
const { enqueueBackgroundJob } = await import("../src/jobs/enqueue.js");

/**
 * Отказ БД при постановке задания (07.10.2026): раньше только console.error и
 * возврат skipped:"error" — вызывающий без await не узнавал о потере вовсе, и в
 * журнале ошибок её не было. Сигнатура возврата не изменилась.
 */
describe("enqueueBackgroundJob: отказ базы виден в журнале ошибок", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    logSystemError.mockClear();
  });

  it("ошибка БД: возвращает skipped=error и пишет logSystemError с ключом по типу задания", async () => {
    vi.spyOn(prisma.backgroundJob, "create").mockRejectedValueOnce(new Error("соединение потеряно"));
    const res = await enqueueBackgroundJob({ type: "clip-compress", payload: { a: 1 }, maxAttempts: 3 });
    expect(res).toEqual({ enqueued: false, skipped: "error" });
    expect(logSystemError).toHaveBeenCalledTimes(1);
    const [source, message, ctx] = logSystemError.mock.calls[0] as unknown as [string, string, { dedupKey: string }];
    expect(source).toBe("background-jobs");
    expect(message).toContain("clip-compress");
    expect(message).toContain("соединение потеряно");
    expect(ctx.dedupKey).toBe("enqueue-failed:clip-compress");
  });

  it("успешная постановка журнал ошибок не трогает", async () => {
    const create = vi.spyOn(prisma.backgroundJob, "create").mockResolvedValueOnce({} as never);
    const res = await enqueueBackgroundJob({ type: "clip-compress", payload: { a: 1 }, maxAttempts: 3 });
    expect(res).toEqual({ enqueued: true });
    expect(create).toHaveBeenCalled();
    expect(logSystemError).not.toHaveBeenCalled();
  });
});
