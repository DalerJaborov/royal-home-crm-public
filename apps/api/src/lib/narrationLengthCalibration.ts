import fs from "node:fs";
import path from "node:path";
import { narrationLengthCheck, narrationSpeechText, NARRATION_CHARS_PER_SEC_RANGE, type NarrationLang, type NarrationLengthCheck } from "@royal-home/shared";
import { prisma } from "../db.js";
import { videoHandoffDir } from "../upload.js";
import { probeDurationSec } from "./ffmpeg.js";
import { localVideoFilePath } from "./localVideoStorage.js";

/**
 * ДЛИНА ОЗВУЧКИ ДО ОПЛАТЫ — СЕРВЕРНАЯ ПОЛОВИНА (18.11.2026). Правило одно — packages/shared/narrationLength.ts;
 * здесь только два входа, которых у экрана нет:
 *   • длина ролика (ffprobe по файлу; ролик без голоса, если он есть — голос ложится на него);
 *   • скорость речи по замерам: уже озвученные версии хранят audioSec (замер при наложении на ролик).
 * Замеров меньше пяти на язык — берётся осторожная постоянная из shared.
 */

const clipCache = new Map<string, number | null>();
const CLIP_CACHE_MAX = 500;

/** Длина ролика, на который ляжет голос: ролик без голоса (мастер), иначе вышедший ролик. null — ролика нет. */
export async function narrationClipSec(p: { videoMasterStorageKey: string | null; videoHandoffFinalPath: string | null }): Promise<number | null> {
  const masterPath = p.videoMasterStorageKey ? localVideoFilePath(p.videoMasterStorageKey) : null;
  const finalPath = p.videoHandoffFinalPath?.startsWith("/uploads/handoff/") ? path.join(videoHandoffDir, path.basename(p.videoHandoffFinalPath)) : null;
  for (const file of [masterPath, finalPath]) {
    if (!file) continue;
    if (clipCache.has(file)) { const v = clipCache.get(file)!; if (v) return v; continue; }
    if (!fs.existsSync(file)) continue;
    const sec = await probeDurationSec(file).catch(() => null);
    if (clipCache.size > CLIP_CACHE_MAX) clipCache.clear();
    clipCache.set(file, sec);
    if (sec) return sec;
  }
  return null;
}
export function resetNarrationClipCacheForTests(): void { clipCache.clear(); measured = null; }
/** Тестам: длина ролика без ffprobe. */
export function setNarrationClipSecForTests(file: string, sec: number | null): void { clipCache.set(file, sec); }

let measured: { at: number; value: Partial<Record<NarrationLang, number>> } | null = null;
const MEASURE_TTL_MS = 10 * 60_000;
/** Медиана «знаков речи в секунду» по последним озвучкам с замером, с запасом 8 % в сторону длинной оценки. */
export async function measuredNarrationCharsPerSec(now = Date.now()): Promise<Partial<Record<NarrationLang, number>>> {
  if (measured && now - measured.at < MEASURE_TTL_MS) return measured.value;
  const rows = await prisma.propertyNarrationVersion.findMany({ where: { audioSec: { gt: 1 } }, orderBy: { createdAt: "desc" }, take: 200,
    select: { script: true, language: true, audioSec: true } });
  const value: Partial<Record<NarrationLang, number>> = {};
  for (const lang of ["ru", "tg"] as const) {
    const rates = rows.filter((r) => (r.language ?? "ru") === lang && r.audioSec)
      .map((r) => narrationSpeechText(r.script, lang).length / r.audioSec!)
      .filter((x) => x >= NARRATION_CHARS_PER_SEC_RANGE.min && x <= NARRATION_CHARS_PER_SEC_RANGE.max)
      .sort((a, b) => a - b);
    if (rates.length >= 5) value[lang] = Math.round(rates[Math.floor(rates.length / 2)]! * 0.92 * 10) / 10;
  }
  measured = { at: now, value };
  return value;
}

/** Проверка текста против ролика объекта; null — ролика нет, проверять не с чем. */
export async function narrationLengthCheckFor(p: { videoMasterStorageKey: string | null; videoHandoffFinalPath: string | null },
  script: string, lang: string | null | undefined): Promise<NarrationLengthCheck | null> {
  const clipSec = await narrationClipSec(p);
  if (!clipSec) return null;
  const l: NarrationLang = lang === "tg" ? "tg" : "ru";
  return narrationLengthCheck(script, l, clipSec, await measuredNarrationCharsPerSec());
}
