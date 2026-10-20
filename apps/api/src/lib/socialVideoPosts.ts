import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  SOCIAL_VIDEO_ALLOWED_EXTENSIONS,
  SOCIAL_VIDEO_CHANNELS,
  SOCIAL_VIDEO_CHANNEL_LABELS,
  SOCIAL_VIDEO_CHANNEL_STATES,
  SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER,
  SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES,
  SOCIAL_VIDEO_STATUSES,
  destinationKeyOf,
  evaluateVideoForChannel,
  parseDestinationKey,
  publishedPostLink,
  type ChannelRuntimeLimits,
  type SocialVideoChannel,
  type SocialVideoChannelResult,
  type SocialVideoChannelState,
  type SocialVideoCoverMeta,
  type SocialVideoCoverMode,
  type SocialVideoCoverProvider,
  type SocialVideoDestination,
  type SocialVideoDuplicate,
  type SocialVideoFacts,
  type SocialVideoItem,
  type SocialVideoListResponse,
  type SocialVideoStatus,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { uploadsDir, videoHandoffDir, moveUploadedFile } from "../upload.js";
import { probeMediaInfo, tryRunFfmpeg, type MediaInfo } from "./ffmpeg.js";
import { publishApprovedPost, type PublishChannel, type PublishResult } from "./socialPublish.js";
import { updateOwnerMarks } from "./publishedMarks.js";
import {
  cachedRuntimeLimits,
  describeDestination,
  loadChannelInfos,
  loadChannelLive,
  resolveInstagramTarget,
  resolveTelegramTarget,
  scrub,
} from "./socialVideoChannels.js";
import { removeCoverFiles, writeCoverFiles, SocialVideoCoverError } from "./socialVideoCovers.js";
import { generateSocialVideoCoverImage } from "./socialVideoAi.js";
import { extractVideoFrameJpeg } from "./socialVideoFrame.js";
import { getSocialVideoTrends } from "./socialVideoTrends.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { sendPushToAgent } from "../push.js";

/**
 * СВОБОДНЫЕ РОЛИКИ В СОЦСЕТИ — сервис (12.10.2026).
 *
 * Жизнь ролика: DRAFT → (SCHEDULED →) PUBLISHING → DONE | PARTIAL | FAILED, и из
 * PARTIAL/FAILED через «Повторить» обратно в PUBLISHING; из DONE/PARTIAL/FAILED —
 * «добавить сеть или аккаунт» (публикация только в новые адреса). Саму публикацию делает тот же
 * `publishApprovedPost`, что и у роликов объектов: хозяином пометок страховки от дублей
 * здесь служит строка `SocialVideoPost`, а не `Property` (lib/publishedMarks.ts).
 *
 * КУДА ПУБЛИКУЕМ — АДРЕСА «КАНАЛ + АККАУНТ» (`destinations`): у одного канала бывает несколько
 * аккаунтов (два Instagram, несколько Telegram-каналов). Исход пишется по каждому адресу под ключом
 * `INSTAGRAM` (аккаунт по умолчанию — как у роликов объектов и у всех роликов до этой правки) или
 * `INSTAGRAM:<id аккаунта>`. Повтор поэтому не задвоит пост в аккаунте, где он уже вышел.
 *
 * ПУБЛИКАЦИЯ ИДЁТ В ФОНЕ (очередь, jobs/socialVideoPublish.ts), потому что один заход —
 * это минуты: Instagram ждёт обработку ролика до пяти минут, TikTok грузит кусками.
 * Экран опрашивает ролик раз в три секунды и видит по каждому адресу: в очереди →
 * публикуется → опубликовано (ссылка) | ошибка (текст) | пропущено. Исход каждого
 * адреса записывается СРАЗУ, не в конце: рестарт посреди публикации не теряет память
 * о вышедших постах, а повтор не выкладывает их второй раз (skipChannels/skipKeys).
 *
 * Автоповтора упавших адресов нет намеренно: площадка отказала — человек должен
 * увидеть причину и решить (исправить подпись, подключить канал, подождать). Повтор — кнопка.
 */

export const SOCIAL_VIDEO_PUBLISH_JOB_TYPE = "social-video-publish";

/** Ошибка, которую можно показать человеку как есть: текст по-русски и HTTP-статус. */
export class SocialVideoError extends Error {
  constructor(
    message: string,
    readonly status: number = 409
  ) {
    super(message);
  }
}

const WITH_CREATOR = { createdBy: { select: { id: true, fullName: true } } } satisfies Prisma.SocialVideoPostInclude;
type Row = Prisma.SocialVideoPostGetPayload<{ include: typeof WITH_CREATOR }>;

const ALL_PUBLISH_CHANNELS: PublishChannel[] = [...SOCIAL_VIDEO_CHANNELS];

/** Статусы, из которых ролик можно отправить на публикацию «в первый раз». */
const FIRST_PUBLISH_FROM: SocialVideoStatus[] = ["DRAFT", "SCHEDULED"];
/** Статусы, из которых работает «Повторить». */
const RETRY_FROM: SocialVideoStatus[] = ["FAILED", "PARTIAL"];
/** Статусы, из которых можно ДОБАВИТЬ новые адреса к вышедшему ролику. */
const ADD_FROM: SocialVideoStatus[] = ["DONE", "PARTIAL", "FAILED"];
/** Публикация, которой не дали закончиться дольше этого срока, считается оборванной. */
const STUCK_PUBLISHING_MS = 45 * 60_000;
const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60_000;

// ───────────────────────────── адреса «канал + аккаунт» ─────────────────────────────

/** Без повторов; у Telegram явные чаты вытесняют «по умолчанию» (основной канал + дополнительные одним адресом). */
export function normalizeDestinations(list: readonly SocialVideoDestination[]): SocialVideoDestination[] {
  const seen = new Set<string>();
  const unique: SocialVideoDestination[] = [];
  for (const d of list) {
    const key = destinationKeyOf(d);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ channel: d.channel, accountId: d.accountId });
  }
  const explicitTelegram = unique.some((d) => d.channel === "TELEGRAM" && d.accountId);
  const kept = explicitTelegram ? unique.filter((d) => !(d.channel === "TELEGRAM" && !d.accountId)) : unique;
  const order = (d: SocialVideoDestination) => SOCIAL_VIDEO_CHANNELS.indexOf(d.channel);
  return [...kept].sort((a, b) => order(a) - order(b));
}

/** Адреса ролика: из JSON; у роликов до выбора аккаунтов (null) — по одному на канал с аккаунтом по умолчанию. */
export function parseDestinations(raw: Prisma.JsonValue | null | undefined, channels: readonly string[] | null | undefined): SocialVideoDestination[] {
  const out: SocialVideoDestination[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const channel = (item as Record<string, unknown>).channel;
      const accountId = (item as Record<string, unknown>).accountId;
      if (typeof channel !== "string" || !(SOCIAL_VIDEO_CHANNELS as readonly string[]).includes(channel)) continue;
      out.push({ channel: channel as SocialVideoChannel, accountId: typeof accountId === "string" && accountId ? accountId : null });
    }
  }
  if (out.length === 0) {
    for (const channel of channels ?? []) {
      if ((SOCIAL_VIDEO_CHANNELS as readonly string[]).includes(channel)) out.push({ channel: channel as SocialVideoChannel, accountId: null });
    }
  }
  return normalizeDestinations(out);
}

