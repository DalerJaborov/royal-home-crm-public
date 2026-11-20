#!/usr/bin/env node
/**
 * СТОРОЖ КОНСТИТУЦИИ ОБОЛОЧКИ «НОВОГО ВИДА» (пачка C, 20.11.2026).
 *
 * ЗАЧЕМ. Разбор интерфейса 20.11 (docs/design/oblik-2026-11-17/audit-20-11/critic-uiux.md)
 * насчитал в слоях нового вида 16 размеров шрифта и 12 clamp, 25 скруглений, 90 цветов
 * мимо токенов, 60 теней и 19 точек перелома: каждый из шестнадцати файлов решал сам. Пачка C
 * свела их к шкалам в одном месте — блок «КОНСТИТУЦИЯ ОБОЛОЧКИ» в theme-look-royal.css. Без
 * сторожа разнобой вернётся через месяц: новый экран пишется копией соседнего, а соседний —
 * копией старой темы.
 *
 * ЧТО ПРОВЕРЯЕТ. Все apps/web/src/theme-look-royal*.css. Литералы допустимы только в
 * объявлениях своих свойств (`--имя: значение`) файла токенов theme-look-royal.css. Везде
 * остальное:
 *   color      — #hex, rgb()/rgba()/hsl()/hsla(), white/black в значении (кроме mask-image:
 *                там #000 — это прозрачность маски, а не цвет). Свой `--x: #hex` в слое
 *                экрана — тоже нарушение: место ему в файле токенов;
 *   font-size  — px/rem/pt (в том числе внутри clamp/max). Можно var(--rh-fs-*), em, %, inherit;
 *   radius     — px/rem и % кроме 50%. Можно var(--rh-r-*), 0, 50%, inherit;
 *   shadow     — слой тени с размытием, заданный числом. Можно токен (var(--rh-ui-shadow*)),
 *                none и тонкую линию без размытия (`[inset] 0 0 0 1px var(--…)`): это граница;
 *   media      — (min|max)-width не из списка BREAKPOINTS.
 * И в components/look/**.tsx (кроме тестов) — цвет литералом и fontSize/borderRadius/
 * boxShadow числом во встроенном style.
 *
 * БАЗА ИСКЛЮЧЕНИЙ. `.look-audit-baseline.json`: файл → { reason, counts: { "вид значение": n } }.
 * Причина обязательна. Новое нарушение (ключа нет или счёт вырос) валит проверку; меньше, чем в
 * базе, — подсказка сжать базу: `npm run audit:look -- --shrink` (только уменьшает числа и
 * убирает пустые записи, добавить ничего не может). Сейчас в базе — четыре раздела директора
 * (Отчёты, Реклама, Деньги, Контроль): их в тот же день переделывает ветка
 * feat/look-director-sections, перевод на токены — после её влития.
 *
 *   node scripts/audit-look.mjs            # проверить
 *   node scripts/audit-look.mjs --list     # все нарушения с номерами строк
 *   node scripts/audit-look.mjs --shrink   # сжать базу до фактических чисел
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "apps/web/src");
const LOOK_DIR = join(SRC, "components/look");
const BASELINE = join(ROOT, ".look-audit-baseline.json");
export const TOKEN_FILE = "theme-look-royal.css";
const LOOK_FILE = /^theme-look-royal(-[\w-]+)?\.css$/;

/** Точки перелома: 360, 390 узкий телефон, 768 планшет, 820 граница разметки useMobileUx, 1024 ПК, 1440 широкий. */
export const BREAKPOINTS = [360, 390, 768, 820, 1024, 1440];
const MAX_OK = new Set(BREAKPOINTS.map((b) => `${(b - 0.02).toFixed(2)}`));
const MIN_OK = new Set(BREAKPOINTS.map(String));

/* ───────── разбор CSS ───────── */

