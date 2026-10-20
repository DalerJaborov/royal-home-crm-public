import { z } from "zod";
import { UPLOAD_VIDEO_MAX_BYTES } from "./uploadLimits.js";

/**
 * СВОБОДНЫЕ РОЛИКИ В СОЦСЕТИ (12.10.2026, владелец: «обычный промо-ролик без
 * объекта — как мне самому добавить ролик из CRM, чтобы он ушёл во все сети»).
 *
 * Здесь живёт ВСЁ, что сервер и экран обязаны понимать одинаково:
 *  - список каналов и их подписи;
 *  - лимиты площадок на ролик (длительность, размер, подпись) С ИСТОЧНИКОМ И ДАТОЙ
 *    СВЕРКИ — не из памяти, а из документации площадок;
 *  - ОДНА функция `evaluateVideoForChannel`: пригоден ли ролик для канала. Её зовёт
 *    сервер перед публикацией (отказ — 409 с причиной) и экран ещё до загрузки файла
 *    (кнопка не даёт нажать то, что площадка всё равно отклонит). Две копии правила
 *    разошлись бы на первой смене лимита — поэтому правило одно, и лежит здесь;
 *  - схемы тел запросов и типы ответов API.
 *
 * ЖИВЫЕ ЛИМИТЫ — ИЗ API, А НЕ ИЗ ЗАШИТЫХ ЧИСЕЛ. Часть цифр зависит от аккаунта и
 * меняется: максимальная длина ролика TikTok (`creator_info` → `max_video_post_duration_sec`),
 * остаток суточной квоты публикаций Instagram (`content_publishing_limit`), потолок
 * отправки Telegram (свой Bot API сервер — 2000 МБ, обычный — 50 МБ). Их сервер спрашивает
 * у самих площадок (`GET /social-videos/channels/live`) и передаёт сюда как
 * `ChannelRuntimeLimits`; зашитые ниже числа — запасные, на случай если площадка не ответила.
 *
 * Сверка с документацией — 12.10.2026 (адреса в `sources` у каждого канала).
 * Пометка «не проверен» означает: площадка числа не публикует или документация
 * противоречит сама себе, и жёсткий отказ на нашей стороне был бы выдумкой.
 */

export const SOCIAL_VIDEO_CHANNELS = ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK", "TELEGRAM", "THREADS"] as const;
export type SocialVideoChannel = (typeof SOCIAL_VIDEO_CHANNELS)[number];

export const SOCIAL_VIDEO_CHANNEL_LABELS: Record<SocialVideoChannel, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
  TELEGRAM: "Telegram",
  THREADS: "Threads",
};

/** Что получится на выходе в каждой сети при хорошем ролике — для подписи под галочкой. */
export const SOCIAL_VIDEO_CHANNEL_FORMATS: Record<SocialVideoChannel, string> = {
  INSTAGRAM: "Reels",
  FACEBOOK: "Reels или видео",
  YOUTUBE: "Shorts",
  TIKTOK: "Видео",
  TELEGRAM: "Видео в канал",
  THREADS: "Видео",
};

export const SOCIAL_VIDEO_STATUSES = ["DRAFT", "SCHEDULED", "PUBLISHING", "DONE", "PARTIAL", "FAILED", "REMOVED"] as const;
export type SocialVideoStatus = (typeof SOCIAL_VIDEO_STATUSES)[number];

export const SOCIAL_VIDEO_STATUS_LABELS: Record<SocialVideoStatus, string> = {
  DRAFT: "Черновик",
  SCHEDULED: "По расписанию",
  PUBLISHING: "Публикуется",
  DONE: "Опубликовано",
  PARTIAL: "Опубликовано частично",
  FAILED: "Не опубликовано",
  REMOVED: "Снят из соцсетей",
};

/** Состояние ОДНОГО канала у одного ролика — это и есть «процесс» на экране. */
export const SOCIAL_VIDEO_CHANNEL_STATES = ["QUEUED", "PUBLISHING", "PUBLISHED", "FAILED", "SKIPPED", "REMOVED"] as const;
export type SocialVideoChannelState = (typeof SOCIAL_VIDEO_CHANNEL_STATES)[number];

