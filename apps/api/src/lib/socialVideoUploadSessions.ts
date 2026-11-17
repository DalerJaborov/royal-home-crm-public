import { randomUUID } from "node:crypto";
import path from "node:path";
import { SOCIAL_VIDEO_ALLOWED_EXTENSIONS, SOCIAL_VIDEO_UPLOAD_MAX_BYTES } from "@royal-home/shared";
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
import { SocialVideoError } from "./socialVideoPosts.js";

/**
 * ЗАГРУЗКА СВОБОДНОГО РОЛИКА ЧАСТЯМИ (17.11.2026). Раньше ролик шёл одним запросом, и
 * файл 87 МБ получал 413 «Файл слишком большой» ещё до API: Cloudflare перед сервером
 * не пропускает тело больше 100 МБ, а прокси на сервере — и меньше. Ролики объектов давно
 * едут частями по 8 МБ (routes/properties/videos.ts, upload-sessions) — здесь тот же
 * приём и та же склейка с диска (lib/localVideoStorage.ts), но без записи в базе:
 * ролик без объекта, план сессии лежит файлом meta.json рядом с частями.
 */

export const SOCIAL_VIDEO_PART_SIZE = 8 * 1024 * 1024;
/** Брошенная сессия (закрыли вкладку) убирается при старте следующей. */
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

interface SocialUploadMeta {
  kind: "social";
  agentId: string;
  filename: string;
  sizeBytes: number;
  partSize: number;
  totalParts: number;
  createdAt: string;
}

function isSocialMeta(v: unknown): v is SocialUploadMeta {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "social";
}

async function sweepStaleSocialSessions(): Promise<void> {
  const now = Date.now();
  for (const id of await listLocalUploadSessionIds()) {
    const meta = await readLocalUploadSessionMeta(id);
    // Чужие сессии (ролики объектов) убирает их собственная уборка по базе — не трогаем.
    if (!isSocialMeta(meta)) continue;
    if (now - Date.parse(meta.createdAt) > STALE_SESSION_MS) await abortLocalUploadSession(id);
  }
}

export async function startSocialVideoUpload(input: {
  agentId: string;
  filename: string;
  sizeBytes: number;
}): Promise<{ sessionId: string; partSize: number; totalParts: number }> {
  const ext = path.extname(input.filename).toLowerCase();
  if (!(SOCIAL_VIDEO_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new SocialVideoError(`Файл «${input.filename}» не подходит: нужен ролик MP4 или MOV`, 422);
  }
  if (input.sizeBytes > SOCIAL_VIDEO_UPLOAD_MAX_BYTES) {
    throw new SocialVideoError("Файл больше 2 ГБ — сожмите ролик и загрузите снова", 413);
  }
  void sweepStaleSocialSessions().catch(() => {});
  const sessionId = randomUUID();
  const partSize = SOCIAL_VIDEO_PART_SIZE;
  const totalParts = Math.max(1, Math.ceil(input.sizeBytes / partSize));
  await createLocalUploadSession(sessionId);
  const meta: SocialUploadMeta = {
    kind: "social",
    agentId: input.agentId,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    partSize,
    totalParts,
    createdAt: new Date().toISOString(),
  };
  await writeLocalUploadSessionMeta(sessionId, meta);
  return { sessionId, partSize, totalParts };
}

/** Сессия этого сотрудника, иначе 404 — чужую сессию не видно, даже зная id. */
async function ownSession(sessionId: string, agentId: string): Promise<SocialUploadMeta> {
  const meta = await readLocalUploadSessionMeta(sessionId);
  if (!isSocialMeta(meta) || meta.agentId !== agentId) {
    throw new SocialVideoError("Загрузка не найдена — выберите файл ещё раз", 404);
  }
  return meta;
}

export async function writeSocialVideoPart(input: {
  sessionId: string;
  agentId: string;
  partNumber: number;
  body: Buffer;
}): Promise<void> {
  const meta = await ownSession(input.sessionId, input.agentId);
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > meta.totalParts) {
    throw new SocialVideoError("Неверный номер части", 400);
  }
  if (input.body.length === 0) throw new SocialVideoError("Пустая часть", 400);
  const expected =
    input.partNumber === meta.totalParts ? meta.sizeBytes - meta.partSize * (meta.totalParts - 1) : meta.partSize;
  if (input.body.length !== expected) {
    throw new SocialVideoError("Размер части не совпадает с планом загрузки", 400);
  }
  // Повтор той же части просто перезаписывает файл — клиент может смело повторять.
  await writeLocalUploadPart(input.sessionId, input.partNumber, input.body);
}

/** Склеивает части во временный файл и отдаёт его путь и исходное имя. */
export async function assembleSocialVideoUpload(
  sessionId: string,
  agentId: string
): Promise<{ tmpPath: string; originalName: string }> {
  const meta = await ownSession(sessionId, agentId);
  const have = await listLocalUploadParts(sessionId);
  if (have.length !== meta.totalParts) {
    throw new SocialVideoError("Не все части ролика дошли — загрузите файл ещё раз", 409);
  }
  const ext = path.extname(meta.filename).toLowerCase();
  const tmpPath = path.join(videoTmpDir, `${randomUUID()}${ext}`);
  await completeLocalUploadSessionToPath(sessionId, tmpPath, meta.totalParts);
  return { tmpPath, originalName: meta.filename };
}
