import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "../db.js";
import { photoPostsDir, uploadsDir } from "../upload.js";
import { publicUploadUrl } from "./crmPublicUrl.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { loadPublishScheduleRules } from "./publishScheduleRules.js";
import { nextPublishSlot } from "./publishSchedule.js";
import { loadOccupiedPublishSlots } from "./publishSlots.js";
import { PUBLISH_SLOT_LOCK_ID } from "./videoHandoff.js";
import { isInstagramLink, NO_INSTAGRAM_LINK_WHERE } from "./instagramLink.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { coverUrlsFor } from "./video/coverOpenAi.js";
import {
  reelsCaptionValuesFromProperty,
  generateReelsCaptionFromTemplates,
  withPostFooter,
  applyContactFooter,
  type CaptionAgent,
} from "./reelsCaptionTemplate.js";
import { loadMoneyContext } from "./money.js";
import {
  loadCredentials,
  instagramApiUrl,
  instagramRequest,
  instagramTokenIdentity,
  fetchWithRetry,
  GRAPH_VERSION,
} from "../messengers/meta.js";
import {
  readJson,
  graphErrorMessage,
  fetchInstagramPermalink,
  deleteInstagramMedia,
  waitForInstagramContainerReady,
  PUBLISH_TIMEOUT_MS,
} from "./socialPublish.js";
import { sendMediaGroupFiles, deleteChannelMessage, isTelegramEnabled } from "../telegram/api.js";
import { decryptSecretSafe } from "../crypto.js";

/**
 * ФОТО-ПОСТЫ ДЛЯ ОБЪЕКТОВ БЕЗ РОЛИКА (28.09.2026, agent-brief.md, решение владельца
 * 26.09.2026) — вся логика здесь, в одном модуле, как и у видео-конвейера
 * (lib/videoHandoff.ts). Карусель Instagram, фото-пост на Странице Facebook и
 * альбом Telegram-канала — из уже загруженных фото объекта, без ролика.
 *
 * ГРАНИЦА С ВИДЕО-КОНВЕЙЕРОМ (правило владельца 24.09.2026: не ломать существующую
 * логику). Публикация ролика (lib/socialPublish.ts::publishApprovedPost) пишет
 * Property.publishedChannels/publishedPostIds/instagramUrl — эти три поля решают,
 * какие каналы публикация ролика вправе пропустить (skipChannels), что видео сняло
 * блокер продажи «нет ссылки на Reels» (blockersForSale, lib/propertyPipeline.ts) и
 * что чинит healInstagramUrl под комментариями. Фото-пост НЕ ролик: живёт в своей
 * таблице (PropertyPhotoPost) и эти три поля не трогает — ни при публикации, ни при
 * снятии. Когда ролик придёт позже, публикуется как обычно, фото-пост остаётся
 * (дубли разных форматов проблемой не считаем, решение владельца 26.09.2026).
 */

export const PHOTO_POST_CHANNELS = ["INSTAGRAM", "FACEBOOK", "TELEGRAM"] as const;
export type PhotoPostChannel = (typeof PHOTO_POST_CHANNELS)[number];

/** До 10 слайдов — предел Instagram-карусели и Telegram-альбома разом:
 *  обложка-квадрат (если есть) занимает первый слайд, остальное — фото по order. */
const MAX_PHOTO_POST_IMAGES = 10;
const INSTAGRAM_CAPTION_MAX = 2200;

// ---------------------------------------------------------------------------
// 1. Подготовка изображений
// ---------------------------------------------------------------------------

const STALE_OUTPUT_AGE_MS = 60 * 60 * 1000;

/** Best-effort: сбой уборки не мешает публикации, файлы подберёт следующая подготовка. */
async function removeStalePhotoPostOutputs(propertyId: string, keep: ReadonlySet<string>): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await fs.readdir(photoPostsDir)) {
      if (!name.startsWith(`${propertyId}-`) || keep.has(name)) continue;
      const file = path.join(photoPostsDir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > STALE_OUTPUT_AGE_MS) await fs.rm(file, { force: true });
    }
  } catch (err) {
    void logSystemError("meta", `Фото-пост объекта ${propertyId}: не удалось убрать устаревшие изображения — ${describeError(err)}`, {
      dedupKey: "photo-post-stale-cleanup",
    });
  }
}

