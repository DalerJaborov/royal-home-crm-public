/**
 * «ПОЧЕМУ ВЗЛЕТЕЛИ» — АНАЛИЗАТОР РОЛИКОВ (24.09.2026, владелец: «можно ещё
 * анализатор включить в это же окно с роликами — почему некоторые наши ролики
 * хорошо взлетели»).
 *
 * Что делает: берёт вышедшие ролики с их просмотрами на всех площадках
 * (lib/postStats.ts) и сравнивает их средние по признакам, которые у нас
 * ЕСТЬ о каждом ролике: час и день выхода, площадка, тип объекта, район, цена,
 * комнаты. По каждому признаку — какое значение даёт больше всего просмотров
 * и насколько выше общего среднего. Поверх — короткий разбор ИИ обычными
 * словами, раз в сутки (тот же приём, что lib/marketingInsights.ts).
 *
 * ЧЕСТНОСТЬ ВАЖНЕЕ КРАСОТЫ. На трёх роликах «вечер лучше утра» — случайность,
 * поэтому: меньше MIN_POSTS роликов со статистикой — разбора нет, так и
 * пишем; значение, за которым меньше MIN_GROUP роликов, в «лучшие» не
 * выбирается. ИИ получает только эти готовые числа и не досчитывает.
 */
import { callAiText } from "../ai/client.js";
import { prisma } from "../db.js";
import { PROPERTY_TYPE_LABELS, type PropertyType } from "@royal-home/shared";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { loadMoneyContext, toTjs } from "./money.js";
import { DUSHANBE_OFFSET_MS } from "./dushanbeTime.js";

/** Меньше — выводов не делаем вовсе. */
export const POST_ANALYSIS_MIN_POSTS = 6;
/** Значение признака, за которым меньше роликов, «лучшим» не становится. */
export const POST_ANALYSIS_MIN_GROUP = 2;

const CHANNEL_WORDS: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
  TELEGRAM: "Telegram",
};

const DOW_WORDS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** Один ролик с тем, что о нём известно. */
export interface AnalyzedPost {
  propertyId: string;
  shortId: number;
  title: string;
  /** Сумма просмотров по площадкам, отдавшим цифру. */
  views: number;
  /** Просмотры по каждой площадке, где цифра есть. */
  byChannel: Record<string, number>;
  publishHour: number | null;
  /** День недели по Душанбе, 0 — воскресенье. */
  publishDow: number | null;
  type: string | null;
  district: string | null;
  priceTjs: number | null;
  rooms: number | null;
}

export interface PostAnalysisFactor {
  key: string;
  title: string;
  best: string;
  bestAvg: number;
  overallAvg: number;
  lift: number;
  sample: number;
}

export interface PostAnalysisResult {
  ready: boolean;
  reason: string | null;
  postsCounted: number;
  factors: PostAnalysisFactor[];
  top: { propertyId: string; shortId: number; title: string; views: number }[];
  summary: string | null;
  summaryAt: string | null;
}

function hourBucket(hour: number): string {
  if (hour < 12) return "утро (до 12:00)";
  if (hour < 15) return "обед (12–15)";
  if (hour < 18) return "день (15–18)";
  if (hour < 21) return "вечер (18–21)";
  return "поздний вечер (после 21)";
}

function priceBucket(tjs: number): string {
  if (tjs < 300_000) return "до 300 тыс. сомони";
  if (tjs < 600_000) return "300–600 тыс. сомони";
  if (tjs < 1_000_000) return "600 тыс. – 1 млн сомони";
  return "дороже 1 млн сомони";
}

function roomsBucket(rooms: number): string {
  if (rooms <= 1) return "1 комната";
  if (rooms >= 4) return "4 комнаты и больше";
  return `${rooms} комнаты`;
}

/**
 * Лучшее значение одного признака. Для каждого значения — среднее просмотров
 * его роликов; «лучшее» — самое высокое среди значений хотя бы с MIN_GROUP
 * роликами. null — признак ничего не различает (одно значение на всех или
 * малые группы).
 */
