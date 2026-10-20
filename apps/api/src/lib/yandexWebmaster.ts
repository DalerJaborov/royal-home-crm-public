import type { SearchMetrics, SearchQueryRow, YandexSearchOverview, YandexSiteSummary } from "@royal-home/shared";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { fetchWithRetry } from "../messengers/meta.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { searchPeriods } from "./searchConsole.js";

/**
 * «САЙТ И ПОИСК» → ЯНДЕКС (24.09.2026, Dan: «seo сайта… полный контроль»;
 * 16:18 «сделай всё»). Яндекс Вебмастер API v4 о royalhome.tj: сколько людей
 * пришло из поиска Яндекса, по каким запросам, на каком месте сайт, ИКС и
 * страницы в поиске. Та же форма ответа, что у Google (lib/searchConsole.ts),
 * только без разбивки по страницам — Вебмастер её не отдаёт.
 *
 * Своё OAuth-приложение Яндекса (oauth.yandex.ru) с правом «Яндекс.Вебмастер:
 * получение информации о сайтах»: ID и пароль вносят на вкладке, вход — своим
 * аккаунтом Яндекса в своём браузере (routes/searchConsole.ts).
 */

const API = "https://api.webmaster.yandex.net/v4";
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60_000;
const TOP_ROWS = 20;
const CANDIDATE_ROWS = 500;
const NEAR_TOP_MIN_POSITION = 4;
const NEAR_TOP_MAX_POSITION = 20;
const NEAR_TOP_MIN_SHOWS = 10;
const NEAR_TOP_ROWS = 10;
const INDICATORS = ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION"] as const;

export interface YandexApp {
  clientId: string;
  clientSecret: string;
}

export async function loadYandexApp(): Promise<YandexApp | null> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { yandexWebmasterClientId: true, yandexWebmasterClientSecret: true },
  });
  const clientId = s?.yandexWebmasterClientId?.trim() || "";
  const clientSecret = decryptSecretSafe(s?.yandexWebmasterClientSecret ?? null) || "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function yandexError(body: Record<string, unknown>, fallback: string): string {
  return (
    (body.error_description as string | undefined) ??
    (body.error_message as string | undefined) ??
    (typeof body.error === "string" ? body.error : undefined) ??
    fallback
  );
}

/** Обмен у oauth.yandex.ru: код входа или refresh-токен → токены. */
export async function yandexToken(
  app: YandexApp,
  grant: { code: string } | { refreshToken: string }
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const params = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret });
  if ("code" in grant) {
    params.set("grant_type", "authorization_code");
    params.set("code", grant.code);
  } else {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", grant.refreshToken);
  }
  const res = await fetchWithRetry(
    "https://oauth.yandex.ru/token",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() },
    TIMEOUT_MS
  );
  const body = await readJson(res);
  const accessToken = body.access_token as string | undefined;
  if (!res.ok || !accessToken) {
    throw new Error(`Яндекс не выдал доступ — подключите Вебмастер заново (${yandexError(body, `HTTP ${res.status}`)})`);
  }
  return { accessToken, refreshToken: (body.refresh_token as string | undefined) ?? null };
}

async function webmaster(accessToken: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetchWithRetry(`${API}${path}`, { headers: { Authorization: `OAuth ${accessToken}` } }, TIMEOUT_MS);
  const body = await readJson(res);
  if (!res.ok) throw new Error(`Яндекс Вебмастер: ${yandexError(body, `HTTP ${res.status}`)}`);
  return body;
}

export async function yandexUserId(accessToken: string): Promise<string> {
  const body = await webmaster(accessToken, "/user");
  const id = body.user_id;
  if (typeof id !== "number" && typeof id !== "string") throw new Error("Яндекс Вебмастер не назвал пользователя");
  return String(id);
}

export interface YandexHost {
  host_id?: string;
  ascii_host_url?: string;
  verified?: boolean;
}

export async function listYandexHosts(accessToken: string, userId: string): Promise<YandexHost[]> {
  const body = await webmaster(accessToken, `/user/${encodeURIComponent(userId)}/hosts`);
  return (body.hosts as YandexHost[] | undefined) ?? [];
}

/** Сайт в Вебмастере: подтверждённый, тот же домен (www не в счёт), https первым. */
export function pickYandexHost(hosts: YandexHost[], host: string): YandexHost | null {
  const bare = host.replace(/^www\./, "");
  const same = hosts.filter((h) => {
    if (!h.host_id || !h.ascii_host_url || h.verified === false) return false;
    try {
      return new URL(h.ascii_host_url).hostname.replace(/^www\./, "") === bare;
    } catch {
      return false;
    }
  });
  return same.find((h) => h.ascii_host_url!.startsWith("https:")) ?? same[0] ?? null;
}

/** Вебмастер ждёт дату со временем и поясом; сутки считаем по Душанбе. */
function ydate(day: string, end: boolean): string {
  return `${day}T${end ? "23:59:59,999" : "00:00:00,000"}+0500`;
}

function indicatorParams(): string {
  return INDICATORS.map((i) => `query_indicator=${i}`).join("&");
}

type History = Partial<Record<(typeof INDICATORS)[number], { date?: string; value?: number }[]>>;

