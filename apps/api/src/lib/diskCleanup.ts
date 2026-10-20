import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { videoHandoffDir, propertyCoversDir, clipVideoDir } from "../upload.js";

/**
 * УБОРКА ДИСКА (25.09.2026, спецификация docs/handoff-2026-09-25-montage-control-spec.md,
 * пачка 6 «Уборка», Б8). Владелец 14.09: «мусор копиться» не должен — диск VPS уже
 * был забит на 96% (см. docs/journal 24.09, «чистка анонимных docker-томов»).
 *
 * До этой правки на диске копились: старые обложки `-cover.jpg` (кадр-обложка
 * убран в #953, но старые файлы остались), заменённые финалы приёма ролика с
 * пересылки, недоделанные части историй, заменённые обложки ChatGPT, временные
 * копии бота-монтажёра, готовые/брошенные клипы карточки без ссылки в базе,
 * сырые исходники без записи PropertyVideo/PropertyDraftMedia/VideoUploadSession.
 * `DELETE /:id/permanent` (routes/properties/crud.ts) тоже не убирал финал и
 * обложки объекта — это чинит propertyOwnedFilePaths ниже, отдельным местом,
 * тем же экспортом, что и ночной крон.
 *
 * ЧУЖИЕ ФАЙЛЫ НЕ ТРОГАЕМ. `/uploads/covers` хранит не только обложки объектов
 * (`<uuid>-<base36>-square|story.jpg`, формат coverOpenAi.ts), но и обложки
 * статей сайта (`cover-<hex>.jpg`, routes/webhooks.ts) — ссылок на них в CRM
 * нет вообще, и правило «файл без ссылки — мусор» снесло бы их. Поэтому
 * `classifyFileName` — белый список по ИМЕНИ, а не чёрный по отсутствию ссылки:
 * неопознанное имя ВСЕГДА остаётся (считается в `unknown`, никогда не удаляется).
 *
 * КОРЗИНА НИКОГДА НЕ ТРОГАЕТСЯ. Объект в Корзине (deletedAt) восстановим —
 * его файлы, привязанные по propertyId, остаются на месте до решения «удалить
 * навсегда» (см. `DELETE /:id/permanent`, где эта же уборка становится
 * осознанной, а правило Корзины намеренно не действует).
 */

export const DISK_CLEANUP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const DISK_CLEANUP_MAX_FILES_PER_RUN = 5000;

export type CleanupArea = "handoff" | "covers" | "clips" | "raw";

