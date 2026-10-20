import {
  SOCIAL_VIDEO_CHANNELS,
  SOCIAL_VIDEO_CHANNEL_LABELS,
  SOCIAL_VIDEO_LIMITS,
  type ChannelRuntimeLimits,
  type SocialVideoAccountOption,
  type SocialVideoChannel,
  type SocialVideoChannelInfo,
  type SocialVideoChannelLive,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { GRAPH_VERSION, fetchWithRetry, instagramTokenIdentity, loadCredentials } from "../messengers/meta.js";
import { getChatMemberStatus, getChatTitle, canBotWriteToChat, isTelegramEnabled, TELEGRAM_BOT_SEND_LIMIT_BYTES } from "../telegram/api.js";
import { parseTelegramChatIds } from "./telegramChats.js";
import { publicUploadUrl } from "./crmPublicUrl.js";
import { describeError } from "./describeError.js";
import {
  checkInstagramPublishingQuota,
  readJson,
  graphErrorMessage,
  tiktokAccessToken,
  tiktokCreatorInfo,
  youtubeAccessGrant,
  type TikTokCredentials,
  type YouTubeCredentials,
} from "./socialPublish.js";

/**
 * КАНАЛЫ СВОБОДНЫХ РОЛИКОВ: ПОДКЛЮЧЕНЫ ЛИ И ЧТО ГОВОРЯТ САМИ ПЛОЩАДКИ (12.10.2026).
 *
 * Два уровня, потому что они стоят по-разному:
 *  - `loadChannelInfos` — БЫСТРО, без сети: введены ли ключи в Настройках. По нему экран
 *    решает, можно ли вообще выбрать канал, и сразу рисует страницу;
 *  - `loadChannelLive` — МЕДЛЕННО (до ~8 с на канал, каналы параллельно): спрашивает
 *    у площадок то, что зависит от аккаунта и меняется само — остаток суточной квоты
 *    Instagram, потолок длины ролика TikTok (`creator_info`), потолок отправки Telegram,
 *    живость токенов. Результат держим 60 с: у TikTok `creator_info` лимитирован
 *    (20 запросов в минуту), а экран может открыться у нескольких человек сразу.
 *
 * Токены и секреты наружу не отдаются никогда; тексты ошибок площадок чистятся от
 * `access_token=…` (Graph кладёт токен в адрес запроса).
 */

const LIVE_TIMEOUT_MS = 8_000;
const LIVE_CACHE_MS = 60_000;

const TOKEN_IN_TEXT = /(access_token|client_secret|refresh_token|token)=[^&\s"']+/gi;
const BOT_TOKEN_IN_PATH = /bot\d+:[\w-]+/g;
const BEARER_TOKEN = /Bearer\s+[\w.~+/=-]+/gi;
/** Чистит от токенов текст, который уйдёт человеку: параметры адреса, токен бота в пути Telegram, заголовок Bearer. */
export function scrub(text: string): string {
  return text.replace(TOKEN_IN_TEXT, "$1=***").replace(BOT_TOKEN_IN_PATH, "bot***").replace(BEARER_TOKEN, "Bearer ***");
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: площадка не ответила за ${Math.round(ms / 1000)} с`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

interface ChannelSettings {
  telegramChannelId: string | null;
  telegramExtraChatIds: string | null;
  youtubeClientId: string | null;
  youtubeClientSecret: string | null;
  youtubeRefreshToken: string | null;
  tiktokClientKey: string | null;
  tiktokClientSecret: string | null;
  tiktokRefreshToken: string | null;
  tiktokPrivacyLevel: string | null;
  threadsUserId: string | null;
  threadsAccessToken: string | null;
}

async function loadChannelSettings(): Promise<ChannelSettings> {
  const row = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      telegramChannelId: true,
      telegramExtraChatIds: true,
      youtubeClientId: true,
      youtubeClientSecret: true,
      youtubeRefreshToken: true,
      tiktokClientKey: true,
      tiktokClientSecret: true,
      tiktokRefreshToken: true,
      tiktokPrivacyLevel: true,
      threadsUserId: true,
      threadsAccessToken: true,
    },
  });
  return {
    telegramChannelId: row?.telegramChannelId ?? null,
    telegramExtraChatIds: row?.telegramExtraChatIds ?? null,
    youtubeClientId: row?.youtubeClientId ?? null,
    youtubeClientSecret: decryptSecretSafe(row?.youtubeClientSecret ?? null) ?? null,
    youtubeRefreshToken: decryptSecretSafe(row?.youtubeRefreshToken ?? null) ?? null,
    tiktokClientKey: row?.tiktokClientKey ?? null,
    tiktokClientSecret: decryptSecretSafe(row?.tiktokClientSecret ?? null) ?? null,
    tiktokRefreshToken: decryptSecretSafe(row?.tiktokRefreshToken ?? null) ?? null,
    tiktokPrivacyLevel: row?.tiktokPrivacyLevel ?? null,
    threadsUserId: row?.threadsUserId ?? null,
    threadsAccessToken: decryptSecretSafe(row?.threadsAccessToken ?? null) ?? null,
  };
}

const SETTINGS_HINT = "Настройки → Каналы связи";

/** Быстрая сводка: что подключено. Без сети. */
export async function loadChannelInfos(): Promise<SocialVideoChannelInfo[]> {
  const [creds, settings] = await Promise.all([loadCredentials(), loadChannelSettings()]);
  // Instagram, Facebook и Threads забирают файл по публичной ссылке CRM — без адреса им нечего скачать.
  const publicUrlOk = publicUploadUrl("/uploads/handoff/check.mp4") !== null;
  // Публикатор (lib/socialPublish.ts::publishApprovedPost) без адреса CRM не берёт в работу НИ ОДИН канал.
  const noPublicUrl = "На сервере не задан CRM_PUBLIC_URL — публикация невозможна";
  const telegramTargets = Boolean(settings.telegramChannelId?.trim()) || parseTelegramChatIds(settings.telegramExtraChatIds, null).length > 0;

  const state: Record<SocialVideoChannel, { connected: boolean; problem: string | null }> = {
    INSTAGRAM: {
      connected: Boolean(creds.igToken),
      problem: !creds.igToken ? `Не подключён — ${SETTINGS_HINT}` : !publicUrlOk ? noPublicUrl : null,
    },
    FACEBOOK: {
      connected: Boolean(creds.pageToken && creds.pageId),
      problem: !(creds.pageToken && creds.pageId) ? `Страница не подключена — ${SETTINGS_HINT}` : !publicUrlOk ? noPublicUrl : null,
    },
    YOUTUBE: {
      connected: Boolean(settings.youtubeRefreshToken && settings.youtubeClientId && settings.youtubeClientSecret),
      problem:
        settings.youtubeRefreshToken && settings.youtubeClientId && settings.youtubeClientSecret
          ? !publicUrlOk
            ? noPublicUrl
            : null
          : `Не подключён — ${SETTINGS_HINT}`,
    },
    TIKTOK: {
      connected: Boolean(settings.tiktokRefreshToken && settings.tiktokClientKey && settings.tiktokClientSecret),
      problem: !(settings.tiktokRefreshToken && settings.tiktokClientKey && settings.tiktokClientSecret)
        ? `Не подключён — ${SETTINGS_HINT}`
        : !settings.tiktokPrivacyLevel
          ? `Не выбран уровень приватности — ${SETTINGS_HINT}`
          : !publicUrlOk
            ? noPublicUrl
            : null,
    },
    TELEGRAM: {
      connected: isTelegramEnabled() && telegramTargets,
      problem: !isTelegramEnabled()
        ? "Бот не настроен на сервере"
        : !telegramTargets
          ? `Не указан канал — ${SETTINGS_HINT}`
          : !publicUrlOk
            ? noPublicUrl
            : null,
    },
    THREADS: {
      connected: Boolean(settings.threadsAccessToken && settings.threadsUserId),
      problem: !(settings.threadsAccessToken && settings.threadsUserId) ? `Не подключён — ${SETTINGS_HINT}` : !publicUrlOk ? noPublicUrl : null,
    },
  };

  const [instagramAccounts, telegramChats] = await Promise.all([loadInstagramAccountOptions(creds.igToken), loadTelegramChatOptions(settings)]);
  const accountsOf = (channel: SocialVideoChannel): SocialVideoAccountOption[] => {
    if (channel === "INSTAGRAM") return instagramAccounts;
    if (channel === "TELEGRAM") return telegramChats;
    // Остальные сети живут на одном аккаунте из Настроек — выбирать нечего (адрес «по умолчанию»).
    return [
      {
        id: null,
        label: SOCIAL_VIDEO_CHANNEL_LABELS[channel],
        username: null,
        isDefault: true,
        ready: state[channel].problem === null,
        problem: state[channel].problem,
      },
    ];
  };

  return SOCIAL_VIDEO_CHANNELS.map((channel) => ({
    channel,
    label: SOCIAL_VIDEO_CHANNEL_LABELS[channel],
    connected: state[channel].connected,
    ready: state[channel].problem === null,
    problem: state[channel].problem,
    limits: SOCIAL_VIDEO_LIMITS[channel],
    accounts: accountsOf(channel),
  }));
}

// ───────────────────────────── аккаунты каналов (выбор «куда») ─────────────────────────────

/**
 * Аккаунты Instagram: таблица MessengerAccount (два и более — «Royal Home» и «Royal Home Info»). Аккаунт по
 * умолчанию отдаётся с `id: null` — это тот же адрес, что у всех роликов объектов и у старых свободных роликов
 * (ключ результата `INSTAGRAM`). Нет ни одной строки — работает одиночный ключ из Настроек, как раньше.
 */
async function loadInstagramAccountOptions(settingsToken: string | undefined): Promise<SocialVideoAccountOption[]> {
  const rows = await prisma.messengerAccount.findMany({
    where: { channel: "INSTAGRAM" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, title: true, username: true, enabled: true, isDefault: true, token: true },
  });
  if (rows.length === 0) {
    return settingsToken ? [{ id: null, label: "Основной аккаунт", username: null, isDefault: true, ready: true, problem: null }] : [];
  }
  // «По умолчанию» — РОВНО тот аккаунт, чей ключ берёт публикатор роликов объектов (messengers/meta.ts::loadCredentials):
  // включённая строка с isDefault, иначе строка с ключом из Настроек. Иначе экран назвал бы «основным» один аккаунт,
  // а пост ушёл бы в другой (или дважды в один и тот же).
  const defaultRow =
    rows.find((r) => r.isDefault && r.enabled && decryptSecretSafe(r.token)) ??
    (settingsToken ? rows.find((r) => decryptSecretSafe(r.token) === settingsToken) : undefined) ??
    null;
  const options: SocialVideoAccountOption[] = rows.map((row) => {
    const hasToken = Boolean(decryptSecretSafe(row.token));
    const isDefault = row === defaultRow;
    return {
      id: isDefault ? null : row.id,
      label: row.title,
      username: row.username,
      isDefault,
      ready: row.enabled && hasToken,
      problem: !row.enabled ? "Аккаунт отключён в Настройках → Каналы связи" : !hasToken ? "Не введён ключ аккаунта" : null,
    };
  });
  // Ключ из Настроек не принадлежит ни одной строке — он и есть «основной аккаунт».
  if (!defaultRow && settingsToken) {
    options.unshift({ id: null, label: "Основной аккаунт (Настройки)", username: null, isDefault: true, ready: true, problem: null });
  }
  return options;
}

/** Токен и подпись аккаунта Instagram для публикатора. `accountId: null` — аккаунт по умолчанию. */
export async function resolveInstagramTarget(accountId: string | null): Promise<{ key: string; token: string; label: string } | { error: string }> {
  if (!accountId) {
    const creds = await loadCredentials();
    return creds.igToken ? { key: "INSTAGRAM", token: creds.igToken, label: "основной аккаунт" } : { error: "Основной аккаунт Instagram не подключён" };
  }
  const row = await prisma.messengerAccount.findFirst({ where: { id: accountId, channel: "INSTAGRAM" }, select: { id: true, title: true, enabled: true, token: true } });
  if (!row) return { error: "Аккаунт Instagram не найден — его убрали из Настроек" };
  if (!row.enabled) return { error: `Аккаунт «${row.title}» отключён в Настройках` };
  const token = decryptSecretSafe(row.token);
  if (!token) return { error: `У аккаунта «${row.title}» не введён ключ` };
  return { key: `INSTAGRAM:${row.id}`, token, label: row.title };
}

/** Подписи чатов Telegram: узнаём у Telegram один раз и держим час; пока не узнали — показываем адрес. */
const telegramTitles = new Map<string, { title: string | null; at: number }>();
const TELEGRAM_TITLE_TTL_MS = 60 * 60_000;

function warmTelegramTitles(ids: string[]): void {
  if (!isTelegramEnabled()) return;
  for (const id of ids) {
    const known = telegramTitles.get(id);
    if (known && Date.now() - known.at < TELEGRAM_TITLE_TTL_MS) continue;
    telegramTitles.set(id, { title: known?.title ?? null, at: Date.now() });
    void withTimeout(getChatTitle(id), 6_000, "Telegram")
      .then((title) => telegramTitles.set(id, { title, at: Date.now() }))
      .catch(() => undefined);
  }
}

export function telegramChatsOf(settings: { telegramChannelId: string | null; telegramExtraChatIds: string | null }): Array<{ id: string; isMain: boolean }> {
  const main = settings.telegramChannelId?.trim() || null;
  const extras = parseTelegramChatIds(settings.telegramExtraChatIds, main);
  return [...(main ? [{ id: main, isMain: true }] : []), ...extras.map((id) => ({ id, isMain: false }))];
}

/**
 * Чаты Telegram. Один чат — выбирать нечего (`id: null`, как у роликов объектов: основной канал плюс
 * дополнительные чаты одним адресом). Два и больше — каждый отдельным аккаунтом с явным chat_id.
 */
async function loadTelegramChatOptions(settings: ChannelSettings): Promise<SocialVideoAccountOption[]> {
  const chats = telegramChatsOf(settings);
  if (!isTelegramEnabled() || chats.length === 0) return [];
  if (chats.length === 1) {
    return [{ id: null, label: "Канал Telegram", username: null, isDefault: true, ready: true, problem: null }];
  }
  warmTelegramTitles(chats.map((c) => c.id));
  return chats.map((chat) => {
    const title = telegramTitles.get(chat.id)?.title ?? null;
    const base = title ?? (chat.id.startsWith("@") ? chat.id : `Чат ${chat.id}`);
    return {
      id: chat.id,
      label: chat.isMain ? `${base} (основной)` : base,
      username: chat.id.startsWith("@") ? chat.id.slice(1) : null,
      isDefault: chat.isMain,
      ready: true,
      problem: null,
    };
  });
}

/** Явно выбранный чат Telegram для публикатора; чата нет в Настройках — ошибка человеку. */
export async function resolveTelegramTarget(chatId: string): Promise<{ key: string; chatId: string; label: string } | { error: string }> {
  const settings = await loadChannelSettings();
  const chat = telegramChatsOf(settings).find((c) => c.id === chatId);
  if (!chat) return { error: "Чат Telegram убрали из Настроек — выберите другой" };
  const title = telegramTitles.get(chat.id)?.title;
  return { key: `TELEGRAM:${chat.id}`, chatId: chat.id, label: title ?? chat.id };
}

/** Подпись адреса для экрана и журнала (в сеть не ходит). */
export async function describeDestination(channel: SocialVideoChannel, accountId: string | null): Promise<string> {
  const base = SOCIAL_VIDEO_CHANNEL_LABELS[channel];
  if (!accountId) return base;
  if (channel === "INSTAGRAM") {
    const row = await prisma.messengerAccount.findFirst({ where: { id: accountId }, select: { title: true } });
    return `${base} · ${row?.title ?? accountId.slice(0, 8)}`;
  }
  if (channel === "TELEGRAM") return `${base} · ${telegramTitles.get(accountId)?.title ?? accountId}`;
  return base;
}

// ───────────────────────────── живые данные площадок ─────────────────────────────

function emptyLive(channel: SocialVideoChannel): SocialVideoChannelLive {
  return { channel, account: null, runtime: {}, quota: null, problem: null, note: null, checkedAt: new Date().toISOString() };
}

/** Ответ Meta приходит JSON-ом на 200 символов — человеку нужен только текст причины. */
function shortMetaError(raw: string): string {
  const message = /"message":"([^"]+)"/.exec(raw)?.[1];
  return scrub(message ?? raw).slice(0, 160);
}

async function liveInstagram(token: string): Promise<SocialVideoChannelLive> {
  const live = emptyLive("INSTAGRAM");
  const identity = await instagramTokenIdentity(token, LIVE_TIMEOUT_MS);
  if (!identity.ok) return { ...live, problem: `Не отвечает: ${shortMetaError(identity.error)}` };
  live.account = identity.username ? `@${identity.username}` : identity.id;
  const limit = await checkInstagramPublishingQuota(identity.id, token);
  if (limit.ok) {
    live.quota = { used: limit.used, total: limit.total, remaining: limit.remaining, windowHours: 24 };
    if (limit.remaining === 0) live.problem = `Суточный лимит публикаций Instagram исчерпан (${limit.used} из ${limit.total}) — подождите до завтра`;
  } else {
    live.note = `Остаток суточной квоты узнать не удалось: ${scrub(limit.error)}`;
  }
  return live;
}

async function liveFacebook(pageId: string, token: string): Promise<SocialVideoChannelLive> {
  const live = emptyLive("FACEBOOK");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}?fields=name&access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithRetry(url, {}, LIVE_TIMEOUT_MS);
  const body = await readJson(res);
  if (!res.ok) return { ...live, problem: `Не принят ключ Страницы: ${scrub(graphErrorMessage(body, `HTTP ${res.status}`))}` };
  live.account = typeof body.name === "string" ? body.name : null;
  return live;
}

async function liveYouTube(settings: ChannelSettings): Promise<SocialVideoChannelLive> {
  const live = emptyLive("YOUTUBE");
  const creds: YouTubeCredentials = {
    clientId: settings.youtubeClientId ?? undefined,
    clientSecret: settings.youtubeClientSecret ?? undefined,
    refreshToken: settings.youtubeRefreshToken ?? undefined,
  };
  let grant: Awaited<ReturnType<typeof youtubeAccessGrant>>;
  try {
    grant = await youtubeAccessGrant(creds);
  } catch (err) {
    return { ...live, problem: scrub(describeError(err)) };
  }
  const canUpload = grant.scopes.length === 0 || grant.scopes.some((s) => /youtube\.upload$|\/auth\/youtube$/.test(s));
  if (!canUpload) {
    return { ...live, problem: "У ключа YouTube нет права загружать видео (youtube.upload) — выпустите ключ заново с этим правом" };
  }
  if (grant.scopes.length > 0 && !grant.scopes.some((s) => /youtube\.force-ssl$|\/auth\/youtube$/.test(s))) {
    live.note = "У ключа YouTube нет права youtube.force-ssl: ролик выйдет, но свою обложку YouTube не поставит";
  }
  return live;
}

async function liveTikTok(settings: ChannelSettings): Promise<SocialVideoChannelLive> {
  const live = emptyLive("TIKTOK");
  const creds: TikTokCredentials = {
    clientKey: settings.tiktokClientKey ?? undefined,
    clientSecret: settings.tiktokClientSecret ?? undefined,
    refreshToken: settings.tiktokRefreshToken ?? undefined,
  };
  const accessToken = await tiktokAccessToken(creds);
  const info = await tiktokCreatorInfo(accessToken);
  live.account = info.creatorUsername ? `@${info.creatorUsername}` : (info.creatorNickname ?? null);
  // Длину ролика называет сам TikTok для ЭТОГО аккаунта (0 — не ответил, тогда действует запасное из shared).
  live.runtime = { maxDurationSec: info.maxVideoPostDurationSec > 0 ? info.maxVideoPostDurationSec : null };
  if (settings.tiktokPrivacyLevel && !info.privacyLevelOptions.includes(settings.tiktokPrivacyLevel)) {
    live.problem = `Аккаунт TikTok не разрешает уровень «${settings.tiktokPrivacyLevel}» — выберите другой в Настройках`;
  } else if (info.privacyLevelOptions.length > 0 && info.privacyLevelOptions.every((o) => o === "SELF_ONLY")) {
    live.note = "TikTok пока разрешает публиковать только «приватно» (приложение не прошло аудит) — ролик увидите только вы";
  }
  return live;
}

async function liveTelegram(settings: ChannelSettings): Promise<SocialVideoChannelLive> {
  const live = emptyLive("TELEGRAM");
  live.runtime = { maxSizeBytes: TELEGRAM_BOT_SEND_LIMIT_BYTES };
  const channelId = settings.telegramChannelId?.trim() || parseTelegramChatIds(settings.telegramExtraChatIds, null)[0] || null;
  if (!channelId) return live;
  try {
    const [title, member] = await Promise.all([getChatTitle(channelId), getChatMemberStatus(channelId)]);
    live.account = title;
    if (!canBotWriteToChat(member)) live.problem = "Бот Telegram не может писать в этот канал — сделайте его администратором с правом публикации";
  } catch (err) {
    live.problem = `Ошибка Telegram: ${scrub(describeError(err))}`;
  }
  return live;
}

function liveThreads(): SocialVideoChannelLive {
  const live = emptyLive("THREADS");
  live.note = "Threads не сообщает остаток суточной квоты через API — лимит 250 публикаций за 24 часа";
  return live;
}

let liveCache: { at: number; data: SocialVideoChannelLive[] } | null = null;
let liveInFlight: Promise<SocialVideoChannelLive[]> | null = null;
/** «Обновить» чаще раза в 15 с не ходит к площадкам: у TikTok creator_info 20 запросов в минуту на всех. */
const LIVE_REFRESH_MIN_MS = 15_000;

/** Живые данные площадок. Каждый канал отвечает за себя: отказ одного не прячет остальные. */
export async function loadChannelLive(opts: { refresh?: boolean } = {}): Promise<SocialVideoChannelLive[]> {
  const age = liveCache ? Date.now() - liveCache.at : Infinity;
  if (liveCache && age < (opts.refresh ? LIVE_REFRESH_MIN_MS : LIVE_CACHE_MS)) return liveCache.data;
  // Параллельные запросы делят один обход площадок, а не множат его.
  if (liveInFlight) return liveInFlight;
  liveInFlight = fetchChannelLive().finally(() => {
    liveInFlight = null;
  });
  return liveInFlight;
}

async function fetchChannelLive(): Promise<SocialVideoChannelLive[]> {

  const [creds, settings, infos] = await Promise.all([loadCredentials(), loadChannelSettings(), loadChannelInfos()]);
  const connected = new Set(infos.filter((i) => i.connected).map((i) => i.channel));

  const jobs: Record<SocialVideoChannel, () => Promise<SocialVideoChannelLive>> = {
    INSTAGRAM: () => liveInstagram(creds.igToken as string),
    FACEBOOK: () => liveFacebook(creds.pageId as string, creds.pageToken as string),
    YOUTUBE: () => liveYouTube(settings),
    TIKTOK: () => liveTikTok(settings),
    TELEGRAM: () => liveTelegram(settings),
    THREADS: async () => liveThreads(),
  };

  const data = await Promise.all(
    SOCIAL_VIDEO_CHANNELS.map(async (channel): Promise<SocialVideoChannelLive> => {
      if (!connected.has(channel)) return emptyLive(channel);
      try {
        return await withTimeout(jobs[channel](), LIVE_TIMEOUT_MS + 2_000, SOCIAL_VIDEO_CHANNEL_LABELS[channel]);
      } catch (err) {
        return { ...emptyLive(channel), problem: scrub(describeError(err)) };
      }
    })
  );
  liveCache = { at: Date.now(), data };
  return data;
}

/**
 * Живые пределы из последнего ответа площадок (без сети) — для расчёта пригодности ролика
 * в списке. Telegram знает свой потолок и без запроса; TikTok — только после первого
 * `loadChannelLive`.
 */
export function cachedRuntimeLimits(): Partial<Record<SocialVideoChannel, ChannelRuntimeLimits>> {
  const out: Partial<Record<SocialVideoChannel, ChannelRuntimeLimits>> = {
    TELEGRAM: { maxSizeBytes: TELEGRAM_BOT_SEND_LIMIT_BYTES },
  };
  for (const item of liveCache?.data ?? []) {
    if (Object.keys(item.runtime).length > 0) out[item.channel] = { ...out[item.channel], ...item.runtime };
  }
  return out;
}

/** Для тестов. */
export function resetChannelLiveCacheForTests(): void {
  liveCache = null;
  liveInFlight = null;
}
