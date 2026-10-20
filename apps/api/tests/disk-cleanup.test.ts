import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  classifyFileName,
  planDiskCleanup,
  propertyIdsInFiles,
  legacyHandoffCoverPath,
  propertyOwnedFilePaths,
  isDiskCleanupDryRun,
  diskCleanupSummary,
  runDiskCleanup,
  DISK_CLEANUP_MIN_AGE_MS,
  DISK_CLEANUP_MAX_FILES_PER_RUN,
  type FoundFile,
  type CleanupFacts,
  type PropertyFileFacts,
} from "../src/lib/diskCleanup.js";

const { prisma } = await import("../src/db.js");

/**
 * Уборка диска (Б8, 25.09.2026) — см. докстринг lib/diskCleanup.ts. Чистые
 * функции (classifyFileName/planDiskCleanup/isDiskCleanupDryRun/diskCleanupSummary)
 * проверены по таблице без базы и без диска; runDiskCleanup — интеграционно на
 * четырёх временных каталогах и своей базе.
 */

const UUID_A = "11111111-1111-1111-1111-111111111111";
const OLD_TS = "1700000000000";
const NEW_TS = "1800000000000";

describe("classifyFileName", () => {
  it.each([
    ["handoff", `${UUID_A}-${NEW_TS}.mp4`, { kind: "final", propertyId: UUID_A }],
    ["handoff", `${UUID_A}-${NEW_TS}`, { kind: "final", propertyId: UUID_A }],
    ["handoff", `${UUID_A}-${NEW_TS}-cover.jpg`, { kind: "legacyCover", propertyId: UUID_A }],
    ["handoff", `${UUID_A}-${NEW_TS}-story-1.mp4`, { kind: "storyPart", propertyId: UUID_A }],
    ["handoff", `${UUID_A}-exterior-${NEW_TS}.jpg`, { kind: "storyCard", propertyId: UUID_A }],
    ["handoff", `montajer-${UUID_A}.mp4`, { kind: "montajerTmp", propertyId: null }],
    ["handoff", `montajer-${UUID_A}`, { kind: "montajerTmp", propertyId: null }],
    ["handoff", "readme.txt", null],
    ["handoff", `${UUID_A}-12.mp4`, null], // цифр меньше 10 — не похоже на ms-таймстемп
    ["covers", `${UUID_A}-a1b2c3-square.jpg`, { kind: "propertyCover", propertyId: UUID_A }],
    ["covers", `${UUID_A}-a1b2c3-story.jpg`, { kind: "propertyCover", propertyId: UUID_A }],
    ["covers", "cover-ab12cd34.jpg", null],
    ["covers", "readme.txt", null],
    ["clips", `${UUID_A}.mp4`, { kind: "clipOutput", propertyId: null }],
    ["clips", `incoming-${UUID_A}`, { kind: "clipIncoming", propertyId: null }],
    ["clips", "readme.txt", null],
  ] as const)("%s / %s -> %j", (area, name, expected) => {
    expect(classifyFileName(area as never, name)).toEqual(expected);
  });

  it("raw — любое имя считается известным (ключи закрытого хранилища не разобрать по имени)", () => {
    expect(classifyFileName("raw", "readme.txt")).toEqual({ kind: "raw", propertyId: null });
    expect(classifyFileName("raw", `${UUID_A}/${UUID_A}.mp4`)).toEqual({ kind: "raw", propertyId: null });
  });
});

describe("propertyIdsInFiles", () => {
  it("собирает propertyId только там, где имя его несёт", () => {
    const files: FoundFile[] = [
      { area: "handoff", relPath: `${UUID_A}-${NEW_TS}.mp4`, sizeBytes: 1, mtimeMs: 0 },
      { area: "handoff", relPath: `montajer-${randomUUID()}.mp4`, sizeBytes: 1, mtimeMs: 0 },
      { area: "clips", relPath: `${randomUUID()}.mp4`, sizeBytes: 1, mtimeMs: 0 },
      { area: "raw", relPath: `${UUID_A}/${randomUUID()}.mp4`, sizeBytes: 1, mtimeMs: 0 },
    ];
    expect(propertyIdsInFiles(files)).toEqual([UUID_A]);
  });
});