const channelsOfDestinations = (dests: readonly SocialVideoDestination[]): SocialVideoChannel[] =>
  SOCIAL_VIDEO_CHANNELS.filter((c) => dests.some((d) => d.channel === c));

/** Выбор по каналам (старый вид запроса) → адреса: у канала остаются его уже выбранные аккаунты, у нового — «по умолчанию». */
function destinationsFromChannels(channels: readonly SocialVideoChannel[], existing: readonly SocialVideoDestination[]): SocialVideoDestination[] {
  const out: SocialVideoDestination[] = [];
  for (const channel of channels) {
    const had = existing.filter((d) => d.channel === channel);
    if (had.length > 0) out.push(...had);
    else out.push({ channel, accountId: null });
  }
  return normalizeDestinations(out);
}

const destinationsJson = (dests: readonly SocialVideoDestination[]): Prisma.InputJsonValue => dests as unknown as Prisma.InputJsonValue;

// ───────────────────────────── разбор и показ ─────────────────────────────

export type ResultsMap = Record<string, SocialVideoChannelResult>;

const RESULT_STATES: readonly SocialVideoChannelState[] = SOCIAL_VIDEO_CHANNEL_STATES;

function blankResult(state: SocialVideoChannelState): SocialVideoChannelResult {
  return { state, error: null, note: null, postId: null, url: null, retriable: false, attempts: 0, startedAt: null, finishedAt: null };
}

/** channelResults — JSON из базы: читаем защитно, лишнее выбрасываем. Ключи — адреса (`INSTAGRAM`, `INSTAGRAM:<id>`). */
export function parseResults(raw: Prisma.JsonValue | null | undefined): ResultsMap {
  const out: ResultsMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
    if (!parseDestinationKey(key)) continue;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const state = RESULT_STATES.find((s) => s === r.state);
    if (!state) continue;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    out[key] = {
      state,
      error: str(r.error),
      note: str(r.note),
      postId: str(r.postId),
      url: str(r.url),
      retriable: r.retriable === true,
      attempts: typeof r.attempts === "number" ? r.attempts : 0,
      startedAt: str(r.startedAt),
      finishedAt: str(r.finishedAt),
    };
  }
  return out;
}

export const resultsJson = (results: ResultsMap): Prisma.InputJsonValue => results as unknown as Prisma.InputJsonValue;

function parseCoverMeta(raw: Prisma.JsonValue | null | undefined): SocialVideoCoverMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.provider !== "GEMINI" && r.provider !== "OPENAI") return null;
  return { provider: r.provider, usedFrame: r.usedFrame === true, usedTrends: r.usedTrends === true };
}

function factsOf(row: Pick<Row, "durationSec" | "sizeBytes" | "width" | "height" | "videoCodec" | "hasAudio">): SocialVideoFacts {
  return {
    durationSec: row.durationSec,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    videoCodec: row.videoCodec,
    hasAudio: row.hasAudio,
  };
}

export function presentSocialVideo(row: Row, runtime: Partial<Record<SocialVideoChannel, ChannelRuntimeLimits>> = cachedRuntimeLimits()): SocialVideoItem {
  const destinations = parseDestinations(row.destinations, row.channels);
  const channels = channelsOfDestinations(destinations);
  const facts = factsOf(row);
  const status = (SOCIAL_VIDEO_STATUSES as readonly string[]).includes(row.status) ? (row.status as SocialVideoStatus) : "DRAFT";
  return {
    id: row.id,
    title: row.title,
    caption: row.caption,
    brief: row.brief,
    videoPath: row.videoPath,
    originalName: row.originalName,
    sizeBytes: row.sizeBytes,
    durationSec: row.durationSec,
    width: row.width,
    height: row.height,
    hasAudio: row.hasAudio,
    videoCodec: row.videoCodec,
    coverMode: (["NONE", "UPLOAD", "AI"] as const).find((m) => m === row.coverMode) ?? "NONE",
    coverUrl: row.coverPath,
    coverMeta: row.coverPath ? parseCoverMeta(row.coverMeta) : null,
    channels,
    destinations,
    status,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    results: parseResults(row.channelResults),
    verdicts: channels.map((c) => evaluateVideoForChannel(c, facts, row.caption, runtime[c])),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.fullName } : null,
  };
}

export async function loadRow(id: string): Promise<Row> {
  const row = await prisma.socialVideoPost.findUnique({ where: { id }, include: WITH_CREATOR });
  if (!row || row.deletedAt) throw new SocialVideoError("Ролик не найден или удалён", 404);
  return row;
}

export async function getSocialVideo(id: string): Promise<SocialVideoItem> {
  return presentSocialVideo(await loadRow(id));
}

