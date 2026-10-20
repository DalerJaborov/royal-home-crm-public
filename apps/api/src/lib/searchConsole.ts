/**
 * «САЙТ И ПОИСК» — ДАННЫЕ GOOGLE SEARCH CONSOLE (24.09.2026, Dan: «seo сайта,
 * что лучше позиция в поиске и так далее, полный контроль — в другую вкладку»).
 *
 * ДОСТУП — кнопкой из CRM (routes/searchConsole.ts), тем же Google-приложением,
 * что у YouTube (`Settings.youtubeClientId/Secret`): у агентства один проект в
 * Google Cloud, заводить второй незачем. Refresh-токен свой
 * (`searchConsoleRefreshToken`, право `webmasters.readonly`) — подключение поиска
 * не трогает публикацию роликов.
 *
 * ЧТО СЧИТАЕМ. Четыре запроса к Search Analytics за период и столько же дней до
 * него: итоги (клики, показы, CTR, место), «что ищут» (запросы), «какие страницы
 * находят» (адреса; страница объекта `/listing/<номер на сайте>` или
 * `/listing/by-crm/<id>` сопоставляется с карточкой) и «почти в топе» — запросы
 * на 4–20 месте с заметным числом показов: подтянуть их в тройку дешевле всего.
 *
 * Google отдаёт данные с задержкой в 2–3 дня, поэтому период кончается
 * позавчера. Кэш на час: цифры за прошедший час всё равно не меняются.
 */
import {
  formatShortCode,
  type SearchMetrics,
  type SearchOverview,
  type SearchPageRow,
  type SearchQueryRow,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { fetchWithRetry } from "../messengers/meta.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://searchconsole.googleapis.com/webmasters/v3";
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
/** Данные Google готовы с задержкой — последний полный день позавчера. */
const DATA_LAG_DAYS = 2;
const TOP_ROWS = 20;
/** «Почти в топе» — с 4 по 20 место, и не случайный разовый показ. */
const NEAR_TOP_MIN_POSITION = 4;
const NEAR_TOP_MAX_POSITION = 20;
const NEAR_TOP_MIN_IMPRESSIONS = 10;
const NEAR_TOP_ROWS = 10;

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
}

/** Google-приложение агентства — то же, что у YouTube. null — не внесено в Настройках. */
export async function loadGoogleApp(): Promise<GoogleApp | null> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { youtubeClientId: true, youtubeClientSecret: true },
  });
  const clientId = s?.youtubeClientId?.trim() || "";
  const clientSecret = decryptSecretSafe(s?.youtubeClientSecret ?? null) || "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function googleError(body: Record<string, unknown>, fallback: string): string {
  const err = body.error as { message?: string } | string | undefined;
  if (typeof err === "string") return (body.error_description as string | undefined) ?? err;
  return err?.message ?? fallback;
}

/** refresh → access. Бросает с понятным текстом: его покажет экран. */
export async function searchConsoleAccessToken(app: GoogleApp, refreshToken: string): Promise<string> {
  const res = await fetchWithRetry(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    },
    TIMEOUT_MS
  );
  const body = await readJson(res);
  const token = body.access_token as string | undefined;
  if (!res.ok || !token) {
    throw new Error(`Google не выдал доступ — подключите Search Console заново (${googleError(body, `HTTP ${res.status}`)})`);
  }
  return token;
}

/**
 * Какой ресурс Search Console читать. Домен (`sc-domain:`) включает все адреса
 * сайта — его и берём, если он есть; иначе ресурс-префикс того же сайта. Ресурс
 * без подтверждённого доступа пропускаем: Google всё равно ответит отказом.
 */
export function pickSite(entries: { siteUrl?: string; permissionLevel?: string }[], host: string): string | null {
  const usable = entries.filter((e) => e.siteUrl && e.permissionLevel !== "siteUnverifiedUser").map((e) => e.siteUrl as string);
  const bare = host.replace(/^www\./, "");
  const domain = usable.find((u) => u === `sc-domain:${bare}`);
  if (domain) return domain;
  return usable.find((u) => u.startsWith("http") && new URL(u).hostname.replace(/^www\./, "") === bare) ?? null;
}

export async function listSites(accessToken: string): Promise<{ siteUrl?: string; permissionLevel?: string }[]> {
  const res = await fetchWithRetry(`${API}/sites`, { headers: { Authorization: `Bearer ${accessToken}` } }, TIMEOUT_MS);
  const body = await readJson(res);
  if (!res.ok) throw new Error(`Список сайтов Search Console: ${googleError(body, `HTTP ${res.status}`)}`);
  return (body.siteEntry as { siteUrl?: string; permissionLevel?: string }[] | undefined) ?? [];
}

/** Хозяин сайта, чей ресурс ищем в Search Console. */
export function siteHost(): string {
  const raw = process.env.SITE_PUBLIC_URL?.trim() || "https://royalhome.tj";
  try {
    return new URL(raw).hostname;
  } catch {
    return "royalhome.tj";
  }
}

type ApiRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };

async function query(
  accessToken: string,
  siteUrl: string,
  body: { startDate: string; endDate: string; dimensions?: string[]; rowLimit?: number }
): Promise<ApiRow[]> {
  const res = await fetchWithRetry(
    `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    TIMEOUT_MS
  );
  const json = await readJson(res);
  if (!res.ok) throw new Error(`Search Console: ${googleError(json, `HTTP ${res.status}`)}`);
  return (json.rows as ApiRow[] | undefined) ?? [];
}

function metrics(row: ApiRow | undefined): SearchMetrics {
  const impressions = row?.impressions ?? 0;
  return {
    clicks: row?.clicks ?? 0,
    impressions,
    ctr: row?.ctr ?? 0,
    position: impressions > 0 && row?.position != null ? Math.round(row.position * 10) / 10 : null,
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Период из `days` дней, кончающийся позавчера, и такой же отрезок до него. */
export function searchPeriods(days: number, now: Date): { start: string; end: string; prevStart: string; prevEnd: string } {
  const end = new Date(now.getTime() - DATA_LAG_DAYS * DAY_MS);
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const prevEnd = new Date(start.getTime() - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * DAY_MS);
  return { start: isoDay(start), end: isoDay(end), prevStart: isoDay(prevStart), prevEnd: isoDay(prevEnd) };
}

/** `/listing/123` — номер объекта на сайте; `/listing/by-crm/<uuid>` — id карточки CRM. */
export function listingRef(page: string): { siteListingId: number } | { crmId: string } | null {
  let path: string;
  try {
    path = new URL(page).pathname;
  } catch {
    path = page;
  }
  const byCrm = /^\/listing\/by-crm\/([0-9a-f-]{36})\/?$/i.exec(path);
  if (byCrm) return { crmId: byCrm[1].toLowerCase() };
  const bySite = /^\/listing\/(\d+)\/?$/.exec(path);
  if (bySite) return { siteListingId: Number(bySite[1]) };
  return null;
}

function pathOf(page: string): string {
  try {
    const u = new URL(page);
    return decodeURI(u.pathname + u.search) || "/";
  } catch {
    return page;
  }
}

async function attachProperties(rows: ApiRow[]): Promise<SearchPageRow[]> {
  const refs = rows.map((r) => listingRef(r.keys?.[0] ?? ""));
  const siteIds = refs.flatMap((r) => (r && "siteListingId" in r ? [r.siteListingId] : []));
  const crmIds = refs.flatMap((r) => (r && "crmId" in r ? [r.crmId] : []));
  const props =
    siteIds.length || crmIds.length
      ? await prisma.property.findMany({
          where: { OR: [{ siteListingId: { in: siteIds } }, { id: { in: crmIds } }] },
          select: { id: true, siteListingId: true, shortId: true, title: true },
        })
      : [];
  const bySite = new Map(props.filter((p) => p.siteListingId != null).map((p) => [p.siteListingId as number, p]));
  const byId = new Map(props.map((p) => [p.id, p]));
  return rows.map((r, i) => {
    const page = r.keys?.[0] ?? "";
    const ref = refs[i];
    const p = ref ? ("siteListingId" in ref ? bySite.get(ref.siteListingId) : byId.get(ref.crmId)) : undefined;
    return {
      page,
      path: pathOf(page),
      ...metrics(r),
      property: p ? { shortId: p.shortId, title: p.title || formatShortCode("ОБ", p.shortId) } : null,
    };
  });
}

function queryRows(rows: ApiRow[]): SearchQueryRow[] {
  return rows.map((r) => ({ query: r.keys?.[0] ?? "", ...metrics(r) }));
}

let cache = new Map<number, { at: number; result: SearchOverview }>();

/** Для тестов: сбросить кэш между сценариями. */
export function resetSearchConsoleCache(): void {
  cache = new Map();
}

export async function loadSearchOverview(days: number, options?: { forceRefresh?: boolean; now?: Date }): Promise<SearchOverview> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { searchConsoleRefreshToken: true, searchConsoleSiteUrl: true },
  });
  const app = await loadGoogleApp();
  const refreshToken = decryptSecretSafe(settings?.searchConsoleRefreshToken ?? null);
  const siteUrl = settings?.searchConsoleSiteUrl ?? null;
  if (!app || !refreshToken || !siteUrl) return { connected: false, appConfigured: Boolean(app) };

  const hit = cache.get(days);
  if (!options?.forceRefresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const period = searchPeriods(days, options?.now ?? new Date());
  const empty: SearchMetrics = { clicks: 0, impressions: 0, ctr: 0, position: null };
  try {
    const token = await searchConsoleAccessToken(app, refreshToken);
    const cur = { startDate: period.start, endDate: period.end };
    const [totals, previous, queries, pages, candidates] = await Promise.all([
      query(token, siteUrl, cur),
      query(token, siteUrl, { startDate: period.prevStart, endDate: period.prevEnd }),
      query(token, siteUrl, { ...cur, dimensions: ["query"], rowLimit: TOP_ROWS }),
      query(token, siteUrl, { ...cur, dimensions: ["page"], rowLimit: TOP_ROWS }),
      // Кандидатов «почти в топе» берём с запасом: Google сортирует по кликам,
      // а нужны частые показы на местах пониже.
      query(token, siteUrl, { ...cur, dimensions: ["query"], rowLimit: 500 }),
    ]);
    const nearTop = queryRows(candidates)
      .filter(
        (r) =>
          r.position != null &&
          r.position >= NEAR_TOP_MIN_POSITION &&
          r.position <= NEAR_TOP_MAX_POSITION &&
          r.impressions >= NEAR_TOP_MIN_IMPRESSIONS
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, NEAR_TOP_ROWS);
    const result: SearchOverview = {
      connected: true,
      siteUrl,
      days,
      start: period.start,
      end: period.end,
      totals: metrics(totals[0]),
      previous: metrics(previous[0]),
      queries: queryRows(queries),
      pages: await attachProperties(pages),
      nearTop,
      error: null,
    };
    cache.set(days, { at: Date.now(), result });
    return result;
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("api", `Search Console: ${reason}`, { dedupKey: "search-console-read" });
    // Отказ не кэшируем: после переподключения экран должен ожить сразу.
    return {
      connected: true,
      siteUrl,
      days,
      start: period.start,
      end: period.end,
      totals: empty,
      previous: empty,
      queries: [],
      pages: [],
      nearTop: [],
      error: reason,
    };
  }
}