/** Абсолютный путь на диске из `/uploads/...`-адреса, хранимого в базе. */
function diskPathFromUploadUrl(uploadUrl: string): string {
  return path.join(uploadsDir, uploadUrl.replace(/^\/uploads\//, ""));
}

/**
 * Обложка-квадрат (если сгенерирована ChatGPT, lib/video/coverOpenAi.ts) первым
 * слайдом, затем фото объекта по `order`, всего не больше MAX_PHOTO_POST_IMAGES.
 * Instagram принимает только JPEG — исходники объекта хранятся WEBP
 * (PropertyPhoto.url), конвертация через sharp в 1080×1350 (4:5, fit: cover, q85).
 *
 * КЭШ ПО ОТПЕЧАТКУ ИСХОДНИКА: выходной JPEG называется
 * `<propertyId>-<n>-<отпечаток>.jpg` (отпечаток — адрес, mtime и размер входного
 * файла) и перекодируется заново только если исходник на диске новее готового
 * выхода — повторный вызов (ретрай задания, повторная кнопка «Опубликовать
 * сейчас») не гоняет sharp по тем же фото, а удалённое или переставленное фото
 * получает новое имя и не подменяется старым снимком.
 */
export async function preparePhotoPostImages(propertyId: string): Promise<{ paths: string[]; urls: string[] } | null> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      socialCoverSquareUrl: true,
      socialCoverStoryUrl: true,
      photos: { orderBy: { order: "asc" }, select: { url: true } },
    },
  });
  if (!property || property.photos.length === 0) return null;

  await fs.mkdir(photoPostsDir, { recursive: true });

  const cover = coverUrlsFor(property);
  const sourceUrls: string[] = [];
  if (cover.square) sourceUrls.push(cover.square);
  for (const photo of property.photos) sourceUrls.push(photo.url);
  const limited = sourceUrls.slice(0, MAX_PHOTO_POST_IMAGES);

  const paths: string[] = [];
  for (let i = 0; i < limited.length; i++) {
    const inputPath = diskPathFromUploadUrl(limited[i]);
    try {
      const inputStat = await fs.stat(inputPath);
      // Имя выхода несёт отпечаток ИСХОДНИКА (адрес + mtime + размер), а не только
      // индекс слайда: после удаления/перестановки фото под индексом i лежит другой
      // снимок, и прежний `-i.jpg`, новее нового исходника, публиковался вместо него
      // (аудит 04.10.2026, PUB01). Тот же исходник даёт то же имя и кэш работает.
      const fingerprint = createHash("sha1").update(`${limited[i]}|${inputStat.mtimeMs}|${inputStat.size}`).digest("hex").slice(0, 10);
      const outputPath = path.join(photoPostsDir, `${propertyId}-${i}-${fingerprint}.jpg`);
      let needsEncode = true;
      try {
        const outputStat = await fs.stat(outputPath);
        needsEncode = outputStat.mtimeMs < inputStat.mtimeMs;
      } catch {
        needsEncode = true;
      }
      if (needsEncode) {
        await sharp(inputPath).rotate().resize(1080, 1350, { fit: "cover" }).jpeg({ quality: 85 }).toFile(outputPath);
      }
      paths.push(outputPath);
    } catch (err) {
      // Файл пропал с диска (снимок удалили, обложка не досчиталась) — пропускаем
      // этот кадр, а не всю подготовку: остальные фото публикации не мешают.
      void logSystemError("meta", `Фото-пост объекта ${propertyId}: снимок ${path.basename(inputPath)} не удалось подготовить — ${describeError(err)}`, {
        dedupKey: `photo-post-prepare:${propertyId}:${i}`,
      });
    }
  }
  if (paths.length === 0) return null;

  // Выходы прежних исходников этого объекта (удалённое/переставленное фото, старая
  // схема имён `<id>-<n>.jpg`) больше никому не нужны. Час выдержки: Meta могла ещё
  // забирать прежний файл по ссылке, а параллельная публикация держит его путь.
  await removeStalePhotoPostOutputs(propertyId, new Set(paths.map((p) => path.basename(p))));

  // Публичные ссылки нужны Instagram/Facebook (Graph API забирает файл по URL);
  // Telegram публикует с диска и в них не нуждается. CRM_PUBLIC_URL — общая
  // настройка на весь сервер: либо задана для всех путей разом, либо ни для
  // одного, поэтому «частично посчитанные» ссылки хуже пустого списка — и
  // Instagram/Facebook сами скажут об этом честной ошибкой ниже.
  const urls = paths.map((p) => publicUploadUrl(`/uploads/photo-posts/${path.basename(p)}`));
  const allUrlsReady = urls.every((u): u is string => u != null);
  return { paths, urls: allUrlsReady ? (urls as string[]) : [] };
}

// ---------------------------------------------------------------------------
// 2. Подпись
// ---------------------------------------------------------------------------

/** По образцу lib/videoHandoff.ts:2895-2918 — тот же порядок сборки подписи, что
 *  и у публикации ролика, только без общего кода (money грузится здесь заново,
 *  это дешёвый запрос курса, не поход во внешний API). */