function bestOf(
  key: string,
  title: string,
  pairs: { value: string; views: number }[],
  overallAvg: number
): PostAnalysisFactor | null {
  const groups = new Map<string, number[]>();
  for (const p of pairs) groups.set(p.value, [...(groups.get(p.value) ?? []), p.views]);
  if (groups.size < 2) return null;
  let best: { value: string; avg: number; n: number } | null = null;
  for (const [value, list] of groups) {
    if (list.length < POST_ANALYSIS_MIN_GROUP) continue;
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    if (!best || avg > best.avg) best = { value, avg, n: list.length };
  }
  if (!best || overallAvg <= 0) return null;
  return {
    key,
    title,
    best: best.value,
    bestAvg: best.avg,
    overallAvg,
    lift: ((best.avg - overallAvg) / overallAvg) * 100,
    sample: best.n,
  };
}

/** Чистое сравнение — его проверяет тест без базы и без сети. */
export function analyzePosts(posts: AnalyzedPost[]): Omit<PostAnalysisResult, "summary" | "summaryAt"> {
  const counted = posts.filter((p) => Object.keys(p.byChannel).length > 0);
  const top = [...counted]
    .sort((a, b) => b.views - a.views)
    .slice(0, 5)
    .map((p) => ({ propertyId: p.propertyId, shortId: p.shortId, title: p.title, views: p.views }));
  if (counted.length < POST_ANALYSIS_MIN_POSTS) {
    return {
      ready: false,
      reason: `Для выводов нужно хотя бы ${POST_ANALYSIS_MIN_POSTS} роликов с просмотрами, сейчас ${counted.length}. Разбор появится сам, когда их станет больше.`,
      postsCounted: counted.length,
      factors: [],
      top,
    };
  }

  const overallAvg = counted.reduce((a, p) => a + p.views, 0) / counted.length;
  const factors: PostAnalysisFactor[] = [];
  const push = (f: PostAnalysisFactor | null) => {
    if (f) factors.push(f);
  };

  push(
    bestOf(
      "hour",
      "Час выхода",
      counted.flatMap((p) => (p.publishHour !== null ? [{ value: hourBucket(p.publishHour), views: p.views }] : [])),
      overallAvg
    )
  );
  push(
    bestOf(
      "dow",
      "День недели",
      counted.flatMap((p) => (p.publishDow !== null ? [{ value: DOW_WORDS[p.publishDow], views: p.views }] : [])),
      overallAvg
    )
  );
  push(
    bestOf(
      "type",
      "Тип объекта",
      counted.flatMap((p) => (p.type ? [{ value: p.type, views: p.views }] : [])),
      overallAvg
    )
  );
  push(
    bestOf(
      "district",
      "Район",
      counted.flatMap((p) => (p.district ? [{ value: p.district, views: p.views }] : [])),
      overallAvg
    )
  );
  push(
    bestOf(
      "price",
      "Цена",
      counted.flatMap((p) => (p.priceTjs !== null ? [{ value: priceBucket(p.priceTjs), views: p.views }] : [])),
      overallAvg
    )
  );
  push(
    bestOf(
      "rooms",
      "Комнаты",
      counted.flatMap((p) => (p.rooms !== null ? [{ value: roomsBucket(p.rooms), views: p.views }] : [])),
      overallAvg
    )
  );

  // Площадка — отдельно: у одного ролика просмотры на нескольких площадках,
  // сравнивается средний ролик площадки со средним роликом на площадке вообще.
  const perChannel = new Map<string, number[]>();
  for (const p of counted) {
    for (const [ch, v] of Object.entries(p.byChannel)) perChannel.set(ch, [...(perChannel.get(ch) ?? []), v]);
  }
  const channelAvgs = [...perChannel.entries()]
    .filter(([, list]) => list.length >= POST_ANALYSIS_MIN_GROUP)
    .map(([ch, list]) => ({ ch, avg: list.reduce((a, b) => a + b, 0) / list.length, n: list.length }));
  if (channelAvgs.length >= 2) {
    const all = [...perChannel.values()].flat();
    const avgAll = all.reduce((a, b) => a + b, 0) / all.length;
    const bestCh = channelAvgs.reduce((a, b) => (b.avg > a.avg ? b : a));
    if (avgAll > 0) {
      factors.push({
        key: "channel",
        title: "Площадка",
        best: CHANNEL_WORDS[bestCh.ch] ?? bestCh.ch,
        bestAvg: bestCh.avg,
        overallAvg: avgAll,
        lift: ((bestCh.avg - avgAll) / avgAll) * 100,
        sample: bestCh.n,
      });
    }
  }

  // Самое сильное различие — первым: экран читается сверху вниз.
  factors.sort((a, b) => b.lift - a.lift);
  return { ready: true, reason: null, postsCounted: counted.length, factors, top };
}

