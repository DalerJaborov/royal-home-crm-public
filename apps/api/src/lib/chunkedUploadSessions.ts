import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_PART_BYTES } from "@royal-home/shared";
import {
  abortLocalUploadSession,
  completeLocalUploadSessionToPath,
  createLocalUploadSession,
  listLocalUploadParts,
  listLocalUploadSessionIds,
  localUploadSessionDir,
  readLocalUploadSessionMeta,
  writeLocalUploadPart,
  writeLocalUploadSessionMeta,
} from "./localVideoStorage.js";
import { videoTmpDir } from "../upload.js";

/**
 * ОБЩЕЕ ЯДРО ЗАГРУЗКИ ЧАСТЯМИ БЕЗ ЗАПИСИ В БАЗЕ (17.11.2026, класс «большой файл одним
 * запросом → 413 от прокси»).
 *
 * Одним запросом файл крупнее ~90 МБ не доходит до API: Cloudflare и прокси перед сервером
 * режут тело (packages/shared/src/uploadLimits.ts, PROXY_SINGLE_REQUEST_MAX_BYTES). Поэтому
 * файл режется на части по 8 МБ: старт → части (повтор той же части просто перезаписывает
 * файл) → сборка во временный файл, который забирает маршрут своего назначения.
 *
 * Здесь — только механика сессии; что делать с собранным файлом, решает маршрут сборки
 * (свободный ролик, ролик карточки объекта, файл в переписку). Ролики объектов едут своими
 * сессиями с записью в базе (routes/properties/videos.ts) — у них докачка между вкладками
 * и уборка по базе; здесь план сессии лежит файлом meta.json рядом с частями.
 *
 * Диск не бесконечен (ревью #254): у сотрудника не больше MAX_SESSIONS_PER_AGENT открытых
 * сессий — новая вытесняет самую давно не двигавшуюся; сессия без новой части дольше
 * SESSION_IDLE_TTL_MS считается брошенной и убирается при следующем старте и кроном
 * (sweepStaleChunkedUploads, cron.ts).
 */

export const MAX_SESSIONS_PER_AGENT = 3;
/** Брошенная сессия — без новой части два часа. */
export const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/** Замок сборки старше этого — след упавшего процесса, его можно перехватить. */
const STALE_LOCK_MS = 15 * 60 * 1000;
const LOCK_FILE = "assemble.lock";

export class ChunkedUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Машинный код: PARTS_MISSING — не все части; ASSEMBLING — сборка уже идёт. */
    readonly code?: string,
    readonly extra?: Record<string, unknown>
  ) {
    super(message);
  }
}

/** Тело ответа на ошибку ядра — одно для всех маршрутов. */
export function chunkedUploadErrorBody(err: ChunkedUploadError): Record<string, unknown> {
  return { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.extra ?? {}) };
}

export interface ChunkedUploadMeta {
  /** Назначение: "social", "clip-video", "conversation-media"… Сборка сверяет его. */
  kind: string;
  agentId: string;
  filename: string;
  sizeBytes: number;
  contentType: string | null;
  partSize: number;
  totalParts: number;
  createdAt: string;
  /** Время последней принятой части (или старта) — по нему считается «брошена». */
  touchedAt?: string;
}

function isChunkedMeta(v: unknown): v is ChunkedUploadMeta {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return typeof m.kind === "string" && typeof m.agentId === "string" && typeof m.totalParts === "number";
}

function lastActivity(meta: ChunkedUploadMeta): number {
  return Date.parse(meta.touchedAt ?? meta.createdAt);
}

async function listSessions(): Promise<Array<{ id: string; meta: ChunkedUploadMeta }>> {
  const out: Array<{ id: string; meta: ChunkedUploadMeta }> = [];
  for (const id of await listLocalUploadSessionIds()) {
    const meta = await readLocalUploadSessionMeta(id);
    // Сессии роликов объектов (без meta.json) убирает их собственная уборка по базе — не трогаем.
    if (isChunkedMeta(meta)) out.push({ id, meta });
  }
  return out;
}

/** Уборка брошенных сессий (крон и каждый старт). Возвращает число убранных. */
export async function sweepStaleChunkedUploads(now = Date.now()): Promise<number> {
  let removed = 0;
  for (const { id, meta } of await listSessions()) {
    if (now - lastActivity(meta) > SESSION_IDLE_TTL_MS && (await abortLocalUploadSession(id))) removed++;
  }
  return removed;
}

/** Не больше MAX_SESSIONS_PER_AGENT открытых у сотрудника: лишние — самые давно не двигавшиеся. */
async function enforceAgentCap(agentId: string): Promise<void> {
  const own = (await listSessions())
    .filter((s) => s.meta.agentId === agentId)
    .sort((a, b) => lastActivity(a.meta) - lastActivity(b.meta));
  // Место под новую сессию: оставляем MAX − 1 самых свежих.
  for (const s of own.slice(0, Math.max(0, own.length - (MAX_SESSIONS_PER_AGENT - 1)))) {
    await abortLocalUploadSession(s.id);
  }
}

export interface StartChunkedUploadInput {
  kind: string;
  agentId: string;
  filename: string;
  sizeBytes: number;
  contentType?: string | null;
  maxBytes: number;
  /** Текст отказа, если файл больше `maxBytes`. */
  tooLargeMessage: string;
}