export async function photoPostCaption(
  property: {
    reelsCaption: string | null;
    shortId: number;
    type: string;
    rooms: number | null;
    areaSqm: number | string | { toString(): string };
    floor: number | null;
    totalFloors: number | null;
    price: number | string | { toString(): string };
    currency: string;
    condition: string;
    stage?: string | null;
    marketType?: string | null;
    address: string | null;
    landAreaSotka?: number | string | { toString(): string } | null;
    amenities: string[] | null;
    district: { name: string } | null;
  },
  agent: CaptionAgent | null
): Promise<string> {
  const money = await loadMoneyContext();
  const captionBase =
    property.reelsCaption ??
    generateReelsCaptionFromTemplates(
      reelsCaptionValuesFromProperty({
        type: property.type,
        rooms: property.rooms,
        areaSqm: property.areaSqm,
        floor: property.floor,
        totalFloors: property.totalFloors,
        price: property.price,
        currency: property.currency,
        condition: property.condition,
        stage: property.stage ?? null,
        marketType: property.marketType ?? null,
        districtName: property.district?.name ?? "",
        phone: null,
        address: property.address,
        landAreaSotka: property.landAreaSotka,
        amenities: property.amenities,
        money,
      }),
      null
    );
  return withPostFooter(applyContactFooter(captionBase, agent), property.shortId);
}

// ---------------------------------------------------------------------------
// 3. Публикация по каналам
// ---------------------------------------------------------------------------

/** Проще, чем PublishResult в socialPublish.ts (нет channel/note/retriable — они
 *  здесь не нужны): `mediaId` — id публикации/карусели, `secondaryId` — второй
 *  идентификатор канала (у Telegram — список message_id через запятую). */
export interface PhotoPostPublishResult {
  ok: boolean;
  mediaId?: string;
  secondaryId?: string;
  permalink?: string;
  error?: string;
  pending?: boolean;
}

