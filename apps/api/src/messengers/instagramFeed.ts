import { prisma } from "../db.js";
import { decryptSecretSafe, encryptSecret } from "../crypto.js";
import { logSystemError } from "../lib/systemError.js";
import { fetchWithRetry, GRAPH_VERSION, instagramApiUrl, instagramRequest, loadCredentials } from "./meta.js";
import { describeError } from "../lib/describeError.js";

/**
 * Лента Instagram агентства для публичного сайта.
 *
 * Раньше сайт ходил в Graph API сам, со своим маркером в файле на сервере. Маркеров
 * стало два на один аккаунт, и они гасили друг друга: стоило сгенерировать маркер
 * для CRM — лента на главной пропадала. Теперь маркер один и живёт в Настройках CRM,
 * а сайт спрашивает готовые посты здесь (см. публичный роут routes/publicFeed.ts).
 *
 * Отдаём почти сырые поля Graph API: как их показать (обрезать подписи, выбрать
 * Reels) — дело сайта, здесь только доставка и кэш.
 */
export interface InstagramMediaItem {
  id: string;
  permalink: string;
  caption?: string;
  mediaType: string;
  mediaProductType?: string;
  /** Прямая ссылка на файл. У видео её отдают только владельцу аккаунта. */
  mediaUrl?: string;
  thumbnailUrl?: string;
  timestamp?: string;
}

interface GraphMediaItem {
  id: string;
  permalink?: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  timestamp?: string;
}

/** Постов на главной сайта — девять; берём с запасом, сайт сам выбирает Reels. */
const MEDIA_LIMIT = 25;
const CACHE_MS = 20 * 60 * 1000;

let cache: { items: InstagramMediaItem[]; fetchedAt: number } | null = null;

/**
 * Посты аккаунта. null — маркера нет или Graph API отказал (сайт покажет своё).
 *
 * `maxAgeMs` — насколько свежий список нужен вызывающему. Сайту хватает двадцати
 * минут, а узнаванию пересланной публикации нет: человек присылает рилс, который
 * мы выложили пять минут назад, и «его нет в ленте» означало бы, что свою же
 * свежую публикацию бот не узнаёт именно тогда, когда она горячая.
 */
export async function getInstagramMedia(maxAgeMs = CACHE_MS): Promise<InstagramMediaItem[] | null> {
  if (cache && Date.now() - cache.fetchedAt < maxAgeMs) return cache.items;

  const { igToken } = await loadCredentials();
  if (!igToken) return null;

  const fields = "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp";
  try {
    // С версией, как велит правило самого meta.ts: без неё Graph подставляет
    // «текущую», и поведение меняется молча при её смене на стороне Meta.
    const req = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/me/media?fields=${fields}&limit=${MEDIA_LIMIT}`), igToken);
    const res = await fetchWithRetry(req.url, { headers: req.headers });
    if (!res.ok) {
      throw new Error(`Graph API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { data?: GraphMediaItem[] };
    const items = (data.data ?? [])
      .filter((m): m is GraphMediaItem & { permalink: string } => !!m.permalink)
      .map((m) => ({
        id: m.id,
        permalink: m.permalink,
        caption: m.caption,
        mediaType: m.media_type ?? "IMAGE",
        mediaProductType: m.media_product_type,
        mediaUrl: m.media_url,
        thumbnailUrl: m.thumbnail_url,
        timestamp: m.timestamp,
      }));
    cache = { items, fetchedAt: Date.now() };
    return items;
  } catch (err) {
    void logSystemError("meta", `Лента Instagram не получена: ${describeError(err)}`);
    // Протухший кэш лучше пустой главной: посты меняются редко, а отказ Graph API
    // не повод показывать посетителю заглушки.
    return cache?.items ?? null;
  }
}

