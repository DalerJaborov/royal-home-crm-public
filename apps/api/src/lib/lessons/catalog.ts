import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * КАТАЛОГ ВИДЕОУРОКОВ ПО CRM (28.11.2026).
 *
 * Уроки кладёт на сервер конвейер в /opt/royalhome-lessons (в контейнер — только на чтение, /app/lessons,
 * переменная LESSONS_DIR). Здесь — чтение и проверка manifest.json, поиск по номеру, названию и тексту озвучки
 * и фрагмент ответа. Каталога или манифеста нет — это «уроки пока не загружены», а не ошибка: помощница так и
 * отвечает. Сам файл урока (mp4, обложка) отдаётся только по пути внутри каталога.
 */
export const LESSON_LANGS = ["ru", "tj"] as const;
export type LessonLang = (typeof LESSON_LANGS)[number];

const lessonSchema = z.object({
  number: z.number().int().min(1).max(999),
  lang: z.enum(LESSON_LANGS),
  title: z.string().trim().min(1).max(200),
  file: z.string().trim().min(1).max(300),
  cover: z.string().trim().max(300).nullish(),
  durationSec: z.number().min(0).max(36_000).nullish(),
  transcript: z.string().max(200_000).default(""),
});
const manifestSchema = z.object({ course: z.string().optional(), updated: z.string().optional(), lessons: z.array(lessonSchema).max(2000) });

export interface Lesson {
  number: number;
  lang: LessonLang;
  title: string;
  /** Абсолютный путь к mp4 внутри каталога уроков. */
  filePath: string;
  coverPath: string | null;
  durationSec: number | null;
  transcript: string;
}

export type LessonCatalog = { status: "ok"; lessons: Lesson[] } | { status: "empty" } | { status: "invalid" };

export const LESSONS_NOT_LOADED_TEXT = "Уроки пока не загружены";
const CACHE_MS = 60_000;
let cache: { dir: string; at: number; value: LessonCatalog } | null = null;

export function lessonsDir(): string {
  return process.env.LESSONS_DIR?.trim() || "/app/lessons";
}

/** Для тестов: забыть кэш. */
export function resetLessonCatalogCache(): void {
  cache = null;
}

/** Путь из манифеста — только внутри каталога уроков (никаких `..` и абсолютных путей). */
function insideDir(dir: string, rel: string): string | null {
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

async function readCatalog(dir: string): Promise<LessonCatalog> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, "manifest.json"), "utf8");
  } catch {
    return { status: "empty" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return { status: "invalid" };
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) return { status: "invalid" };
  const lessons: Lesson[] = [];
  for (const item of parsed.data.lessons) {
    const filePath = insideDir(dir, item.file);
    if (!filePath) continue;
    lessons.push({
      number: item.number,
      lang: item.lang,
      title: item.title,
      filePath,
      coverPath: item.cover ? insideDir(dir, item.cover) : null,
      durationSec: item.durationSec ?? null,
      transcript: item.transcript,
    });
  }
  if (lessons.length === 0) return { status: "empty" };
  lessons.sort((a, b) => a.number - b.number || a.lang.localeCompare(b.lang));
  return { status: "ok", lessons };
}

export async function loadLessonCatalog(): Promise<LessonCatalog> {
  const dir = lessonsDir();
  if (cache && cache.dir === dir && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await readCatalog(dir);
  cache = { dir, at: Date.now(), value };
  return value;
}

/** Строка про состояние каталога для ответа инструмента; null — уроки есть. */
export function catalogProblem(catalog: LessonCatalog): string | null {
  if (catalog.status === "ok") return null;
  return catalog.status === "empty" ? LESSONS_NOT_LOADED_TEXT : "Список уроков сейчас не читается, сообщите руководителю";
}

// ─── Поиск ────────────────────────────────────────────────────────────────

/** Нормализация для сравнения слов: регистр, ё, таджикские буквы к близким русским. */
export function normalizeLessonText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/ӣ/g, "и")
    .replace(/ӯ/g, "у")
    .replace(/ғ/g, "г")
    .replace(/қ/g, "к")
    .replace(/ҳ/g, "х")
    .replace(/ҷ/g, "ч")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const STOPWORDS = new Set([
  "как", "что", "это", "где", "для", "или", "при", "про", "над", "под", "надо", "можно", "нужно", "урок", "уроки", "видео",
  "покажи", "скажи", "хочу", "если", "чтобы", "меня", "мне", "мой", "моя", "наш", "crm", "срм", "сделать", "делать",
  "ман", "хам", "чи", "ки", "барои", "аз", "дар", "ба", "бо", "чун", "мисли",
]);