export async function listSocialVideos(query: { status?: SocialVideoStatus; limit: number; offset: number }): Promise<SocialVideoListResponse> {
  const where: Prisma.SocialVideoPostWhereInput = { deletedAt: null, ...(query.status ? { status: query.status } : {}) };
  const [rows, total, grouped] = await Promise.all([
    prisma.socialVideoPost.findMany({ where, include: WITH_CREATOR, orderBy: [{ updatedAt: "desc" }], take: query.limit, skip: query.offset }),
    prisma.socialVideoPost.count({ where }),
    prisma.socialVideoPost.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(SOCIAL_VIDEO_STATUSES.map((s) => [s, 0])) as Record<SocialVideoStatus, number>;
  for (const g of grouped) {
    if ((SOCIAL_VIDEO_STATUSES as readonly string[]).includes(g.status)) counts[g.status as SocialVideoStatus] = g._count._all;
  }
  const runtime = cachedRuntimeLimits();
  return { items: rows.map((row) => presentSocialVideo(row, runtime)), total, counts };
}

// ───────────────────────────── файлы ─────────────────────────────

const publicToDisk = (publicPath: string): string => path.join(uploadsDir, publicPath.slice("/uploads/".length));

async function removeVideoFile(publicPath: string): Promise<void> {
  if (!/^\/uploads\/handoff\/promo-[0-9a-f-]{36}\.(mp4|mov|m4v)$/.test(publicPath)) return;
  try {
    await fs.promises.rm(publicToDisk(publicPath), { force: true });
  } catch (err) {
    void logSystemError("api", `Свободный ролик: не удалось удалить файл ${publicPath}: ${describeError(err)}`, {
      dedupKey: "social-video-file-rm",
    });
  }
}

function factsFromProbe(info: MediaInfo | null): Pick<Row, "durationSec" | "width" | "height" | "hasAudio" | "videoCodec"> {
  return {
    durationSec: info && info.durationSec > 0 ? info.durationSec : null,
    width: info?.width ?? null,
    height: info?.height ?? null,
    hasAudio: info ? info.hasAudio : null,
    videoCodec: info?.videoCodec ? info.videoCodec.toLowerCase() : null,
  };
}

// ───────────────────────────── создание и правка ─────────────────────────────

/** SHA-256 файла потоком: ролик до 2 ГБ целиком в память не берём. */
function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * «Этот файл уже загружали» (12.10.2026): точное совпадение по содержимому. Ролики, загруженные до появления отпечатка,
 * узнаём по имени файла и длительности (с точностью до 0,2 с) - перепаковка файла размер меняет, поэтому размер не годится.
 * Это предупреждение, а не запрет: повторить тот же ролик можно сознательно.
 */
async function findDuplicate(hash: string, originalName: string, durationSec: number | null): Promise<SocialVideoDuplicate | null> {
  const legacy: Prisma.SocialVideoPostWhereInput[] =
    durationSec !== null
      ? [{ contentHash: null, originalName, durationSec: { gte: durationSec - 0.2, lte: durationSec + 0.2 } }]
      : [];
  const row = await prisma.socialVideoPost.findFirst({
    where: { deletedAt: null, OR: [{ contentHash: hash }, ...legacy] },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, status: true, createdAt: true, channelResults: true },
  });
  if (!row) return null;
  const results = parseResults(row.channelResults);
  const publishedKeys = Object.entries(results).filter(([, r]) => r.state === "PUBLISHED").map(([key]) => key);
  return {
    id: row.id,
    title: row.title,
    status: row.status as SocialVideoStatus,
    createdAt: row.createdAt.toISOString(),
    publishedTo: await Promise.all(publishedKeys.map(labelOfKey)),
  };
}

export async function createSocialVideoFromUpload(input: {
  tmpPath: string;
  originalName: string;
  title: string;
  caption: string;
  brief?: string | null;
  channels: SocialVideoChannel[];
  /** Адреса «канал + аккаунт»; если заданы, главнее `channels`. */
  destinations?: SocialVideoDestination[];
  createdById: string;
}): Promise<SocialVideoItem> {
  const ext = path.extname(input.originalName).toLowerCase();
  try {
    if (!(SOCIAL_VIDEO_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new SocialVideoError(`Файл «${input.originalName}» не подходит: нужен ролик MP4 или MOV`, 422);
    }
    const probe = await probeMediaInfo(input.tmpPath);
    if (probe && !probe.hasVideo) throw new SocialVideoError("В файле нет видео — загрузите ролик MP4 или MOV", 422);

    const contentHash = await hashFile(input.tmpPath);
    const duplicateOf = await findDuplicate(contentHash, input.originalName.slice(0, 200), probe?.durationSec ?? null);
    const id = randomUUID();
    // Перепаковка БЕЗ перекодирования (-c copy): moov-атом в начало файла, лишние дорожки
    // (таймкод/метаданные iPhone) долой. Meta и Telegram забирают файл по ссылке и требуют
    // moov впереди; потерь качества нет, на ролик в сотни МБ уходят секунды. Не вышло —
    // кладём исходник как есть: ролик всё равно может пройти, а отказ даст сама площадка.
    let finalExt = ".mp4";
    let destPublic = `/uploads/handoff/promo-${id}${finalExt}`;
    await fs.promises.mkdir(videoHandoffDir, { recursive: true });
    const remuxed = await tryRunFfmpeg({
      label: "перепаковка свободного ролика",
      timeoutMs: 8 * 60_000,
      // `-f mov` - читаем только как MP4/MOV, а не «по содержимому» любым демуксером ffmpeg (плейлист HLS под видом .mp4).
      args: ["-y", "-f", "mov", "-i", input.tmpPath, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", publicToDisk(destPublic)],
    });
    if (!remuxed) {
      await fs.promises.rm(publicToDisk(destPublic), { force: true }).catch(() => {});
      // Ни перепаковать, ни измерить не вышло - это не видео, а произвольные байты: не кладём их на диск.
      if (!probe) throw new SocialVideoError("Не удалось прочитать файл как видео — загрузите ролик MP4 или MOV", 422);
      finalExt = ext;
      destPublic = `/uploads/handoff/promo-${id}${finalExt}`;
      await moveUploadedFile(input.tmpPath, publicToDisk(destPublic));
    }
    const destDisk = publicToDisk(destPublic);
    try {
      const info = (await probeMediaInfo(destDisk)) ?? probe;
      const sizeBytes = (await fs.promises.stat(destDisk)).size;
      const dests = input.destinations ? normalizeDestinations(input.destinations) : destinationsFromChannels(input.channels, []);
      const row = await prisma.socialVideoPost.create({
        data: {
          id,
          title: input.title,
          caption: input.caption,
          brief: input.brief?.trim() || null,
          videoPath: destPublic,
          originalName: input.originalName.slice(0, 200),
          sizeBytes,
          contentHash,
          ...factsFromProbe(info),
          channels: channelsOfDestinations(dests),
          destinations: destinationsJson(dests),
          createdById: input.createdById,
        },
        include: WITH_CREATOR,
      });
      return { ...presentSocialVideo(row), duplicateOf };
    } catch (err) {
      // Запись не создалась - файл-сирота на диске не нужен никому.
      await fs.promises.rm(destDisk, { force: true }).catch(() => {});
      throw err;
    }
  } finally {
    // Временный файл загрузчика — ответственность обработчика (upload.ts): убираем в любом исходе.
    await fs.promises.rm(input.tmpPath, { force: true }).catch(() => {});
  }
}

export async function updateSocialVideo(
  id: string,
  patch: { title?: string; caption?: string; brief?: string | null; channels?: SocialVideoChannel[]; destinations?: SocialVideoDestination[] }
): Promise<SocialVideoItem> {
  const row = await loadRow(id);
  if (row.status === "PUBLISHING") throw new SocialVideoError("Ролик сейчас публикуется — дождитесь окончания", 409);
  const touchesContent =
    patch.caption !== undefined || patch.brief !== undefined || patch.channels !== undefined || patch.destinations !== undefined;
  if (row.status === "DONE" && touchesContent) {
    throw new SocialVideoError("Ролик уже опубликован — подпись и адреса менять нельзя (можно изменить только название)", 409);
  }

  const data: Prisma.SocialVideoPostUpdateManyMutationInput = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.caption !== undefined) data.caption = patch.caption;
  if (patch.brief !== undefined) data.brief = patch.brief?.trim() || null;
  if (patch.destinations !== undefined || patch.channels !== undefined) {
    const current = parseDestinations(row.destinations, row.channels);
    const next = patch.destinations ? normalizeDestinations(patch.destinations) : destinationsFromChannels(patch.channels ?? [], current);
    data.destinations = destinationsJson(next);
    data.channels = channelsOfDestinations(next);
    // Убрали адрес, где ещё ничего не вышло, — его запись об ошибке больше не нужна.
    const keep = new Set(next.map(destinationKeyOf));
    const results = parseResults(row.channelResults);
    for (const key of Object.keys(results)) {
      if (!keep.has(key) && results[key].state !== "PUBLISHED") delete results[key];
    }
    data.channelResults = resultsJson(results);
  }
  // Условная запись: между чтением выше и записью ролик мог уйти в публикацию - тогда не перезаписываем его исходы.
  const written = await prisma.socialVideoPost.updateMany({
    where: { id, deletedAt: null, status: { notIn: touchesContent ? ["PUBLISHING", "DONE"] : ["PUBLISHING"] } },
    data,
  });
  if (written.count !== 1) throw new SocialVideoError("Ролик только что изменился — обновите страницу", 409);
  return presentSocialVideo(await loadRow(id));
}

/**
 * КОПИЯ ЧЕРНОВИКОМ: тот же файл, подпись, адреса и обложка, без исходов публикации. Для регулярных промо
 * («тот же ролик с другой подписью или в другое время») — без повторной загрузки сотен мегабайт.
 */
export async function copySocialVideo(id: string, createdById: string): Promise<SocialVideoItem> {
  const row = await loadRow(id);
  const newId = randomUUID();
  const ext = path.extname(row.videoPath).toLowerCase();
  const destPublic = `/uploads/handoff/promo-${newId}${ext}`;
  try {
    await fs.promises.copyFile(publicToDisk(row.videoPath), publicToDisk(destPublic));
  } catch {
    throw new SocialVideoError("Файл исходного ролика пропал с сервера — копию сделать нельзя", 409);
  }
  let cover: { coverPath: string; coverSquarePath: string } | null = null;
  if (row.coverPath) {
    try {
      cover = await writeCoverFiles(newId, await fs.promises.readFile(publicToDisk(row.coverPath)));
    } catch {
      cover = null; // обложка не скопировалась — копия без неё, а не отказ
    }
  }
  const dests = parseDestinations(row.destinations, row.channels);
  try {
    const created = await prisma.socialVideoPost.create({
      data: {
        id: newId,
        title: `${row.title} (копия)`.slice(0, 120),
        caption: row.caption,
        brief: row.brief,
        videoPath: destPublic,
        originalName: row.originalName,
        sizeBytes: row.sizeBytes,
        durationSec: row.durationSec,
        width: row.width,
        height: row.height,
        hasAudio: row.hasAudio,
        videoCodec: row.videoCodec,
        coverMode: cover ? row.coverMode : "NONE",
        coverPath: cover?.coverPath ?? null,
        coverSquarePath: cover?.coverSquarePath ?? null,
        ...(cover && row.coverMeta ? { coverMeta: row.coverMeta as Prisma.InputJsonValue } : {}),
        channels: channelsOfDestinations(dests),
        destinations: destinationsJson(dests),
        createdById,
      },
      include: WITH_CREATOR,
    });
    return presentSocialVideo(created);
  } catch (err) {
    await removeVideoFile(destPublic);
    await removeCoverFiles([cover?.coverPath, cover?.coverSquarePath]);
    throw err;
  }
}

// ───────────────────────────── обложка ─────────────────────────────

async function assertCoverEditable(id: string): Promise<Row> {
  const row = await loadRow(id);
  if (row.status === "PUBLISHING") throw new SocialVideoError("Ролик сейчас публикуется — обложку менять поздно", 409);
  if (row.status === "DONE") throw new SocialVideoError("Ролик уже опубликован — обложку менять нельзя", 409);
  return row;
}

async function swapCover(row: Row, mode: SocialVideoCoverMode, image: Buffer, meta: SocialVideoCoverMeta | null): Promise<SocialVideoItem> {
  let files;
  try {
    files = await writeCoverFiles(row.id, image);
  } catch (err) {
    if (err instanceof SocialVideoCoverError) throw new SocialVideoError(err.message, 422);
    throw err;
  }
  // Обложку рисовали до полутора минут: за это время ролик могли удалить или отправить в публикацию.
  const written = await prisma.socialVideoPost.updateMany({
    where: { id: row.id, deletedAt: null, status: { notIn: ["PUBLISHING", "DONE"] } },
    data: {
      coverMode: mode,
      coverPath: files.coverPath,
      coverSquarePath: files.coverSquarePath,
      coverMeta: meta ? (meta as unknown as Prisma.InputJsonValue) : (null as unknown as Prisma.InputJsonValue),
    },
  });
  if (written.count !== 1) {
    await removeCoverFiles([files.coverPath, files.coverSquarePath]);
    throw new SocialVideoError("Ролик только что изменился — обложку не сохранили, попробуйте ещё раз", 409);
  }
  await removeCoverFiles([row.coverPath, row.coverSquarePath]);
  return presentSocialVideo(await loadRow(row.id));
}

export async function setUploadedCover(id: string, image: Buffer): Promise<SocialVideoItem> {
  return swapCover(await assertCoverEditable(id), "UPLOAD", image, null);
}

/**
 * Обложка от ИИ. По умолчанию рисует Gemini, переключатель — ChatGPT. Основой может быть кадр самого
 * ролика (человек и сцена из видео), а промт учитывает свежие тренды оформления (поиск Google, кэш на сутки).
 * Что реально использовано, записывается в `coverMeta` и показывается под обложкой.
 */
export async function setAiCover(
  id: string,
  opts: { prompt?: string; provider?: SocialVideoCoverProvider; useFrame?: boolean; useTrends?: boolean } = {}
): Promise<SocialVideoItem> {
  const row = await assertCoverEditable(id);
  const provider = opts.provider ?? SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER;
  const frameImage = opts.useFrame === false ? null : await extractVideoFrameJpeg(publicToDisk(row.videoPath));
  const trends = opts.useTrends === false ? null : await getSocialVideoTrends();
  const generated = await generateSocialVideoCoverImage({ title: row.title, brief: row.brief, prompt: opts.prompt ?? null, provider, frameImage, trends });
  return swapCover(row, "AI", generated.buffer, {
    provider: generated.provider,
    usedFrame: generated.usedFrame,
    usedTrends: generated.usedTrends,
  });
}

export async function clearCover(id: string): Promise<SocialVideoItem> {
  const row = await assertCoverEditable(id);
  const written = await prisma.socialVideoPost.updateMany({
    where: { id, deletedAt: null, status: { notIn: ["PUBLISHING", "DONE"] } },
    data: { coverMode: "NONE", coverPath: null, coverSquarePath: null, coverMeta: null as unknown as Prisma.InputJsonValue },
  });
  if (written.count !== 1) throw new SocialVideoError("Ролик только что изменился — обновите страницу", 409);
  await removeCoverFiles([row.coverPath, row.coverSquarePath]);
  return presentSocialVideo(await loadRow(id));
}

// ───────────────────────────── проверка перед публикацией ─────────────────────────────

/**
 * Всё, что должно быть правдой, ПРЕЖДЕ чем ролик уйдёт в сети. Возвращает список причин
 * по-русски; пусто — можно. Живые данные площадок берём из кэша на 60 с: если площадка
 * не ответила, это не повод запретить публикацию (отказ даст она сама), запрещаем только
 * то, что знаем точно — пустую суточную квоту Instagram и документированные пределы ролика.
 */
async function publishProblems(row: Row, dests: SocialVideoDestination[]): Promise<string[]> {
  const problems: string[] = [];
  if (dests.length === 0) return ["Выберите хотя бы один канал"];
  try {
    await fs.promises.access(publicToDisk(row.videoPath));
  } catch {
    return ["Файл ролика пропал с сервера — загрузите ролик заново"];
  }
  const [infos, live] = await Promise.all([
    loadChannelInfos(),
    loadChannelLive().catch((err: unknown) => {
      // Живые данные необязательны для запуска (отказ даст сама площадка), но молча терять причину нельзя.
      void logSystemError("api", `Свободный ролик: живые данные площадок недоступны — ${describeError(err)}`, { dedupKey: "social-video-live" });
      return [];
    }),
  ]);
  const facts = factsOf(row);
  const checkedChannels = new Set<SocialVideoChannel>();
  for (const dest of dests) {
    const label = SOCIAL_VIDEO_CHANNEL_LABELS[dest.channel];
    const info = infos.find((i) => i.channel === dest.channel);
    if (!info || !info.ready) {
      if (!checkedChannels.has(dest.channel)) problems.push(`${label}: ${info?.problem ?? "канал недоступен"}`);
      checkedChannels.add(dest.channel);
      continue;
    }
    // Аккаунт: выбранный должен существовать и быть доступным.
    if (dest.accountId) {
      const option = info.accounts.find((a) => a.id === dest.accountId);
      if (!option) problems.push(`${await describeDestination(dest.channel, dest.accountId)}: аккаунт больше не подключён — выберите другой`);
      else if (!option.ready) problems.push(`${label} · ${option.label}: ${option.problem ?? "аккаунт недоступен"}`);
    } else {
      const option = info.accounts.find((a) => a.id === null);
      // Единственный аккаунт канала называем просто каналом — не «Facebook · Facebook».
      const named = option && info.accounts.length > 1 && option.label !== label ? `${label} · ${option.label}` : label;
      if (option && !option.ready) problems.push(`${named}: ${option.problem ?? "аккаунт недоступен"}`);
    }
    if (checkedChannels.has(dest.channel)) continue;
    checkedChannels.add(dest.channel);
    const liveInfo = live.find((l) => l.channel === dest.channel);
    if (liveInfo?.quota && liveInfo.quota.remaining === 0) problems.push(`${label}: ${liveInfo.problem ?? "суточный лимит публикаций исчерпан"}`);
    const verdict = evaluateVideoForChannel(dest.channel, facts, row.caption, liveInfo?.runtime ?? {});
    for (const blocker of verdict.blockers) problems.push(`${label}: ${blocker}`);
  }
  return problems;
}

function refuse(problems: string[]): never {
  throw new SocialVideoError(problems.join("\n"), 409);
}

// ───────────────────────────── запуск публикации ─────────────────────────────

async function enqueuePublish(id: string): Promise<void> {
  const queued = await enqueueBackgroundJob({
    type: SOCIAL_VIDEO_PUBLISH_JOB_TYPE,
    payload: { id },
    maxAttempts: 2,
    dedupeKey: `${SOCIAL_VIDEO_PUBLISH_JOB_TYPE}:${id}:${Date.now()}`,
  });
  // Очередь отказала (база, выключенный модуль) — публикуем сами: ролик уже помечен
  // PUBLISHING, и оставить его в этом статусе без исполнителя значило бы вечную «публикуется».
  if (!queued.enqueued) {
    runSocialVideoPublish(id).catch((err: unknown) => {
      void logSystemError("api", `Свободный ролик ${id}: запуск публикации без очереди не удался — ${describeError(err)}`, { dedupKey: "social-video-run" });
    });
  }
}

/** Перевод в PUBLISHING одним условным обновлением — вторая кнопка/тик расписания не запустят второй заход. */
async function claimForPublishing(
  row: Row,
  from: SocialVideoStatus[],
  dests: SocialVideoDestination[],
  resetKeys: string[],
  clearSchedule = false
): Promise<boolean> {
  const results = parseResults(row.channelResults);
  for (const dest of dests) {
    const key = destinationKeyOf(dest);
    const current = results[key];
    if (current?.state === "PUBLISHED") continue;
    if (!current || resetKeys.includes(key)) results[key] = { ...blankResult("QUEUED"), attempts: current?.attempts ?? 0 };
  }
  const claimed = await prisma.socialVideoPost.updateMany({
    where: { id: row.id, deletedAt: null, status: { in: from } },
    data: {
      status: "PUBLISHING",
      startedAt: new Date(),
      finishedAt: null,
      channels: channelsOfDestinations(dests),
      destinations: destinationsJson(dests),
      channelResults: resultsJson(results),
      ...(clearSchedule ? { scheduledAt: null } : {}),
    },
  });
  return claimed.count === 1;
}

export async function publishSocialVideo(
  id: string,
  input: { mode: "NOW" | "SCHEDULE"; scheduledAt?: string; channels?: SocialVideoChannel[]; destinations?: SocialVideoDestination[] }
): Promise<SocialVideoItem> {
  const row = await loadRow(id);
  if (!FIRST_PUBLISH_FROM.includes(row.status as SocialVideoStatus)) {
    throw new SocialVideoError(
      row.status === "PUBLISHING"
        ? "Ролик уже публикуется"
        : row.status === "DONE"
          ? "Ролик уже опубликован — чтобы добавить сеть или аккаунт, используйте «Добавить сеть или аккаунт»"
          : "Часть адресов уже пробовали — используйте «Повторить»",
      409
    );
  }
  const current = parseDestinations(row.destinations, row.channels);
  const dests = input.destinations
    ? normalizeDestinations(input.destinations)
    : input.channels
      ? destinationsFromChannels(input.channels, current)
      : current;
  const problems = await publishProblems(row, dests);
  if (problems.length > 0) refuse(problems);

  if (input.mode === "SCHEDULE") {
    const at = new Date(input.scheduledAt ?? "");
    if (Number.isNaN(at.getTime())) throw new SocialVideoError("Неверное время публикации", 422);
    const lead = SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES * 60_000;
    if (at.getTime() < Date.now() + lead) {
      throw new SocialVideoError(`Время публикации — не раньше чем через ${SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES} мин`, 422);
    }
    if (at.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw new SocialVideoError("Дальше чем на год вперёд публикацию не планируем", 422);
    const scheduled = await prisma.socialVideoPost.updateMany({
      where: { id, deletedAt: null, status: { in: FIRST_PUBLISH_FROM } },
      data: { status: "SCHEDULED", scheduledAt: at, channels: channelsOfDestinations(dests), destinations: destinationsJson(dests) },
    });
    if (scheduled.count !== 1) throw new SocialVideoError("Ролик только что изменился — обновите страницу", 409);
    return getSocialVideo(id);
  }

  if (!(await claimForPublishing(row, FIRST_PUBLISH_FROM, dests, [], true))) {
    throw new SocialVideoError("Ролик только что изменился — обновите страницу", 409);
  }
  await enqueuePublish(id);
  return getSocialVideo(id);
}

export async function retrySocialVideo(id: string, only?: SocialVideoChannel[], keys?: string[]): Promise<SocialVideoItem> {
  const row = await loadRow(id);
  if (!RETRY_FROM.includes(row.status as SocialVideoStatus)) {
    throw new SocialVideoError("Повторять нечего: нет адресов с ошибкой", 409);
  }
  const results = parseResults(row.channelResults);
  const dests = parseDestinations(row.destinations, row.channels);
  const targets = dests.filter((d) => {
    const key = destinationKeyOf(d);
    const state = results[key]?.state;
    if (state !== "FAILED" && state !== "SKIPPED") return false;
    if (keys) return keys.includes(key);
    return !only || only.includes(d.channel);
  });
  if (targets.length === 0) throw new SocialVideoError("Повторять нечего: нет адресов с ошибкой", 409);
  const problems = await publishProblems(row, targets);
  if (problems.length > 0) refuse(problems);

  if (!(await claimForPublishing(row, RETRY_FROM, dests, targets.map(destinationKeyOf)))) {
    throw new SocialVideoError("Ролик только что изменился — обновите страницу", 409);
  }
  await enqueuePublish(id);
  return getSocialVideo(id);
}

/**
 * ДОБАВИТЬ СЕТЬ ИЛИ АККАУНТ К ВЫШЕДШЕМУ РОЛИКУ (забыли Threads, нужен второй Instagram): публикация идёт
 * только в НОВЫЕ адреса, уже вышедшие не трогаются. Раньше выход был один — загрузить файл заново, а это путь
 * к дублю поста.
 */
export async function addSocialVideoDestinations(id: string, add: SocialVideoDestination[]): Promise<SocialVideoItem> {
  const row = await loadRow(id);
  if (!ADD_FROM.includes(row.status as SocialVideoStatus)) {
    throw new SocialVideoError(
      row.status === "PUBLISHING" ? "Ролик сейчас публикуется — добавить можно после окончания" : "У черновика просто измените выбор каналов и аккаунтов",
      409
    );
  }
  const results = parseResults(row.channelResults);
  const current = parseDestinations(row.destinations, row.channels);
  const fresh = normalizeDestinations(add).filter((d) => results[destinationKeyOf(d)]?.state !== "PUBLISHED");
  if (fresh.length === 0) throw new SocialVideoError("Эти адреса уже опубликованы", 409);
  // Telegram «по умолчанию» (основной канал + дополнительные чаты одним адресом) и явные чаты накрывают друг друга:
  // если один вид уже вышел, второй добавлять нельзя — пост задвоился бы в тех же чатах.
  const telegramPublishedAsDefault = results.TELEGRAM?.state === "PUBLISHED";
  const telegramPublishedExplicit = Object.entries(results).some(([key, r]) => key.startsWith("TELEGRAM:") && r.state === "PUBLISHED");
  if (
    (telegramPublishedAsDefault && fresh.some((d) => d.channel === "TELEGRAM" && d.accountId)) ||
    (telegramPublishedExplicit && fresh.some((d) => d.channel === "TELEGRAM" && !d.accountId))
  ) {
    throw new SocialVideoError(
      "В Telegram этот ролик уже вышел другим способом (основной канал со всеми чатами или отдельные чаты) — добавление задвоило бы пост",
      409
    );
  }
  const merged = normalizeDestinations([...current, ...fresh]);
  // Нормализация могла вытеснить добавленное (явные чаты Telegram против «по умолчанию») — «тихий успех» без публикации не отдаём.
  const mergedKeys = new Set(merged.map(destinationKeyOf));
  if (!fresh.some((d) => mergedKeys.has(destinationKeyOf(d)))) {
    throw new SocialVideoError("Выбранные адреса пересекаются с уже выбранными — уточните выбор", 409);
  }
  const problems = await publishProblems(row, fresh);
  if (problems.length > 0) refuse(problems);

  if (!(await claimForPublishing(row, ADD_FROM, merged, fresh.map(destinationKeyOf)))) {
    throw new SocialVideoError("Ролик только что изменился — обновите страницу", 409);
  }
  await enqueuePublish(id);
  return getSocialVideo(id);
}

export async function unscheduleSocialVideo(id: string): Promise<SocialVideoItem> {
  await loadRow(id);
  const moved = await prisma.socialVideoPost.updateMany({
    where: { id, deletedAt: null, status: "SCHEDULED" },
    data: { status: "DRAFT", scheduledAt: null },
  });
  if (moved.count !== 1) throw new SocialVideoError("Ролик не стоит в расписании", 409);
  return getSocialVideo(id);
}

export async function deleteSocialVideo(id: string): Promise<void> {
  const row = await loadRow(id);
  if (row.status === "PUBLISHING") throw new SocialVideoError("Ролик сейчас публикуется — удалить можно после окончания", 409);
  const deleted = await prisma.socialVideoPost.updateMany({
    where: { id, deletedAt: null, status: { not: "PUBLISHING" } },
    data: { deletedAt: new Date() },
  });
  if (deleted.count !== 1) throw new SocialVideoError("Ролик только что изменился — обновите страницу", 409);
  await removeVideoFile(row.videoPath);
  await removeCoverFiles([row.coverPath, row.coverSquarePath]);
}

// ───────────────────────────── исполнение (фон) ─────────────────────────────

/** Запись одного адреса в channelResults: читаем свежее, меняем одно место, пишем. Публикация идёт последовательно — гонок нет. */
export async function patchChannel(id: string, key: string, change: (current: SocialVideoChannelResult) => SocialVideoChannelResult): Promise<void> {
  const row = await prisma.socialVideoPost.findUnique({ where: { id }, select: { channelResults: true } });
  if (!row) return;
  const results = parseResults(row.channelResults);
  results[key] = change(results[key] ?? blankResult("QUEUED"));
  await prisma.socialVideoPost.update({ where: { id }, data: { channelResults: resultsJson(results) } });
}

async function recordPublished(id: string, result: PublishResult): Promise<void> {
  const channel = result.channel as SocialVideoChannel;
  const key = result.destinationKey ?? channel;
  const postIds: Record<string, string> = {};
  if (result.postId) postIds[key] = result.postId;
  if (channel === "FACEBOOK" && result.secondaryPostId) postIds.FACEBOOK_POST = result.secondaryPostId;
  if (channel === "THREADS" && result.permalink) postIds.THREADS_URL = result.permalink;
  // Ссылку собирает общее правило (shared) по id под ИМЕНЕМ канала, поэтому для адреса с аккаунтом подставляем его.
  const url = publishedPostLink(channel, {
    instagramUrl: channel === "INSTAGRAM" ? (result.permalink ?? null) : null,
    publishedPostIds: { ...postIds, ...(result.postId ? { [channel]: result.postId } : {}) },
  });

  // СНАЧАЛА исход адреса: пост уже висит, и если дальше что-то упадёт, на экране он обязан быть
  // «опубликован» - иначе «Повторить» выложит его второй раз.
  await patchChannel(id, key, (current) => ({
    ...current,
    state: "PUBLISHED",
    error: null,
    retriable: false,
    note: result.note ? scrub(result.note) : null,
    postId: result.postId ?? null,
    url,
    finishedAt: new Date().toISOString(),
  }));
  try {
    // Метки «где висит» - тем же условным обновлением, что у объектов (lib/publishedMarks.ts).
    await updateOwnerMarks({ kind: "freeVideo", id }, (current) => ({
      channels: current.channels.includes(channel) ? current.channels : [...current.channels, channel],
      postIds: { ...current.postIds, ...postIds },
    }));
    if (key === "INSTAGRAM" && result.permalink) {
      await prisma.socialVideoPost.update({ where: { id }, data: { instagramUrl: result.permalink } });
    }
  } catch (err) {
    void logSystemError("api", `Свободный ролик ${id}: пост в ${key} вышел, но метки не записались — ${describeError(err)}`, { dedupKey: "social-video-marks" });
  }
}

async function recordFailed(id: string, key: string, error: string, retriable = false, note: string | null = null): Promise<void> {
  await patchChannel(id, key, (current) => ({
    ...current,
    state: "FAILED",
    error,
    note,
    retriable,
    finishedAt: new Date().toISOString(),
  }));
}

/** Итог по результатам адресов: все вышли — DONE, часть — PARTIAL, ничего — FAILED. `selected` — ключи адресов. */
export function finalStatusOf(selected: readonly string[], results: ResultsMap): SocialVideoStatus {
  const published = selected.filter((k) => results[k]?.state === "PUBLISHED").length;
  if (selected.length > 0 && published === selected.length) return "DONE";
  return published > 0 ? "PARTIAL" : "FAILED";
}

async function finalize(id: string): Promise<void> {
  const row = await prisma.socialVideoPost.findUnique({
    where: { id },
    select: { channels: true, destinations: true, channelResults: true, status: true, title: true, createdById: true },
  });
  if (!row || row.status !== "PUBLISHING") return;
  const keys = parseDestinations(row.destinations, row.channels).map(destinationKeyOf);
  const results = parseResults(row.channelResults);
  const status = finalStatusOf(keys, results);
  const moved = await prisma.socialVideoPost.updateMany({ where: { id, status: "PUBLISHING" }, data: { status, finishedAt: new Date() } });
  if (moved.count === 1 && row.createdById) await notifyCreator(id, row.createdById, row.title, status, keys, results);
}

const shortText = (text: string, max = 140): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export async function labelOfKey(key: string): Promise<string> {
  const parsed = parseDestinationKey(key);
  return parsed ? describeDestination(parsed.channel, parsed.accountId) : key;
}

/**
 * Итог публикации — тому, кто загрузил ролик. Запланированная публикация идёт без человека
 * у экрана (ночью, в выходной): без уведомления ошибка лежала бы, пока кто-нибудь случайно
 * не откроет раздел. Тихие часы действуют как у всех пушей (отложится до утра).
 */
async function notifyCreator(
  id: string,
  agentId: string,
  title: string,
  status: SocialVideoStatus,
  keys: string[],
  results: ResultsMap
): Promise<void> {
  const published = await Promise.all(keys.filter((k) => results[k]?.state === "PUBLISHED").map(labelOfKey));
  const badKeys = keys.filter((k) => results[k]?.state !== "PUBLISHED");
  const reasons = (await Promise.all(badKeys.map(async (k) => `${await labelOfKey(k)}: ${shortText(results[k]?.error ?? "не вышло")}`))).join("; ");
  const payload =
    status === "DONE"
      ? { title: "Ролик опубликован", body: `«${title}» вышел: ${published.join(", ")}` }
      : status === "PARTIAL"
        ? { title: "Ролик вышел не везде", body: `«${title}»: вышел в ${published.join(", ")}. Не вышел — ${reasons}` }
        : { title: "Ролик не опубликован", body: `«${title}»: ${reasons}` };
  try {
    await sendPushToAgent(agentId, { kind: "task", ...payload, url: "/social-videos", tag: `social-video:${id}` });
  } catch (err) {
    void logSystemError("api", `Свободный ролик ${id}: не удалось уведомить автора об итоге — ${describeError(err)}`, { dedupKey: "social-video-notify" });
  }
}

const inFlight = new Set<string>();

/**
 * Исполнитель задания. Идемпотентен: берёт только адреса, где ещё ничего не вышло и нет
 * зафиксированной ошибки (QUEUED), поэтому повторный заход после падения
 * процесса не выкладывает второй раз то, что уже вышло. `inFlight` не даёт очереди
 * запустить второй заход, пока первый ещё работает (задание может «зависнуть» по таймауту
 * очереди, оставаясь живым).
 */
export async function runSocialVideoPublish(id: string): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    await doRun(id);
  } finally {
    inFlight.delete(id);
  }
}

async function doRun(id: string): Promise<void> {
  try {
    await doRunUnsafe(id);
  } catch (err) {
    // Любой сбой вне публикатора (база, список каналов) - не оставляем ролик «публикуется» на 45 минут.
    const message = scrub(describeError(err));
    void logSystemError("api", `Свободный ролик ${id}: сбой запуска публикации — ${message}`, { dedupKey: "social-video-run-unsafe" });
    const row = await prisma.socialVideoPost.findUnique({ where: { id }, select: { channels: true, destinations: true, channelResults: true, status: true } });
    if (!row || row.status !== "PUBLISHING") return;
    const results = parseResults(row.channelResults);
    for (const key of parseDestinations(row.destinations, row.channels).map(destinationKeyOf)) {
      const state = results[key]?.state;
      if (state === undefined || state === "QUEUED" || state === "PUBLISHING") await recordFailed(id, key, `Сбой запуска публикации: ${message}`);
    }
    await finalize(id);
  }
}

async function doRunUnsafe(id: string): Promise<void> {
  const row = await prisma.socialVideoPost.findUnique({ where: { id } });
  if (!row || row.deletedAt || row.status !== "PUBLISHING") return;
  const dests = parseDestinations(row.destinations, row.channels);
  const results = parseResults(row.channelResults);
  // Адрес в PUBLISHING на старте - значит прошлый заход оборвался именно на нём (текущий процесс его не ведёт,
  // inFlight). Пост мог выйти, а запись не успеть: публиковать вслепую нельзя, у Instagram/Telegram/Threads нет
  // меток страховки от дубля. Человек проверит площадку и нажмёт «Повторить».
  for (const dest of dests) {
    const key = destinationKeyOf(dest);
    if (results[key]?.state === "PUBLISHING") {
      await recordFailed(
        id,
        key,
        "Публикация оборвалась на этом канале (перезапуск сервера) — проверьте, не вышел ли пост на площадке, и при необходимости нажмите «Повторить»"
      );
      results[key] = { ...results[key], state: "FAILED" };
    }
  }
  let todo = dests.filter((d) => {
    const state = results[destinationKeyOf(d)]?.state;
    return state === undefined || state === "QUEUED";
  });
  if (todo.length === 0) {
    await finalize(id);
    return;
  }

  try {
    await fs.promises.access(publicToDisk(row.videoPath));
  } catch {
    for (const d of todo) await recordFailed(id, destinationKeyOf(d), "Файл ролика пропал с сервера — загрузите ролик заново");
    await finalize(id);
    return;
  }

  // Канал или аккаунт, отключённый после постановки, — понятная ошибка, а не молчаливый пропуск публикатора.
  const infos = await loadChannelInfos();
  const stillOk: SocialVideoDestination[] = [];
  for (const d of todo) {
    const info = infos.find((i) => i.channel === d.channel);
    const option = info?.accounts.find((a) => a.id === d.accountId);
    const why = !info?.ready
      ? (info?.problem ?? "Канал недоступен")
      : d.accountId && !option
        ? "Аккаунт больше не подключён — выберите другой"
        : option && !option.ready
          ? (option.problem ?? "Аккаунт недоступен")
          : null;
    if (why) await recordFailed(id, destinationKeyOf(d), why);
    else stillOk.push(d);
  }
  todo = stillOk;

  // Токены и чаты явно выбранных аккаунтов — за публикатора решаем здесь (он их не ищет).
  const igTargets: Array<{ key: string; token: string }> = [];
  const tgTargets: Array<{ key: string; chatId: string }> = [];
  const ready: SocialVideoDestination[] = [];
  for (const d of todo) {
    const key = destinationKeyOf(d);
    if (d.channel === "INSTAGRAM") {
      const target = await resolveInstagramTarget(d.accountId);
      if ("error" in target) await recordFailed(id, key, target.error);
      else {
        igTargets.push({ key, token: target.token });
        ready.push(d);
      }
    } else if (d.channel === "TELEGRAM" && d.accountId) {
      const target = await resolveTelegramTarget(d.accountId);
      if ("error" in target) await recordFailed(id, key, target.error);
      else {
        tgTargets.push({ key, chatId: target.chatId });
        ready.push(d);
      }
    } else {
      ready.push(d);
    }
  }
  todo = ready;

  try {
    if (todo.length > 0) {
      const todoKeys = new Set(todo.map(destinationKeyOf));
      const returned = await publishApprovedPost({
        freeVideoId: id,
        localVideoPath: row.videoPath,
        caption: row.caption,
        localCoverPath: row.coverPath,
        localSquareCoverPath: row.coverSquarePath,
        skipChannels: ALL_PUBLISH_CHANNELS.filter((c) => !todo.some((d) => d.channel === c)),
        skipKeys: dests.map(destinationKeyOf).filter((k) => !todoKeys.has(k)),
        instagramTargets: igTargets.length > 0 ? igTargets : undefined,
        telegramTargets: tgTargets.length > 0 ? tgTargets : undefined,
        onChannelStarted: (_channel, key) =>
          patchChannel(id, key, (current) => ({
            ...current,
            state: "PUBLISHING",
            error: null,
            retriable: false,
            attempts: current.attempts + 1,
            startedAt: new Date().toISOString(),
            finishedAt: null,
          })),
        onChannelPublished: (result) => recordPublished(id, result),
      });
      for (const result of returned) {
        const key = result.destinationKey ?? result.channel;
        if (!result.ok) {
          // Результат без ключа адреса (ранний отказ публикатора, например без адреса сервера) относится ко ВСЕМ адресам канала.
          const failKeys = result.destinationKey
            ? [result.destinationKey]
            : todo.filter((d) => d.channel === result.channel).map(destinationKeyOf);
          for (const failKey of failKeys.length > 0 ? failKeys : [key]) {
            await recordFailed(id, failKey, scrub(result.error ?? "Площадка отказала без объяснения"), Boolean(result.retriable), result.note ? scrub(result.note) : null);
          }
        } else {
          // Вышел, но запись исхода могла не лечь (сбой базы внутри колбэка) - дозаписываем, чтобы не стал «SKIPPED».
          const current = parseResults((await prisma.socialVideoPost.findUnique({ where: { id }, select: { channelResults: true } }))?.channelResults);
          if (current[key]?.state !== "PUBLISHED") await recordPublished(id, result);
        }
      }
      // Адрес выбран, а публикатор про него промолчал (нет ключей, файл вне /uploads) — это не успех.
      const fresh = parseResults((await prisma.socialVideoPost.findUnique({ where: { id }, select: { channelResults: true } }))?.channelResults);
      for (const d of todo) {
        const key = destinationKeyOf(d);
        const state = fresh[key]?.state;
        if (state === "QUEUED" || state === "PUBLISHING") {
          await patchChannel(id, key, (current) => ({
            ...current,
            state: "SKIPPED",
            error: "Площадка не приняла канал в работу: не хватает ключей, настроек или адреса сервера — проверьте «Настройки → Каналы связи»",
            finishedAt: new Date().toISOString(),
          }));
        }
      }
    }
  } catch (err) {
    const message = scrub(describeError(err));
    void logSystemError("meta", `Свободный ролик ${id}: сбой публикации — ${message}`);
    const fresh = parseResults((await prisma.socialVideoPost.findUnique({ where: { id }, select: { channelResults: true } }))?.channelResults);
    for (const d of todo) {
      const key = destinationKeyOf(d);
      const state = fresh[key]?.state;
      if (state === "QUEUED" || state === "PUBLISHING") await recordFailed(id, key, `Сбой при публикации: ${message}`);
    }
  }
  await finalize(id);
}

// ───────────────────────────── расписание ─────────────────────────────

/** Раз в минуту: запускает ролики, чьё время пришло, и снимает оборванные публикации. */
export async function runSocialVideoScheduleTick(now: Date = new Date()): Promise<{ started: number; recovered: number }> {
  let started = 0;
  const due = await prisma.socialVideoPost.findMany({
    where: { status: "SCHEDULED", deletedAt: null, scheduledAt: { lte: now } },
    include: WITH_CREATOR,
    orderBy: { scheduledAt: "asc" },
    take: 10,
  });
  for (const row of due) {
    if (await claimForPublishing(row, ["SCHEDULED"], parseDestinations(row.destinations, row.channels), [])) {
      await enqueuePublish(row.id);
      started += 1;
    }
  }

  let recovered = 0;
  const stuck = await prisma.socialVideoPost.findMany({
    where: { status: "PUBLISHING", deletedAt: null, startedAt: { lt: new Date(now.getTime() - STUCK_PUBLISHING_MS) } },
    select: { id: true, channels: true, destinations: true, channelResults: true },
    take: 10,
  });
  for (const row of stuck) {
    if (inFlight.has(row.id)) continue;
    const results = parseResults(row.channelResults);
    for (const key of parseDestinations(row.destinations, row.channels).map(destinationKeyOf)) {
      const state = results[key]?.state;
      if (state === "QUEUED" || state === "PUBLISHING" || state === undefined) {
        await recordFailed(row.id, key, "Публикация оборвалась (перезапуск сервера) — нажмите «Повторить»");
      }
    }
    await finalize(row.id);
    recovered += 1;
    void logSystemError("meta", `Свободный ролик ${row.id}: публикация оборвалась и снята с ожидания`, { dedupKey: "social-video-stuck" });
  }
  return { started, recovered };
}