/**
 * ЛЕНТЫ ВСЕХ НАШИХ АККАУНТОВ, ГЛУБОКО — чтобы бот узнавал ЛЮБОЙ свой ролик.
 *
 * Владелец 17.08.2026: «главное — бот узнаёт все наши рилсы?». До этого дня нет,
 * и по двум причинам сразу: лента бралась одним маркером из Настроек (то есть
 * только у основного аккаунта, а публикации Royal Home Info не искались вовсе) и
 * ограничивалась 25 последними постами — при 131 публикации это четверть ленты.
 * Клиент присылал наш же ролик месячной давности, а бот отвечал «не понял, о
 * какой квартире речь».
 *
 * Берём постранично до GLOBAL_MEDIA_LIMIT записей на аккаунт: этого хватает на
 * всю ленту агентства, а дальше публикации всё равно неактуальны — квартиры
 * проданы. Кэш общий и живёт те же двадцать минут: лента меняется редко, а
 * запрос идёт на каждое пересланное видео.
 */
const GLOBAL_MEDIA_LIMIT = 300;
/**
 * ГЛУБОКАЯ ЛЕНТА (10.10.2026, аудит docs/audit-bots-2026-10-10-object-routing.md,
 * P0-2): пост старше 300-й записи бот не узнавал — «видео не открылось» на наш же
 * ролик полугодовой давности. Глубже читаем только когда код НЕ нашёлся в обычной
 * ленте (ownMedia.ts::findOwnMedia), и держим такой список часами: старые посты не
 * меняются, а лишние десять страниц Graph на каждую пересылку не нужны.
 */
const DEEP_MEDIA_LIMIT = 1500;
const DEEP_CACHE_MS = 6 * 60 * 60 * 1000;
/**
 * НЕДОЧИТАННАЯ ЛЕНТА НЕ ЖИВЁТ В КЭШЕ ПОЛНЫЙ СРОК (тот же аудит): отказ маркера
 * одного аккаунта или обрыв на середине давал частичный список, и он кэшировался
 * как полный — до следующего чтения бот не видел половину своих постов.
 */
const PARTIAL_CACHE_MS = 60 * 1000;
const PAGE_SIZE = 100;
const allCache = new Map<number, { items: InstagramMediaItem[]; fetchedAt: number; complete: boolean }>();

/**
 * Маркеры ВСЕХ подключённых аккаунтов Instagram — и основного, и Info.
 *
 * Пусто (аккаунты ещё не заведены) — вызывающий откатывается на одиночный маркер
 * из Настроек, то есть на прежнее поведение.
 */
async function instagramAccountTokens(): Promise<string[]> {
  try {
    const rows = await prisma.messengerAccount.findMany({
      where: { channel: "INSTAGRAM" },
      select: { token: true },
    });
    const tokens = rows.map((r) => decryptSecretSafe(r.token)).filter((t): t is string => !!t);
    if (tokens.length > 0) return tokens;
  } catch (err) {
    void logSystemError("meta", `Маркеры аккаунтов Instagram не прочитаны: ${describeError(err)}`);
  }
  const { igToken } = await loadCredentials();
  return igToken ? [igToken] : [];
}

/**
 * Адрес для журнала — ТОЛЬКО схема, хост и путь. Через прокси маркер Instagram
 * уходит query-параметром access_token (см. instagramRequest в meta.ts), и полный
 * адрес в журнале означал бы живой маркер на экране «Здоровье системы» и в утренней
 * сводке. Правило то же, что у hostOf в routes/attachments.ts.
 */
function sanitizeFeedUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "адрес не разобран";
  }
}

