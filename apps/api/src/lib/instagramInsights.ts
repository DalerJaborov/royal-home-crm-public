/**
 * СТАТИСТИКА INSTAGRAM: «сколько наших подписчиков онлайн в каждый час».
 *
 * 21.09.2026 владелец выпустил новый маркер Instagram с правами на статистику
 * (`instagram_business_manage_insights` / `instagram_manage_insights`), но
 * проверить его было нечем: из веб-сессии прод недоступен, а сам маркер лежит
 * в базе зашифрованным. Отсюда этот модуль — сначала как живая проверка из
 * Настроек, потом как источник суточного сбора для тепловой карты
 * (`lib/audienceHeatmap.ts`).
 *
 * ХОДИТ ТЕМ ЖЕ ПУТЁМ, ЧТО ПУБЛИКАЦИЯ И БОТ — `instagramApiUrl`/`instagramRequest`
 * (messengers/meta.ts): с нашего VPS `graph.instagram.com` недоступен на
 * сетевом уровне, прямой запрос отвалился бы «fetch failed» и выглядел бы как
 * отсутствие прав.
 *
 * `online_followers` Meta отдаёт только за последние 30 дней и только аккаунту
 * от 100 подписчиков; период `lifetime` здесь — это «значения по часам за
 * последние сутки», а не за всё время (так устроена именно эта метрика).
 */
import { prisma } from "../db.js";
import {
  GRAPH_VERSION,
  fetchWithRetry,
  instagramApiUrl,
  instagramRequest,
  instagramTokenIdentity,
  loadCredentials,
} from "../messengers/meta.js";

/** Значения по часам местного времени аккаунта: ключ — час (0-23). */
export type OnlineFollowersByHour = Record<number, number>;

export interface OnlineFollowersResult {
  ok: boolean;
  /** Часы, по которым Meta вернула числа. Пусто при отказе. */
  byHour: OnlineFollowersByHour;
  /** Человеческая причина отказа — уходит в ответ роута как есть. */
  error: string | null;
}

/**
 * Разбор ответа вынесен отдельно: в нём весь риск (Meta кладёт часы строками в
 * `values[].value`), и проверить его можно без сети.
 */
export function parseOnlineFollowers(body: unknown): OnlineFollowersByHour {
  const data = (body as { data?: { values?: { value?: unknown }[] }[] } | null)?.data;
  const byHour: OnlineFollowersByHour = {};
  if (!Array.isArray(data)) return byHour;
  for (const metric of data) {
    for (const point of metric.values ?? []) {
      const value = point.value;
      if (!value || typeof value !== "object") continue;
      for (const [hour, count] of Object.entries(value as Record<string, unknown>)) {
        const h = Number(hour);
        const n = Number(count);
        if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isFinite(n)) continue;
        byHour[h] = (byHour[h] ?? 0) + n;
      }
    }
  }
  return byHour;
}

/** Живой запрос статистики. Ошибку возвращает текстом, не бросает: вызывающий
 *  код (проверка из Настроек, будущий суточный сбор) обязан показать причину
 *  человеку, а не упасть. */