/** Итог периода из дневной истории. Место — среднее, взвешенное показами. */
export function totalsFromHistory(indicators: History): SearchMetrics {
  const shows = new Map((indicators.TOTAL_SHOWS ?? []).map((p) => [p.date ?? "", Number(p.value ?? 0)]));
  const impressions = [...shows.values()].reduce((a, b) => a + b, 0);
  const clicks = (indicators.TOTAL_CLICKS ?? []).reduce((a, p) => a + Number(p.value ?? 0), 0);
  let weighted = 0;
  let weight = 0;
  for (const p of indicators.AVG_SHOW_POSITION ?? []) {
    const w = shows.get(p.date ?? "") ?? 0;
    if (w > 0 && typeof p.value === "number") {
      weighted += p.value * w;
      weight += w;
    }
  }
  return { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position: weight > 0 ? weighted / weight : null };
}

type PopularQuery = { query_text?: string; indicators?: Partial<Record<(typeof INDICATORS)[number], number>> };

export function queryRowsFromPopular(queries: PopularQuery[]): SearchQueryRow[] {
  return queries
    .filter((q) => q.query_text)
    .map((q) => {
      const impressions = Number(q.indicators?.TOTAL_SHOWS ?? 0);
      const clicks = Number(q.indicators?.TOTAL_CLICKS ?? 0);
      const pos = q.indicators?.AVG_SHOW_POSITION;
      return {
        query: q.query_text as string,
        clicks,
        impressions,
        ctr: impressions > 0 ? clicks / impressions : 0,
        position: typeof pos === "number" ? pos : null,
      };
    });
}

function summaryOf(body: Record<string, unknown>): YandexSiteSummary {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const problems = (body.site_problems as Record<string, unknown> | undefined) ?? {};
  // Рекомендации — не проблемы: считаем только то, что мешает поиску.
  const count = ["FATAL", "CRITICAL", "POSSIBLE_PROBLEM"].reduce((a, k) => a + (num(problems[k]) ?? 0), 0);
  return {
    sqi: num(body.sqi),
    searchablePages: num(body.searchable_pages_count),
    excludedPages: num(body.excluded_pages_count),
    problems: count,
  };
}

let cache = new Map<number, { at: number; result: YandexSearchOverview }>();

export function resetYandexWebmasterCache(): void {
  cache = new Map();
}

export async function loadYandexOverview(
  days: number,
  options?: { forceRefresh?: boolean; now?: Date }
): Promise<YandexSearchOverview> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { yandexWebmasterRefreshToken: true, yandexWebmasterUserId: true, yandexWebmasterHostId: true },
  });
  const app = await loadYandexApp();
  const refreshToken = decryptSecretSafe(settings?.yandexWebmasterRefreshToken ?? null);
  const userId = settings?.yandexWebmasterUserId ?? null;
  const hostId = settings?.yandexWebmasterHostId ?? null;
  if (!app || !refreshToken || !userId || !hostId) return { connected: false, appConfigured: Boolean(app) };

  const hit = cache.get(days);
  if (!options?.forceRefresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const period = searchPeriods(days, options?.now ?? new Date());
  const hostUrl = hostId.replace(/^(https?):(.+):(\d+)$/, (_m, scheme: string, h: string, port: string) =>
    `${scheme}://${h}${(scheme === "https" && port === "443") || (scheme === "http" && port === "80") ? "" : `:${port}`}/`
  );
  const base = `/user/${encodeURIComponent(userId)}/hosts/${encodeURIComponent(hostId)}`;
  const range = (from: string, to: string) => `date_from=${encodeURIComponent(ydate(from, false))}&date_to=${encodeURIComponent(ydate(to, true))}`;
  const empty: SearchMetrics = { clicks: 0, impressions: 0, ctr: 0, position: null };

  try {
    const { accessToken } = await yandexToken(app, { refreshToken });
    const [cur, prev, popular, summary] = await Promise.all([
      webmaster(accessToken, `${base}/search-queries/all/history?${indicatorParams()}&${range(period.start, period.end)}`),
      webmaster(accessToken, `${base}/search-queries/all/history?${indicatorParams()}&${range(period.prevStart, period.prevEnd)}`),
      webmaster(
        accessToken,
        `${base}/search-queries/popular?order_by=TOTAL_SHOWS&${indicatorParams()}&${range(period.start, period.end)}&limit=${CANDIDATE_ROWS}`
      ),
      // Сводка необязательна: без неё числа поиска всё равно показываем.
      webmaster(accessToken, `${base}/summary`).catch(() => null),
    ]);
    const rows = queryRowsFromPopular((popular.queries as PopularQuery[] | undefined) ?? []);
    const nearTop = rows
      .filter(
        (r) =>
          r.position != null &&
          r.position >= NEAR_TOP_MIN_POSITION &&
          r.position <= NEAR_TOP_MAX_POSITION &&
          r.impressions >= NEAR_TOP_MIN_SHOWS
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, NEAR_TOP_ROWS);
    const result: YandexSearchOverview = {
      connected: true,
      hostUrl,
      days,
      start: period.start,
      end: period.end,
      totals: totalsFromHistory((cur.indicators as History | undefined) ?? {}),
      previous: totalsFromHistory((prev.indicators as History | undefined) ?? {}),
      queries: [...rows].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, TOP_ROWS),
      nearTop,
      summary: summary ? summaryOf(summary) : null,
      error: null,
    };
    cache.set(days, { at: Date.now(), result });
    return result;
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("api", `Яндекс Вебмастер: ${reason}`, { dedupKey: "yandex-webmaster-read" });
    return {
      connected: true,
      hostUrl,
      days,
      start: period.start,
      end: period.end,
      totals: empty,
      previous: empty,
      queries: [],
      nearTop: [],
      summary: null,
      error: reason,
    };
  }
}