describe("legacyHandoffCoverPath", () => {
  it("строит имя старой кадр-обложки рядом с финалом, без расширения финала", () => {
    const finalPublicPath = `/uploads/handoff/${UUID_A}-${NEW_TS}.mp4`;
    const got = legacyHandoffCoverPath(finalPublicPath);
    expect(path.basename(got)).toBe(`${UUID_A}-${NEW_TS}-cover.jpg`);
  });
});

describe("propertyOwnedFilePaths", () => {
  it("финал + старая обложка + обе обложки ChatGPT, если имя проходит белый список", () => {
    const paths = propertyOwnedFilePaths({
      videoHandoffFinalPath: `/uploads/handoff/${UUID_A}-${NEW_TS}.mp4`,
      socialCoverSquareUrl: `/uploads/covers/${UUID_A}-abc-square.jpg`,
      socialCoverStoryUrl: `/uploads/covers/${UUID_A}-abc-story.jpg`,
    });
    expect(paths.map((p) => path.basename(p)).sort()).toEqual(
      [`${UUID_A}-${NEW_TS}.mp4`, `${UUID_A}-${NEW_TS}-cover.jpg`, `${UUID_A}-abc-square.jpg`, `${UUID_A}-abc-story.jpg`].sort()
    );
  });

  it("чужую обложку (имя мимо белого списка) не отдаёт — битая/кривая ссылка не должна сносить чужой файл", () => {
    const paths = propertyOwnedFilePaths({
      videoHandoffFinalPath: null,
      socialCoverSquareUrl: "/uploads/covers/cover-deadbeef.jpg",
      socialCoverStoryUrl: null,
    });
    expect(paths).toEqual([]);
  });

  it("без финала — пусто (не рисует несуществующие пути)", () => {
    expect(propertyOwnedFilePaths({ videoHandoffFinalPath: null, socialCoverSquareUrl: null, socialCoverStoryUrl: null })).toEqual([]);
  });
});

