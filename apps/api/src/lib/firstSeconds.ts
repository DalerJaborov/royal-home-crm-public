import {
  OPENING_SHOTS,
  OPENING_SHOT_LABELS,
  type FirstSecondsFactor,
  type FirstSecondsPost,
  type FirstSecondsResult,
  type OpeningShot,
  type VideoOpeningView,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadPostStats, type PostStatsPost } from "./postStats.js";
import { scheduleVideoOpening } from "./videoOpening.js";

/**
 * «ПЕРВЫЕ СЕКУНДЫ РОЛИКА» (24.09.2026, Dan: «разбор первых секунд ролика»).
 *
 * Сводит две половины: цифры удержания с площадок (lib/postStats.ts — доля
 * ушедших в первые 3 с у Instagram, среднее время просмотра у Instagram,
 * Facebook и YouTube) и разбор начала каждого ролика ИИ (jobs/videoOpening.ts,
 * таблица VideoOpening). Ролик без разбора ставится в очередь отсюда же — при
 * открытии экрана, не по расписанию.
 *
 * Сравнение групп — тем же честным приёмом, что «Почему взлетели»
 * (lib/postAnalysis.ts): меньше MIN_POSTS роликов с цифрами — выводов нет,
 * группа меньше MIN_GROUP «лучшей» не становится.
 */

export const FIRST_SECONDS_MIN_POSTS = 6;
export const FIRST_SECONDS_MIN_GROUP = 2;
/** Сколько новых разборов ставим за одно открытие экрана — ИИ платный, а экран открывают часто. */
const ENQUEUE_PER_CALL = 10;
/** Неудачный разбор повторяем не чаще раза в сутки. */
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Удержание одного ролика по площадкам. Чистая — проверяется тестом.
 * Досмотренная доля: YouTube отдаёт её сам, у Instagram/Facebook — среднее
 * время, делённое на длину ролика (её знает разбор начала). Больше 1 бывает
 * у Instagram (ролик крутится по кругу) — считаем как «досмотрели целиком».
 */
export function retentionOf(
  stats: PostStatsPost["stats"],
  durationSec: number | null
): { skipRate: number | null; avgWatchSec: number | null; watchedShare: number | null } {
  const skip = stats.find((s) => s.channel === "INSTAGRAM")?.skipRate ?? null;
  const watch = stats.flatMap((s) => (s.avgWatchSec !== null && s.avgWatchSec > 0 ? [s.avgWatchSec] : []));
  const shares: number[] = [];
  for (const s of stats) {
    if (s.watchedShare !== null) shares.push(s.watchedShare);
    else if (s.avgWatchSec !== null && s.avgWatchSec > 0 && durationSec) shares.push(s.avgWatchSec / durationSec);
  }
  const share = mean(shares.map((x) => Math.min(1, Math.max(0, x))));
  return { skipRate: skip, avgWatchSec: mean(watch), watchedShare: share };
}

function bestGroup(
  key: FirstSecondsFactor["key"],
  title: string,
  pairs: { value: string; share: number }[],
  overallShare: number
): FirstSecondsFactor | null {
  const groups = new Map<string, number[]>();
  for (const p of pairs) groups.set(p.value, [...(groups.get(p.value) ?? []), p.share]);
  if (groups.size < 2 || overallShare <= 0) return null;
  let best: { value: string; avg: number; n: number } | null = null;
  for (const [value, list] of groups) {
    if (list.length < FIRST_SECONDS_MIN_GROUP) continue;
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    if (!best || avg > best.avg) best = { value, avg, n: list.length };
  }
  if (!best) return null;
  return { key, title, best: best.value, bestShare: best.avg, overallShare, sample: best.n };
}

