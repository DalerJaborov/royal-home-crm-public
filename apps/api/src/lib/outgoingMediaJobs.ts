import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatUploadLimit } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { OutgoingMediaJob } from "../generated/prisma/client.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { asMetaChannel } from "../messengers/meta.js";
import { moveUploadedFile } from "../upload.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { agentSender, deliverMediaToConversation, mediaDeliveryPrecheck, type DeliveryTarget } from "./conversationDelivery.js";
import { TG_PREFIX } from "./conversationId.js";
import { describeError } from "./describeError.js";
import { channelMediaLimit, prepareOutgoingMedia, PrepareError, type OutgoingMediaChannel, type PreparedMedia } from "./outgoingMediaPrepare.js";
import { privateDirRoot } from "./privateFiles.js";
import { logSystemError } from "./systemError.js";

/**
 * ОЧЕРЕДЬ ОТПРАВКИ ФОТО И ВИДЕО КЛИЕНТУ (25.11.2026, владелец: «как сам WhatsApp или
 * Telegram, чтобы всё мгновенно открывалось… всё летало, без багов»).
 *
 * Раньше файл доставлялся ВНУТРИ запроса загрузки: агент ждал до двух минут, видео
 * больше 16 МБ уходило клиенту ссылкой. Теперь:
 *  1. Приём (api): файл уже на сервере (части по 8 МБ, lib/chunkedUploadSessions.ts) —
 *     быстрые проверки (переписка, канал, окно 24 часа) за секунду, файл ложится в спул
 *     на ОБЩЕМ томе api и worker, строка OutgoingMediaJob, задание очереди. Ответ 202 и
 *     номер задания — пузырь в чате сразу «Сжимаем…».
 *  2. Работа (worker, своя полоса очереди, одно сжатие за раз): подготовка под канал
 *     (lib/outgoingMediaPrepare.ts) и та же доставка, что и раньше
 *     (deliverMediaToConversation: пауза бота, откат паузы при заведомой неотправке,
 *     запись в историю, mid). Экран спрашивает состояние раз в пару секунд.
 *  3. Сбой → FAILED с причиной простыми словами, исходник лежит сутки: «Повторить» не
 *     грузит файл заново. Выкат посреди сжатия → ffmpeg обрывается, задание возвращается в
 *     очередь и продолжается в новом процессе. Падение процесса В МОМЕНТ отправки клиенту
 *     (статус SENDING) второй раз НЕ шлёт: исход неизвестен, сотрудник видит «проверьте
 *     переписку» и решает сам — двойное видео клиенту хуже.
 *
 * Рубильник `outgoingMediaCompressEnabled` (Настройки → Автоматика): выключен — маршрут
 * загрузки работает по-старому, синхронно и без сжатия (routes/conversations.ts).
 */

export const OUTGOING_MEDIA_JOB_TYPE = "outgoing-media-send";
export const OUTGOING_MEDIA_MAX_ATTEMPTS = 5;
/** Сколько всего даём подготовке одного файла: ниже срока задания очереди (14 мин) и «зависшего RUNNING» (15 мин). */
const PREPARE_DEADLINE_MS = 12 * 60_000;
/** Исходник после сбоя ждёт «Повторить» сутки. */
const FAILED_KEEP_MS = 24 * 60 * 60 * 1000;
/** Файл в спуле без строки задания — след оборванного приёма. */
const ORPHAN_KEEP_MS = 6 * 60 * 60 * 1000;
/** Задание, которое ждёт или сжимается дольше этого, — повод для тревоги. */
const STUCK_ALERT_MS = 20 * 60_000;
/** Записи старше месяца не нужны даже для разбора. */
const ROW_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Минимум свободного места под приём: сжатие пишет копию рядом с исходником. */
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export type OutgoingMediaStatus = "QUEUED" | "PREPARING" | "SENDING" | "SENT" | "FAILED" | "CANCELLED";
const TERMINAL: ReadonlySet<string> = new Set(["SENT", "FAILED", "CANCELLED"]);

