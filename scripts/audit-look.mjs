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
 * убирает пустые записи, добавить ничего не может). С 21.11.2026 база пуста: четыре раздела
 * директора (Отчёты, Реклама, Деньги, Контроль) переведены на токены (451 место); новое исключение
 * — только с причиной и объявленным ростом (`Look-Audit-Base-Growth`).
 *
 *   node scripts/audit-look.mjs            # проверить
 *   node scripts/audit-look.mjs --list     # все нарушения с номерами строк
 *   node scripts/audit-look.mjs --shrink   # сжать базу до фактических чисел
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "apps/web/src");
const LOOK_DIR = join(SRC, "components/look");
const BASELINE = join(ROOT, ".look-audit-baseline.json");
export const TOKEN_FILE = "theme-look-royal.css";
const LOOK_FILE = /^theme-look-royal(-[\w-]+)?\.css$/;

/**
 * Точки перелома: 360, 390 узкий телефон, 768 планшет, 820 граница разметки useMobileUx, 1024 ПК,
 * 1100 — ПК с боковым меню, где содержимому меньше ~850 px (плитки «Телефонии» 2×2, узкий список
 * чатов; на 1024–1099 четыре плитки в ряд сжаты — кадры повторного ревью #337), 1440 широкий.
 */
export const BREAKPOINTS = [360, 390, 768, 820, 1024, 1100, 1440];
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

/** Все именованные цвета CSS: цвет словом — тот же литерал, что #hex (ревью #337). */
const NAMED_COLORS = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" ");
const COLOR_RE = new RegExp(String.raw`#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(|(?<![\w-])(?:${NAMED_COLORS.join("|")})(?![\w-])`, "i");
const FS_NAMES = "(?:xs|sm|md|lg|xl|2xl|3xl|4xl)";
const FS_TOKEN = new RegExp(`^var\\(--rh-fs-${FS_NAMES}\\)$`);
const FS_ANY = new RegExp(`var\\(--rh-fs-${FS_NAMES}\\)`);
const R_TOKEN = /^var\(--rh-r-(?:sm|md|lg|full)\)$/;
const KEYWORD = /^(?:inherit|initial|unset|revert)$/;
const isZero = (t) => /^-?0(?:\.0+)?(?:px)?$/.test(t);
/** Значение без строк в кавычках и url(): там цвет — часть текста или картинки. */
const bare = (v) => v.replace(/"[^"]*"|'[^']*'/g, '""').replace(/url\([^)]*\)/g, "url()");

/**
 * Слой тени, который НЕ является токеном тени или тонкой линией: число с размытием, своя
 * переменная мимо токенов (`var(--x)`), слой без длин. Токен тени — переменная из файла токенов
 * с «shadow» в имени; линия — `[inset] x y 0 [spread] <цвет через var()>` (это граница).
 */
export function badShadowLayer(layer, shadowTokens = null) {
  const l = layer.replace(/!important/g, "").trim();
  if (/^(none|inherit|initial|unset)$/.test(l)) return false;
  const only = /^var\((--[\w-]+)\)$/.exec(l);
  if (only) return !/shadow/.test(only[1]) || (shadowTokens ? !shadowTokens.has(only[1]) : false);
  const parts = l.replace(/\([^()]*(\([^()]*\)[^()]*)*\)/g, (m) => m.replace(/\s+/g, "")).split(/\s+/).filter((p) => p && p !== "inset");
  const lengths = parts.filter((p) => /^-?\d*\.?\d+(px)?$/.test(p));
  if (lengths.length < 2) return true;
  return lengths.length >= 3 && !isZero(lengths[2]);
}
/** Прежнее имя (тесты): слой с размытием числом. */
export const blurredShadowLayer = (layer) => badShadowLayer(layer);

/** Признак ширины в @media: только `(min-width: N px)` и `(max-width: N-0,02 px)` из списка. */
function mediaWidthFindings(head) {
  const bad = [];
  for (const m of head.matchAll(/\(([^()]*\bwidth\b[^()]*)\)/g)) {
    const f = m[1].trim();
    const ok = /^(min|max)-width:\s*([\d.]+)px$/.exec(f);
    if (!ok) { bad.push(`(${f})`); continue; }
    const fine = ok[1] === "min" ? MIN_OK.has(ok[2]) : MAX_OK.has(Number(ok[2]).toFixed(2)) && /\.98$/.test(ok[2]);
    if (!fine) bad.push(`(${f})`);
  }
  return bad;
}