describe("isDiskCleanupDryRun", () => {
  it.each([
    [{}, true],
    [{ DISK_CLEANUP_DRY_RUN: "1" }, true],
    [{ DISK_CLEANUP_DRY_RUN: "0" }, false],
    [{ DISK_CLEANUP_DRY_RUN: "false" }, false],
    [{ DISK_CLEANUP_DRY_RUN: "anything-else" }, true],
  ])("%j -> %s", (env, expected) => {
    expect(isDiskCleanupDryRun(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("diskCleanupSummary", () => {
  it("боевой прогон", () => {
    const text = diskCleanupSummary({
      dryRun: false,
      files: 12,
      bytes: 340.5 * 1024 * 1024,
      byReason: { "заменённый финал": 3, "заменённая обложка": 8, "объект удалён навсегда": 1 },
      unknown: 0,
      failed: 0,
    });
    expect(text).toBe("Уборка диска: удалено 12 файлов, 340.5 МБ (заменённый финал 3, заменённая обложка 8, объект удалён навсегда 1)");
  });

  it("пробный прогон и неизвестные имена хвостом", () => {
    const text = diskCleanupSummary({
      dryRun: true,
      files: 12,
      bytes: 340.5 * 1024 * 1024,
      byReason: { "заменённый финал": 3, "заменённая обложка": 8, "объект удалён навсегда": 1 },
      unknown: 4,
      failed: 0,
    });
    expect(text).toBe(
      "Уборка диска (пробный прогон, ничего не удалено): удалилось бы 12 файлов, 340.5 МБ (заменённый финал 3, заменённая обложка 8, объект удалён навсегда 1), неизвестных имён пропущено: 4"
    );
  });
});

describe("planDiskCleanup — правила по одному", () => {
  const NOW = 2_000_000_000_000; // произвольная опорная точка
  const OLD_MTIME = NOW - DISK_CLEANUP_MIN_AGE_MS - 1000; // старше суток
  const YOUNG_MTIME = NOW - 1000; // моложе суток

  function emptyFacts(): CleanupFacts {
    return { properties: new Map(), clipRefs: new Set(), rawRefs: new Set() };
  }

  it("правило 1 — моложе суток остаётся, даже если во всём остальном мусор", () => {
    const file: FoundFile = { area: "handoff", relPath: `montajer-${randomUUID()}.mp4`, sizeBytes: 10, mtimeMs: YOUNG_MTIME };
    expect(planDiskCleanup([file], emptyFacts(), NOW)).toEqual([]);
  });

  it("правило 2 — неизвестное имя остаётся", () => {
    const file: FoundFile = { area: "covers", relPath: "cover-deadbeef.jpg", sizeBytes: 10, mtimeMs: OLD_MTIME };
    expect(planDiskCleanup([file], emptyFacts(), NOW)).toEqual([]);
  });

  it("правило 3 — объект в Корзине: файл остаётся, даже если он давно заменён", () => {
    const file: FoundFile = { area: "handoff", relPath: `${UUID_A}-${OLD_TS}.mp4`, sizeBytes: 10, mtimeMs: OLD_MTIME };
    const facts: CleanupFacts = {
      properties: new Map([[UUID_A, { trashed: true, finalPath: `/uploads/handoff/${UUID_A}-${NEW_TS}.mp4`, coverSquareUrl: null, coverStoryUrl: null }]]),
      clipRefs: new Set(),
      rawRefs: new Set(),
    };
    expect(planDiskCleanup([file], facts, NOW)).toEqual([]);
  });

  it("правило 4 — propertyId есть, объекта в базе нет вовсе: удалить", () => {
    const file: FoundFile = { area: "handoff", relPath: `${UUID_A}-${OLD_TS}.mp4`, sizeBytes: 10, mtimeMs: OLD_MTIME };
    const out = planDiskCleanup([file], emptyFacts(), NOW);
    expect(out).toEqual([{ ...file, reason: "объект удалён навсегда" }]);
  });

  describe("правило 5 — живой объект", () => {
    const liveFacts = (over: Partial<PropertyFileFacts> = {}): CleanupFacts => ({
      properties: new Map([
        [UUID_A, { trashed: false, finalPath: `/uploads/handoff/${UUID_A}-${NEW_TS}.mp4`, coverSquareUrl: `/uploads/covers/${UUID_A}-abc-square.jpg`, coverStoryUrl: `/uploads/covers/${UUID_A}-abc-story.jpg`, ...over }],
      ]),
      clipRefs: new Set(),
      rawRefs: new Set(),
    });

    it("final — совпадает с текущим: остаётся", () => {
      const file: FoundFile = { area: "handoff", relPath: `${UUID_A}-${NEW_TS}.mp4`, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], liveFacts(), NOW)).toEqual([]);
    });

    it("final — расходится с текущим: заменённый финал", () => {
      const file: FoundFile = { area: "handoff", relPath: `${UUID_A}-${OLD_TS}.mp4`, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], liveFacts(), NOW)).toEqual([{ ...file, reason: "заменённый финал" }]);
    });

    it("legacyCover — база финала совпадает с текущим финалом: остаётся", () => {
      const file: FoundFile = { area: "handoff", relPath: `${UUID_A}-${NEW_TS}-cover.jpg`, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], liveFacts(), NOW)).toEqual([]);
    });

    it("legacyCover — база финала расходится: обложка старого ролика", () => {
      const file: FoundFile = { area: "handoff", relPath: `${UUID_A}-${OLD_TS}-cover.jpg`, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], liveFacts(), NOW)).toEqual([{ ...file, reason: "обложка старого ролика" }]);
    });

    it("storyPart — всегда временный файл истории", () => {
      const file: FoundFile = { area: "handoff", relPath: `${UUID_A}-${NEW_TS}-story-1.mp4`, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], liveFacts(), NOW)).toEqual([{ ...file, reason: "временный файл истории" }]);
    });

    it("storyCard — всегда временный файл истории", () => {
      const file: FoundFile = { area: "handoff", relPath: `${UUID_A}-exterior-${NEW_TS}.jpg`, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], liveFacts(), NOW)).toEqual([{ ...file, reason: "временный файл истории" }]);
    });

    it("propertyCover — совпадает с square или story: остаётся", () => {
      const square: FoundFile = { area: "covers", relPath: `${UUID_A}-abc-square.jpg`, sizeBytes: 10, mtimeMs: OLD_MTIME };
      const story: FoundFile = { area: "covers", relPath: `${UUID_A}-abc-story.jpg`, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([square, story], liveFacts(), NOW)).toEqual([]);
    });

    it("propertyCover — расходится с обеими: заменённая обложка", () => {
      const file: FoundFile = { area: "covers", relPath: `${UUID_A}-old-square.jpg`, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], liveFacts(), NOW)).toEqual([{ ...file, reason: "заменённая обложка" }]);
    });
  });

  it("правило 6 — временная копия бота удаляется всегда", () => {
    const file: FoundFile = { area: "handoff", relPath: `montajer-${UUID_A}.mp4`, sizeBytes: 10, mtimeMs: OLD_MTIME };
    expect(planDiskCleanup([file], emptyFacts(), NOW)).toEqual([{ ...file, reason: "временная копия бота" }]);
  });

  describe("правило 7 — клипы карточки", () => {
    it("clipOutput без ссылки — удалить", () => {
      const name = `${randomUUID()}.mp4`;
      const file: FoundFile = { area: "clips", relPath: name, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], emptyFacts(), NOW)).toEqual([{ ...file, reason: "клип без ссылки" }]);
    });

    it("clipOutput со ссылкой — остаётся", () => {
      const name = `${randomUUID()}.mp4`;
      const file: FoundFile = { area: "clips", relPath: name, sizeBytes: 10, mtimeMs: OLD_MTIME };
      const facts: CleanupFacts = { properties: new Map(), clipRefs: new Set([name]), rawRefs: new Set() };
      expect(planDiskCleanup([file], facts, NOW)).toEqual([]);
    });

    it("clipIncoming без задания — брошенный исходник клипа", () => {
      const name = `incoming-${randomUUID()}`;
      const file: FoundFile = { area: "clips", relPath: name, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], emptyFacts(), NOW)).toEqual([{ ...file, reason: "брошенный исходник клипа" }]);
    });

    it("clipIncoming с ждущим заданием — остаётся", () => {
      const name = `incoming-${randomUUID()}`;
      const file: FoundFile = { area: "clips", relPath: name, sizeBytes: 10, mtimeMs: OLD_MTIME };
      const facts: CleanupFacts = { properties: new Map(), clipRefs: new Set([name]), rawRefs: new Set() };
      expect(planDiskCleanup([file], facts, NOW)).toEqual([]);
    });
  });

  describe("правило 8 — сырые исходники", () => {
    it("без записи в базе — удалить", () => {
      const rel = `${randomUUID()}/${randomUUID()}.mp4`;
      const file: FoundFile = { area: "raw", relPath: rel, sizeBytes: 10, mtimeMs: OLD_MTIME };
      expect(planDiskCleanup([file], emptyFacts(), NOW)).toEqual([{ ...file, reason: "исходник без записи" }]);
    });

    it("с записью в базе — остаётся", () => {
      const rel = `${randomUUID()}/${randomUUID()}.mp4`;
      const file: FoundFile = { area: "raw", relPath: rel, sizeBytes: 10, mtimeMs: OLD_MTIME };
      const facts: CleanupFacts = { properties: new Map(), clipRefs: new Set(), rawRefs: new Set([rel]) };
      expect(planDiskCleanup([file], facts, NOW)).toEqual([]);
    });
  });

  it("обрезает итог до DISK_CLEANUP_MAX_FILES_PER_RUN — остаток идёт следующей ночью", () => {
    const files: FoundFile[] = Array.from({ length: DISK_CLEANUP_MAX_FILES_PER_RUN + 25 }, () => ({
      area: "handoff" as const,
      relPath: `montajer-${randomUUID()}.mp4`,
      sizeBytes: 1,
      mtimeMs: OLD_MTIME,
    }));
    const out = planDiskCleanup(files, emptyFacts(), NOW);
    expect(out.length).toBe(DISK_CLEANUP_MAX_FILES_PER_RUN);
  });
});