/** Слова запроса: без служебных, не короче 3 букв. */
export function queryWords(query: string): string[] {
  return [...new Set(normalizeLessonText(query).split(" ").filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

/** Основа слова для сравнения «заявка / заявку / заявки»: первые 5 букв (короткие слова целиком). */
function stem(word: string): string {
  return word.length > 5 ? word.slice(0, 5) : word;
}

function stemSet(text: string): Set<string> {
  return new Set(normalizeLessonText(text).split(" ").filter((w) => w.length >= 3).map(stem));
}

export interface LessonHit {
  lesson: Lesson;
  score: number;
  snippet: string;
}

const SNIPPET_MAX = 320;

/** Предложение текста урока с наибольшим числом совпавших слов и следующее за ним (до SNIPPET_MAX знаков). */
export function lessonSnippet(transcript: string, words: string[]): string {
  const clean = transcript.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentences = clean.split(/(?<=[.!?…])\s+/u);
  const wantedStems = new Set(words.map(stem));
  let best = sentences.slice(0, 2).join(" ");
  let bestScore = 0;
  for (let i = 0; i < sentences.length; i += 1) {
    const stems = stemSet(sentences[i]!);
    let score = 0;
    for (const w of wantedStems) if (stems.has(w)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = [sentences[i], sentences[i + 1]].filter(Boolean).join(" ");
    }
  }
  return best.length > SNIPPET_MAX ? `${best.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : best;
}

/** Номер урока из запроса: «5», «урок 5», «урок №12»; иначе null. */
export function lessonNumberFromQuery(query: string): number | null {
  const m = /^\s*(?:урок|дарс|lesson)?\s*(?:№|#|номер)?\s*(\d{1,3})\s*$/iu.exec(query);
  return m ? Number(m[1]) : null;
}

/**
 * Поиск: номер → точное попадание; иначе слова запроса против названия (вес 3) и текста (вес 1).
 * Язык задан — уроки этого языка идут первыми.
 */
export function searchLessons(lessons: Lesson[], query: string, lang?: LessonLang, limit = 5): LessonHit[] {
  const number = lessonNumberFromQuery(query);
  if (number !== null) {
    return lessons
      .filter((l) => l.number === number)
      .sort((a, b) => Number(b.lang === lang) - Number(a.lang === lang))
      .slice(0, limit)
      .map((lesson) => ({ lesson, score: 100, snippet: lessonSnippet(lesson.transcript, []) }));
  }
  const words = queryWords(query);
  if (words.length === 0) return [];
  const wantedStems = words.map(stem);
  const hits: LessonHit[] = [];
  for (const lesson of lessons) {
    const titleStems = stemSet(lesson.title);
    const textStems = stemSet(lesson.transcript);
    let score = 0;
    for (const w of wantedStems) {
      if (titleStems.has(w)) score += 3;
      if (textStems.has(w)) score += 1;
    }
    if (score > 0) hits.push({ lesson, score, snippet: lessonSnippet(lesson.transcript, words) });
  }
  hits.sort(
    (a, b) =>
      Number(b.lesson.lang === lang) - Number(a.lesson.lang === lang) ||
      b.score - a.score ||
      a.lesson.number - b.lesson.number,
  );
  return hits.slice(0, limit);
}

/** Урок по номеру и языку. */
export function findLessonByNumber(lessons: Lesson[], number: number, lang: LessonLang): Lesson | null {
  return lessons.find((l) => l.number === number && l.lang === lang) ?? null;
}

export function formatDuration(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return null;
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