export async function fetchOnlineFollowers(token: string): Promise<OnlineFollowersResult> {
  try {
    const req = instagramRequest(
      instagramApiUrl(`/${GRAPH_VERSION}/me/insights?metric=online_followers&period=lifetime`),
      token
    );
    const res = await fetchWithRetry(req.url, { headers: req.headers });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, byHour: {}, error: `Meta ответила ${res.status}: ${text.slice(0, 300)}` };
    }
    const byHour = parseOnlineFollowers(JSON.parse(text));
    if (Object.keys(byHour).length === 0) {
      // Ответ без ошибки, но и без чисел — так Meta отвечает аккаунту меньше
      // ста подписчиков. Это не отказ в правах, и путать их нельзя.
      return { ok: false, byHour, error: "Meta ответила без чисел — обычно так бывает у аккаунта меньше 100 подписчиков" };
    }
    return { ok: true, byHour, error: null };
  } catch (err) {
    return { ok: false, byHour: {}, error: err instanceof Error ? err.message : "неизвестный сбой" };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * СУТОЧНЫЙ СБОР ДЛЯ ТЕПЛОВОЙ КАРТЫ (23.09.2026).
 *
 * Meta хранит `online_followers` только 30 дней, поэтому раз в сутки
 * забираем то, что она отдаёт, и складываем в InstagramOnlineFollowersHour —
 * по строке на час. Повторный сбор того же часа перезаписывает число.
 *
 * ЧАСОВОЙ ПОЯС. Ключи 0-23 в ответе — часы суток АККАУНТА, а не UTC и не
 * Душанбе, и документация Meta пояс не называет. Зато каждая точка несёт
 * `end_time` — границу этих суток, выраженную в UTC (07:00 UTC — полночь по
 * Калифорнии летом, 19:00 UTC — полночь по Душанбе). Поэтому момент часа
 * считаем от самой границы: сутки точки — это [end_time − 24 ч, end_time), и
 * час h начинается в end_time − 24 ч + h. Пояс аккаунта так угадывать не
 * нужно вовсе, и при его смене расчёт не ломается. Точка без `end_time`
 * отбрасывается: положить её во времени не на что.
 * ────────────────────────────────────────────────────────────────────────── */

export interface OnlineFollowersHourPoint {
  /** Начало часа, UTC. */
  at: Date;
  count: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** Разбор ответа по точкам с их границей суток — без сети, его и проверяет тест. */
export function parseOnlineFollowersHours(body: unknown): OnlineFollowersHourPoint[] {
  const data = (body as { data?: { values?: { value?: unknown; end_time?: unknown }[] }[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const byAt = new Map<number, number>();
  for (const metric of data) {
    for (const point of metric.values ?? []) {
      const end = typeof point.end_time === "string" ? Date.parse(point.end_time) : NaN;
      if (!Number.isFinite(end)) continue;
      const value = point.value;
      if (!value || typeof value !== "object") continue;
      const dayStart = end - 24 * HOUR_MS;
      for (const [hour, count] of Object.entries(value as Record<string, unknown>)) {
        const h = Number(hour);
        const n = Number(count);
        if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isFinite(n) || n < 0) continue;
        byAt.set(dayStart + h * HOUR_MS, Math.round(n));
      }
    }
  }
  return [...byAt.entries()].sort((a, b) => a[0] - b[0]).map(([at, count]) => ({ at: new Date(at), count }));
}

export interface CollectOnlineFollowersResult {
  ok: boolean;
  /** Сколько часов записано (новых или обновлённых). */
  stored: number;
  error: string | null;
}

/** Сколько дней назад просить у Meta: она отдаёт не больше 30. */
const BACKFILL_DAYS = 29;

async function requestOnlineFollowers(token: string, range: { since: number; until: number } | null) {
  const query = range ? `&since=${range.since}&until=${range.until}` : "";
  const req = instagramRequest(
    instagramApiUrl(`/${GRAPH_VERSION}/me/insights?metric=online_followers&period=lifetime${query}`),
    token
  );
  const res = await fetchWithRetry(req.url, { headers: req.headers });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

/**
 * Забрать часы у Meta и сложить в базу. Бросает только на сбое самой базы —
 * отказ Meta возвращается текстом (его пишет в журнал вызывающий крон).
 *
 * Сначала просим месяц целиком (since/until), чтобы первый же сбор заполнил
 * карту, а не копил её месяц. Если Meta такой диапазон для этой метрики не
 * принимает — берём то, что она отдаёт без диапазона (последние сутки).
 */
export async function collectInstagramOnlineFollowers(deps?: {
  token?: string | null;
  now?: Date;
}): Promise<CollectOnlineFollowersResult> {
  const token = deps && "token" in deps ? deps.token : (await loadCredentials()).igToken;
  if (!token) return { ok: false, stored: 0, error: "Маркер Instagram не сохранён в Настройках" };

  const identity = await instagramTokenIdentity(token);
  if (!identity.ok) return { ok: false, stored: 0, error: `Маркер не читается: ${identity.error}` };

  const now = deps?.now ?? new Date();
  const until = Math.floor(now.getTime() / 1000);
  const since = until - BACKFILL_DAYS * 24 * 60 * 60;

  let points: OnlineFollowersHourPoint[] = [];
  let lastError: string | null = null;
  try {
    for (const range of [{ since, until }, null]) {
      const res = await requestOnlineFollowers(token, range);
      if (!res.ok) {
        lastError = `Meta ответила ${res.status}: ${res.text.slice(0, 300)}`;
        continue;
      }
      points = parseOnlineFollowersHours(JSON.parse(res.text));
      if (points.length > 0) break;
      lastError = "Meta ответила без чисел — обычно так бывает у аккаунта меньше 100 подписчиков";
    }
  } catch (err) {
    return { ok: false, stored: 0, error: err instanceof Error ? err.message : "неизвестный сбой" };
  }
  if (points.length === 0) return { ok: false, stored: 0, error: lastError };

  // Одним запросом, а не по upsert на час: за месяц это ~700 строк.
  const ats = points.map((p) => p.at);
  const counts = points.map((p) => p.count);
  const stored = await prisma.$executeRaw`
    INSERT INTO "InstagramOnlineFollowersHour" ("igUserId", "at", "count", "fetchedAt")
    SELECT ${identity.id}, t.at, t.count, NOW()
    FROM UNNEST(${ats}::timestamp[], ${counts}::int[]) AS t(at, count)
    ON CONFLICT ("igUserId", "at") DO UPDATE SET "count" = EXCLUDED."count", "fetchedAt" = NOW()
  `;
  return { ok: true, stored, error: null };
}