describe("runDiskCleanup — интеграция на временных каталогах и своей базе", () => {
  const runId = Date.now();
  const oldMtime = new Date(Date.now() - 48 * 60 * 60 * 1000);

  let handoffDir = "";
  let coversDir = "";
  let clipsDir = "";
  let rawDir = "";

  let districtId = "";
  let agentId = "";
  let liveId = "";
  let trashedId = "";
  const orphanId = randomUUID(); // без строки в базе вовсе
  const freshOrphanId = randomUUID(); // без строки, но файл свежий — должен уцелеть

  const clipRefUuid = randomUUID();
  const clipOrphanUuid = randomUUID();
  const pendingInputUuid = randomUUID();
  const pendingOutputUuid = randomUUID();
  const abandonedIncomingUuid = randomUUID();

  const rawKeptKey = `${randomUUID()}/${randomUUID()}.mp4`;
  const rawOrphanKey = `${randomUUID()}/${randomUUID()}.mp4`;

  const propertyIds: string[] = [];
  let jobId = "";

  async function writeFile(dir: string, name: string, fresh = false): Promise<string> {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, `тестовый файл ${name}`);
    if (!fresh) await fs.utimes(full, oldMtime, oldMtime);
    return full;
  }

  beforeAll(async () => {
    handoffDir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-handoff-"));
    coversDir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-covers-"));
    clipsDir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-clips-"));
    rawDir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-raw-"));

    districtId = (await prisma.district.create({ data: { name: `Уборка диска ${runId}` } })).id;
    const agent = await prisma.agent.create({
      data: { fullName: `Агент уборки ${runId}`, phone: `+992944${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
    });
    agentId = agent.id;

    const live = await prisma.property.create({
      data: {
        title: `Живой объект ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 50000,
        currency: "USD",
        districtId,
        address: `Тест ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        videoHandoffFinalPath: `/uploads/handoff/${randomUUID()}-placeholder.mp4`, // переопределим ниже настоящим id
        clipVideoUrl: `/uploads/video/${clipRefUuid}.mp4`,
        clipVideoStatus: "READY",
      },
    });
    liveId = live.id;
    propertyIds.push(liveId);

    const trashed = await prisma.property.create({
      data: {
        title: `Объект в Корзине ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 40000,
        currency: "USD",
        districtId,
        address: `Тест-корзина ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        deletedAt: new Date(),
      },
    });
    trashedId = trashed.id;
    propertyIds.push(trashedId);

    const finalName = `${liveId}-${runId}9.mp4`;
    const squareName = `${liveId}-cur-square.jpg`;
    const storyName = `${liveId}-cur-story.jpg`;
    await prisma.property.update({
      where: { id: liveId },
      data: {
        videoHandoffFinalPath: `/uploads/handoff/${finalName}`,
        socialCoverSquareUrl: `/uploads/covers/${squareName}`,
        socialCoverStoryUrl: `/uploads/covers/${storyName}`,
      },
    });

    await prisma.propertyVideo.create({
      data: { propertyId: liveId, storageKey: rawKeptKey, filename: "raw.mp4", sizeBytes: 1, uploadedById: agentId },
    });

    const job = await prisma.backgroundJob.create({
      data: {
        type: "clip-compress",
        status: "PENDING",
        maxAttempts: 2,
        payload: { propertyId: liveId, inputFilename: `incoming-${pendingInputUuid}`, outputFilename: `${pendingOutputUuid}.mp4`, previousUrl: null, sizeBytes: 1, durationSec: 5 },
      },
    });
    jobId = job.id;

    // ===== handoff =====
    await writeFile(handoffDir, `${liveId}-${runId}1.mp4`); // старый финал L — заменён
    await writeFile(handoffDir, finalName); // текущий финал L — цел
    await writeFile(handoffDir, `${liveId}-${runId}1-cover.jpg`); // старая кадр-обложка старого финала — мусор
    await writeFile(handoffDir, `${finalName.replace(/\.mp4$/, "")}-story-1.mp4`); // часть истории — всегда мусор
    await writeFile(handoffDir, `${liveId}-exterior-${runId}9.jpg`); // картинка истории — всегда мусор
    await writeFile(handoffDir, `montajer-${randomUUID()}.mp4`); // временная копия бота — всегда мусор
    await writeFile(handoffDir, `${orphanId}-${runId}1.mp4`); // объект удалён навсегда
    await writeFile(handoffDir, `${trashedId}-${runId}1.mp4`); // Корзина — не трогать
    await writeFile(handoffDir, `${trashedId}-${runId}1-cover.jpg`); // Корзина — не трогать
    await writeFile(handoffDir, "readme.txt"); // неизвестное имя — не трогать

    // ===== covers =====
    await writeFile(coversDir, `${liveId}-old-square.jpg`); // заменённая обложка
    await writeFile(coversDir, squareName); // текущая — цела
    await writeFile(coversDir, storyName); // текущая — цела
    await writeFile(coversDir, `${orphanId}-x-square.jpg`); // объект удалён навсегда
    await writeFile(coversDir, `${trashedId}-old-square.jpg`); // Корзина — не трогать
    await writeFile(coversDir, `cover-${runId}deadbeef.jpg`); // чужой файл (статья сайта) — не трогать
    await writeFile(coversDir, `${freshOrphanId}-x-square.jpg`, true); // свежий сирота — не трогать (моложе суток)

    // ===== clips =====
    await writeFile(clipsDir, `${clipRefUuid}.mp4`); // на него ссылается Property.clipVideoUrl — цел
    await writeFile(clipsDir, `${clipOrphanUuid}.mp4`); // ссылки нет — мусор
    await writeFile(clipsDir, `incoming-${pendingInputUuid}`); // ждёт задание — цел
    await writeFile(clipsDir, `${pendingOutputUuid}.mp4`); // выход того же задания — цел
    await writeFile(clipsDir, `incoming-${abandonedIncomingUuid}`); // брошен — мусор

    // ===== raw =====
    await writeFile(rawDir, rawKeptKey); // есть PropertyVideo — цел
    await writeFile(rawDir, rawOrphanKey); // записи нет — мусор
  });

  afterAll(async () => {
    await prisma.backgroundJob.deleteMany({ where: { id: jobId } });
    await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.district.deleteMany({ where: { id: districtId } });
    await Promise.all([handoffDir, coversDir, clipsDir, rawDir].map((d) => fs.rm(d, { recursive: true, force: true })));
    await prisma.$disconnect();
  });

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  it("удаляет ровно ожидаемый набор мусора, остальное не трогает", async () => {
    const finalName = `${liveId}-${runId}9.mp4`;
    const squareName = `${liveId}-cur-square.jpg`;
    const storyName = `${liveId}-cur-story.jpg`;

    const result = await runDiskCleanup({
      dryRun: false,
      dirs: { handoff: handoffDir, covers: coversDir, clips: clipsDir, raw: rawDir },
    });

    expect(result.dryRun).toBe(false);
    expect(result.failed).toBe(0);
    // неизвестные: readme.txt (handoff) + cover-*.jpg (covers) = 2
    expect(result.unknown).toBe(2);

    // --- удалено ---
    expect(await exists(path.join(handoffDir, `${liveId}-${runId}1.mp4`))).toBe(false);
    expect(await exists(path.join(handoffDir, `${liveId}-${runId}1-cover.jpg`))).toBe(false);
    expect(await exists(path.join(handoffDir, `${finalName.replace(/\.mp4$/, "")}-story-1.mp4`))).toBe(false);
    expect(await exists(path.join(handoffDir, `${liveId}-exterior-${runId}9.jpg`))).toBe(false);
    expect(await exists(path.join(coversDir, `${liveId}-old-square.jpg`))).toBe(false);
    expect(await exists(path.join(handoffDir, `${orphanId}-${runId}1.mp4`))).toBe(false);
    expect(await exists(path.join(coversDir, `${orphanId}-x-square.jpg`))).toBe(false);
    expect(await exists(path.join(clipsDir, `${clipOrphanUuid}.mp4`))).toBe(false);
    expect(await exists(path.join(clipsDir, `incoming-${abandonedIncomingUuid}`))).toBe(false);
    expect(await exists(path.join(rawDir, rawOrphanKey))).toBe(false);
    // временная копия бота — было ровно одна, проверим по разбору причин ниже

    // --- цело: текущие файлы L ---
    expect(await exists(path.join(handoffDir, finalName))).toBe(true);
    expect(await exists(path.join(coversDir, squareName))).toBe(true);
    expect(await exists(path.join(coversDir, storyName))).toBe(true);

    // --- цело: ВСЕ файлы T (Корзина) ---
    expect(await exists(path.join(handoffDir, `${trashedId}-${runId}1.mp4`))).toBe(true);
    expect(await exists(path.join(handoffDir, `${trashedId}-${runId}1-cover.jpg`))).toBe(true);
    expect(await exists(path.join(coversDir, `${trashedId}-old-square.jpg`))).toBe(true);

    // --- цело: чужой файл, свежий сирота, неизвестное имя ---
    expect(await exists(path.join(coversDir, `cover-${runId}deadbeef.jpg`))).toBe(true);
    expect(await exists(path.join(coversDir, `${freshOrphanId}-x-square.jpg`))).toBe(true);
    expect(await exists(path.join(handoffDir, "readme.txt"))).toBe(true);

    // --- цело: ссылки живы ---
    expect(await exists(path.join(clipsDir, `${clipRefUuid}.mp4`))).toBe(true);
    expect(await exists(path.join(clipsDir, `incoming-${pendingInputUuid}`))).toBe(true);
    expect(await exists(path.join(clipsDir, `${pendingOutputUuid}.mp4`))).toBe(true);
    expect(await exists(path.join(rawDir, rawKeptKey))).toBe(true);

    expect(result.byReason["временная копия бота"]).toBe(1);
    expect(result.byReason["заменённый финал"]).toBe(1);
    expect(result.byReason["обложка старого ролика"]).toBe(1);
    expect(result.byReason["временный файл истории"]).toBe(2);
    expect(result.byReason["заменённая обложка"]).toBe(1);
    expect(result.byReason["объект удалён навсегда"]).toBe(2);
    expect(result.byReason["клип без ссылки"]).toBe(1);
    expect(result.byReason["брошенный исходник клипа"]).toBe(1);
    expect(result.byReason["исходник без записи"]).toBe(1);
  });
});

describe("runDiskCleanup — Корзина не трогается", () => {
  const runId = Date.now();
  const oldMtime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  let districtId = "";
  let trashedId = "";
  let dir = "";
  let coversD = "";
  let clipsD = "";
  let rawD = "";

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-trash-handoff-"));
    coversD = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-trash-covers-"));
    // Пустые, но ОТДЕЛЬНЫЕ каталоги — raw совпадает с любым именем (см.
    // classifyFileName), и если переиспользовать dir/coversD под него, те же
    // физические файлы попадут в обход ещё раз уже без защиты Корзины.
    clipsD = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-trash-clips-"));
    rawD = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-trash-raw-"));
    districtId = (await prisma.district.create({ data: { name: `Уборка-Корзина ${runId}` } })).id;
    const trashed = await prisma.property.create({
      data: {
        title: `Объект в Корзине (уборка) ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 40000,
        currency: "USD",
        districtId,
        address: `Тест-корзина-2 ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        deletedAt: new Date(),
      },
    });
    trashedId = trashed.id;

    // Все три файла давно заменены/устарели по содержимому базы — не будь
    // объект в Корзине, каждый ушёл бы своим правилом (rule 5). Trashed
    // коротким замыканием (rule 3) обязан оставить их на месте.
    const finalPath = path.join(dir, `${trashedId}-1800000000000.mp4`);
    await fs.writeFile(finalPath, "final");
    await fs.utimes(finalPath, oldMtime, oldMtime);
    const legacyCoverPath = path.join(dir, `${trashedId}-1800000000000-cover.jpg`);
    await fs.writeFile(legacyCoverPath, "cover");
    await fs.utimes(legacyCoverPath, oldMtime, oldMtime);
    const squarePath = path.join(coversD, `${trashedId}-x-square.jpg`);
    await fs.writeFile(squarePath, "square");
    await fs.utimes(squarePath, oldMtime, oldMtime);
  });

  afterAll(async () => {
    await prisma.property.deleteMany({ where: { id: trashedId } });
    await prisma.district.deleteMany({ where: { id: districtId } });
    await Promise.all([dir, coversD, clipsD, rawD].map((d) => fs.rm(d, { recursive: true, force: true })));
    await prisma.$disconnect();
  });

  it("настоящий прогон (dryRun: false) не удаляет ни один файл объекта в Корзине", async () => {
    const result = await runDiskCleanup({
      dryRun: false,
      dirs: { handoff: dir, covers: coversD, clips: clipsD, raw: rawD },
    });
    expect(result.failed).toBe(0);
    expect(await fs.access(path.join(dir, `${trashedId}-1800000000000.mp4`)).then(() => true, () => false)).toBe(true);
    expect(await fs.access(path.join(dir, `${trashedId}-1800000000000-cover.jpg`)).then(() => true, () => false)).toBe(true);
    expect(await fs.access(path.join(coversD, `${trashedId}-x-square.jpg`)).then(() => true, () => false)).toBe(true);
  });
});

describe("runDiskCleanup — пробный прогон", () => {
  const runId = Date.now();
  const oldMtime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  let districtId = "";
  let dir = "";
  let coversD = "";
  let clipsD = "";
  let rawD = "";
  const orphanId = randomUUID(); // без строки в базе — обычный прогон удалил бы файл

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-dryrun-handoff-"));
    coversD = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-dryrun-covers-"));
    clipsD = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-dryrun-clips-"));
    rawD = await fs.mkdtemp(path.join(os.tmpdir(), "rh-disk-cleanup-dryrun-raw-"));
    districtId = (await prisma.district.create({ data: { name: `Уборка-пробный ${runId}` } })).id;
    const orphanPath = path.join(dir, `${orphanId}-1800000000000.mp4`);
    await fs.writeFile(orphanPath, "final");
    await fs.utimes(orphanPath, oldMtime, oldMtime);
  });

  afterAll(async () => {
    await prisma.district.deleteMany({ where: { id: districtId } });
    await Promise.all([dir, coversD, clipsD, rawD].map((d) => fs.rm(d, { recursive: true, force: true })));
    await prisma.$disconnect();
  });

  it("считает так же, как настоящий прогон, но ничего не удаляет", async () => {
    const dirs = { handoff: dir, covers: coversD, clips: clipsD, raw: rawD };
    const dry = await runDiskCleanup({ dryRun: true, dirs });
    expect(dry.dryRun).toBe(true);
    expect(dry.files).toBe(1);
    expect(dry.byReason["объект удалён навсегда"]).toBe(1);
    expect(dry.bytes).toBeGreaterThan(0);
    // Файл цел — dry-run ничего не тронул на диске.
    expect(await fs.access(path.join(dir, `${orphanId}-1800000000000.mp4`)).then(() => true, () => false)).toBe(true);

    const real = await runDiskCleanup({ dryRun: false, dirs });
    expect(real.dryRun).toBe(false);
    expect(real.files).toBe(1);
    expect(await fs.access(path.join(dir, `${orphanId}-1800000000000.mp4`)).then(() => true, () => false)).toBe(false);
  });
});
