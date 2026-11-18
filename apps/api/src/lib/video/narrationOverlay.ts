import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryRunFfmpeg } from "../ffmpeg.js";

/**
 * ИЗМЕНЯЕМЫЙ ТЕКСТ НА РОЛИКЕ (18.11.2026, решение владельца): цену и субтитры CRM рисует сама при каждой
 * сборке ролика (lib/narrationAutoFlow.ts → перемонтаж), а не монтажёр: сменилась цена — новый ролик
 * получает новую плашку, старая цифра нигде не остаётся. Рубильник textOverlay в настройках озвучки,
 * по умолчанию ВЫКЛ.
 *
 * Рисует ffmpeg (drawtext, шрифт Onest из apps/api/assets/fonts/report — с таджикскими буквами ӣ ҳ ҷ қ ғ ӯ,
 * проверено по таблице символов шрифта 18.11). Файл шрифта указывается путём, не по имени: системный
 * fontconfig для этого не нужен. Тексты кладутся во временные файлы (textfile=), чтобы двоеточия,
 * * кавычки из текста озвучки не ломали фильтр; expansion=none — чтобы «%» не читался как подстановка.
 *
 * ТАЙМИНГИ СУБТИТРОВ. ElevenLabs умеет отдавать время каждого символа (POST /v1/text-to-speech/{voice_id}/with-timestamps,
 * поля alignment.characters / character_start_times_seconds; проверено по документации 18.11), но озвучка CRM
 * сейчас заказывается обычным путём и времени не хранит. Поэтому фразы делятся по длине текста
 * пропорционально длине голоса (subtitleCues); когда генерация начнёт сохранять alignment — передать его сюда.
 */

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/fonts/report");
export const OVERLAY_FONTS = { bold: path.join(FONT_DIR, "Onest-Bold.ttf"), semibold: path.join(FONT_DIR, "Onest-SemiBold.ttf") } as const;

export type SubtitleCue = { text: string; start: number; end: number };

/** Не длиннее этого — одна строка субтитра; фраза длиннее режется по словам. */
export const SUBTITLE_LINE_CHARS = 26;
const CUE_MAX_CHARS = SUBTITLE_LINE_CHARS * 2;

/** Фразы по знакам препинания, длинные — по словам до двух строк. */
export function splitSubtitlePhrases(script: string): string[] {
  const clean = script.replace(/\s+/gu, " ").trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?…;:,])\s+/u).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length <= CUE_MAX_CHARS) { out.push(part); continue; }
    let cur = "";
    for (const word of part.split(" ")) {
      if (cur && (cur + " " + word).length > CUE_MAX_CHARS) { out.push(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(cur);
  }
  // Короткий хвост («Звоните.») присоединяем к соседу, чтобы субтитр не мелькал.
  const merged: string[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && (s.length < 14 || prev.length < 14) && (prev + " " + s).length <= CUE_MAX_CHARS) merged[merged.length - 1] = `${prev} ${s}`;
    else merged.push(s);
  }
  return merged;
}

/** Субтитр в две строки по словам. */
export function wrapSubtitle(text: string): string {
  if (text.length <= SUBTITLE_LINE_CHARS) return text;
  const words = text.split(" ");
  let best = text, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) { bestDiff = diff; best = `${a}\n${b}`; }
  }
  return best;
}

/**
 * Время фраз. alignment (если есть) — время символов ElevenLabs по тексту script; иначе — пропорционально
 * числу букв на длину голоса. startSec — задержка начала голоса (narrationMix: 0,3 с), tempo — ускорение.
 */
