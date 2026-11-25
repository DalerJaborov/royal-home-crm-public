import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  UPLOAD_RESULT_KEEP_MS,
  UPLOAD_SESSION_IDLE_TTL_MS,
  computeUploadPartPlan,
  expectedUploadPartBytes,
  type UploadSessionStatusView,
} from "@royal-home/shared";
import {
  abortLocalUploadSession,
  assertUploadDiskSpace,
  completeLocalUploadSessionToPath,
  uploadStartDiskBytes,
  createLocalUploadSession,
  listLocalUploadParts,
  listLocalUploadSessionIds,
  localUploadPartSizes,
  readLocalUploadSessionMeta,
  readLocalUploadSessionState,
  writeLocalUploadPart,
  writeLocalUploadSessionMeta,
} from "./localVideoStorage.js";
import { UploadError } from "./uploadErrors.js";
import { readUploadState } from "./uploadCompletion.js";
import { videoTmpDir } from "../upload.js";

/**
 * ОБЩЕЕ ЯДРО ЗАГРУЗКИ ЧАСТЯМИ БЕЗ ЗАПИСИ В БАЗЕ (17.11.2026, класс «большой файл одним
 * запросом → 413 от прокси»).
 *
 * Одним запросом файл крупнее ~90 МБ не доходит до API: Cloudflare и прокси перед сервером
 * режут тело (packages/shared/src/uploadLimits.ts, PROXY_SINGLE_REQUEST_MAX_BYTES). Поэтому
 * файл режется на части (UPLOAD_PART_BYTES): старт → части (повтор той же части просто
 * перезаписывает файл) → сборка во временный файл, который забирает маршрут своего назначения.
 *
 * Здесь — только механика сессии; что делать с собранным файлом, решает маршрут сборки
 * (свободный ролик, ролик карточки объекта, файл в переписку) — через runUploadCompletion
 * (lib/uploadCompletion.ts): части убираются ТОЛЬКО после того, как маршрут закрепил
 * результат, итог помнится сутки. План сессии лежит файлом meta.json рядом с частями.
 *
 * Диск не бесконечен (ревью #254): у сотрудника не больше MAX_SESSIONS_PER_AGENT идущих
 * сессий. Новая вытесняет только сессию, в которую части не шли дольше EVICTABLE_IDLE_MS;
 * если все идут — отказ TOO_MANY_UPLOADS (раньше вытеснялась самая старая, даже если в неё
 * в эту секунду шли части). Сессия без новой части дольше SESSION_IDLE_TTL_MS (сутки,
 * 25.11.2026; было 2 часа — 2 ГБ на 300 Кбит/с идут ~16 ч с перерывами) убирается кроном.
 */

export const MAX_SESSIONS_PER_AGENT = 8;
export const SESSION_IDLE_TTL_MS = UPLOAD_SESSION_IDLE_TTL_MS;
/** Сессию без новой части дольше этого новая может вытеснить. */
export const EVICTABLE_IDLE_MS = 10 * 60 * 1000;

/** Совместимость: ошибки ядра — это UploadError (единый формат отказа). */
export { UploadError as ChunkedUploadError };