/** Нарушения одного файла слоя: [{ kind, value, line }]. */
export function cssFindings(css, { tokenFile = false, shadowTokens = null } = {}) {
  const { decls, media } = parseCss(css);
  const out = [];
  for (const { prop, value, line } of decls) {
    const v = value.replace(/\s*!important\s*$/, "").trim();
    if (prop.startsWith("--")) {
      if (!tokenFile && COLOR_RE.test(bare(v))) out.push({ kind: "color", value: `${prop}: ${v}`, line });
      continue;
    }
    if (!/mask/.test(prop) && COLOR_RE.test(bare(v))) out.push({ kind: "color", value: v, line });
    if (prop === "font-size") {
      // Только ступень шкалы: ни px/em/%/vw, ни слова (small, larger), ни своя переменная.
      if (!FS_TOKEN.test(v) && !KEYWORD.test(v)) out.push({ kind: "font-size", value: v, line });
    } else if (prop === "font") {
      if (!KEYWORD.test(v) && !FS_ANY.test(v)) out.push({ kind: "font-size", value: v, line });
    } else if (/radius$/.test(prop)) {
      const parts = v.split(/\s*\/\s*|\s+/).filter(Boolean);
      if (!KEYWORD.test(v) && !parts.every((p) => isZero(p) || p === "50%" || R_TOKEN.test(p))) out.push({ kind: "radius", value: v, line });
    } else if (prop === "box-shadow" || prop === "-webkit-box-shadow" || prop === "text-shadow") {
      if (splitTop(v).some((layer) => badShadowLayer(layer, shadowTokens))) out.push({ kind: "shadow", value: v, line });
    } else if (/(^|-)filter$/.test(prop) && /drop-shadow\(/.test(v) && !/drop-shadow\(\s*var\(--[\w-]*shadow[\w-]*\)\s*\)/.test(v)) {
      out.push({ kind: "shadow", value: v, line });
    }
  }
  for (const { head, line } of media) for (const value of mediaWidthFindings(head)) out.push({ kind: "media", value, line });
  return out;
}

/** Имена теней из файла токенов: только они годятся слоем тени `var(--…)`. */
export function shadowTokensOf(tokenCss) {
  const names = new Set();
  for (const m of stripComments(tokenCss).matchAll(/(--[\w-]*shadow[\w-]*)\s*:/g)) names.add(m[1]);
  return names;
}

/**
 * Нарушения деталей нового вида (TSX): цвет литералом в строке (hex, rgb/hsl), произвольные
 * значения tailwind (`text-[11px]`, `bg-[#fff]`, `rounded-[3px]`, `shadow-[…]`), мелкий
 * `text-xs`, fontSize/borderRadius/boxShadow встроенного стиля не токеном — в том числе на
 * нескольких строках (проверка идёт по всему тексту, а не построчно).
 */
export function tsxFindings(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const out = [];
  const lineAt = (i) => text.slice(0, i).split("\n").length;
  const push = (kind, i, value) => out.push({ kind, value: value.replace(/\s+/g, " ").slice(0, 80), line: lineAt(i) });
  for (const m of text.matchAll(/["'`][^"'`\n]*?(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab)\()/g)) push("color", m.index, m[0]);
  for (const m of text.matchAll(/(?<![\w-])(?:[a-z0-9]+:)*(?:text|bg|border(?:-[trblxy])?|ring|outline|fill|stroke|from|via|to|decoration|shadow|rounded(?:-[a-z]{1,2})?|leading|tracking)-\[(?!var\(--rh-)[^\]\s"'`]+\]/g)) push("tailwind", m.index, m[0]);
  for (const m of text.matchAll(/(?<![\w-])(?:[a-z0-9]+:)*text-xs(?![\w-])/g)) push("font-size", m.index, m[0]);
  for (const m of text.matchAll(/\bfontSize\s*:(?!\s*["'`]var\(--rh-fs-(?:xs|sm|md|lg|xl|2xl|3xl|4xl)\)["'`])\s*([^,}\n]+)/g)) push("inline-size", m.index, m[0]);
  for (const m of text.matchAll(/\bborderRadius\s*:(?!\s*["'`]var\(--rh-r-(?:sm|md|lg|full)\)["'`]|0\b)\s*([^,}\n]+)/g)) push("inline-size", m.index, m[0]);
  for (const m of text.matchAll(/\b(?:boxShadow|textShadow)\s*:(?!\s*["'`](?:none|var\(--[\w-]*shadow[\w-]*\))["'`])\s*([^,}\n]+)/g)) push("shadow", m.index, m[0]);
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
  const shadowTokens = shadowTokensOf(readFileSync(join(SRC, TOKEN_FILE), "utf8"));
  for (const name of readdirSync(SRC).filter((f) => LOOK_FILE.test(f)).sort()) {
    const css = readFileSync(join(SRC, name), "utf8");
    files[`apps/web/src/${name}`] = cssFindings(css, { tokenFile: name === TOKEN_FILE, shadowTokens });
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

/**
 * «БАЗА ТОЛЬКО УБЫВАЕТ» — проверка, а не обещание (ревью #337): база ветки сверяется с базой
 * `origin/main`. Новый ключ или выросшее число — красное. На main базы нет — значит, она пустая.
 * Рост объявляется вслух ПО ФАЙЛУ: строкой в сообщении коммита ветки (облачная проверка ship
 * меток PR не видит)
 *   Look-Audit-Base-Growth: apps/web/src/theme-look-royal-money.css — причина
 * Рост в файле, который не назван, — красное; объявленный рост печатается (виден в выводе ship).
 */
export function baselineGrowth(current, main) {
  const grown = [];
  for (const [file, entry] of Object.entries(current.files ?? {})) {
    const before = main.files?.[file]?.counts ?? {};
    for (const [key, n] of Object.entries(entry.counts ?? {})) {
      const was = before[key] ?? 0;
      if (n > was) grown.push({ file, key, was, now: n });
    }
  }
  return grown;
}

/** Объявления роста из сообщений коммитов: файл → причина. Без причины объявление не считается. */
export function declaredGrowth(log) {
  const out = new Map();
  for (const m of (log ?? "").matchAll(/^Look-Audit-Base-Growth:[ \t]*(\S+)[ \t]+(?:—|–|-)[ \t]*(\S.*)$/gm)) out.set(m[1].replace(/\\/g, "/"), m[2].trim());
  return out;
}

/** Рост, разложенный на объявленный (с причиной) и необъявленный. Файл можно назвать путём или именем. */
export function splitGrowth(growth, declared) {
  const reasonOf = (file) => {
    for (const [name, reason] of declared) if (file === name || file.endsWith(`/${name}`)) return reason;
    return null;
  };
  const allowed = []; const undeclared = [];
  for (const g of growth) {
    const reason = reasonOf(g.file);
    (reason ? allowed : undeclared).push({ ...g, reason });
  }
  return { allowed, undeclared };
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
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
  const mainText = git(["show", "origin/main:.look-audit-baseline.json"]);
  const mainBase = mainText ? JSON.parse(mainText) : { files: {} };
  const growth = baselineGrowth(baseline, mainBase);
  const { allowed, undeclared } = splitGrowth(growth, declaredGrowth(git(["log", "--format=%B", "origin/main..HEAD"])));
  if (allowed.length) {
    const byFile = new Map();
    for (const g of allowed) byFile.set(g.file, { reason: g.reason, n: (byFile.get(g.file)?.n ?? 0) + 1 });
    console.log(`audit:look: база исключений выросла против main — объявлено вслух (${allowed.length} ключей):`);
    for (const [file, { reason, n }] of byFile) console.log(`  ${file}: +${n} — ${reason}`);
  }
  if (undeclared.length) {
    badBase.push(`база выросла против main в необъявленных файлах: ${undeclared.length} ключей`);
    for (const g of undeclared.slice(0, 10)) badBase.push(`  ${g.file}  ${g.key}  (${g.was} -> ${g.now})`);
    if (undeclared.length > 10) badBase.push(`  … ещё ${undeclared.length - 10}`);
    badBase.push("База только убывает. Рост объявляется по файлу строкой «Look-Audit-Base-Growth: <файл> — <причина>» в коммите ветки.");
  }
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