/** Из ответа статистики площадок — в ролики с признаками объекта. Одним запросом в базу. */
export async function enrichPosts(
  posts: {
    propertyId: string;
    shortId: number;
    title: string;
    publishedAt: string | null;
    publishHour: number | null;
    stats: { channel: string; views: number | null }[];
  }[]
): Promise<AnalyzedPost[]> {
  if (posts.length === 0) return [];
  const [rows, money] = await Promise.all([
    prisma.property.findMany({
      where: { id: { in: posts.map((p) => p.propertyId) } },
      select: { id: true, type: true, rooms: true, price: true, currency: true, district: { select: { name: true } } },
    }),
    loadMoneyContext(),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return posts.map((p) => {
    const row = byId.get(p.propertyId);
    const byChannel: Record<string, number> = {};
    for (const s of p.stats) if (s.views !== null) byChannel[s.channel] = s.views;
    const publishDow =
      p.publishedAt !== null ? new Date(new Date(p.publishedAt).getTime() + DUSHANBE_OFFSET_MS).getUTCDay() : null;
    return {
      propertyId: p.propertyId,
      shortId: p.shortId,
      title: p.title,
      views: Object.values(byChannel).reduce((a, b) => a + b, 0),
      byChannel,
      publishHour: p.publishHour,
      publishDow,
      type: row ? (PROPERTY_TYPE_LABELS[row.type as PropertyType] ?? null) : null,
      district: row?.district?.name ?? null,
      priceTjs: row ? toTjs(row.price, row.currency, money) : null,
      rooms: row?.rooms ?? null,
    };
  });
}

/** Разбор ИИ — раз в сутки на процесс; без него экран всё равно показывает числа. */
const SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;
let summaryCache: { text: string; at: number; key: string } | null = null;

export function _clearPostAnalysisCache(): void {
  summaryCache = null;
}

export async function summarizeWithAi(analysis: Omit<PostAnalysisResult, "summary" | "summaryAt">): Promise<{
  summary: string | null;
  summaryAt: string | null;
}> {
  if (!analysis.ready || analysis.factors.length === 0) return { summary: null, summaryAt: null };
  // Ключ — сами выводы: поменялись цифры — разбор пишется заново, не раньше суток.
  const key = JSON.stringify(analysis.factors.map((f) => [f.key, f.best, Math.round(f.lift)]));
  if (summaryCache && summaryCache.key === key && Date.now() - summaryCache.at < SUMMARY_TTL_MS) {
    return { summary: summaryCache.text, summaryAt: new Date(summaryCache.at).toISOString() };
  }
  const facts = analysis.factors
    .map(
      (f) =>
        `${f.title}: лучше всего «${f.best}» — в среднем ${Math.round(f.bestAvg)} просмотров против ${Math.round(f.overallAvg)} у всех (+${Math.round(f.lift)} %, роликов в группе ${f.sample})`
    )
    .join("\n");
  const top = analysis.top.map((t) => `№${t.shortId} «${t.title}» — ${t.views} просмотров`).join("\n");
  try {
    const data = await callAiText<{ summary: string }>({
      endpoint: "post-analysis",
      system:
        "Ты маркетолог агентства недвижимости Royal Home в Душанбе. Тебе дают готовое сравнение роликов об объектах: " +
        "какие признаки (час и день выхода, площадка, тип объекта, район, цена, комнаты) дают больше просмотров. " +
        "Напиши 2–3 предложения: что общего у роликов, которые взлетели, и что попробовать в ближайшие публикации. " +
        "По-русски, простыми словами, без англицизмов. Числа — только из данных, ничего не досчитывай. " +
        "Если группа маленькая (2–3 ролика), скажи, что это пока совпадение, а не закон. " +
        `Ответ строго JSON: {"summary": "..."}.\n\nСравнение (всего роликов ${analysis.postsCounted}):\n${facts}\n\nЛучшие ролики:\n${top}`,
      user: "Сделай разбор.",
      maxTokens: 600,
    });
    if (!data?.summary) return { summary: null, summaryAt: null };
    summaryCache = { text: data.summary, at: Date.now(), key };
    return { summary: data.summary, summaryAt: new Date().toISOString() };
  } catch (err) {
    void logSystemError("ai", `Разбор «почему взлетели» не построен: ${describeError(err)}`, {
      dedupKey: "post-analysis-ai-failed",
    });
    return { summary: null, summaryAt: null };
  }
}