export async function getAllOwnMedia(
  maxAgeMs = CACHE_MS,
  /** "deep" — до DEEP_MEDIA_LIMIT записей и кэш на часы (см. DEEP_MEDIA_LIMIT выше). */
  depth: "recent" | "deep" = "recent"
): Promise<InstagramMediaItem[] | null> {
  const limit = depth === "deep" ? DEEP_MEDIA_LIMIT : GLOBAL_MEDIA_LIMIT;
  if (depth === "deep") maxAgeMs = Math.max(maxAgeMs, DEEP_CACHE_MS);
  const cached = allCache.get(limit);
  if (cached && Date.now() - cached.fetchedAt < (cached.complete ? maxAgeMs : Math.min(maxAgeMs, PARTIAL_CACHE_MS))) {
    return cached.items;
  }

  const tokens = await instagramAccountTokens();
  if (tokens.length === 0) return getInstagramMedia(maxAgeMs);

  const fields = "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp";
  const collected: InstagramMediaItem[] = [];
  let complete = true;
  for (const token of tokens) {
    let url: string | null = instagramApiUrl(`/${GRAPH_VERSION}/me/media?fields=${fields}&limit=${PAGE_SIZE}`);
    let taken = 0;
    while (url && taken < limit) {
      // Вне try: нужен в catch для диагностики (какой адрес реально фетчили).
      const req = instagramRequest(url, token);
      try {
        const res = await fetchWithRetry(req.url, { headers: req.headers });
        if (!res.ok) {
          // Осмысленный HTTP-отказ (протухший маркер — 401, лимит Graph — 429) до
          // 26.08.2026 не логировался вовсе: маркер умирал, бот переставал узнавать
          // рилсы аккаунта, а «Здоровье системы» оставалось зелёным — ровно сценарий,
          // от которого журнал и заводился (та же беда была с маркером WhatsApp).
          const bodyText = await res.text().catch(() => "");
          void logSystemError(
            "meta",
            `Лента аккаунта Instagram: Graph API HTTP ${res.status} (${sanitizeFeedUrl(req.url)}): ${bodyText.slice(0, 300)}`
          );
          complete = false;
          break;
        }
        const data = (await res.json()) as { data?: GraphMediaItem[]; paging?: { next?: string } };
        for (const m of data.data ?? []) {
          if (!m.permalink) continue;
          collected.push({
            id: m.id,
            permalink: m.permalink,
            caption: m.caption,
            mediaType: m.media_type ?? "IMAGE",
            mediaProductType: m.media_product_type,
            mediaUrl: m.media_url,
            thumbnailUrl: m.thumbnail_url,
            timestamp: m.timestamp,
          });
          taken += 1;
        }
        // Следующая страница приходит готовой ссылкой; через прокси её надо
        // пересобрать тем же способом, что и первую (см. instagramRequest).
        url = data.paging?.next ?? null;
      } catch (err) {
        void logSystemError(
          "meta",
          `Лента аккаунта Instagram не дочитана (${sanitizeFeedUrl(req.url)}): ${describeError(err)}`
        );
        complete = false;
        break;
      }
    }
  }

  if (collected.length === 0) return getInstagramMedia(maxAgeMs);
  allCache.set(limit, { items: collected, fetchedAt: Date.now(), complete });
  return collected;
}


/** Маркер Instagram живёт 60 дней; продлеваем раз в неделю с большим запасом. */
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

/** Просит у Graph API новый маркер взамен переданного. Бросает при отказе —
 *  что писать в базу (и писать ли вообще), решает вызывающий. */