function stripComments(css) {
  // Сохраняем переводы строк, чтобы номера строк остались верными.
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Делит по запятым верхнего уровня (запятые внутри скобок — часть одного значения). */
export function splitTop(value) {
  const out = []; let depth = 0; let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Объявления и заголовки @media с номерами строк. */
export function parseCss(css) {
  const text = stripComments(css);
  const decls = []; const media = [];
  let buf = ""; let bufLine = 1; let line = 1;
  for (const ch of text) {
    if (ch === "{") {
      const head = buf.trim();
      if (/^@media\b/.test(head)) media.push({ head, line: bufLine });
      buf = ""; bufLine = line;
    } else if (ch === ";" || ch === "}") {
      const d = buf.trim();
      const i = d.indexOf(":");
      if (i > 0 && !d.startsWith("@")) decls.push({ prop: d.slice(0, i).trim().toLowerCase(), value: d.slice(i + 1).trim(), line: bufLine });
      buf = ""; bufLine = line;
    } else {
      if (!buf.trim() && !/\s/.test(ch)) bufLine = line;
      buf += ch;
    }
    if (ch === "\n") line++;
  }
  return { decls, media };
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(|\b(?:white|black)\b/;
const SIZE_RE = /-?\d*\.?\d+(?:px|rem|pt)\b/;
const isZero = (t) => /^-?0(?:\.0+)?(?:px)?$/.test(t);

/** Слой тени с размытием, заданный числом (а не токеном). */
export function blurredShadowLayer(layer) {
  const l = layer.replace(/!important/g, "").trim();
  if (/^(none|inherit|initial|unset)$/.test(l) || /^var\(--[\w-]+\)$/.test(l)) return false;
  const parts = l.replace(/\([^()]*(\([^()]*\)[^()]*)*\)/g, "X").split(/\s+/).filter((p) => p && p !== "inset");
  const lengths = parts.filter((p) => /^-?\d*\.?\d+(px)?$/.test(p));
  return lengths.length >= 3 && !isZero(lengths[2]);
}

/** Нарушения одного файла слоя: [{ kind, value, line }]. */
export function cssFindings(css, { tokenFile = false } = {}) {
  const { decls, media } = parseCss(css);
  const out = [];
  for (const { prop, value, line } of decls) {
    const v = value.replace(/\s*!important\s*$/, "");
    if (prop.startsWith("--")) {
      if (!tokenFile && COLOR_RE.test(v)) out.push({ kind: "color", value: `${prop}: ${v}`, line });
      continue;
    }
    if (!/mask/.test(prop) && COLOR_RE.test(v.replace(/url\([^)]*\)/g, ""))) out.push({ kind: "color", value: v, line });
    if (prop === "font-size" || prop === "font") {
      if (SIZE_RE.test(v)) out.push({ kind: "font-size", value: v, line });
    } else if (/radius$/.test(prop)) {
      if (SIZE_RE.test(v) || /\d%/.test(v.replace(/\b50%/g, ""))) out.push({ kind: "radius", value: v, line });
    } else if (prop === "box-shadow" || prop === "-webkit-box-shadow") {
      if (splitTop(v).some(blurredShadowLayer)) out.push({ kind: "shadow", value: v, line });
    }
  }
  for (const { head, line } of media) {
    for (const m of head.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g)) {
      const ok = m[1] === "min" ? MIN_OK.has(m[2]) : MAX_OK.has(Number(m[2]).toFixed(2)) && /\.98$/.test(m[2]);
      if (!ok) out.push({ kind: "media", value: m[0], line });
    }
    if (/width\s*[<>]=?/.test(head)) out.push({ kind: "media", value: head, line });
  }
  return out;
}

/** Нарушения во встроенных стилях деталей нового вида (TSX). */
export function tsxFindings(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const out = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    if (/["'`]\s*#[0-9a-fA-F]{3,8}\s*["'`]|\brgba?\(/.test(l)) out.push({ kind: "color", value: l.trim().slice(0, 80), line: i + 1 });
    if (/\b(fontSize|borderRadius)\s*:\s*["'`]?\d/.test(l)) out.push({ kind: "inline-size", value: l.trim().slice(0, 80), line: i + 1 });
    if (/\bboxShadow\s*:\s*["'`](?!var\()/.test(l)) out.push({ kind: "shadow", value: l.trim().slice(0, 80), line: i + 1 });
  });
  return out;
}

/* ───────── обход и база ───────── */

function walkTsx(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTsx(p, acc);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) acc.push(p);
  }
  return acc;
}

export function collect() {
  const files = {};
  for (const name of readdirSync(SRC).filter((f) => LOOK_FILE.test(f)).sort()) {
    const css = readFileSync(join(SRC, name), "utf8");
    files[`apps/web/src/${name}`] = cssFindings(css, { tokenFile: name === TOKEN_FILE });
  }
  for (const p of walkTsx(LOOK_DIR)) files[relative(ROOT, p).replace(/\\/g, "/")] = tsxFindings(readFileSync(p, "utf8"));
  return files;
}

const keyOf = (f) => `${f.kind} ${f.value.replace(/\s+/g, " ")}`;
export function countKeys(findings) {
  const counts = {};
  for (const f of findings) counts[keyOf(f)] = (counts[keyOf(f)] ?? 0) + 1;
  return counts;
}

/** Сверка с базой: новые/выросшие — ошибки, уменьшившиеся — подсказки. */
export function compare(files, baseline) {
  const errors = []; const shrinkable = []; const badBase = [];
  for (const [file, entry] of Object.entries(baseline.files ?? {})) {
    if (!entry.reason || !String(entry.reason).trim()) badBase.push(`${file}: в базе нет причины`);
  }
  for (const [file, findings] of Object.entries(files)) {
    const allowed = baseline.files?.[file]?.counts ?? {};
    const counts = countKeys(findings);
    for (const [key, n] of Object.entries(counts)) {
      const max = allowed[key] ?? 0;
      if (n > max) {
        for (const f of findings.filter((x) => keyOf(x) === key).slice(max)) errors.push(`${file}:${f.line}  ${f.kind}  ${f.value}`);
      }
    }
    for (const [key, max] of Object.entries(allowed)) if ((counts[key] ?? 0) < max) shrinkable.push(`${file}  ${key}  (${counts[key] ?? 0} из ${max})`);
  }
  for (const file of Object.keys(baseline.files ?? {})) if (!(file in files)) shrinkable.push(`${file}  (файла больше нет)`);
  return { errors, shrinkable, badBase };
}

export function shrink(files, baseline) {
  const next = { ...baseline, files: {} };
  for (const [file, entry] of Object.entries(baseline.files ?? {})) {
    if (!(file in files)) continue;
    const counts = countKeys(files[file]);
    const kept = {};
    for (const [key, max] of Object.entries(entry.counts ?? {})) {
      const n = Math.min(max, counts[key] ?? 0);
      if (n > 0) kept[key] = n;
    }
    if (Object.keys(kept).length) next.files[file] = { reason: entry.reason, counts: kept };
  }
  return next;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const files = collect();
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { files: {} };
  if (args.has("--list")) {
    for (const [file, findings] of Object.entries(files)) for (const f of findings) console.log(`${file}:${f.line}  ${f.kind}  ${f.value}`);
    return;
  }
  if (args.has("--shrink")) {
    writeFileSync(BASELINE, JSON.stringify(shrink(files, baseline), null, 2) + "\n");
    console.log("база .look-audit-baseline.json сжата до фактических чисел");
    return;
  }
  const { errors, shrinkable, badBase } = compare(files, baseline);
  const total = Object.values(files).reduce((s, f) => s + f.length, 0);
  if (shrinkable.length) {
    console.log(`audit:look: в базе больше, чем в коде (${shrinkable.length}) — сожми: npm run audit:look -- --shrink`);
    for (const s of shrinkable.slice(0, 10)) console.log("  " + s);
  }
  if (errors.length || badBase.length) {
    console.error(`✗ audit:look: ${errors.length + badBase.length} нарушений конституции оболочки (docs/design/look-constitution.md):`);
    for (const e of [...badBase, ...errors]) console.error("  " + e);
    console.error("Лечение: размер шрифта — var(--rh-fs-*), скругление — var(--rh-r-*), тень — var(--rh-ui-shadow-sm|--rh-ui-shadow|--rh-ui-shadow-lg),");
    console.error(`цвет — var(--rh-ui-*) (новый цвет — токеном в ${TOKEN_FILE}), точки перелома — ${BREAKPOINTS.join(", ")} (max-width на 0,02 меньше).`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ audit:look: слои нового вида на токенах (${Object.keys(files).length} файлов; в базе исключений ${total} мест в ${Object.keys(baseline.files ?? {}).length} файлах)`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