async function publishInstagramContainer(igUserId: string, token: string, containerId: string): Promise<PhotoPostPublishResult> {
  const publishReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/media_publish`), token);
  const publishRes = await fetchWithRetry(
    publishReq.url,
    {
      method: "POST",
      headers: { ...publishReq.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: containerId }),
    },
    PUBLISH_TIMEOUT_MS
  );
  const publishBody = await readJson(publishRes);
  const mediaId = publishBody.id as string | undefined;
  if (!publishRes.ok || !mediaId) {
    return { ok: false, error: graphErrorMessage(publishBody, `HTTP ${publishRes.status}`) };
  }
  const permalink = (await fetchInstagramPermalink(mediaId, token)) ?? undefined;
  return { ok: true, mediaId, permalink };
}

/**
 * 1 фото — обычный `IMAGE`-контейнер; 2-10 — дочерние `is_carousel_item=true`,
 * затем родитель `media_type=CAROUSEL` с `children` через запятую. Тот же
 * протокол ожидания готовности контейнера, что у Reels (publishInstagramReel в
 * socialPublish.ts) — waitForInstagramContainerReady экспортирована оттуда же.
 */
export async function publishInstagramCarousel(
  propertyId: string,
  igUserId: string,
  token: string,
  imageUrls: string[],
  caption: string
): Promise<PhotoPostPublishResult> {
  if (imageUrls.length === 0) return { ok: false, error: "Нет ни одной фотографии для публикации" };
  const igCaption = caption.slice(0, INSTAGRAM_CAPTION_MAX);
  try {
    if (imageUrls.length === 1) {
      const createReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/media`), token);
      const createRes = await fetchWithRetry(
        createReq.url,
        {
          method: "POST",
          headers: { ...createReq.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ image_url: imageUrls[0], caption: igCaption }),
        },
        PUBLISH_TIMEOUT_MS
      );
      const createBody = await readJson(createRes);
      const containerId = createBody.id as string | undefined;
      if (!createRes.ok || !containerId) {
        return { ok: false, error: graphErrorMessage(createBody, `HTTP ${createRes.status}`) };
      }
      const ready = await waitForInstagramContainerReady(containerId, token);
      if (!ready.ok) return { ok: false, error: ready.error, pending: ready.pending };
      return await publishInstagramContainer(igUserId, token, containerId);
    }

    const childIds: string[] = [];
    for (const url of imageUrls.slice(0, MAX_PHOTO_POST_IMAGES)) {
      const childReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/media`), token);
      const childRes = await fetchWithRetry(
        childReq.url,
        {
          method: "POST",
          headers: { ...childReq.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ image_url: url, is_carousel_item: true }),
        },
        PUBLISH_TIMEOUT_MS
      );
      const childBody = await readJson(childRes);
      const childId = childBody.id as string | undefined;
      if (!childRes.ok || !childId) {
        return { ok: false, error: `Не удалось создать слайд карусели: ${graphErrorMessage(childBody, `HTTP ${childRes.status}`)}` };
      }
      childIds.push(childId);
    }

    const parentReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/media`), token);
    const parentRes = await fetchWithRetry(
      parentReq.url,
      {
        method: "POST",
        headers: { ...parentReq.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ media_type: "CAROUSEL", children: childIds.join(","), caption: igCaption }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const parentBody = await readJson(parentRes);
    const containerId = parentBody.id as string | undefined;
    if (!parentRes.ok || !containerId) {
      return { ok: false, error: graphErrorMessage(parentBody, `HTTP ${parentRes.status}`) };
    }
    const ready = await waitForInstagramContainerReady(containerId, token);
    if (!ready.ok) return { ok: false, error: ready.error, pending: ready.pending };
    return await publishInstagramContainer(igUserId, token, containerId);
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Facebook: каждое фото — `POST /{page}/photos` с `published:false` (не
 * появляется в ленте само), затем один `POST /{page}/feed` с `attached_media`
 * собирает их в один пост. БЕЗ fetchWithRetry — тот же довод, что у
 * publishFacebookVideo (socialPublish.ts): обе операции не идемпотентны,
 * повтор на таймауте создал бы вторые копии фото/поста.
 */
export async function publishFacebookPhotoPost(
  pageId: string,
  token: string,
  imageUrls: string[],
  caption: string
): Promise<PhotoPostPublishResult> {
  if (imageUrls.length === 0) return { ok: false, error: "Нет ни одной фотографии для публикации" };
  try {
    const photoIds: string[] = [];
    for (const url of imageUrls.slice(0, MAX_PHOTO_POST_IMAGES)) {
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, published: false, access_token: token }),
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      const body = await readJson(res);
      const id = body.id as string | undefined;
      if (!res.ok || !id) {
        return { ok: false, error: `Не удалось загрузить фото в Facebook: ${graphErrorMessage(body, `HTTP ${res.status}`)}` };
      }
      photoIds.push(id);
    }

    const feedRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: caption,
        attached_media: photoIds.map((id) => ({ media_fbid: id })),
        access_token: token,
      }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const feedBody = await readJson(feedRes);
    const postId = feedBody.id as string | undefined;
    if (!feedRes.ok || !postId) {
      return { ok: false, error: graphErrorMessage(feedBody, `HTTP ${feedRes.status}`) };
    }
    return { ok: true, mediaId: postId, permalink: `https://www.facebook.com/${postId}` };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** Telegram: альбом файлами с диска (sendMediaGroupFiles, до 10), подпись на
 *  первом файле — она и есть подпись альбома. Возвращает message_id всех
 *  сообщений через запятую (secondaryId) — удаление снимает их по одному. */
export async function publishTelegramPhotoPost(chatId: string, paths: string[], caption: string): Promise<PhotoPostPublishResult> {
  if (paths.length === 0) return { ok: false, error: "Нет ни одной фотографии для публикации" };
  try {
    const items = paths.slice(0, MAX_PHOTO_POST_IMAGES).map((p, i) => ({
      type: "photo" as const,
      path: p,
      ...(i === 0 ? { caption } : {}),
    }));
    const sent = await sendMediaGroupFiles(chatId, items);
    return { ok: true, secondaryId: sent.map((m) => String(m.message_id)).join(",") };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

// ---------------------------------------------------------------------------
// 4. Оркестрация публикации объекта
// ---------------------------------------------------------------------------

export interface PhotoPostSummary {
  ok: boolean;
  results: Partial<Record<PhotoPostChannel, PhotoPostPublishResult>>;
  /** Каналы, пропущенные как уже опубликованные (идемпотентность). */
  skipped: PhotoPostChannel[];
  /** Публикация не запускалась вовсе — гейт, нет фото, объект не найден и т.п. */
  reason?: string;
}

async function upsertPhotoPostRecord(
  propertyId: string,
  channel: PhotoPostChannel,
  existingScheduledId: string | undefined,
  data: {
    status: "PUBLISHED" | "FAILED";
    publishedAt?: Date;
    mediaId?: string | null;
    secondaryId?: string | null;
    permalink?: string | null;
    error?: string | null;
  }
): Promise<void> {
  if (existingScheduledId) {
    await prisma.propertyPhotoPost.update({ where: { id: existingScheduledId }, data });
  } else {
    await prisma.propertyPhotoPost.create({ data: { propertyId, channel, ...data } });
  }
}

/**
 * ПУБЛИКАЦИЯ ФОТО-ПОСТА ОБЪЕКТА. Гейт `Settings.photoPostsEnabled` (force
 * обходит только его — та же ручка, что у ручной публикации Историй/TikTok:
 * `force: true` на явном действии человека или на уже решённом фоновом задании).
 * `instagramUrl`/`publishedChannels`/`publishedPostIds` НЕ трогает — см. докстринг
 * файла. Три канала публикуются независимо: отказ одного не мешает остальным, и
 * канал с уже PUBLISHED-записью пропускается (идемпотентность).
 */
export async function publishPropertyPhotoPost(propertyId: string, options?: { force?: boolean }): Promise<PhotoPostSummary> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { photoPostsEnabled: true, telegramChannelId: true },
  });
  if (!options?.force && !settings?.photoPostsEnabled) {
    return { ok: false, results: {}, skipped: [], reason: "Фото-посты выключены в Настройках" };
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      district: true,
      photos: { orderBy: { order: "asc" } },
      intakeAgent: { select: { fullName: true, phone: true } },
      assignedAgent: { select: { fullName: true, phone: true } },
      createdBy: { select: { fullName: true, phone: true } },
      photoPosts: true,
    },
  });
  if (!property || property.deletedAt) {
    return { ok: false, results: {}, skipped: [], reason: "Объект не найден или удалён" };
  }
  // Объект ушёл с продажи, пока слот ждал своего часа (или кнопку нажали на
  // проданном): фото-пост не выходит, а ждущие слоты гасятся — иначе в три канала
  // уезжало «Продаётся…» про проданную или снятую квартиру (аудит 02.10.2026, D1).
  if (property.status !== "AVAILABLE") {
    await cancelScheduledPhotoPosts(property.id);
    return { ok: false, results: {}, skipped: [], reason: "Объект не в продаже — фото-пост не нужен" };
  }
  // Закрытый объект («только для своих клиентов», WizardShell) в соцсети не выходит:
  // планировщик (schedulePhotoPostsTick) и повторы его уже исключают, а ручная кнопка
  // и фоновое задание идут сюда с force и без этой проверки выпускали бы фото
  // закрытого объекта публично (аудит 04.10.2026, PUB10). Ждущие слоты гасим тоже —
  // объект мог стать закрытым уже после постановки в очередь.
  if (property.offSite) {
    await cancelScheduledPhotoPosts(property.id, "объект закрытый (offSite)");
    return { ok: false, results: {}, skipped: [], reason: "Объект закрытый (offSite) — фото-пост не нужен" };
  }
  // «Ролика нет» — то самое условие из §3 задания: финального файла от
  // монтажёра нет, и Reels в Instagram ещё не публиковался. С 02.10.2026 (владелец:
  // «пусть идёт только само видео») ролик «в пути» тоже считается роликом: сырое
  // видео уже у монтажёра или загружено агентом — выйдет Reels, карусель не нужна.
  if (
    property.videoHandoffFinalPath ||
    property.videoHandoffStatus !== "NONE" ||
    property.publishedChannels.includes("INSTAGRAM") ||
    isInstagramLink(property.instagramUrl) ||
    (await prisma.propertyVideo.count({ where: { propertyId } })) > 0
  ) {
    return { ok: false, results: {}, skipped: [], reason: "У объекта есть ролик (или он в работе) — фото-пост не нужен" };
  }

  const already = new Set<PhotoPostChannel>(
    property.photoPosts.filter((p) => p.status === "PUBLISHED").map((p) => p.channel as PhotoPostChannel)
  );
  const toPublish = PHOTO_POST_CHANNELS.filter((c) => !already.has(c));
  if (toPublish.length === 0) {
    return { ok: true, results: {}, skipped: [...already] };
  }

  const prepared = await preparePhotoPostImages(propertyId);
  if (!prepared || prepared.paths.length === 0) {
    return { ok: false, results: {}, skipped: [...already], reason: "У объекта нет ни одной подходящей фотографии" };
  }

  const captionAgent = property.intakeAgent ?? property.assignedAgent ?? property.createdBy ?? null;
  const caption = await photoPostCaption(property, captionAgent);
  const creds = await loadCredentials();
  const results: PhotoPostSummary["results"] = {};

  // Запись, в которую пишем исход — та же, что уже есть по каналу, а не новая
  // (28.09.2026, найдено тестом «повторный вызов не дублирует»): SCHEDULED от
  // тика или FAILED от прошлой попытки обновляются на месте, иначе повтор
  // отказавшего канала копил бы по строке на каждый ретрай. PUBLISHED сюда не
  // попадает — такой канал уже отфильтрован в `already` выше; REMOVED — это
  // снятый исторический пост, ему на смену встаёт свежая строка, не обновление.
  const reusableByChannel = new Map(
    [...property.photoPosts]
      .filter((p) => p.status === "SCHEDULED" || p.status === "FAILED")
      // По возрастанию даты — Map.set() позже перезаписывает раньше, поэтому
      // САМАЯ СВЕЖАЯ запись канала должна идти последней и остаться в карте.
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => [p.channel, p.id] as const)
  );

  if (toPublish.includes("INSTAGRAM")) {
    let r: PhotoPostPublishResult;
    if (!creds.igToken) {
      r = { ok: false, error: "Instagram не подключён в Настройках" };
    } else if (prepared.urls.length === 0) {
      r = { ok: false, error: "Не настроен CRM_PUBLIC_URL — Meta неоткуда забрать фото" };
    } else {
      const identity = await instagramTokenIdentity(creds.igToken);
      r = identity.ok
        ? await publishInstagramCarousel(propertyId, identity.id, creds.igToken, prepared.urls, caption)
        : { ok: false, error: `Не удалось определить аккаунт Instagram: ${identity.error}` };
    }
    results.INSTAGRAM = r;
    await upsertPhotoPostRecord(
      propertyId,
      "INSTAGRAM",
      reusableByChannel.get("INSTAGRAM"),
      r.ok
        ? { status: "PUBLISHED", publishedAt: new Date(), mediaId: r.mediaId ?? null, permalink: r.permalink ?? null, error: null }
        : { status: "FAILED", error: r.error ?? "неизвестная ошибка" }
    );
    // pending — контейнер ещё обрабатывается у Meta, не честный отказ (см.
    // PublishResult.pending в socialPublish.ts) — вторую запись в журнал не шлём.
    if (!r.ok && !r.pending)
      void logSystemError("meta", `Фото-пост в Instagram (объект ${propertyId}) не удался: ${r.error}`, {
        dedupKey: "Фото-пост в Instagram не удался",
      });
  }

  if (toPublish.includes("FACEBOOK")) {
    let r: PhotoPostPublishResult;
    if (!creds.pageToken || !creds.pageId) {
      r = { ok: false, error: "Facebook не подключён в Настройках" };
    } else if (prepared.urls.length === 0) {
      r = { ok: false, error: "Не настроен CRM_PUBLIC_URL — Meta неоткуда забрать фото" };
    } else {
      r = await publishFacebookPhotoPost(creds.pageId, creds.pageToken, prepared.urls, caption);
    }
    results.FACEBOOK = r;
    await upsertPhotoPostRecord(
      propertyId,
      "FACEBOOK",
      reusableByChannel.get("FACEBOOK"),
      r.ok
        ? { status: "PUBLISHED", publishedAt: new Date(), mediaId: r.mediaId ?? null, permalink: r.permalink ?? null, error: null }
        : { status: "FAILED", error: r.error ?? "неизвестная ошибка" }
    );
    if (!r.ok)
      void logSystemError("meta", `Фото-пост в Facebook (объект ${propertyId}) не удался: ${r.error}`, {
        dedupKey: "Фото-пост в Facebook не удался",
      });
  }

  if (toPublish.includes("TELEGRAM")) {
    const channelId = settings?.telegramChannelId?.trim();
    let r: PhotoPostPublishResult;
    if (!channelId || !isTelegramEnabled()) {
      r = { ok: false, error: "Канал Telegram не настроен" };
    } else {
      r = await publishTelegramPhotoPost(channelId, prepared.paths, caption);
    }
    results.TELEGRAM = r;
    await upsertPhotoPostRecord(
      propertyId,
      "TELEGRAM",
      reusableByChannel.get("TELEGRAM"),
      r.ok ? { status: "PUBLISHED", publishedAt: new Date(), secondaryId: r.secondaryId ?? null, error: null } : { status: "FAILED", error: r.error ?? "неизвестная ошибка" }
    );
    if (!r.ok)
      void logSystemError("telegram", `Фото-пост в Telegram (объект ${propertyId}) не удался: ${r.error}`, {
        dedupKey: "Фото-пост в Telegram не удался",
      });
  }

  const ok = Object.values(results).some((r) => r?.ok);
  return { ok, results, skipped: [...already] };
}