async function requestRefreshedInstagramToken(igToken: string): Promise<string> {
  const req = instagramRequest(instagramApiUrl("/refresh_access_token?grant_type=ig_refresh_token"), igToken);
  const res = await fetchWithRetry(req.url, { headers: req.headers });
  if (!res.ok) {
    throw new Error(`Graph API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Graph API не вернул новый маркер");
  return data.access_token;
}

/** Есть ли у основного включённого аккаунта Instagram свой маркер — то же
 *  условие, при котором meta.ts/loadCredentials не смотрит в Settings.metaIgToken.
 *  Отказ базы — «не знаем», считаем что нет: тогда отказ продления пишется как раньше. */
async function defaultInstagramAccountHasToken(): Promise<boolean> {
  try {
    const row = await prisma.messengerAccount.findFirst({
      where: { channel: "INSTAGRAM", isDefault: true, enabled: true },
      select: { token: true },
    });
    return !!decryptSecretSafe(row?.token ?? null);
  } catch {
    return false;
  }
}

/**
 * Продлевает маркеры Instagram, если пора, и сохраняет каждый там, где он живёт.
 *
 * ДВА НЕЗАВИСИМЫХ ИСТОЧНИКА (разбор 14.09.2026). До этого дня функция знала только
 * копию в Settings.metaIgToken — а входящие сообщения ею вовсе не пользуются:
 * рабочие маркеры лежат в MessengerAccount, и вебхук читает их через
 * instagramAccountTokens() выше (см. loadCredentials в meta.ts — Settings там
 * запасной путь, а не основной). Продлевалась мёртвая для дела копия, а маркеры
 * аккаунтов умирали молча; у «Royal Home Info» копии в Settings не было вовсе —
 * этот аккаунт был обречён гарантированно, второй («Royal Home») жил до
 * ближайшего совпадения по случайности.
 *
 * Каждый источник продлевается и пишется НЕЗАВИСИМО от остальных (свой try/catch):
 * отказ одного маркера не должен мешать продлить другой, а в журнал попадает,
 * ЧЕЙ именно маркер не продлился — иначе искать пришлось бы по всем сразу.
 * Периодичность прежняя — раз в неделю НА КАЖДЫЙ источник, считая от ЕГО
 * собственной отметки (`tokenRefreshedAt` у строки аккаунта, `metaIgTokenRefreshedAt`
 * у Settings); для строки, которую этот код ещё ни разу не продлевал, точка отсчёта —
 * `updatedAt`, чтобы только что заведённый аккаунт не продлевался в ту же секунду.
 *
 * Без этого маркер тихо умирает через 60 дней — ровно та беда, из-за которой
 * WhatsApp однажды замолчал на суточном маркере. Продление возможно только для
 * маркера старше суток и живого, поэтому единичный отказ здесь не авария:
 * попробуем через неделю снова.
 */
export async function refreshInstagramTokenIfDue(): Promise<{ refreshed: number; failed: number }> {
  let refreshed = 0;
  let failed = 0;

  // 1) Копия в Settings — прежнее поведение, не тронуто, только обёрнуто отдельно.
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { metaIgToken: true, metaIgTokenRefreshedAt: true },
    });
    // Продлевать имеет смысл только СВОЙ маркер из Настроек: значение из окружения
    // сервера мы всё равно не сможем перезаписать.
    const last = settings?.metaIgTokenRefreshedAt?.getTime() ?? 0;
    if (settings?.metaIgToken && Date.now() - last >= REFRESH_EVERY_MS) {
      const igToken = decryptSecretSafe(settings.metaIgToken);
      if (igToken) {
        const newToken = await requestRefreshedInstagramToken(igToken);
        await prisma.settings.update({
          where: { id: "singleton" },
          data: { metaIgToken: encryptSecret(newToken), metaIgTokenRefreshedAt: new Date() },
        });
        refreshed++;
      }
    }
  } catch (err) {
    // Пока у основного аккаунта списка есть свой маркер, копия в Настройках не
    // используется вовсе (meta.ts/loadCredentials берёт маркер аккаунта первым).
    // Продлевать её всё равно пробуем — она запасной путь на случай, если аккаунт
    // уберут, — но её отказ в этом случае не авария: «Здоровье системы» не должно
    // краснеть из-за поля, которым никто не пользуется (28.09.2026).
    if (await defaultInstagramAccountHasToken()) {
      console.warn(
        `[instagram] запасной маркер в Настройках не продлён (не используется — работает маркер основного аккаунта): ${describeError(err)}`
      );
    } else {
      failed++;
      void logSystemError("meta", `Маркер Instagram (копия в Настройках) не продлён: ${describeError(err)}`);
    }
  }

  // 2) Каждая строка MessengerAccount — это и есть маркеры, которыми CRM реально
  //    отвечает (см. разбор в комментарии выше).
  let rows: Array<{ id: string; title: string; token: string; tokenRefreshedAt: Date | null; updatedAt: Date }> = [];
  try {
    rows = await prisma.messengerAccount.findMany({
      where: { channel: "INSTAGRAM" },
      select: { id: true, title: true, token: true, tokenRefreshedAt: true, updatedAt: true },
    });
  } catch (err) {
    failed++;
    void logSystemError(
      "meta",
      `Список аккаунтов Instagram не прочитан — продление маркеров пропущено в этом тике: ${describeError(err)}`
    );
    return { refreshed, failed };
  }

  for (const row of rows) {
    const last = (row.tokenRefreshedAt ?? row.updatedAt).getTime();
    if (Date.now() - last < REFRESH_EVERY_MS) continue;
    try {
      const igToken = decryptSecretSafe(row.token);
      if (!igToken) continue;
      const newToken = await requestRefreshedInstagramToken(igToken);
      await prisma.messengerAccount.update({
        where: { id: row.id },
        data: { token: encryptSecret(newToken), tokenRefreshedAt: new Date() },
      });
      refreshed++;
    } catch (err) {
      failed++;
      void logSystemError("meta", `Маркер Instagram «${row.title}» не продлён: ${describeError(err)}`);
    }
  }

  return { refreshed, failed };
}
