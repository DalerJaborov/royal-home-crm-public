import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";

/**
 * НАДЁЖНОСТЬ СЛОЯ ХРАНЕНИЯ ЧАСТЕЙ (25.11.2026, волна B «загрузка не теряет данные»).
 * Один слой (lib/localVideoStorage.ts) на три вида загрузки частями, поэтому проверяется он,
 * а не каждый маршрут: каждая находка аудита — свой тест, и каждый проверен поломкой.
 *
 * База не нужна: слой хранения и порядок сборки до неё не доходят. db.js подменён, чтобы
 * общая подготовка (tests/setup.ts) не требовала живой базы.
 */
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));
const logged: string[] = [];
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string) => {
    logged.push(message);
  },
}));

const storage = await import("../src/lib/localVideoStorage.js");
const { UploadError } = await import("../src/lib/uploadErrors.js");
const { computeUploadPartPlan, UPLOAD_PART_BYTES, UPLOAD_PART_MAX_BYTES, UPLOAD_PART_MIN_BYTES } = await import("@royal-home/shared");

const created: string[] = [];
const keys: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of created.splice(0)) await storage.abortLocalUploadSession(id);
  for (const key of keys.splice(0)) await storage.localVideoDelete(key);
});

async function newSession(): Promise<string> {
  const id = randomUUID();
  await storage.createLocalUploadSession(id);
  created.push(id);
  return id;
}

function newKey(): string {
  const key = `${randomUUID()}/${randomUUID()}.mp4`;
  keys.push(key);
  return key;
}

function sessionFiles(id: string): string[] {
  return fs.readdirSync(storage.localUploadSessionDir(id)!).sort();
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(UploadError);
  expect((err as InstanceType<typeof UploadError>).code).toBe(code);
}