/** Какое начало досматривают дольше. Чистая — проверяется тестом. */
export function compareOpenings(posts: FirstSecondsPost[]): { counted: number; factors: FirstSecondsFactor[] } {
  const counted = posts.filter(
    (p): p is FirstSecondsPost & { opening: VideoOpeningView; watchedShare: number } =>
      p.opening !== null && p.watchedShare !== null
  );
  if (counted.length < FIRST_SECONDS_MIN_POSTS) return { counted: counted.length, factors: [] };
  const overall = counted.reduce((a, p) => a + p.watchedShare, 0) / counted.length;
  const factors = [
    bestGroup(
      "firstShot",
      "Что показано первым",
      counted.map((p) => ({ value: OPENING_SHOT_LABELS[p.opening.firstShot], share: p.watchedShare })),
      overall
    ),
    bestGroup(
      "person",
      "Человек в кадре",
      counted.map((p) => ({ value: p.opening.hasPerson ? "с человеком" : "без человека", share: p.watchedShare })),
      overall
    ),
    bestGroup(
      "text",
      "Надпись на экране",
      counted.map((p) => ({ value: p.opening.hasText ? "с надписью" : "без надписи", share: p.watchedShare })),
      overall
    ),
  ].filter((f): f is FirstSecondsFactor => f !== null);
  factors.sort((a, b) => b.bestShare - a.bestShare);
  return { counted: counted.length, factors };
}

export async function loadFirstSeconds(): Promise<FirstSecondsResult> {
  const stats = await loadPostStats();
  const ids = stats.posts.map((p) => p.propertyId);
  const [properties, openings] = await Promise.all([
    prisma.property.findMany({ where: { id: { in: ids } }, select: { id: true, videoHandoffFinalPath: true } }),
    prisma.videoOpening.findMany({ where: { propertyId: { in: ids } } }),
  ]);
  const pathById = new Map(properties.map((p) => [p.id, p.videoHandoffFinalPath]));
  const openingByKey = new Map(openings.map((o) => [`${o.propertyId}|${o.videoPath}`, o]));

  const toEnqueue: { propertyId: string; videoPath: string }[] = [];
  const posts: FirstSecondsPost[] = stats.posts.map((post) => {
    const videoPath = pathById.get(post.propertyId) ?? null;
    const row = videoPath ? openingByKey.get(`${post.propertyId}|${videoPath}`) : undefined;

    let opening: VideoOpeningView | null = null;
    let openingMissing: FirstSecondsPost["openingMissing"] = null;
    if (!videoPath || row?.status === "NO_FILE") {
      openingMissing = "no-file";
    } else if (row?.status === "OK" && row.firstShot && (OPENING_SHOTS as readonly string[]).includes(row.firstShot)) {
      opening = {
        firstShot: row.firstShot as OpeningShot,
        hasPerson: row.hasPerson,
        hasText: row.hasText,
        hookScore: row.hookScore ?? 0,
        note: row.note ?? "",
        tip: row.tip,
        durationSec: row.durationSec,
      };
    } else {
      openingMissing = "pending";
      const retry = !row || (row.status === "FAILED" && Date.now() - row.updatedAt.getTime() > FAILED_RETRY_MS);
      if (retry) toEnqueue.push({ propertyId: post.propertyId, videoPath });
    }

    const views = post.stats.reduce((a, s) => a + (s.views ?? 0), 0);
    return {
      propertyId: post.propertyId,
      shortId: post.shortId,
      title: post.title,
      views,
      ...retentionOf(post.stats, row?.durationSec ?? null),
      opening,
      openingMissing,
    };
  });

  await Promise.all(toEnqueue.slice(0, ENQUEUE_PER_CALL).map((t) => scheduleVideoOpening(t.propertyId, t.videoPath)));

  const { counted, factors } = compareOpenings(posts);
  return {
    posts,
    factors,
    counted,
    pending: posts.filter((p) => p.openingMissing === "pending").length,
    retentionAvailable: posts.some((p) => p.skipRate !== null || p.avgWatchSec !== null || p.watchedShare !== null),
  };
}