// ---------------------------------------------------------------------------
// 5. Снятие
// ---------------------------------------------------------------------------

/**
 * Маркер удаления Instagram (Facebook Login, `metaIgManageToken`) — СВОЯ копия
 * той же настройки, что читает `instagramManageToken()` в
 * lib/publishedVideoFix.ts (приватная функция, не экспортирована). Не
 * импортируем её и не экспортируем оттуда: publishedVideoFix.ts вызывает
 * `removePropertyPhotoPosts` из ЭТОГО модуля (см. её докстринг там же) — второй
 * импорт в обратную сторону завёл бы цикл модулей ради одного чтения настройки.
 */
async function instagramManageTokenForPhotoPosts(): Promise<string | null> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaIgManageToken: true } });
  return decryptSecretSafe(settings?.metaIgManageToken ?? null);
}

/**
 * Telegram отвечает на удаление уже удалённого сообщения «Bad Request: message
 * to delete not found» — та же проверка, что и `isTelegramMessageGone` в
 * lib/publishedVideoFix.ts. СВОЯ копия, а не импорт оттуда (3 строки): этот
 * модуль зовёт `removePropertyPhotoPosts` НЕ ТОЛЬКО он сам — publishedVideoFix.ts
 * тоже вызывает её рядом с removeFromSocial (см. докстринг там же), и импорт в
 * обратную сторону закольцевал бы два модуля друг на друга.
 */