export async function startChunkedUpload(
  input: StartChunkedUploadInput
): Promise<{ sessionId: string; partSize: number; totalParts: number }> {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new ChunkedUploadError("Пустой файл", 400);
  }
  if (input.sizeBytes > input.maxBytes) throw new ChunkedUploadError(input.tooLargeMessage, 413);
  await sweepStaleChunkedUploads().catch(() => 0);
  await enforceAgentCap(input.agentId);
  const sessionId = randomUUID();
  const partSize = UPLOAD_PART_BYTES;
  const totalParts = Math.max(1, Math.ceil(input.sizeBytes / partSize));
  await createLocalUploadSession(sessionId);
  const now = new Date().toISOString();
  const meta: ChunkedUploadMeta = {
    kind: input.kind,
    agentId: input.agentId,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    contentType: input.contentType ?? null,
    partSize,
    totalParts,
    createdAt: now,
    touchedAt: now,
  };
  await writeLocalUploadSessionMeta(sessionId, meta);
  return { sessionId, partSize, totalParts };
}

/** Сессия этого сотрудника (и этого назначения, если оно задано), иначе 404 — чужую не видно. */
async function ownSession(sessionId: string, agentId: string, kind?: string): Promise<ChunkedUploadMeta> {
  const meta = await readLocalUploadSessionMeta(sessionId);
  if (!isChunkedMeta(meta) || meta.agentId !== agentId || (kind !== undefined && meta.kind !== kind)) {
    throw new ChunkedUploadError("Загрузка не найдена — выберите файл ещё раз", 404);
  }
  return meta;
}

/** Назначение сессии (без проверки владельца) — общему маршруту частей нужно знать, чья она. */
export async function chunkedUploadKind(sessionId: string): Promise<string | null> {
  const meta = await readLocalUploadSessionMeta(sessionId);
  return isChunkedMeta(meta) ? meta.kind : null;
}

/** Состояние своей сессии для докачки: план и уже принятые части. */
export async function chunkedUploadStatus(
  sessionId: string,
  agentId: string
): Promise<{ sessionId: string; kind: string; partSize: number; totalParts: number; uploadedPartNumbers: number[] }> {
  const meta = await ownSession(sessionId, agentId);
  return {
    sessionId,
    kind: meta.kind,
    partSize: meta.partSize,
    totalParts: meta.totalParts,
    uploadedPartNumbers: await listLocalUploadParts(sessionId),
  };
}

export async function writeChunkedUploadPart(input: {
  kind: string;
  sessionId: string;
  agentId: string;
  partNumber: number;
  body: Buffer;
}): Promise<void> {
  const meta = await ownSession(input.sessionId, input.agentId, input.kind);
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > meta.totalParts) {
    throw new ChunkedUploadError("Неверный номер части", 400);
  }
  if (input.body.length === 0) throw new ChunkedUploadError("Пустая часть", 400);
  const expected =
    input.partNumber === meta.totalParts ? meta.sizeBytes - meta.partSize * (meta.totalParts - 1) : meta.partSize;
  if (input.body.length !== expected) {
    throw new ChunkedUploadError("Размер части не совпадает с планом загрузки", 400);
  }
  // Повтор той же части просто перезаписывает файл — клиент может смело повторять.
  await writeLocalUploadPart(input.sessionId, input.partNumber, input.body);
  await writeLocalUploadSessionMeta(input.sessionId, { ...meta, touchedAt: new Date().toISOString() });
}

/**
 * Замок сборки: файл создаётся атомарно (`wx`), второй одновременный /complete получает
 * 409 «уже собирается», а не склеивает те же части во второй файл. Замок старше
 * STALE_LOCK_MS — след упавшего процесса, его перехватываем.
 */
async function lockAssembly(sessionId: string): Promise<string> {
  const dir = localUploadSessionDir(sessionId);
  if (!dir) throw new ChunkedUploadError("Загрузка не найдена — выберите файл ещё раз", 404);
  const lockPath = path.join(dir, LOCK_FILE);
  try {
    await (await fs.promises.open(lockPath, "wx")).close();
    return lockPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const stat = await fs.promises.stat(lockPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      await fs.promises.utimes(lockPath, new Date(), new Date());
      return lockPath;
    }
    throw new ChunkedUploadError("Файл уже собирается — подождите", 409, "ASSEMBLING");
  }
}

/**
 * Склеивает части во временный файл (videoTmpDir) и отдаёт его путь. Временный файл —
 * забота вызывающего: он обязан убрать его в любом исходе. Сессия после сборки удаляется;
 * при сбое склейки части остаются, замок снимается, недосклеенный файл удаляется — повтор
 * сборки не требует загружать файл заново.
 */
export async function assembleChunkedUpload(input: {
  kind: string;
  sessionId: string;
  agentId: string;
}): Promise<{ tmpPath: string; originalName: string; sizeBytes: number; contentType: string | null }> {
  const meta = await ownSession(input.sessionId, input.agentId, input.kind);
  const have = await listLocalUploadParts(input.sessionId);
  if (have.length !== meta.totalParts) {
    throw new ChunkedUploadError("Не все части файла дошли — дошлём недостающие", 409, "PARTS_MISSING", {
      uploadedPartNumbers: have,
    });
  }
  const lockPath = await lockAssembly(input.sessionId);
  const ext = path.extname(meta.filename).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const tmpPath = path.join(videoTmpDir, `${randomUUID()}${ext}`);
  try {
    await completeLocalUploadSessionToPath(input.sessionId, tmpPath, meta.totalParts);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    await fs.promises.rm(lockPath, { force: true }).catch(() => {});
    throw err;
  }
  return { tmpPath, originalName: meta.filename, sizeBytes: meta.sizeBytes, contentType: meta.contentType };
}
