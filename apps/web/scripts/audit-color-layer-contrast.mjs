#!/usr/bin/env node
/**
 * КОНТРАСТ ПАСТЕЛЬНОГО СЛОЯ — СЧЁТОМ, А НЕ НА ГЛАЗ.
 *
 * Цветной слой темы «Royal Home 2026» держится на пяти парах
 * «пастельная подложка + насыщенный текст» (`--lime`/`--lime-ink` и так далее).
 * Пара используется в аватарах, чипах прироста, плашках очередей и кольце
 * оценки, и у каждой пары ДВА набора значений — светлая тема и ночная.
 *
 * ПОЧЕМУ СКРИПТ, А НЕ ЧИСЛА В ОТЧЁТЕ. Числа в отчёте стареют в тот же вечер:
 * значения живут в CSS и меняются при следующей пересборке прототипа. Скрипт
 * читает ИМЕННО ТЕ ФАЙЛЫ, которые попадают в сборку, поэтому проверка не может
 * разойтись с кодом. Значения из документа-спецификации сюда не берутся
 * намеренно: они уже расходились с кодом.
 *
 * ПОЧЕМУ ОБЕ ТЕМЫ. Порог, пройденный в светлой теме, ничего не говорит о
 * ночной: это разные значения обеих половин пары. Проверка, написанная под одну
 * тему, молча отчитывается «чисто» про вторую.
 *
 *   node apps/web/scripts/audit-color-layer-contrast.mjs
 *
 * Код возврата 1, если хоть одна пара не дотягивает до 4.5:1 (WCAG 2.1 AA,
 * обычный текст). Порог именно 4.5, а не 3:1 для крупного: инициалы аватара и
 * подпись чипа — мелкий текст.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const TONES = ["lime", "aqua", "lav", "pink", "sky"];
const THRESHOLD = 4.5;

/* ─────────────────────────── формула WCAG 2.1 ─────────────────────────── */

function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Относительная яркость, WCAG 2.1 §  «relative luminance». */
function luminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** #rgb / #rrggbb → [r,g,b]. Иных записей в наборах токенов нет; встретится
 *  другая — падаем, а не считаем по половине набора. */
function parseHex(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) throw new Error(`не hex-цвет: ${value}`);
  const h = m[1];
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/* ───────────────────── чтение НАСТОЯЩИХ значений из CSS ───────────────────── */

/**
 * Вырезает тело правила по началу селектора. Скобок внутри объявлений темы нет
 * (ни вложенности, ни функций со скобками в этих блоках), поэтому хватает
 * поиска ближайшей закрывающей.
 */
function ruleBody(css, selectorStart) {
  const at = css.indexOf(selectorStart);
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (open === -1 || close === -1) return null;
  return css.slice(open + 1, close);
}

function tokensFrom(body) {
  const out = {};
  for (const m of body.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const proto = readFileSync(join(SRC, "theme-2026-proto.css"), "utf8");
const layer = readFileSync(join(SRC, "theme-2026-color-layer.css"), "utf8");

/**
 * Четыре набора: пара «внутри области `.rh2`» (источник правды — артефакт
 * пульта) и пара «запасной набор вне области» из цветного слоя. Проверяются все
 * четыре: пользователь видит и те и другие, и разойтись они могут молча.
 */
const SETS = [
  { name: ".rh2 · светлая", tokens: tokensFrom(ruleBody(proto, ".rh2{color-scheme:light") ?? "") },
  {
    name: ".rh2 · ночная",
    tokens: tokensFrom(ruleBody(proto, 'html[data-theme="royal-home-2026-night"] .rh2{') ?? ""),
  },
  {
    name: "вне .rh2 · светлая",
    tokens: tokensFrom(ruleBody(layer, ':where(html[data-theme^="royal-home-2026-"])') ?? ""),
  },
  {
    name: "вне .rh2 · ночная",
    tokens: tokensFrom(ruleBody(layer, ':where(html[data-theme="royal-home-2026-night"])') ?? ""),
  },
];

/* Пустой набор — это сломанная проба, а не «нарушений нет»: селектор мог
   переехать при следующей пересборке прототипа, и молчаливое «чисто» здесь
   опаснее падения. */
let broken = false;
for (const set of SETS) {
  const found = TONES.filter((t) => set.tokens[t] && set.tokens[`${t}-ink`]).length;
  if (found !== TONES.length) {
    console.error(`ПРОБА СЛОМАНА: в наборе «${set.name}» найдено ${found} пар из ${TONES.length}`);
    broken = true;
  }
}
if (broken) process.exit(1);

/* ────────────────────────────── отчёт ────────────────────────────── */

let failed = 0;
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("набор", 22), pad("тон", 6), pad("подложка", 10), pad("текст", 10), "контраст");
for (const set of SETS) {
  for (const tone of TONES) {
    const bg = set.tokens[tone];
    const ink = set.tokens[`${tone}-ink`];
    const ratio = contrast(parseHex(ink), parseHex(bg));
    const ok = ratio >= THRESHOLD;
    if (!ok) failed++;
    console.log(
      pad(set.name, 22),
      pad(tone, 6),
      pad(bg, 10),
      pad(ink, 10),
      `${ratio.toFixed(2)}:1 ${ok ? "" : `← НИЖЕ ${THRESHOLD}`}`.trim()
    );
  }
}

console.log(
  `\nПроверено пар: ${SETS.length * TONES.length}. Порог ${THRESHOLD}:1 (WCAG 2.1 AA, обычный текст). ` +
    (failed === 0 ? "Нарушений нет." : `НАРУШЕНИЙ: ${failed}.`)
);
process.exit(failed === 0 ? 0 : 1);