function isPhotoPostTelegramMessageGone(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? "");
  return /message to delete not found/i.test(text);
}

export interface PhotoPostRemovalResult {
  removed: PhotoPostChannel[];
  failed: { channel: PhotoPostChannel; error: string }[];
  manual: { channel: PhotoPostChannel; reason: string }[];
}

/** Слоты, занятые под публикацию, но ещё не вышедшие, — в «снято» (объект ушёл с продажи). */
export async function cancelScheduledPhotoPosts(propertyId: string, reason = "объект ушёл с продажи до публикации"): Promise<void> {
  await prisma.propertyPhotoPost.updateMany({
    where: { propertyId, status: "SCHEDULED" },
    data: { status: "REMOVED", error: reason },
  });
}

/**
 * Снять уже опубликованные фото-посты объекта. Отказ одного канала не мешает
 * остальным (тот же принцип, что у lib/publishedVideoFix.ts::removeFromSocial).
 * Instagram — тем же вызовом, каким видео-конвейер удаляет Reels
 * (deleteInstagramMedia, socialPublish.ts), но БЕЗ поиска по permalink: у
 * фото-поста mediaId уже сохранён при публикации, искать по ленте незачем.
 */
export async function removePropertyPhotoPosts(propertyId: string): Promise<PhotoPostRemovalResult> {
  // Ждущие слоты — тоже снимаются: опубликованного ещё нет, но он выйдет в слот.
  await cancelScheduledPhotoPosts(propertyId);
  const posts = await prisma.propertyPhotoPost.findMany({ where: { propertyId, status: "PUBLISHED" } });
  const removed: PhotoPostChannel[] = [];
  const failed: { channel: PhotoPostChannel; error: string }[] = [];
  const manual: { channel: PhotoPostChannel; reason: string }[] = [];

  for (const post of posts) {
    const channel = post.channel as PhotoPostChannel;
    try {
      if (channel === "INSTAGRAM") {
        if (!post.mediaId) {
          manual.push({ channel, reason: "нет сохранённого id публикации — снимите в приложении" });
          await prisma.propertyPhotoPost.update({ where: { id: post.id }, data: { status: "REMOVED", error: "снять руками — нет id" } });
          continue;
        }
        const token = await instagramManageTokenForPhotoPosts();
        if (!token) {
          manual.push({ channel, reason: "маркер удаления Instagram не настроен — снимите в приложении" });
          await prisma.propertyPhotoPost.update({ where: { id: post.id }, data: { status: "REMOVED", error: "снять руками — нет маркера" } });
          continue;
        }
        const res = await deleteInstagramMedia(post.mediaId, token);
        if (res.ok) {
          removed.push(channel);
          await prisma.propertyPhotoPost.update({ where: { id: post.id }, data: { status: "REMOVED", error: null } });
        } else {
          failed.push({ channel, error: res.error ?? "неизвестная ошибка" });
        }
      } else if (channel === "FACEBOOK") {
        const creds = await loadCredentials();
        if (!post.mediaId || !creds.pageToken) {
          failed.push({ channel, error: !post.mediaId ? "в записи нет id поста Facebook" : "Facebook не подключён в Настройках" });
          continue;
        }
        const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${post.mediaId}?access_token=${encodeURIComponent(creds.pageToken)}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        });
        const body = await readJson(res);
        if (res.ok || res.status === 404) {
          removed.push(channel);
          await prisma.propertyPhotoPost.update({ where: { id: post.id }, data: { status: "REMOVED", error: null } });
        } else {
          failed.push({ channel, error: graphErrorMessage(body, `HTTP ${res.status}`) });
        }
      } else if (channel === "TELEGRAM") {
        const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } });
        const channelId = settings?.telegramChannelId?.trim();
        if (!post.secondaryId || !channelId) {
          failed.push({ channel, error: !post.secondaryId ? "в записи нет id сообщений Telegram" : "канал Telegram не настроен" });
          continue;
        }
        const ids = post.secondaryId
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));
        let ok = true;
        for (const id of ids) {
          try {
            await deleteChannelMessage(channelId, id);
          } catch (err) {
            if (!isPhotoPostTelegramMessageGone(err)) {
              ok = false;
              failed.push({ channel, error: err instanceof Error ? err.message : String(err) });
              break;
            }
          }
        }
        if (ok) {
          removed.push(channel);
          await prisma.propertyPhotoPost.update({ where: { id: post.id }, data: { status: "REMOVED", error: null } });
        }
      }
    } catch (err) {
      failed.push({ channel, error: describeError(err) });
    }
  }

  return { removed, failed, manual };
}