describe("план частей — одно число на все виды загрузки", () => {
  it("по умолчанию UPLOAD_PART_BYTES; свой размер — только в пределах; за пределами — null", () => {
    expect(computeUploadPartPlan(10 * 1024 * 1024)).toEqual({ partSize: UPLOAD_PART_BYTES, totalParts: Math.ceil((10 * 1024 * 1024) / UPLOAD_PART_BYTES) });
    expect(computeUploadPartPlan(3 * 1024 * 1024, UPLOAD_PART_MIN_BYTES)).toEqual({ partSize: UPLOAD_PART_MIN_BYTES, totalParts: 3 });
    expect(computeUploadPartPlan(100, UPLOAD_PART_MIN_BYTES - 1)).toBeNull();
    expect(computeUploadPartPlan(100, UPLOAD_PART_MAX_BYTES + 1)).toBeNull();
  });

  it("в коде сервера нет своих копий размера части", () => {
    const src = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === "generated") continue;
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.ts$/.test(name) && /(?<![A-Z0-9_])(?:VIDEO_)?PART_SIZE\s*=\s*\d/.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe("запись части — атомарно и со сверкой размера (№4, №9)", () => {
  it("поток пишется на диск без копии в памяти; ровно план — часть есть, временных файлов нет", async () => {
    const id = await newSession();
    const written = await storage.writeLocalUploadPart(id, 1, Readable.from([Buffer.alloc(3000, 1), Buffer.alloc(2000, 2)]), { expectedBytes: 5000 });
    expect(written).toBe(5000);
    expect(sessionFiles(id)).toEqual(["part-1"]);
  });

  it("лишний байт в потоке — отказ PART_SIZE_MISMATCH, части нет, временного файла нет", async () => {
    const id = await newSession();
    await expectCode(storage.writeLocalUploadPart(id, 1, Readable.from([Buffer.alloc(5001)]), { expectedBytes: 5000 }), "PART_SIZE_MISMATCH");
    expect(sessionFiles(id)).toEqual([]);
  });

  it("короткое тело — отказ, обрезанная часть не появляется (раньше ложилась как «принята»)", async () => {
    const id = await newSession();
    await expectCode(storage.writeLocalUploadPart(id, 2, Buffer.alloc(10), { expectedBytes: 20 }), "PART_SIZE_MISMATCH");
    expect(sessionFiles(id)).toEqual([]);
  });

  it("обрыв посреди тела — PART_INCOMPLETE (повторяемый), прежняя целая часть не испорчена", async () => {
    const id = await newSession();
    await storage.writeLocalUploadPart(id, 1, Buffer.alloc(100, 7), { expectedBytes: 100 });
    const body = new PassThrough();
    const pending = storage.writeLocalUploadPart(id, 1, body, { expectedBytes: 100 });
    body.write(Buffer.alloc(40, 9));
    setTimeout(() => body.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" })), 10);
    await expectCode(pending, "PART_INCOMPLETE");
    expect(sessionFiles(id)).toEqual(["part-1"]);
    expect(fs.readFileSync(path.join(storage.localUploadSessionDir(id)!, "part-1")).equals(Buffer.alloc(100, 7))).toBe(true);
  });

  it("нет места на диске при записи (ENOSPC) — DISK_FULL 507, а не 500; части нет", async () => {
    const id = await newSession();
    vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(Object.assign(new Error("no space"), { code: "ENOSPC" }));
    const err = await storage.writeLocalUploadPart(id, 1, Buffer.alloc(10), { expectedBytes: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as InstanceType<typeof UploadError>).code).toBe("DISK_FULL");
    expect((err as InstanceType<typeof UploadError>).status).toBe(507);
    expect((err as InstanceType<typeof UploadError>).body()).toMatchObject({ code: "DISK_FULL", retryable: false });
    expect(sessionFiles(id)).toEqual([]);
  });

  it("сессии нет — SESSION_NOT_FOUND, а не сбой диска", async () => {
    await expectCode(storage.writeLocalUploadPart(randomUUID(), 1, Buffer.alloc(1)), "SESSION_NOT_FOUND");
  });

  it("план сессии (meta.json) пишется атомарно: сбой записи не оставляет обрезанный файл", async () => {
    const id = await newSession();
    await storage.writeLocalUploadSessionMeta(id, { kind: "x", n: 1 });
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("no space"), { code: "ENOSPC" }));
    await expectCode(storage.writeLocalUploadSessionMeta(id, { kind: "x", n: 2 }), "DISK_FULL");
    expect(await storage.readLocalUploadSessionMeta(id)).toEqual({ kind: "x", n: 1 });
    expect(sessionFiles(id)).toEqual(["meta.json"]);
  });
});

describe("место на диске проверяется до записи (№1)", () => {
  it("свободно меньше нужного с запасом — DISK_FULL; больше — пропуск; измерить нельзя — пропуск", async () => {
    process.env.UPLOAD_DISK_CHECK = "on";
    const reserve = storage.uploadDiskReserveBytes();
    vi.spyOn(fs.promises, "statfs").mockResolvedValueOnce({ bavail: 1, bsize: reserve } as unknown as fs.StatsFs);
    await expectCode(storage.assertUploadDiskSpace(1024), "DISK_FULL");
    vi.spyOn(fs.promises, "statfs").mockResolvedValueOnce({ bavail: 2, bsize: reserve } as unknown as fs.StatsFs);
    await expect(storage.assertUploadDiskSpace(1024)).resolves.toBeUndefined();
    vi.spyOn(fs.promises, "statfs").mockRejectedValueOnce(new Error("не поддерживается"));
    await expect(storage.assertUploadDiskSpace(1024)).resolves.toBeUndefined();
  });

  it("запас настраивается переменной UPLOAD_DISK_RESERVE_BYTES; по умолчанию 5 ГБ", () => {
    const prev = process.env.UPLOAD_DISK_RESERVE_BYTES;
    delete process.env.UPLOAD_DISK_RESERVE_BYTES;
    expect(storage.uploadDiskReserveBytes()).toBe(5 * 1024 * 1024 * 1024);
    process.env.UPLOAD_DISK_RESERVE_BYTES = "123";
    expect(storage.uploadDiskReserveBytes()).toBe(123);
    if (prev === undefined) delete process.env.UPLOAD_DISK_RESERVE_BYTES;
    else process.env.UPLOAD_DISK_RESERVE_BYTES = prev;
  });
});

describe("сборка — со сверкой, без удаления частей, повторяемая (№2, №4, №5)", () => {
  async function fill(id: string, parts: Buffer[]): Promise<void> {
    for (const [i, b] of parts.entries()) await storage.writeLocalUploadPart(id, i + 1, b);
  }

  it("100+ частей: файл байт-в-байт, части на месте до явного завершения, повтор сборки не склеивает заново", async () => {
    const id = await newSession();
    const partSize = 1000;
    const total = 120;
    const parts = Array.from({ length: total }, (_, i) => Buffer.alloc(i === total - 1 ? 337 : partSize, i % 251));
    await fill(id, parts);
    const plan = { totalParts: total, partSize, sizeBytes: partSize * (total - 1) + 337 };
    const key = newKey();
    expect(await storage.completeLocalUploadSession(id, key, plan)).toEqual({ reused: false });
    expect(fs.readFileSync(storage.localVideoFilePath(key)!).equals(Buffer.concat(parts))).toBe(true);
    // Части НЕ удалены сборкой: упади запись в базу — повтор соберёт снова.
    expect(await storage.listLocalUploadParts(id)).toHaveLength(total);
    // Повтор: файл уже целый — склейки нет.
    expect(await storage.completeLocalUploadSession(id, key, plan)).toEqual({ reused: true });
    // Явное завершение с итогом: части убраны, итог помнится.
    expect(await storage.finishLocalUploadSession(id, { state: "done" })).toBe(true);
    expect(sessionFiles(id)).toEqual(["state.json"]);
    expect(await storage.readLocalUploadSessionState(id)).toEqual({ state: "done" });
  });

  it("обрезанная часть на диске — PARTS_MISSING со списком годных, битая удалена, файла назначения нет", async () => {
    const id = await newSession();
    await fill(id, [Buffer.alloc(10, 1), Buffer.alloc(10, 2), Buffer.alloc(5, 3)]);
    fs.writeFileSync(path.join(storage.localUploadSessionDir(id)!, "part-2"), Buffer.alloc(4, 2)); // «обрезана сбоем»
    const key = newKey();
    const err = await storage.completeLocalUploadSession(id, key, { totalParts: 3, partSize: 10, sizeBytes: 25 }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof UploadError>).code).toBe("PARTS_MISSING");
    expect((err as InstanceType<typeof UploadError>).body()).toMatchObject({ uploadedPartNumbers: [1, 3], retryable: true });
    expect(await storage.listLocalUploadParts(id)).toEqual([1, 3]);
    expect(fs.existsSync(storage.localVideoFilePath(key)!)).toBe(false);
  });

  it("сбой посреди склейки не оставляет недосклеенный файл под именем назначения", async () => {
    const id = await newSession();
    await fill(id, [Buffer.alloc(10, 1), Buffer.alloc(10, 2)]);
    const key = newKey();
    const dest = storage.localVideoFilePath(key)!;
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      if (String(from).includes(".partial-")) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return realRename(from, to);
    });
    await expectCode(storage.completeLocalUploadSession(id, key, { totalParts: 2, partSize: 10, sizeBytes: 20 }), "STORAGE_FAILED");
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(path.dirname(dest)).filter((n) => n.includes(".partial-"))).toEqual([]);
    expect(await storage.listLocalUploadParts(id)).toEqual([1, 2]);
  });

  it("две одновременные сборки одной сессии дают целый файл (раньше — дыра нулей)", async () => {
    const id = await newSession();
    const parts = Array.from({ length: 30 }, (_, i) => Buffer.alloc(4096, i + 1));
    await fill(id, parts);
    const key = newKey();
    const plan = { totalParts: 30, partSize: 4096, sizeBytes: 30 * 4096 };
    await Promise.all([storage.completeLocalUploadSession(id, key, plan), storage.completeLocalUploadSession(id, key, plan)]);
    expect(fs.readFileSync(storage.localVideoFilePath(key)!).equals(Buffer.concat(parts))).toBe(true);
  });
});

describe("замок сборки — один на всех, не виснет после убитого процесса (№5, №11)", () => {
  it("второй замок той же сессии — null; после снятия — снова можно", async () => {
    const id = await newSession();
    const first = await storage.lockLocalUploadAssembly(id);
    expect(first).not.toBeNull();
    expect(await storage.lockLocalUploadAssembly(id)).toBeNull();
    await first!.release();
    const again = await storage.lockLocalUploadAssembly(id);
    expect(again).not.toBeNull();
    await again!.release();
  });

  it("замок без пульса дольше ASSEMBLY_LOCK_STALE_MS (процесс убит) перехватывается, а не держит 15 минут", async () => {
    const id = await newSession();
    const lockPath = path.join(storage.localUploadSessionDir(id)!, "assemble.lock");
    fs.writeFileSync(lockPath, "");
    const old = new Date(Date.now() - storage.ASSEMBLY_LOCK_STALE_MS - 5_000);
    fs.utimesSync(lockPath, old, old);
    const lock = await storage.lockLocalUploadAssembly(id);
    expect(lock).not.toBeNull();
    await lock!.release();
    expect(storage.ASSEMBLY_LOCK_STALE_MS).toBeLessThanOrEqual(2 * 60 * 1000);
  });
});