export const SOCIAL_VIDEO_CHANNEL_STATE_LABELS: Record<SocialVideoChannelState, string> = {
  QUEUED: "В очереди",
  PUBLISHING: "Публикуется",
  PUBLISHED: "Опубликовано",
  FAILED: "Ошибка",
  SKIPPED: "Пропущено",
  REMOVED: "Снято",
};

/**
 * КУДА ИМЕННО (12.10.2026, владелец: «у нас два Instagram — нужен выбор аккаунта»). Один канал может
 * иметь несколько аккаунтов: два Instagram (таблица MessengerAccount), несколько Telegram-каналов и
 * чатов. `accountId: null` — «аккаунт по умолчанию», ровно как публикуются ролики объектов; именно такой
 * адрес у всех роликов, загруженных до этой правки (ключ без суффикса, результаты остаются на месте).
 */
export interface SocialVideoDestination {
  channel: SocialVideoChannel;
  accountId: string | null;
}

/** Ключ адреса в `results` и в служебных метках: `INSTAGRAM` для аккаунта по умолчанию, `INSTAGRAM:<id>` для выбранного. */
export function destinationKey(channel: SocialVideoChannel, accountId: string | null): string {
  return accountId ? `${channel}:${accountId}` : channel;
}

export function destinationKeyOf(d: SocialVideoDestination): string {
  return destinationKey(d.channel, d.accountId);
}

/** Обратный разбор ключа; незнакомый канал — null. */
export function parseDestinationKey(key: string): SocialVideoDestination | null {
  const colon = key.indexOf(":");
  const channel = (colon < 0 ? key : key.slice(0, colon)) as SocialVideoChannel;
  if (!(SOCIAL_VIDEO_CHANNELS as readonly string[]).includes(channel)) return null;
  return { channel, accountId: colon < 0 ? null : key.slice(colon + 1) || null };
}