// ---------------------------------------------------------------------------
// 6. Расстановка кандидатов по времени (крон, раз в час)
// ---------------------------------------------------------------------------

export const PHOTO_POST_PUBLISH_JOB_TYPE = "photo-post-publish";

/** Через сколько объект, у которого каналы упали, снова берётся в расстановку. */
const PHOTO_POST_FAILED_RETRY_MS = 24 * 3_600_000;

/**
 * Отказ канала, который повтор не исправит: канал не подключён или не настроен
 * в Настройках. Остальные отказы (сеть, ответ Meta, контейнер ещё обрабатывается)
 * повторяются лесенкой фонового задания (jobs/photoPostPublish.ts).
 */
export function isPhotoPostSetupError(error: string | undefined): boolean {
  return /не подключён в Настройках|Не настроен CRM_PUBLIC_URL|Канал Telegram не настроен/.test(error ?? "");
}

/**
 * Закрыть строки SCHEDULED объекта, которые уже никто не опубликует (Ф5 аудита
 * фона 02.10.2026): публикация не запустилась вовсе или задание сдалось. Без
 * этого объект навсегда выпадал из кандидатов (их фильтр исключает SCHEDULED),
 * а в карточке висело «запланировано».
 */
export async function closeStuckScheduledPhotoPosts(propertyId: string, reason: string): Promise<number> {
  const res = await prisma.propertyPhotoPost.updateMany({
    where: { propertyId, status: "SCHEDULED" },
    data: { status: "FAILED", error: reason.slice(0, 500) },
  });
  return res.count;
}
export const PHOTO_POST_PUBLISH_MAX_ATTEMPTS = 6;