export function outgoingMediaSpoolDir(): string {
  const dir = path.join(privateDirRoot(), "outgoing-media-spool");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Тип файла по расширению, когда браузер прислал пустой (HEIC в Chrome на Windows) или общий. */
export function normalizeOutgoingMime(mimetype: string | null | undefined, filename: string): string {
  const m = (mimetype ?? "").toLowerCase().split(";")[0].trim();
  if (m.startsWith("image/") || m.startsWith("video/")) return m;
  const ext = path.extname(filename).toLowerCase();
  const byExt: Record<string, string> = {
    ".heic": "image/heic", ".heif": "image/heif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".mov": "video/quicktime", ".mp4": "video/mp4", ".m4v": "video/mp4",
    ".3gp": "video/3gpp", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  };
  return byExt[ext] ?? (m || "application/octet-stream");
}

/** Переписка по id из инбокса («<uuid>» или «tg_<uuid>») — та же форма цели, что у маршрута отправки. */
export async function resolveMediaTarget(rawId: string): Promise<DeliveryTarget | null> {
  if (rawId.startsWith(TG_PREFIX)) {
    const tg = await prisma.telegramConversation.findUnique({ where: { id: rawId.slice(TG_PREFIX.length) }, select: { id: true, chatId: true } });
    return tg ? { kind: "telegram", id: tg.id, subscriberId: tg.chatId } : null;
  }
  const bot = await prisma.botConversation.findUnique({
    where: { id: rawId },
    select: { id: true, channel: true, subscriberId: true, accountId: true },
  });
  return bot ? { kind: "bot", id: bot.id, channel: bot.channel, subscriberId: bot.subscriberId, accountId: bot.accountId } : null;
}

export function outgoingMediaChannelOf(target: DeliveryTarget): OutgoingMediaChannel | null {
  if (target.kind === "telegram") return "TELEGRAM";
  return asMetaChannel(target.channel);
}

export async function outgoingMediaCompressOn(): Promise<boolean> {
  return automationSwitchOn("outgoingMediaCompressEnabled");
}

/** Что видит экран про задание. */
export function outgoingMediaJobView(job: Pick<OutgoingMediaJob, "id" | "status" | "progress" | "error" | "note" | "conversationId" | "createdAt">) {
  return {
    id: job.id,
    conversationId: job.conversationId,
    status: job.status as OutgoingMediaStatus,
    progress: job.progress,
    error: job.error,
    note: job.note,
    createdAt: job.createdAt.toISOString(),
  };
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.promises.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export interface AcceptedMediaFile {
  path: string;
  size: number;
  mimetype: string;
  originalname: string;
}

/**
 * Принять файл в очередь. Файл забирается (переносится в спул) или удаляется в любом исходе —
 * вызывающему убирать нечего.
 */
export async function enqueueOutgoingMedia(input: {
  agentId: string;
  conversationId: string;
  file: AcceptedMediaFile;
  caption?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const drop = () => fs.promises.rm(input.file.path, { force: true }).catch(() => {});
  const mimetype = normalizeOutgoingMime(input.file.mimetype, input.file.originalname);
  const target = await resolveMediaTarget(input.conversationId);
  if (!target) {
    await drop();
    return { status: 404, body: { error: "Диалог не найден" } };
  }
  const pre = await mediaDeliveryPrecheck(target, await agentSender(input.agentId), mimetype);
  if (!pre.ok) {
    await drop();
    return { status: pre.status, body: { error: pre.error, code: pre.code } };
  }
  const spool = outgoingMediaSpoolDir();
  const free = await freeBytes(spool);
  if (free !== null && free < Math.max(MIN_FREE_BYTES, input.file.size * 3)) {
    await drop();
    void logSystemError("storage", `Мало места для файлов переписки: свободно ${formatUploadLimit(free)}, файл не принят`, {
      dedupKey: "outgoing-media-disk-low",
    });
    return { status: 507, body: { error: "На сервере кончается место — файл не принят. Сообщите руководителю." } };
  }
  const ext = path.extname(input.file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  const inputName = `${randomUUID()}${ext}`;
  const dest = path.join(spool, inputName);
  try {
    if (path.resolve(path.dirname(input.file.path)) === path.resolve(spool)) await fs.promises.rename(input.file.path, dest);
    else await moveUploadedFile(input.file.path, dest);
  } catch (err) {
    await drop();
    void logSystemError("storage", `Файл переписки не перенесён в очередь отправки: ${describeError(err)}`, { dedupKey: "outgoing-media-spool-write" });
    return { status: 503, body: { error: "Файл не сохранился на сервере — попробуйте ещё раз" } };
  }
  const job = await prisma.outgoingMediaJob.create({
    data: {
      conversationId: input.conversationId,
      agentId: input.agentId,
      inputName,
      originalName: input.file.originalname.slice(0, 255),
      mimeType: mimetype,
      sizeBytes: input.file.size,
      caption: input.caption || null,
    },
  });
  const queued = await enqueueBackgroundJob({
    type: OUTGOING_MEDIA_JOB_TYPE,
    payload: { mediaJobId: job.id },
    maxAttempts: OUTGOING_MEDIA_MAX_ATTEMPTS,
    dedupeKey: `outgoing-media:${job.id}`,
  });
  if (!queued.enqueued) {
    await finishJob(job.id, "FAILED", { error: "Очередь отправки недоступна — нажмите «Повторить» через минуту" });
    return { status: 503, body: { error: "Очередь отправки недоступна — попробуйте через минуту", jobId: job.id } };
  }
  return { status: 202, body: { ok: true, queued: true, jobId: job.id, status: "QUEUED" } };
}

async function finishJob(
  id: string,
  status: "SENT" | "FAILED" | "CANCELLED",
  data: { error?: string | null; note?: string | null; outBytes?: number; outMime?: string; prepareMs?: number } = {}
): Promise<void> {
  await prisma.outgoingMediaJob.update({
    where: { id },
    data: { status, finishedAt: new Date(), progress: status === "SENT" ? 100 : undefined, ...data },
  });
}

/** Повтор упавшего: исходник ещё в спуле — снова в очередь, без новой загрузки. */
export async function retryOutgoingMediaJob(jobId: string, agentId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const job = await prisma.outgoingMediaJob.findUnique({ where: { id: jobId } });
  if (!job || job.agentId !== agentId) return { status: 404, body: { error: "Отправка не найдена" } };
  if (job.status !== "FAILED") return { status: 409, body: { error: "Повторять нечего", status: job.status } };
  if (!fs.existsSync(path.join(outgoingMediaSpoolDir(), job.inputName))) {
    return { status: 410, body: { error: "Файла уже нет на сервере — выберите его и отправьте заново", code: "INPUT_GONE" } };
  }
  const reset = await prisma.outgoingMediaJob.updateMany({
    where: { id: jobId, status: "FAILED" },
    data: { status: "QUEUED", error: null, note: null, progress: 0, finishedAt: null, startedAt: null },
  });
  if (!reset.count) return { status: 409, body: { error: "Повторять нечего" } };
  const queued = await enqueueBackgroundJob({
    type: OUTGOING_MEDIA_JOB_TYPE,
    payload: { mediaJobId: jobId },
    maxAttempts: OUTGOING_MEDIA_MAX_ATTEMPTS,
    dedupeKey: `outgoing-media:${jobId}`,
  });
  if (!queued.enqueued) {
    await finishJob(jobId, "FAILED", { error: "Очередь отправки недоступна — нажмите «Повторить» через минуту" });
    return { status: 503, body: { error: "Очередь отправки недоступна — попробуйте через минуту" } };
  }
  return { status: 202, body: { ok: true, queued: true, jobId, status: "QUEUED" } };
}

/** Отмена: пока файл не начал уходить клиенту. В момент отправки — уже нельзя. */
export async function cancelOutgoingMediaJob(jobId: string, agentId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const job = await prisma.outgoingMediaJob.findUnique({ where: { id: jobId } });
  if (!job || job.agentId !== agentId) return { status: 404, body: { error: "Отправка не найдена" } };
  const cancelled = await prisma.outgoingMediaJob.updateMany({
    where: { id: jobId, status: { in: ["QUEUED", "PREPARING", "FAILED"] } },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  if (!cancelled.count) {
    const now = await prisma.outgoingMediaJob.findUnique({ where: { id: jobId }, select: { status: true } });
    return { status: 409, body: { error: now?.status === "SENT" ? "Файл уже отправлен" : "Файл уже уходит клиенту — отменить нельзя", status: now?.status } };
  }
  // Сжатие, если идёт, оборвёт сам обработчик (он следит за статусом); исходник ждущего убираем сразу.
  if (job.status === "QUEUED" || job.status === "FAILED") {
    await fs.promises.rm(path.join(outgoingMediaSpoolDir(), job.inputName), { force: true }).catch(() => {});
  }
  return { status: 200, body: { ok: true } };
}

function mb(bytes: number): string {
  return formatUploadLimit(Math.max(bytes, 1024 * 102)).replace(/ МБ$/, "");
}

const CHANNEL_NAMES: Record<OutgoingMediaChannel, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Messenger",
  TELEGRAM: "Telegram",
};

function noteFor(prepared: PreparedMedia, sizeIn: number, channel: OutgoingMediaChannel | null, sentAsLink: boolean): string | null {
  if (sentAsLink && channel) {
    return `Видео слишком длинное для ${CHANNEL_NAMES[channel]} (предел ${formatUploadLimit(channelMediaLimit(channel, "video"))}) — клиенту ушла ссылка на просмотр`;
  }
  if (prepared.action === "transcoded" || prepared.action === "image") return `Сжато ${mb(sizeIn)} → ${mb(prepared.size)} МБ`;
  return null;
}

class JobInterrupted extends Error {}

/**
 * Исполнение одного задания (worker). Идемпотентно: завершённое не трогает, отправку,
 * начатую до сбоя процесса, не повторяет. Бросает только когда процесс выходит —
 * очередь вернёт задание и новый процесс начнёт сжатие заново.
 */
export async function runOutgoingMediaJob(mediaJobId: string, stopSignal?: AbortSignal): Promise<void> {
  const job = await prisma.outgoingMediaJob.findUnique({ where: { id: mediaJobId } });
  if (!job || TERMINAL.has(job.status)) return;
  const spool = outgoingMediaSpoolDir();
  const inputPath = path.join(spool, job.inputName);
  if (job.status === "SENDING") {
    await finishJob(job.id, "FAILED", {
      error: "Связь оборвалась в момент отправки. Проверьте переписку: если файла там нет — нажмите «Повторить».",
    });
    void logSystemError("background-jobs", `Отправка файла клиенту прервана в момент передачи (задание ${job.id}) — повтор не делали, чтобы не задвоить`);
    return;
  }
  const claimed = await prisma.outgoingMediaJob.updateMany({
    where: { id: job.id, status: { in: ["QUEUED", "PREPARING"] } },
    data: { status: "PREPARING", startedAt: new Date(), progress: 0, error: null },
  });
  if (!claimed.count) return;

  const controller = new AbortController();
  let cancelled = false;
  const onStop = () => controller.abort();
  stopSignal?.addEventListener("abort", onStop);
  const deadline = setTimeout(() => controller.abort(), PREPARE_DEADLINE_MS);
  // Отмена сотрудником во время сжатия: статус в базе — единственный общий язык api и worker.
  const watcher = setInterval(() => {
    void prisma.outgoingMediaJob
      .findUnique({ where: { id: job.id }, select: { status: true } })
      .then((row) => {
        if (row?.status === "CANCELLED") {
          cancelled = true;
          controller.abort();
        }
      })
      .catch(() => {});
  }, 3_000);
  let lastProgressWrite = 0;
  const onProgress = (percent: number) => {
    const now = Date.now();
    if (now - lastProgressWrite < 2_000) return;
    lastProgressWrite = now;
    void prisma.outgoingMediaJob.updateMany({ where: { id: job.id, status: "PREPARING" }, data: { progress: percent } }).catch(() => {});
  };

  let prepared: PreparedMedia | null = null;
  try {
    const target = await resolveMediaTarget(job.conversationId);
    if (!target) {
      await finishJob(job.id, "FAILED", { error: "Переписка удалена — отправлять некуда" });
      return;
    }
    if (!fs.existsSync(inputPath)) {
      await finishJob(job.id, "FAILED", { error: "Файл не сохранился на сервере — выберите его и отправьте заново" });
      return;
    }
    const channel = outgoingMediaChannelOf(target);
    const original: PreparedMedia = {
      path: inputPath, mimetype: job.mimeType, size: job.sizeBytes, action: "original", sendAsLink: false, owned: false, ms: 0,
    };
    prepared = channel && (await outgoingMediaCompressOn())
      ? await prepareOutgoingMedia({ path: inputPath, mimetype: job.mimeType, size: job.sizeBytes }, channel, { workDir: spool, signal: controller.signal, onProgress })
      : original;
    if (controller.signal.aborted) throw new JobInterrupted();

    const delivery = await deliverMediaToConversation(
      target,
      { path: prepared.path, size: prepared.size, mimetype: prepared.mimetype, originalname: job.originalName },
      {
        sender: await agentSender(job.agentId),
        caption: job.caption ?? undefined,
        beforeTransport: async () =>
          (await prisma.outgoingMediaJob.updateMany({ where: { id: job.id, status: "PREPARING" }, data: { status: "SENDING", progress: 100 } })).count === 1,
      }
    );
    if (delivery.ok) {
      await finishJob(job.id, "SENT", {
        error: null,
        note: noteFor(prepared, job.sizeBytes, channel, delivery.sentAsLink),
        outBytes: prepared.size,
        outMime: prepared.mimetype,
        prepareMs: prepared.ms,
      });
      await fs.promises.rm(inputPath, { force: true }).catch(() => {});
      return;
    }
    const nowRow = await prisma.outgoingMediaJob.findUnique({ where: { id: job.id }, select: { status: true } });
    if (nowRow?.status === "CANCELLED") {
      await fs.promises.rm(inputPath, { force: true }).catch(() => {});
      return;
    }
    await finishJob(job.id, "FAILED", { error: delivery.error, prepareMs: prepared.ms });
  } catch (err) {
    if (cancelled || (await isCancelled(job.id))) {
      await fs.promises.rm(inputPath, { force: true }).catch(() => {});
      return;
    }
    if (stopSignal?.aborted) {
      // Процесс выходит (выкат): вернуть в очередь, новый worker начнёт заново.
      await prisma.outgoingMediaJob.updateMany({ where: { id: job.id, status: "PREPARING" }, data: { status: "QUEUED", progress: 0 } }).catch(() => {});
      throw new Error("worker выходит — сжатие продолжится в новом процессе");
    }
    if (err instanceof PrepareError || err instanceof JobInterrupted) {
      const timedOut = controller.signal.aborted;
      const message = timedOut
        ? "Сжатие не уложилось в 12 минут — отправьте видео короче или частями"
        : err instanceof PrepareError && err.code !== "ffmpeg"
          ? err.message
          : "Не удалось подготовить файл для клиента — попробуйте ещё раз или отправьте другой файл";
      await finishJob(job.id, "FAILED", { error: message });
      void logSystemError("storage", `Файл для клиента не подготовлен (${job.mimeType}, ${formatUploadLimit(job.sizeBytes)}): ${err.message}`.slice(0, 900), {
        dedupKey: `outgoing-media-prepare:${err instanceof PrepareError ? err.code : "interrupted"}`,
      });
      return;
    }
    await finishJob(job.id, "FAILED", { error: "Не удалось отправить файл — нажмите «Повторить»" }).catch(() => {});
    void logSystemError("background-jobs", `Отправка файла клиенту упала: ${describeError(err)}`, { dedupKey: "outgoing-media-run" });
  } finally {
    clearTimeout(deadline);
    clearInterval(watcher);
    stopSignal?.removeEventListener("abort", onStop);
    if (prepared?.owned) await fs.promises.rm(prepared.path, { force: true }).catch(() => {});
  }
}

async function isCancelled(id: string): Promise<boolean> {
  const row = await prisma.outgoingMediaJob.findUnique({ where: { id }, select: { status: true } }).catch(() => null);
  return row?.status === "CANCELLED";
}

/** Очередь исчерпала попытки (процесс падал на этом задании) — честный отказ сотруднику. */
export async function giveUpOutgoingMediaJob(mediaJobId: string): Promise<void> {
  await prisma.outgoingMediaJob.updateMany({
    where: { id: mediaJobId, status: { in: ["QUEUED", "PREPARING"] } },
    data: { status: "FAILED", finishedAt: new Date(), error: "Файл не удалось подготовить — попробуйте другой файл или отправьте позже" },
  });
}

export interface OutgoingMediaSweepResult {
  removedFiles: number;
  removedRows: number;
  stuck: number;
}

/**
 * Уборка спула и тревога (крон worker, раз в 30 минут): исходники упавших старше суток,
 * брошенные файлы без задания, старые строки; ждущие и сжимаемые дольше 20 минут — в журнал.
 */
export async function sweepOutgoingMediaSpool(now = Date.now()): Promise<OutgoingMediaSweepResult> {
  const spool = outgoingMediaSpoolDir();
  const rows = await prisma.outgoingMediaJob.findMany({
    where: { status: { in: ["QUEUED", "PREPARING", "SENDING", "FAILED"] } },
    select: { id: true, inputName: true, status: true, updatedAt: true, finishedAt: true },
    take: 5000,
  });
  const live = new Set<string>();
  let removedFiles = 0;
  let stuck = 0;
  for (const row of rows) {
    if (row.status === "FAILED") {
      if (now - (row.finishedAt ?? row.updatedAt).getTime() > FAILED_KEEP_MS) {
        await fs.promises.rm(path.join(spool, row.inputName), { force: true }).catch(() => {});
        removedFiles++;
        continue;
      }
    } else if (now - row.updatedAt.getTime() > STUCK_ALERT_MS) {
      stuck++;
    }
    live.add(row.inputName);
  }
  for (const name of await fs.promises.readdir(spool).catch(() => [] as string[])) {
    if (live.has(name)) continue;
    const full = path.join(spool, name);
    const st = await fs.promises.stat(full).catch(() => null);
    if (st?.isFile() && now - st.mtimeMs > ORPHAN_KEEP_MS) {
      await fs.promises.rm(full, { force: true }).catch(() => {});
      removedFiles++;
    }
  }
  const removedRows = (
    await prisma.outgoingMediaJob.deleteMany({
      where: { status: { in: ["SENT", "CANCELLED", "FAILED"] }, createdAt: { lt: new Date(now - ROW_KEEP_MS) } },
    })
  ).count;
  if (stuck) {
    void logSystemError("background-jobs", `Очередь отправки файлов клиентам: ${stuck} шт. ждут или сжимаются дольше 20 минут`, {
      dedupKey: "outgoing-media-stuck",
    });
  }
  return { removedFiles, removedRows, stuck };
}