/** Тело ответа на ошибку ядра — одно для всех маршрутов. */
export function chunkedUploadErrorBody(err: UploadError): Record<string, unknown> {
  return err.body();
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

/** Владелец итога сессии ядра — сотрудник (lib/uploadCompletion.ts). */
export function chunkedUploadOwner(agentId: string): string {
  return `agent:${agentId}`;
}

interface SessionEntry {
  id: string;
  meta: ChunkedUploadMeta;
  /** Есть итог сборки (done/failed) — сессия уже не «идёт». */
  finished: boolean;
  lastActivity: number;
}

async function listSessions(): Promise<SessionEntry[]> {
  const out: SessionEntry[] = [];
  for (const id of await listLocalUploadSessionIds()) {
    const meta = await readLocalUploadSessionMeta(id);
    // Сессии роликов объектов и черновиков (без meta.json) убирает их собственная уборка по базе.
    if (!isChunkedMeta(meta)) continue;
    const state = (await readLocalUploadSessionState(id)) as { state?: string; updatedAt?: string } | null;
    const times = [Date.parse(meta.touchedAt ?? meta.createdAt), Date.parse(state?.updatedAt ?? "")].filter(Number.isFinite);
    // Закончена — собрана, либо отвергнута по содержимому (части уже убраны). Сбой сборки
    // с целыми частями — не конец: сессия ждёт повтора и считается идущей.
    const finished = state?.state === "done" || (state?.state === "failed" && (await listLocalUploadParts(id)).length === 0);
    out.push({ id, meta, finished, lastActivity: times.length ? Math.max(...times) : 0 });
  }
  return out;
}

/**
 * Уборка брошенных сессий и старых итогов (крон и каждый старт). `onAbandoned` — сессия,
 * которую так и не собрали (автору — пуш, см. lib/videoUploadCleanup.ts). Возвращает число убранных.
 */
export async function sweepStaleChunkedUploads(
  now = Date.now(),
  onAbandoned?: (s: { id: string; meta: ChunkedUploadMeta }) => Promise<void>
): Promise<number> {
  let removed = 0;
  for (const s of await listSessions()) {
    const age = now - s.lastActivity;
    const expired = s.finished ? age > UPLOAD_RESULT_KEEP_MS : age > SESSION_IDLE_TTL_MS;
    if (!expired) continue;
    if (await abortLocalUploadSession(s.id)) {
      removed++;
      if (!s.finished && onAbandoned) await onAbandoned(s).catch(() => {});
    }
  }
  return removed;
}

/**
 * Место под новую сессию сотрудника: если идущих уже MAX_SESSIONS_PER_AGENT, вытесняются
 * только стоящие дольше EVICTABLE_IDLE_MS (самые давние первыми). Не хватило — отказ.
 */
async function enforceAgentCap(agentId: string, now = Date.now()): Promise<void> {
  const own = (await listSessions())
    .filter((s) => s.meta.agentId === agentId && !s.finished)
    .sort((a, b) => a.lastActivity - b.lastActivity);
  let active = own.length;
  for (const s of own) {
    if (active < MAX_SESSIONS_PER_AGENT) break;
    if (now - s.lastActivity <= EVICTABLE_IDLE_MS) break;
    if (await abortLocalUploadSession(s.id)) active--;
  }
  if (active >= MAX_SESSIONS_PER_AGENT) throw new UploadError("TOO_MANY_UPLOADS");
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
  /** Размер части, который просит клиент (UPLOAD_PART_MIN_BYTES…UPLOAD_PART_MAX_BYTES). */
  partSize?: number | null;
  /** После склейки у назначения есть ещё копия (перепаковка, сжатие) — на старте просим 2,5× места. */
  extraCopy?: boolean;
}

export async function startChunkedUpload(
  input: StartChunkedUploadInput
): Promise<{ sessionId: string; partSize: number; totalParts: number }> {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new UploadError("EMPTY_PART", { message: "Пустой файл" });
  }
  if (input.sizeBytes > input.maxBytes) throw new UploadError("FILE_TOO_LARGE", { message: input.tooLargeMessage });
  const plan = computeUploadPartPlan(input.sizeBytes, input.partSize);
  if (!plan) throw new UploadError("PART_SIZE_INVALID");
  await sweepStaleChunkedUploads().catch(() => 0);
  await enforceAgentCap(input.agentId);
  await assertUploadDiskSpace(uploadStartDiskBytes(input.sizeBytes, input.extraCopy));
  const sessionId = randomUUID();
  await createLocalUploadSession(sessionId);
  const now = new Date().toISOString();
  const meta: ChunkedUploadMeta = {
    kind: input.kind,
    agentId: input.agentId,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    contentType: input.contentType ?? null,
    partSize: plan.partSize,
    totalParts: plan.totalParts,
    createdAt: now,
    touchedAt: now,
  };
  await writeLocalUploadSessionMeta(sessionId, meta);
  return { sessionId, partSize: plan.partSize, totalParts: plan.totalParts };
}

/** Сессия этого сотрудника (и этого назначения, если оно задано), иначе 404 — чужую не видно. */
async function ownSession(sessionId: string, agentId: string, kind?: string): Promise<ChunkedUploadMeta> {
  const meta = await readLocalUploadSessionMeta(sessionId);
  if (!isChunkedMeta(meta) || meta.agentId !== agentId || (kind !== undefined && meta.kind !== kind)) {
    throw new UploadError("SESSION_NOT_FOUND");
  }
  return meta;
}