export function photoPostPublishDedupeKey(propertyId: string): string {
  return `photo-post-publish:${propertyId}`;
}

/** Только объект, УЖЕ вышедший в продажу без ролика. AWAITING_VIDEO/EDITING сюда
 *  не входят (владелец, 02.10.2026: «при публикации нового объекта пусть идёт
 *  только само видео»): там ролик делают, и карусель вышла бы рядом с ним. */
const PHOTO_POST_CANDIDATE_STATUSES = ["AVAILABLE"] as const;

/**
 * Кандидаты без ролика, одобренные (или созданные, если постApprovedAt пуст)
 * раньше `photoPostAfterHours` часов назад — одна запись-«заявка» ПО КАНАЛУ
 * (три строки SCHEDULED на объект, не один общий channel="ALL": схема уже
 * определяет channel как INSTAGRAM|FACEBOOK|TELEGRAM, и лишнего значения
 * заводить не стали — идемпотентность и показ в карточке равно проще, когда
 * канал строки совпадает с каналом публикации 1:1).
 *
 * Слот — тем же замком и той же функцией, что у ролика
 * (lib/videoHandoff.ts::schedulePublishAfterAccept, PUBLISH_SLOT_LOCK_ID,
 * lib/publishSlots.ts::loadOccupiedPublishSlots) — фото-посты и ролики делят
 * одну и ту же шкалу времени.
 */
export async function schedulePhotoPostsTick(): Promise<{ scheduled: number }> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { photoPostsEnabled: true, photoPostAfterHours: true },
  });
  if (!settings?.photoPostsEnabled) return { scheduled: 0 };

  const cutoff = new Date(Date.now() - settings.photoPostAfterHours * 3_600_000);
  const candidates = await prisma.property.findMany({
    where: {
      deletedAt: null,
      publishedOnSite: true,
      offSite: false,
      status: { in: [...PHOTO_POST_CANDIDATE_STATUSES] },
      videoHandoffFinalPath: null,
      // Ролик уже передан монтажёру или загружен агентом — он выйдет сам.
      videoHandoffStatus: "NONE",
      videos: { none: {} },
      photos: { some: {} },
      photoPosts: { none: { status: { in: ["SCHEDULED", "PUBLISHED"] } } },
      // Круг, в котором каналы упали, — не чаще раза в сутки (Ф5 аудита фона
      // 02.10.2026). Раньше объект с тремя FAILED снова был кандидатом через
      // час: не настроен CRM_PUBLIC_URL или протух маркер — и каждый час новый
      // круг из трёх строк и записей в журнал, без предела.
      NOT: { photoPosts: { some: { status: "FAILED", updatedAt: { gte: new Date(Date.now() - PHOTO_POST_FAILED_RETRY_MS) } } } },
      OR: [{ postApprovedAt: { not: null, lte: cutoff } }, { postApprovedAt: null, createdAt: { lte: cutoff } }],
      // Рабочая ссылка Instagram в карточке = ролик уже вышел (05.10.2026): страховка ниже
      // смотрела только publishedChannels, и объект с instagramUrl, но без каналов получал
      // карусель поверх своего Reels.
      AND: [NO_INSTAGRAM_LINK_WHERE],
    },
    select: { id: true },
    take: 200,
  });
  if (candidates.length === 0) return { scheduled: 0 };

  const scheduleRules = (await loadPublishScheduleRules()).rules;
  let scheduled = 0;
  for (const candidate of candidates) {
    const now = new Date();
    const scheduledAt = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLISH_SLOT_LOCK_ID}::bigint)`;
      // Гонка с параллельным тиком/публикацией руками — перепроверяем под замком.
      const already = await tx.propertyPhotoPost.findFirst({
        where: { propertyId: candidate.id, status: { in: ["SCHEDULED", "PUBLISHED"] } },
        select: { id: true },
      });
      if (already) return null;
      const occupied = await loadOccupiedPublishSlots(tx, new Date(now.getTime() - scheduleRules.minGapMin * 60_000));
      const computed = nextPublishSlot(now, occupied, scheduleRules);
      await tx.propertyPhotoPost.createMany({
        data: PHOTO_POST_CHANNELS.map((channel) => ({ propertyId: candidate.id, channel, status: "SCHEDULED", scheduledAt: computed.at })),
      });
      return computed.at;
    });
    if (!scheduledAt) continue;
    const enqueued = await enqueueBackgroundJob({
      type: PHOTO_POST_PUBLISH_JOB_TYPE,
      payload: { propertyId: candidate.id },
      maxAttempts: PHOTO_POST_PUBLISH_MAX_ATTEMPTS,
      dedupeKey: photoPostPublishDedupeKey(candidate.id),
      runAt: scheduledAt,
    });
    if (!enqueued.enqueued) {
      void logSystemError("meta", `Объект ${candidate.id}: слот фото-поста выдан, но задание не встало в очередь — досмотрит только следующий тик`);
    }
    scheduled++;
  }
  return { scheduled };
}
