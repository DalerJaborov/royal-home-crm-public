import { randomUUID } from "node:crypto";
import path from "node:path";
import { UPLOAD_PART_BYTES } from "@royal-home/shared";
import {
  abortLocalUploadSession,
  completeLocalUploadSessionToPath,
  createLocalUploadSession,
  listLocalUploadParts,
  listLocalUploadSessionIds,
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
 */

/** Брошенная сессия (закрыли вкладку) убирается при старте следующей. */
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

export class ChunkedUploadError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
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
}

function isChunkedMeta(v: unknown): v is ChunkedUploadMeta {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return typeof m.kind === "string" && typeof m.agentId === "string" && typeof m.totalParts === "number";
}

async function sweepStaleSessions(): Promise<void> {
  const now = Date.now();
  for (const id of await listLocalUploadSessionIds()) {
    const meta = await readLocalUploadSessionMeta(id);
    // Сессии роликов объектов (без meta.json) убирает их собственная уборка по базе — не трогаем.
    if (!isChunkedMeta(meta)) continue;
    if (now - Date.parse(meta.createdAt) > STALE_SESSION_MS) await abortLocalUploadSession(id);
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
  void sweepStaleSessions().catch(() => {});
  const sessionId = randomUUID();
  const partSize = UPLOAD_PART_BYTES;
  const totalParts = Math.max(1, Math.ceil(input.sizeBytes / partSize));
  await createLocalUploadSession(sessionId);
  const meta: ChunkedUploadMeta = {
    kind: input.kind,
    agentId: input.agentId,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    contentType: input.contentType ?? null,
    partSize,
    totalParts,
    createdAt: new Date().toISOString(),
  };
  await writeLocalUploadSessionMeta(sessionId, meta);
  return { sessionId, partSize, totalParts };
}

/** Сессия этого сотрудника и этого назначения, иначе 404 — чужую не видно, даже зная id. */
async function ownSession(sessionId: string, agentId: string, kind: string): Promise<ChunkedUploadMeta> {
  const meta = await readLocalUploadSessionMeta(sessionId);
  if (!isChunkedMeta(meta) || meta.agentId !== agentId || meta.kind !== kind) {
    throw new ChunkedUploadError("Загрузка не найдена — выберите файл ещё раз", 404);
  }
  return meta;
}

/** Назначение сессии (без проверки владельца) — общему маршруту частей нужно знать, чья она. */
export async function chunkedUploadKind(sessionId: string): Promise<string | null> {
  const meta = await readLocalUploadSessionMeta(sessionId);
  return isChunkedMeta(meta) ? meta.kind : null;
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
}

/**
 * Склеивает части во временный файл (videoTmpDir) и отдаёт его путь. Временный файл —
 * забота вызывающего: он обязан убрать его в любом исходе. Сессия после сборки удаляется.
 */
export async function assembleChunkedUpload(input: {
  kind: string;
  sessionId: string;
  agentId: string;
}): Promise<{ tmpPath: string; originalName: string; sizeBytes: number; contentType: string | null }> {
  const meta = await ownSession(input.sessionId, input.agentId, input.kind);
  const have = await listLocalUploadParts(input.sessionId);
  if (have.length !== meta.totalParts) {
    throw new ChunkedUploadError("Не все части файла дошли — загрузите файл ещё раз", 409);
  }
  const ext = path.extname(meta.filename).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const tmpPath = path.join(videoTmpDir, `${randomUUID()}${ext}`);
  await completeLocalUploadSessionToPath(input.sessionId, tmpPath, meta.totalParts);
  return { tmpPath, originalName: meta.filename, sizeBytes: meta.sizeBytes, contentType: meta.contentType };
}