/** Назначение сессии (без проверки владельца) — общему маршруту частей нужно знать, чья она. */
export async function chunkedUploadKind(sessionId: string): Promise<string | null> {
  const meta = await readLocalUploadSessionMeta(sessionId);
  return isChunkedMeta(meta) ? meta.kind : null;
}

/** Состояние своей сессии для докачки: план, принятые части и байты, состояние сборки. */
export async function chunkedUploadStatus(
  sessionId: string,
  agentId: string
): Promise<UploadSessionStatusView & { kind: string }> {
  const meta = await ownSession(sessionId, agentId);
  const sizes = await localUploadPartSizes(sessionId);
  const stored = await readUploadState(sessionId, chunkedUploadOwner(agentId));
  const receiving = !stored || (stored.state === "failed" && stored.error?.code === "PARTS_MISSING");
  return {
    sessionId,
    kind: meta.kind,
    state: receiving ? "receiving" : stored.state,
    partSize: meta.partSize,
    totalParts: meta.totalParts,
    sizeBytes: meta.sizeBytes,
    uploadedPartNumbers: [...sizes.keys()],
    receivedBytes: [...sizes.values()].reduce((a, b) => a + b, 0),
    ...(stored?.result && stored.state === "done" ? { result: stored.result } : {}),
    ...(stored?.error && !receiving ? { error: stored.error } : {}),
    updatedAt: stored?.updatedAt ?? meta.touchedAt ?? meta.createdAt,
  };
}

export async function writeChunkedUploadPart(input: {
  kind: string;
  sessionId: string;
  agentId: string;
  partNumber: number;
  body: Buffer | Readable;
}): Promise<number> {
  const meta = await ownSession(input.sessionId, input.agentId, input.kind);
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > meta.totalParts) {
    throw new UploadError("PART_OUT_OF_RANGE");
  }
  // Файл уже собран (итог хранится сутки) или собирается прямо сейчас — новые части в эту
  // сессию не пишем: подменённая на ходу часть дала бы файл, не совпадающий с итогом.
  const stored = await readUploadState(input.sessionId, chunkedUploadOwner(input.agentId));
  if (stored?.state === "done") throw new UploadError("ALREADY_ASSEMBLED");
  if (stored?.state === "assembling" || stored?.state === "processing") throw new UploadError("ASSEMBLING");
  const expected = expectedUploadPartBytes(meta, input.partNumber);
  await assertUploadDiskSpace(expected);
  // Повтор той же части просто перезаписывает файл — клиент может смело повторять.
  const written = await writeLocalUploadPart(input.sessionId, input.partNumber, input.body, { expectedBytes: expected });
  await writeLocalUploadSessionMeta(input.sessionId, { ...meta, touchedAt: new Date().toISOString() });
  return written;
}

/**
 * Склеивает части во временный файл (videoTmpDir) и отдаёт его путь. Временный файл —
 * забота вызывающего: он обязан убрать его в любом исходе. Части НЕ удаляются — это делает
 * runUploadCompletion, когда маршрут закрепил результат; при сбое склейки части целы,
 * недосклеенный файл удалён — повтор сборки не требует загружать файл заново.
 * Вызывать ТОЛЬКО под замком сборки (внутри runUploadCompletion).
 */
export async function assembleChunkedUpload(input: {
  kind: string;
  sessionId: string;
  agentId: string;
  /** Куда склеить файл (по умолчанию videoTmpDir). Очередь отправки файлов клиенту берёт
   *  общий том api и worker: из /tmp контейнера api worker файла не увидит. */
  destDir?: string;
}): Promise<{ tmpPath: string; originalName: string; sizeBytes: number; contentType: string | null }> {
  const meta = await ownSession(input.sessionId, input.agentId, input.kind);
  const ext = path.extname(meta.filename).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const tmpPath = path.join(input.destDir ?? videoTmpDir, `${randomUUID()}${ext}`);
  try {
    await completeLocalUploadSessionToPath(input.sessionId, tmpPath, meta);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  return { tmpPath, originalName: meta.filename, sizeBytes: meta.sizeBytes, contentType: meta.contentType };
}

/** Проверка до замка: сессия своя и этого назначения (404 иначе). */
export async function assertOwnChunkedUpload(input: { kind: string; sessionId: string; agentId: string }): Promise<ChunkedUploadMeta> {
  return ownSession(input.sessionId, input.agentId, input.kind);
}