export function subtitleCues(input: { script: string; voiceSec: number; startSec: number; tempo?: number;
  alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null }): SubtitleCue[] {
  const phrases = splitSubtitlePhrases(input.script);
  const tempo = input.tempo && input.tempo > 0 ? input.tempo : 1;
  const spoken = input.voiceSec / tempo;
  if (!phrases.length || !(spoken > 0)) return [];
  const weight = (s: string) => Math.max(1, s.replace(/[^\p{L}\p{N}]/gu, "").length);
  const total = phrases.reduce((n, s) => n + weight(s), 0);
  let t = 0;
  const cues = phrases.map((text) => {
    const len = (weight(text) / total) * spoken;
    const cue = { text: wrapSubtitle(text), start: input.startSec + t, end: input.startSec + t + len };
    t += len;
    return cue;
  });
  const a = input.alignment;
  if (a && a.characters.length === a.character_start_times_seconds.length && a.characters.length > 0) {
    // Сдвиг по точному времени: начало фразы — время её первой буквы в тексте озвучки.
    const joined = a.characters.join("");
    let from = 0;
    cues.forEach((cue, i) => {
      const first = phrases[i]!.slice(0, 12);
      const at = joined.indexOf(first, from);
      if (at < 0) return;
      from = at + first.length;
      cue.start = input.startSec + a.character_start_times_seconds[at]! / tempo;
      if (i > 0) cues[i - 1]!.end = cue.start;
    });
    const lastEnd = a.character_end_times_seconds[a.character_end_times_seconds.length - 1];
    if (lastEnd !== undefined) cues[cues.length - 1]!.end = input.startSec + lastEnd / tempo;
  }
  return cues;
}

/** Путь для фильтра ffmpeg: прямые слэши, двоеточие диска экранировано. */
export function ffFilterPath(p: string): string {
  return p.replace(/\\/gu, "/").replace(/:/gu, "\\:").replace(/'/gu, "\\'");
}

/**
 * Цепочка фильтров видео: плашка с ценой вверху слева (весь ролик) и субтитры внизу по времени.
 * Размеры — доли кадра: годится и для 9:16, и для квадрата. Тексты — файлы в workDir.
 */
export function buildOverlayFilter(input: { width: number; height: number; price: string | null; cues: SubtitleCue[]; workDir: string }): string {
  const { width: w, height: h } = input;
  const unit = Math.min(w, h * 9 / 16);
  const parts: string[] = [];
  const textFile = (name: string, text: string) => {
    const file = path.join(input.workDir, name);
    fs.writeFileSync(file, text, "utf8");
    return ffFilterPath(file);
  };
  if (input.price) {
    const size = Math.round(unit * 0.075);
    const pad = Math.round(size * 0.45);
    const x = Math.round(w * 0.055), y = Math.round(h * 0.075);
    parts.push(`drawtext=fontfile='${ffFilterPath(OVERLAY_FONTS.bold)}':textfile='${textFile("price.txt", input.price)}':x=${x + pad}:y=${y + pad}:fontsize=${size}:expansion=none:fontcolor=white:box=1:boxcolor=0x1f4fd8@0.94:boxborderw=${pad}`);
  }
  const subSize = Math.round(unit * 0.05);
  // Каждая строка субтитра — своим drawtext с x=(w-text_w)/2: многострочный drawtext ровняет строки по левому краю
  // блока, и короткая строка выглядела сдвинутой. Плашки строк стыкуются и читаются одной.
  const border = Math.round(subSize * 0.4);
  // Шаг = высота плашки строки: плашки стыкуются, а не накладываются (полупрозрачное наложение давало тёмную полосу).
  const step = Math.round(subSize * 0.95) + 2 * border;
  input.cues.forEach((cue, i) => {
    const lines = cue.text.split("\n");
    const top = Math.round(h * 0.78) - (lines.length - 1) * step;
    lines.forEach((line, j) => {
      parts.push(`drawtext=fontfile='${ffFilterPath(OVERLAY_FONTS.semibold)}':textfile='${textFile(`sub-${i}-${j}.txt`, line)}':x=(w-text_w)/2:y=${top + j * step}:fontsize=${subSize}:expansion=none:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=${border}:enable='between(t,${cue.start.toFixed(2)},${cue.end.toFixed(2)})'`);
    });
  });
  return parts.join(",");
}

let drawtext: Promise<boolean> | null = null;
/** Есть ли в ffmpeg фильтр drawtext (сборка с libfreetype). Ответ запоминается на процесс. */
export function drawtextAvailable(): Promise<boolean> {
  drawtext ??= tryRunFfmpeg({ args: ["-hide_banner", "-filters"], captureStdout: true, timeoutMs: 15_000, label: "фильтры ffmpeg" })
    .then((r) => !!r && /\bdrawtext\b/u.test(r.stdout));
  return drawtext;
}