/** Один аккаунт канала, который можно выбрать галочкой. */
export interface SocialVideoAccountOption {
  /** Идентификатор для `destinations[].accountId`; null — «по умолчанию» (единственный аккаунт канала). */
  id: string | null;
  label: string;
  /** Ник без «@» (Instagram) — для подписи. */
  username: string | null;
  isDefault: boolean;
  /** Аккаунт можно выбрать; иначе `problem` объясняет почему (токен отключён, нет прав). */
  ready: boolean;
  problem: string | null;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Верхний предел файла, который принимает CRM, — не лимит площадок (они ниже: Instagram 300 МБ, Threads 1 ГБ,
 * Telegram 2 ГБ), а предохранитель приёма. 2 ГБ (владелец 12.10.2026: «а можно лимит убрать?») — как у роликов
 * объектов и потолок нашего Bot API сервера; «2 ГБ минус байт», потому что размер лежит в колонке Int.
 * Число стоит в трёх местах: здесь (оно же подпись на экране и multer), nginx.conf (client_max_body_size)
 * и колонка SocialVideoPost.sizeBytes — поднимать выше 2 ГБ нужно вместе со всеми тремя.
 */
export const SOCIAL_VIDEO_UPLOAD_MAX_BYTES = UPLOAD_VIDEO_MAX_BYTES;
/** Допустимые расширения при загрузке. */
export const SOCIAL_VIDEO_ALLOWED_EXTENSIONS = [".mp4", ".mov", ".m4v"] as const;
/** Не раньше чем через столько минут от «сейчас» можно назначить публикацию по расписанию. */
export const SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES = 2;

export interface ChannelVideoLimits {
  /** Короче — площадка не примет. null — числа нет в документации. */
  minDurationSec: number | null;
  /** Длиннее — площадка не примет (жёсткий потолок формата). null — нет данных. */
  maxDurationSec: number | null;
  maxSizeBytes: number | null;
  /** Длиннее — подпись обрежется (или площадка откажет). */
  maxCaptionChars: number | null;
  /** Правила словами для экрана «куда и что уйдёт». */
  rules: string[];
  /** Суточная квота публикаций: число из документации; живое значение — из API. */
  dailyQuotaHint: string | null;
  sources: { title: string; url: string }[];
  /** ГГГГ-ММ-ДД, когда числа сверены с документацией. */
  verifiedAt: string;
}

export const SOCIAL_VIDEO_LIMITS: Record<SocialVideoChannel, ChannelVideoLimits> = {
  INSTAGRAM: {
    minDurationSec: 3,
    maxDurationSec: 15 * 60,
    maxSizeBytes: 300 * MB,
    maxCaptionChars: 2200,
    rules: [
      "Длительность от 3 секунд до 15 минут",
      "Файл до 300 МБ, MP4 или MOV, кодек H.264 или HEVC",
      "Лучше вертикаль 9:16; ширина не больше 1920 px; 23–60 кадров в секунду",
      "Подпись до 2200 символов, до 30 хештегов",
    ],
    dailyQuotaHint: "до 100 публикаций через API за 24 часа (остаток спрашиваем у Meta)",
    sources: [
      { title: "Instagram Graph API — media (Reels)", url: "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media" },
      { title: "Instagram — публикация и лимит", url: "https://developers.facebook.com/docs/instagram-platform/content-publishing" },
    ],
    verifiedAt: "2026-10-12",
  },
  FACEBOOK: {
    minDurationSec: null,
    maxDurationSec: null,
    maxSizeBytes: null,
    maxCaptionChars: null,
    rules: [
      "Вертикальный ролик 9:16 от 3 до 90 секунд и не меньше 540×960 уходит как Reels",
      "Любой другой ролик уходит обычным видео на Страницу (жёсткий лимит не проверен)",
      "Reels: 24–60 кадров в секунду, H.264/H.265, звук AAC",
    ],
    dailyQuotaHint: null,
    sources: [{ title: "Facebook — публикация Reels", url: "https://developers.facebook.com/docs/video-api/guides/reels-publishing" }],
    verifiedAt: "2026-10-12",
  },
  YOUTUBE: {
    minDurationSec: null,
    maxDurationSec: null,
    maxSizeBytes: null,
    maxCaptionChars: null,
    rules: [
      "Вертикальный или квадратный ролик до 3 минут YouTube сам считает Shorts",
      "Горизонтальный или длиннее 3 минут выйдет обычным видео, не Shorts",
      "Первая строка подписи станет заголовком (до 100 символов), вся подпись — описанием",
    ],
    dailyQuotaHint: "загрузка стоит ≈100 единиц квоты из 10 000 в сутки",
    sources: [
      { title: "YouTube — Shorts до 3 минут", url: "https://support.google.com/youtube/answer/15424877" },
      { title: "YouTube Data API — стоимость квоты", url: "https://developers.google.com/youtube/v3/determine_quota_cost" },
    ],
    verifiedAt: "2026-10-12",
  },
  TIKTOK: {
    minDurationSec: null,
    maxDurationSec: 10 * 60,
    maxSizeBytes: 4 * GB,
    maxCaptionChars: 2200,
    rules: [
      "Максимальную длину ролика TikTok называет для каждого аккаунта (creator_info), по умолчанию до 10 минут",
      "Файл до 4 ГБ; MP4, MOV или WebM; H.264, H.265, VP8 или VP9",
      "Стороны от 360 до 4096 px; 23–60 кадров в секунду",
      "Пока приложение не прошло аудит TikTok, публикация возможна только как «приватная»",
    ],
    dailyQuotaHint: "суточный предел TikTok не называет; при превышении ответит spam_risk_too_many_posts",
    sources: [
      { title: "TikTok — загрузка файла", url: "https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide" },
      { title: "TikTok — Direct Post", url: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post" },
    ],
    verifiedAt: "2026-10-12",
  },
  TELEGRAM: {
    minDurationSec: null,
    maxDurationSec: null,
    maxSizeBytes: 50 * MB,
    maxCaptionChars: 1024,
    rules: [
      "Размер файла — предел нашего Bot API сервера (2000 МБ на своём сервере, 50 МБ на обычном; спрашиваем у сервера)",
      "Подпись до 1024 символов",
    ],
    dailyQuotaHint: null,
    sources: [{ title: "Telegram Bot API — локальный сервер и sendVideo", url: "https://core.telegram.org/bots/api#sendvideo" }],
    verifiedAt: "2026-10-12",
  },
  THREADS: {
    minDurationSec: null,
    maxDurationSec: 5 * 60,
    maxSizeBytes: 1 * GB,
    maxCaptionChars: 500,
    rules: [
      "Длительность до 5 минут, файл до 1 ГБ, MP4 или MOV, кодек H.264 или HEVC",
      "Ширина не больше 1920 px; 23–60 кадров в секунду",
      "Текст до 500 символов",
    ],
    dailyQuotaHint: "до 250 публикаций за 24 часа",
    sources: [{ title: "Threads API — публикации", url: "https://developers.facebook.com/docs/threads/posts" }],
    verifiedAt: "2026-10-12",
  },
};

/** Что известно о файле. Всё, что не удалось измерить, — null (это не «плохо», а «не проверили»). */
export interface SocialVideoFacts {
  durationSec: number | null;
  sizeBytes: number;
  /** Экранные размеры (после разворота по rotation). */
  width: number | null;
  height: number | null;
  /** Название кодека из ffprobe в нижнем регистре: h264, hevc, vp9… */
  videoCodec: string | null;
  hasAudio: boolean | null;
}

/** Живые значения, полученные у самих площадок. Нет значения — действует запасное из SOCIAL_VIDEO_LIMITS. */
export interface ChannelRuntimeLimits {
  /** TikTok: max_video_post_duration_sec из creator_info (0 или нет — не ответил). */
  maxDurationSec?: number | null;
  /** Telegram: потолок отправки нашего Bot API сервера. */
  maxSizeBytes?: number | null;
}

export type SocialVideoVerdictLevel = "OK" | "WARN" | "BLOCK";

export interface ChannelVerdict {
  channel: SocialVideoChannel;
  level: SocialVideoVerdictLevel;
  /** Во что превратится ролик в этой сети: «Reels», «Обычное видео», «Shorts»… */
  format: string;
  /** Причины отказа. Есть хоть одна — публикация в канал заблокирована. */
  blockers: string[];
  /** Публикация пройдёт, но не так, как ждут (обрежется подпись, не станет Shorts…). */
  warnings: string[];
}

export function formatDurationRu(totalSec: number): string {
  const sec = Math.round(totalSec);
  if (sec < 60) return `${sec} с`;
  const minutes = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
}

export function formatBytesRu(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1).replace(".", ",")} ГБ`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

const META_CODECS = new Set(["h264", "hevc", "h265"]);
const TIKTOK_CODECS = new Set(["h264", "hevc", "h265", "vp8", "vp9"]);

function isVerticalReel(facts: SocialVideoFacts): boolean {
  if (facts.width === null || facts.height === null) return false;
  const ratio = facts.width / facts.height;
  // Тот же допуск ±5 % вокруг 9:16, что у сервера (lib/socialPublish.ts::facebookFormatFor).
  return ratio >= 0.535 && ratio <= 0.59;
}

function isVerticalOrSquare(facts: SocialVideoFacts): boolean {
  return facts.width !== null && facts.height !== null && facts.width <= facts.height;
}

/**
 * Пригоден ли ролик для канала. Чистая функция: одинаково считает сервер (перед
 * публикацией) и экран (до загрузки файла). `blockers` — площадка точно откажет
 * (документированный предел); `warnings` — пройдёт, но не так, как ждут, либо
 * документация не даёт жёсткого числа и отказывать за неё было бы выдумкой.
 */
export function evaluateVideoForChannel(
  channel: SocialVideoChannel,
  facts: SocialVideoFacts,
  caption: string,
  runtime: ChannelRuntimeLimits = {}
): ChannelVerdict {
  const limits = SOCIAL_VIDEO_LIMITS[channel];
  const blockers: string[] = [];
  const warnings: string[] = [];
  let format: string = SOCIAL_VIDEO_CHANNEL_FORMATS[channel];

  const { durationSec, sizeBytes, width, height, videoCodec } = facts;
  const maxDuration =
    channel === "TIKTOK" && runtime.maxDurationSec && runtime.maxDurationSec > 0 ? runtime.maxDurationSec : limits.maxDurationSec;
  const maxSize = channel === "TELEGRAM" && runtime.maxSizeBytes && runtime.maxSizeBytes > 0 ? runtime.maxSizeBytes : limits.maxSizeBytes;

  if (durationSec === null) {
    warnings.push("Не удалось измерить длительность ролика — проверьте её сами, площадка может отклонить");
  } else {
    if (limits.minDurationSec !== null && durationSec < limits.minDurationSec) {
      blockers.push(`Ролик ${formatDurationRu(durationSec)} — короче минимума ${formatDurationRu(limits.minDurationSec)}`);
    }
    if (maxDuration !== null && durationSec > maxDuration) {
      const source = channel === "TIKTOK" && runtime.maxDurationSec ? " (лимит вашего аккаунта по данным TikTok)" : "";
      blockers.push(`Ролик ${formatDurationRu(durationSec)} — длиннее предела ${formatDurationRu(maxDuration)}${source}`);
    }
  }

  if (maxSize !== null && sizeBytes > maxSize) {
    blockers.push(`Файл ${formatBytesRu(sizeBytes)} — больше предела ${formatBytesRu(maxSize)}`);
  }

  if (caption.length > 0 && limits.maxCaptionChars !== null && caption.length > limits.maxCaptionChars) {
    warnings.push(`Подпись ${caption.length} символов — в ${SOCIAL_VIDEO_CHANNEL_LABELS[channel]} уйдёт обрезанная до ${limits.maxCaptionChars}`);
  }

  if (channel === "INSTAGRAM" || channel === "THREADS") {
    if (videoCodec !== null && !META_CODECS.has(videoCodec)) {
      blockers.push(`Кодек ${videoCodec.toUpperCase()} не подходит: нужен H.264 или HEVC`);
    }
    if (width !== null && width > 1920) {
      warnings.push(`Ширина ${width} px — Meta принимает до 1920 px, ролик могут отклонить или пережать`);
    }
  }

  if (channel === "FACEBOOK") {
    const reelOk =
      isVerticalReel(facts) &&
      durationSec !== null &&
      durationSec >= 3 &&
      durationSec <= 90 &&
      height !== null &&
      width !== null &&
      height >= 960 &&
      width >= 540;
    format = reelOk ? "Reels" : "Обычное видео";
    if (!reelOk) {
      warnings.push("Не подходит под Reels (нужна вертикаль 9:16, 3–90 с, от 540×960) — выйдет обычным видео на Страницу");
    }
  }

  if (channel === "YOUTUBE") {
    const shorts = isVerticalOrSquare(facts) && durationSec !== null && durationSec <= 180;
    format = shorts ? "Shorts" : "Обычное видео";
    if (!shorts && durationSec !== null) {
      warnings.push("Не вертикальное/квадратное или длиннее 3 минут — выйдет обычным видео, не Shorts");
    }
    const firstLine = caption.split("\n")[0] ?? "";
    if (firstLine.length > 100) warnings.push("Первая строка подписи длиннее 100 символов — заголовок на YouTube обрежется");
  }

  if (channel === "TIKTOK") {
    if (videoCodec !== null && !TIKTOK_CODECS.has(videoCodec)) {
      blockers.push(`Кодек ${videoCodec.toUpperCase()} не подходит: TikTok принимает H.264, H.265, VP8, VP9`);
    }
    if (width !== null && height !== null) {
      if (Math.min(width, height) < 360) blockers.push(`Размер ${width}×${height} — меньшая сторона должна быть не менее 360 px`);
      if (Math.max(width, height) > 4096) blockers.push(`Размер ${width}×${height} — большая сторона должна быть не более 4096 px`);
    }
  }

  const level: SocialVideoVerdictLevel = blockers.length > 0 ? "BLOCK" : warnings.length > 0 ? "WARN" : "OK";
  return { channel, level, format, blockers, warnings };
}

export function evaluateVideoForChannels(
  channels: readonly SocialVideoChannel[],
  facts: SocialVideoFacts,
  caption: string,
  runtime: Partial<Record<SocialVideoChannel, ChannelRuntimeLimits>> = {}
): ChannelVerdict[] {
  return channels.map((channel) => evaluateVideoForChannel(channel, facts, caption, runtime[channel]));
}

// ───────────────────────────── схемы запросов ─────────────────────────────

export const socialVideoChannelSchema = z.enum(SOCIAL_VIDEO_CHANNELS);

const channelsSchema = z
  .array(socialVideoChannelSchema)
  .max(SOCIAL_VIDEO_CHANNELS.length)
  .transform((list) => [...new Set(list)]);

export const socialVideoDestinationSchema = z.object({
  channel: socialVideoChannelSchema,
  accountId: z.string().trim().min(1).max(200).nullable().default(null),
});

/** Список адресов: без повторов; не больше 30 (шесть сетей × несколько аккаунтов). */
const destinationsSchema = z
  .array(socialVideoDestinationSchema)
  .max(30)
  .transform((list) => {
    const seen = new Set<string>();
    return list.filter((d) => {
      const key = destinationKeyOf(d);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

/** Поля формы загрузки (multipart: файл + эти поля; `channels` приходит JSON-строкой). */
export const socialVideoCreateFieldsSchema = z.object({
  title: z.string().trim().min(1, "Название обязательно").max(120),
  caption: z.string().max(8000).default(""),
  brief: z.string().max(2000).optional(),
  channels: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return [] as SocialVideoChannel[];
      try {
        const parsed = channelsSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      } catch {
        // падаем ниже общей ошибкой
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Список каналов — JSON-массив допустимых значений" });
      return z.NEVER;
    }),
  /** Адреса «канал + аккаунт» JSON-строкой; если заданы, главнее `channels`. */
  destinations: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return undefined;
      try {
        const parsed = destinationsSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      } catch {
        // падаем ниже общей ошибкой
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Список адресов — JSON-массив {channel, accountId}" });
      return z.NEVER;
    }),
});

export const socialVideoUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    caption: z.string().max(8000).optional(),
    /** Короткое описание для ИИ; null — стереть. */
    brief: z.string().max(2000).nullable().optional(),
    channels: channelsSchema.optional(),
    /** Адреса «канал + аккаунт»; если заданы, главнее `channels`. */
    destinations: destinationsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Нечего менять" });

export const socialVideoPublishSchema = z
  .object({
    mode: z.enum(["NOW", "SCHEDULE"]),
    /** ISO-время (UTC). Нужно при mode=SCHEDULE. */
    scheduledAt: z.string().datetime().optional(),
    /** Если передан — заменяет выбранные каналы (так экран публикует, не делая отдельного PATCH). */
    channels: channelsSchema.optional(),
    /** Адреса «канал + аккаунт»; если заданы, главнее `channels`. */
    destinations: destinationsSchema.optional(),
  })
  .refine((v) => v.mode !== "SCHEDULE" || Boolean(v.scheduledAt), { message: "Для публикации по расписанию укажите время", path: ["scheduledAt"] });

export const socialVideoRetrySchema = z.object({
  /** Какие упавшие каналы повторить; без поля — все упавшие. */
  channels: channelsSchema.optional(),
  /** Какие упавшие адреса повторить (ключи `destinationKey`); главнее `channels`. */
  keys: z.array(z.string().max(220)).max(30).optional(),
});

/** Добавить адреса к УЖЕ вышедшему ролику (забыли сеть или второй Instagram): запускается публикация только в новые. */
export const socialVideoAddDestinationsSchema = z.object({
  destinations: destinationsSchema.refine((list) => list.length > 0, { message: "Выберите хотя бы один новый адрес" }),
});

/** Снять пост из соцсетей (12.10.2026): без `keys` - все вышедшие адреса, с `keys` - только выбранные. */
export const socialVideoRemoveSchema = z.object({
  keys: z.array(z.string().max(220)).max(30).optional(),
});

/** «Я удалил(а) пост вручную» - для площадок, где программа снять не может (TikTok, второй Instagram). */
export const socialVideoMarkRemovedSchema = z.object({
  keys: z.array(z.string().max(220)).min(1).max(30),
});

export const socialVideoListQuerySchema = z.object({
  status: z.enum(SOCIAL_VIDEO_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

// ───────────────────────────── ИИ: подписи и обложки ─────────────────────────────

export const SOCIAL_VIDEO_CAPTION_TONES = ["SELLING", "FRIENDLY", "PREMIUM", "SHORT"] as const;
export type SocialVideoCaptionTone = (typeof SOCIAL_VIDEO_CAPTION_TONES)[number];
export const SOCIAL_VIDEO_CAPTION_TONE_LABELS: Record<SocialVideoCaptionTone, string> = {
  SELLING: "Продающий",
  FRIENDLY: "Дружелюбный",
  PREMIUM: "Премиум",
  SHORT: "Коротко и ярко",
};

export const SOCIAL_VIDEO_CAPTION_LANGUAGES = ["RU", "TG", "RU_TG"] as const;
export type SocialVideoCaptionLanguage = (typeof SOCIAL_VIDEO_CAPTION_LANGUAGES)[number];
export const SOCIAL_VIDEO_CAPTION_LANGUAGE_LABELS: Record<SocialVideoCaptionLanguage, string> = {
  RU: "Русский",
  TG: "Тоҷикӣ",
  RU_TG: "Русский + тоҷикӣ",
};

/** Сколько вариантов подписи ИИ возвращает за раз (больше не нужно — «Перегенерировать» даёт новые). */
export const SOCIAL_VIDEO_CAPTION_VARIANTS = 3;

export const socialVideoAiCaptionSchema = z.object({
  /** О чём ролик — своими словами, хоть одной строкой. */
  brief: z.string().trim().min(3, "Опишите ролик хотя бы парой слов").max(2000),
  title: z.string().trim().max(120).optional(),
  tone: z.enum(SOCIAL_VIDEO_CAPTION_TONES).default("SELLING"),
  language: z.enum(SOCIAL_VIDEO_CAPTION_LANGUAGES).default("RU"),
  /** Для каких сетей писать: влияет на длину и хештеги. Пусто — универсальная подпись. */
  channels: z.array(socialVideoChannelSchema).max(SOCIAL_VIDEO_CHANNELS.length).default([]),
  /** Подписи, которые уже показывали, — ИИ обязан написать НЕ похожие («Перегенерировать»). */
  avoid: z.array(z.string().max(8000)).max(9).default([]),
});
export type SocialVideoAiCaptionRequest = z.infer<typeof socialVideoAiCaptionSchema>;

export interface SocialVideoAiProviderInfo {
  provider: SocialVideoCoverProvider;
  label: string;
  /** Ключ введён и провайдер можно выбирать; иначе `problem` объясняет почему. */
  available: boolean;
  problem: string | null;
}

/** GET /social-videos/ai-providers */
export interface SocialVideoAiProvidersResponse {
  providers: SocialVideoAiProviderInfo[];
  defaultProvider: SocialVideoCoverProvider;
}

/** Сводка свежих трендов оформления обложек, которую ИИ учитывает при рисовании. GET /social-videos/trends */
export interface SocialVideoTrends {
  /** 4–7 коротких пунктов: что сейчас в тренде (цвет, композиция, свет, стиль). */
  digest: string[];
  /** Когда собрано (ISO). */
  updatedAt: string;
  /** LIVE — найдено поиском в интернете сейчас; FALLBACK — поиск недоступен, взяты вечные правила. */
  source: "LIVE" | "FALLBACK";
  sources: { title: string; url: string }[];
}

/** Чем нарисована текущая обложка — показывается под ней. */
export interface SocialVideoCoverMeta {
  provider: SocialVideoCoverProvider;
  usedFrame: boolean;
  usedTrends: boolean;
}

export interface SocialVideoAiCaptionResponse {
  variants: string[];
}

export const SOCIAL_VIDEO_COVER_MODES = ["NONE", "UPLOAD", "AI"] as const;
export type SocialVideoCoverMode = (typeof SOCIAL_VIDEO_COVER_MODES)[number];
export const SOCIAL_VIDEO_COVER_MODE_LABELS: Record<SocialVideoCoverMode, string> = {
  NONE: "Без обложки",
  UPLOAD: "Своя картинка",
  AI: "Нарисует ИИ",
};

/** Допустимые типы и размер загружаемой обложки. */
export const SOCIAL_VIDEO_COVER_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const SOCIAL_VIDEO_COVER_MAX_BYTES = 10 * 1024 * 1024;

/** Кто рисует обложку. По умолчанию Gemini; ChatGPT (OpenAI) — переключатель. */
export const SOCIAL_VIDEO_COVER_PROVIDERS = ["GEMINI", "OPENAI"] as const;
export type SocialVideoCoverProvider = (typeof SOCIAL_VIDEO_COVER_PROVIDERS)[number];
export const SOCIAL_VIDEO_COVER_PROVIDER_LABELS: Record<SocialVideoCoverProvider, string> = {
  GEMINI: "Gemini (Google)",
  OPENAI: "ChatGPT (OpenAI)",
};
export const SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER: SocialVideoCoverProvider = "GEMINI";

export const socialVideoAiCoverSchema = z.object({
  /** Что нарисовать. Пусто — ИИ возьмёт описание ролика и название. */
  prompt: z.string().trim().max(1000).optional(),
  provider: z.enum(SOCIAL_VIDEO_COVER_PROVIDERS).default(SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER),
  /** Взять кадр из самого ролика как основу (человек, офис, интерьер из видео), а не рисовать «из воздуха». */
  useFrame: z.boolean().default(true),
  /** Учесть свежие тренды оформления обложек (ИИ ищет их в интернете, ответ кэшируется на сутки). */
  useTrends: z.boolean().default(true),
});
export type SocialVideoAiCoverRequest = z.infer<typeof socialVideoAiCoverSchema>;

// ───────────────────────────── типы ответов ─────────────────────────────

export interface SocialVideoChannelResult {
  state: SocialVideoChannelState;
  error: string | null;
  note: string | null;
  postId: string | null;
  /** Ссылка на вышедший пост, если площадка её даёт. */
  url: string | null;
  /** Площадка просит подождать (TikTok): повторить позже, это не поломка. */
  retriable: boolean;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SocialVideoItem {
  id: string;
  title: string;
  caption: string;
  brief: string | null;
  /** Путь файла под /uploads — сервер подписывает его для просмотра в плеере. */
  videoPath: string;
  originalName: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
  videoCodec: string | null;
  coverMode: SocialVideoCoverMode;
  /** Вертикальная обложка 1080×1920 под /uploads (null — обложки нет). */
  coverUrl: string | null;
  /** Чем нарисована обложка (только для режима «ИИ»). */
  coverMeta: SocialVideoCoverMeta | null;
  /** Каналы (уникальные каналы из `destinations`) — для совместимости и счётчиков. */
  channels: SocialVideoChannel[];
  /** Адреса «канал + аккаунт»; у старых роликов — по одному на канал с `accountId: null`. */
  destinations: SocialVideoDestination[];
  status: SocialVideoStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Исход по каждому адресу; ключ — `destinationKey` (`INSTAGRAM` или `INSTAGRAM:<id аккаунта>`). */
  results: Record<string, SocialVideoChannelResult>;
  /** Пригодность ролика к выбранным каналам (по последним известным живым лимитам). */
  verdicts: ChannelVerdict[];
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  /** Только в ответе на загрузку: такой же файл уже загружали раньше (по содержимому). */
  duplicateOf?: SocialVideoDuplicate | null;
}

/** Итог снятия постов: что снято программой, что не вышло, что надо убрать руками. */
export interface SocialVideoRemovalOutcome {
  removed: Array<{ key: string; label: string; note: string | null }>;
  failed: Array<{ key: string; label: string; error: string }>;
  /** Площадка не даёт снять через API - пост надо убрать руками (ссылка, если известна). */
  manual: Array<{ key: string; label: string; reason: string; url: string | null }>;
}

/** Этот же файл уже загружали раньше (по содержимому) - показываем предупреждение после загрузки. */
export interface SocialVideoDuplicate {
  id: string;
  title: string;
  status: SocialVideoStatus;
  createdAt: string;
  /** Адреса, куда прежний ролик уже вышел (подписи), - чтобы не выложить второй раз то же самое. */
  publishedTo: string[];
}

export interface SocialVideoListResponse {
  items: SocialVideoItem[];
  total: number;
  /** Сколько роликов сейчас в каждом статусе — для вкладок-счётчиков. */
  counts: Record<SocialVideoStatus, number>;
}

export interface SocialVideoChannelInfo {
  channel: SocialVideoChannel;
  label: string;
  /** Ключи и токены канала введены в Настройках. */
  connected: boolean;
  /** Канал можно выбирать прямо сейчас; иначе `problem` объясняет почему. */
  ready: boolean;
  problem: string | null;
  limits: ChannelVideoLimits;
  /** Аккаунты канала для выбора. Один аккаунт — выбор не нужен (адрес `accountId: null`). */
  accounts: SocialVideoAccountOption[];
}

export interface SocialVideoChannelLive {
  channel: SocialVideoChannel;
  /** Название аккаунта/канала, который ответил площадке (проверка, что токен жив). */
  account: string | null;
  runtime: ChannelRuntimeLimits;
  /** Суточная квота публикаций по данным API. */
  quota: { used: number; total: number; remaining: number; windowHours: number } | null;
  /** Что не так с каналом по ответу площадки (токен умер, нет прав…). */
  problem: string | null;
  /** Заметка по аккаунту, не блокирующая публикацию (TikTok: только приватные посты и т. п.). */
  note: string | null;
  checkedAt: string;
}