export interface FoundFile {
  area: CleanupArea;
  /** Относительный путь ОТ каталога области, всегда с "/", даже на Windows
   *  (raw обходится рекурсивно, у остальных областей это просто имя файла). */
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface PropertyFileFacts {
  trashed: boolean;
  finalPath: string | null;
  coverSquareUrl: string | null;
  coverStoryUrl: string | null;
}

export interface CleanupFacts {
  properties: Map<string, PropertyFileFacts>;
  /** Имена файлов (basename), на которые ссылается Property.clipVideoUrl (в т.ч.
   *  в Корзине) или payload ждущего/выполняющегося задания clip-compress. */
  clipRefs: Set<string>;
  /** storageKey закрытого хранилища видео (PropertyVideo, PropertyDraftMedia,
   *  VideoUploadSession) — полный relPath области raw. */
  rawRefs: Set<string>;
}

export type FileKind =
  | "final"
  | "legacyCover"
  | "storyPart"
  | "storyCard"
  | "montajerTmp"
  | "propertyCover"
  | "clipOutput"
  | "clipIncoming"
  | "raw";

export interface CleanupCandidate extends FoundFile {
  reason: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const HANDOFF_PATTERNS: Array<{ re: RegExp; kind: FileKind }> = [
  // Порядок важен только для читаемости — паттерны взаимоисключающие по хвосту имени.
  { re: new RegExp(`^(${UUID})-(\\d{10,})(?:\\.[A-Za-z0-9]{1,5})?$`, "i"), kind: "final" },
  { re: new RegExp(`^(${UUID})-(\\d{10,})-cover\\.jpg$`, "i"), kind: "legacyCover" },
  { re: new RegExp(`^(${UUID})-(\\d{10,})-story-\\d+\\.mp4$`, "i"), kind: "storyPart" },
  { re: new RegExp(`^(${UUID})-([a-z_]+)-(\\d{10,})\\.jpg$`, "i"), kind: "storyCard" },
  { re: new RegExp(`^montajer-(${UUID})(?:\\.[A-Za-z0-9]{1,5})?$`, "i"), kind: "montajerTmp" },
];
const COVER_RE = new RegExp(`^(${UUID})-([0-9a-z]+)-(square|story)\\.jpg$`, "i");
const CLIP_OUTPUT_RE = new RegExp(`^${UUID}\\.mp4$`, "i");
const CLIP_INCOMING_RE = new RegExp(`^incoming-${UUID}$`, "i");

/** Белый список имён по области — null значит «неопознанное имя, не трогать
 *  никогда» (считается в DiskCleanupResult.unknown). raw совпадает всегда:
 *  ключи закрытого хранилища живут только в базе, и по имени файла ничего не
 *  разобрать (черновики не обязаны начинаться с id объекта). */
export function classifyFileName(area: CleanupArea, name: string): { kind: FileKind; propertyId: string | null } | null {
  if (area === "handoff") {
    for (const { re, kind } of HANDOFF_PATTERNS) {
      const m = name.match(re);
      if (m) return { kind, propertyId: kind === "montajerTmp" ? null : m[1] };
    }
    return null;
  }
  if (area === "covers") {
    const m = name.match(COVER_RE);
    if (m) return { kind: "propertyCover", propertyId: m[1] };
    return null;
  }
  if (area === "clips") {
    if (CLIP_OUTPUT_RE.test(name)) return { kind: "clipOutput", propertyId: null };
    if (CLIP_INCOMING_RE.test(name)) return { kind: "clipIncoming", propertyId: null };
    return null;
  }
  // area === "raw": любой файл — ключ закрытого хранилища, сверяется целиком
  // по relPath (не по имени) в planDiskCleanup, здесь всегда "известное" имя.
  return { kind: "raw", propertyId: null };
}

/** Различные propertyId, которые удалось разобрать из имён файлов — чтобы
 *  забрать факты о них из базы одним пакетным запросом (без N+1). */
export function propertyIdsInFiles(files: FoundFile[]): string[] {
  const ids = new Set<string>();
  for (const file of files) {
    const classified = classifyFileName(file.area, path.basename(file.relPath));
    if (classified?.propertyId) ids.add(classified.propertyId);
  }
  return [...ids];
}

/** Путь к старой обложке кадром финала (кадр-обложка убрана в #953, но старые
 *  файлы остались на проде) — имя было `<finalBase>-cover.jpg`. */
export function legacyHandoffCoverPath(finalPublicPath: string): string {
  const base = path.basename(finalPublicPath).replace(/\.[^./]+$/, "");
  return path.join(videoHandoffDir, `${base}-cover.jpg`);
}

/** Файлы объекта, которые обязаны уйти вместе с ним при удалении навсегда:
 *  финал приёма ролика, его старая кадр-обложка (если была) и обе обложки
 *  ChatGPT — обложку ТОЛЬКО если имя проходит белый список propertyCover
 *  (чужой файл по кривой/битой ссылке в базе так не удалить). */
export function propertyOwnedFilePaths(p: {
  videoHandoffFinalPath: string | null;
  socialCoverSquareUrl: string | null;
  socialCoverStoryUrl: string | null;
}): string[] {
  const paths: string[] = [];
  if (p.videoHandoffFinalPath) {
    paths.push(path.join(videoHandoffDir, path.basename(p.videoHandoffFinalPath)));
    paths.push(legacyHandoffCoverPath(p.videoHandoffFinalPath));
  }
  for (const coverUrl of [p.socialCoverSquareUrl, p.socialCoverStoryUrl]) {
    if (!coverUrl) continue;
    const name = path.basename(coverUrl);
    if (classifyFileName("covers", name)?.kind === "propertyCover") {
      paths.push(path.join(propertyCoversDir, name));
    }
  }
  return paths;
}

/** Пробный прогон по умолчанию — крон только считает, пока владелец не
 *  поставит DISK_CLEANUP_DRY_RUN=0 на проде (см. .env.production.example). */
export function isDiskCleanupDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DISK_CLEANUP_DRY_RUN;
  return raw !== "0" && raw !== "false";
}

/**
 * Правила по порядку — первое сработавшее решает судьбу файла:
 *  1. моложе DISK_CLEANUP_MIN_AGE_MS — не трогаем никогда.
 *  2. неопознанное имя — не трогаем никогда (см. classifyFileName).
 *  3. у файла есть propertyId, объект в Корзине — не трогаем (восстановим).
 *  4. у файла есть propertyId, объекта в базе нет вовсе — удалён навсегда.
 *  5. живой объект — сверка с текущими ссылками по виду файла.
 *  6. временная копия бота-монтажёра — всегда мусор.
 *  7. клип карточки без ссылки в базе/очереди — мусор.
 *  8. сырой исходник без записи в базе — мусор.
 * Итог обрезается до DISK_CLEANUP_MAX_FILES_PER_RUN — остаток берёт следующая ночь.
 */
export function planDiskCleanup(files: FoundFile[], facts: CleanupFacts, nowMs: number): CleanupCandidate[] {
  const candidates: CleanupCandidate[] = [];
  for (const file of files) {
    if (nowMs - file.mtimeMs < DISK_CLEANUP_MIN_AGE_MS) continue; // 1
    const name = path.basename(file.relPath);
    const classified = classifyFileName(file.area, name);
    if (!classified) continue; // 2
    const { kind, propertyId } = classified;

    if (propertyId) {
      const propFacts = facts.properties.get(propertyId);
      if (propFacts?.trashed) continue; // 3
      if (!propFacts) {
        candidates.push({ ...file, reason: "объект удалён навсегда" }); // 4
        continue;
      }
      // 5 — живой объект
      if (kind === "final") {
        const expectedName = propFacts.finalPath ? path.basename(propFacts.finalPath) : null;
        if (expectedName !== name) candidates.push({ ...file, reason: "заменённый финал" });
        continue;
      }
      if (kind === "legacyCover") {
        const ownBase = name.replace(/-cover\.jpg$/i, "");
        const expectedBase = propFacts.finalPath ? path.basename(propFacts.finalPath).replace(/\.[^./]+$/, "") : null;
        if (expectedBase !== ownBase) candidates.push({ ...file, reason: "обложка старого ролика" });
        continue;
      }
      if (kind === "storyPart" || kind === "storyCard") {
        candidates.push({ ...file, reason: "временный файл истории" });
        continue;
      }
      if (kind === "propertyCover") {
        const url = `/uploads/covers/${name}`;
        if (url !== propFacts.coverSquareUrl && url !== propFacts.coverStoryUrl) {
          candidates.push({ ...file, reason: "заменённая обложка" });
        }
        continue;
      }
      continue;
    }

    // без propertyId
    if (kind === "montajerTmp") {
      candidates.push({ ...file, reason: "временная копия бота" }); // 6
      continue;
    }
    if (kind === "clipOutput") {
      if (!facts.clipRefs.has(name)) candidates.push({ ...file, reason: "клип без ссылки" }); // 7
      continue;
    }
    if (kind === "clipIncoming") {
      if (!facts.clipRefs.has(name)) candidates.push({ ...file, reason: "брошенный исходник клипа" }); // 7
      continue;
    }
    if (kind === "raw") {
      if (!facts.rawRefs.has(file.relPath)) candidates.push({ ...file, reason: "исходник без записи" }); // 8
      continue;
    }
  }
  return candidates.slice(0, DISK_CLEANUP_MAX_FILES_PER_RUN);
}

async function listShallow(area: CleanupArea, dir: string): Promise<FoundFile[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // отсутствующий каталог = пусто
  }
  const result: FoundFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(full);
      result.push({ area, relPath: entry.name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // файл исчез между readdir и stat — не наш мусор, пропускаем молча
    }
  }
  return result;
}

async function listRecursive(area: CleanupArea, rootDir: string): Promise<FoundFile[]> {
  const result: FoundFile[] = [];
  async function walk(currentDir: string, relPrefix: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // отсутствующий каталог = пусто
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(full);
        result.push({ area, relPath: rel, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // файл исчез между readdir и stat
      }
    }
  }
  await walk(rootDir, "");
  return result;
}

function candidateFsPath(dirs: Record<CleanupArea, string>, candidate: CleanupCandidate): string {
  return path.join(dirs[candidate.area], ...candidate.relPath.split("/"));
}

export interface DiskCleanupResult {
  dryRun: boolean;
  files: number;
  bytes: number;
  byReason: Record<string, number>;
  unknown: number;
  failed: number;
}

/** Один ночной прогон: обходит четыре области, собирает факты из базы одним
 *  пакетным запросом на propertyId (без N+1), решает судьбу planDiskCleanup'ом
 *  и — если не dry-run — удаляет. Ничего не бросает наружу: ошибка удаления
 *  отдельного файла считается в `failed` и не останавливает прогон. */
export async function runDiskCleanup(
  opts: { dryRun?: boolean; now?: number; dirs?: Partial<Record<CleanupArea, string>> } = {}
): Promise<DiskCleanupResult> {
  const dryRun = opts.dryRun ?? isDiskCleanupDryRun();
  const nowMs = opts.now ?? Date.now();
  // ТОЛЬКО внутри функции, не на верхнем уровне модуля — тесты мокают
  // localVideoStorage.js без этого поля, а обходить закрытое хранилище нужно
  // не в каждом тесте, только когда runDiskCleanup реально вызван.
  const { videoStorageDir } = await import("./localVideoStorage.js");
  const dirs: Record<CleanupArea, string> = {
    handoff: opts.dirs?.handoff ?? videoHandoffDir,
    covers: opts.dirs?.covers ?? propertyCoversDir,
    clips: opts.dirs?.clips ?? clipVideoDir,
    raw: opts.dirs?.raw ?? videoStorageDir,
  };

  const files: FoundFile[] = [];
  files.push(...(await listShallow("handoff", dirs.handoff)));
  files.push(...(await listShallow("covers", dirs.covers)));
  files.push(...(await listShallow("clips", dirs.clips)));
  files.push(...(await listRecursive("raw", dirs.raw)));

  const propertyIds = propertyIdsInFiles(files);
  const properties = new Map<string, PropertyFileFacts>();
  for (let i = 0; i < propertyIds.length; i += 1000) {
    const batch = propertyIds.slice(i, i + 1000);
    const rows = await prisma.property.findMany({
      where: { id: { in: batch } },
      select: { id: true, deletedAt: true, videoHandoffFinalPath: true, socialCoverSquareUrl: true, socialCoverStoryUrl: true },
    });
    for (const row of rows) {
      properties.set(row.id, {
        trashed: row.deletedAt !== null,
        finalPath: row.videoHandoffFinalPath,
        coverSquareUrl: row.socialCoverSquareUrl,
        coverStoryUrl: row.socialCoverStoryUrl,
      });
    }
  }

  const clipRefs = new Set<string>();
  const clipUrlRows = await prisma.property.findMany({
    where: { clipVideoUrl: { not: null } },
    select: { clipVideoUrl: true },
  });
  for (const row of clipUrlRows) {
    if (row.clipVideoUrl) clipRefs.add(path.basename(row.clipVideoUrl));
  }
  const pendingClipJobs = await prisma.backgroundJob.findMany({
    where: { type: "clip-compress", status: { in: ["PENDING", "RUNNING"] } },
    select: { payload: true },
  });
  for (const job of pendingClipJobs) {
    const payload = job.payload as { inputFilename?: unknown; outputFilename?: unknown } | null;
    if (typeof payload?.inputFilename === "string") clipRefs.add(payload.inputFilename);
    if (typeof payload?.outputFilename === "string") clipRefs.add(payload.outputFilename);
  }

  const rawRefs = new Set<string>();
  const videoRows = await prisma.propertyVideo.findMany({ select: { storageKey: true } });
  for (const row of videoRows) rawRefs.add(row.storageKey);
  const draftRows = await prisma.propertyDraftMedia.findMany({
    where: { storageKey: { not: null } },
    select: { storageKey: true },
  });
  for (const row of draftRows) if (row.storageKey) rawRefs.add(row.storageKey);
  const sessionRows = await prisma.videoUploadSession.findMany({ select: { storageKey: true } });
  for (const row of sessionRows) rawRefs.add(row.storageKey);

  const facts: CleanupFacts = { properties, clipRefs, rawRefs };
  const candidates = planDiskCleanup(files, facts, nowMs);

  let unknown = 0;
  for (const file of files) {
    if (nowMs - file.mtimeMs < DISK_CLEANUP_MIN_AGE_MS) continue;
    if (!classifyFileName(file.area, path.basename(file.relPath))) unknown++;
  }

  const result: DiskCleanupResult = { dryRun, files: 0, bytes: 0, byReason: {}, unknown, failed: 0 };
  for (const candidate of candidates) {
    result.files++;
    result.bytes += candidate.sizeBytes;
    result.byReason[candidate.reason] = (result.byReason[candidate.reason] ?? 0) + 1;
    if (dryRun) continue;
    try {
      await fs.rm(candidateFsPath(dirs, candidate), { force: true });
    } catch {
      result.failed++;
    }
  }
  if (!dryRun && result.failed > 0) {
    void logSystemError("storage", `Уборка диска: ${result.failed} файлов не удалось удалить`);
  }
  return result;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function diskCleanupSummary(r: DiskCleanupResult): string {
  const reasonsText = Object.entries(r.byReason)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  const head = r.dryRun
    ? `Уборка диска (пробный прогон, ничего не удалено): удалилось бы ${r.files} файлов, ${formatMb(r.bytes)} МБ`
    : `Уборка диска: удалено ${r.files} файлов, ${formatMb(r.bytes)} МБ`;
  const withReasons = reasonsText ? `${head} (${reasonsText})` : head;
  return r.unknown > 0 ? `${withReasons}, неизвестных имён пропущено: ${r.unknown}` : withReasons;
}
