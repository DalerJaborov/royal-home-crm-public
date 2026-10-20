#!/usr/bin/env node
/**
 * КОНТРАСТ ТЕКСТА НА СТЕКЛЕ ПУЛЬТА — СЧЁТОМ, А НЕ НА ГЛАЗ.
 *
 * С 12.09.2026 карточки главного экрана полупрозрачны и размывают то, что под
 * ними, а под ними лежит «аврора» — четыре пастельных пятна. Значит фон под
 * текстом больше не постоянный `#fff`: он зависит от того, над каким пятном
 * оказалась карточка, и меняется при каждом изменении раскладки. Проверять
 * такое глазами нельзя — проверка должна считаться из тех же файлов, которые
 * попадают в сборку.
 *
 *   node apps/web/scripts/audit-dashboard-glass-contrast.mjs
 *
 * ЧТО СЧИТАЕТСЯ. Худший случай, а не средний:
 *   1. фон страницы `--page`;
 *   2. поверх него самое насыщенное пятно авроры при её прозрачности из
 *      theme-2026-dashboard.css (`--dash-aurora-o`) и доле цвета из
 *      `color-mix(... N%, transparent)` в самом градиенте — то есть центр
 *      пятна, где цвета больше всего;
 *   3. поверх — стекло карточки (`--card` при доле из `color-mix`);
 *   4. и уже на этом — каждый текстовый токен темы.
 * Настоящий фон под любым куском текста светлее расчётного: пятна перекрываются
 * не в центре, и градиент сходит в прозрачность. Порог, который прошёл худший
 * случай, пройден везде.
 *
 * ПОЧЕМУ ОБЕ ТЕМЫ. Значения обеих половин пары в ночной теме другие; проверка,
 * написанная под светлую, молча отчитывается «чисто» про ночную.
 *
 * Код возврата 1, если хоть одна пара не дотягивает до 4.5:1 (WCAG 2.1 AA,
 * обычный текст). Порог именно 4.5, а не 3:1 для крупного: на стекле лежат
 * подписи плиток и мелкие пояснения, а не одни заголовки.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const THRESHOLD = 4.5;

/* ─────────────────────────── формула WCAG 2.1 ─────────────────────────── */

function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** #rgb / #rrggbb → [r,g,b]. Иных записей в наборах токенов темы нет. */
function parseHex(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) throw new Error(`не hex-цвет: ${value}`);
  const h = m[1];
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** Непрозрачный слой `over` долей `alpha` поверх непрозрачного `under`. */
function over(overColor, alpha, under) {
  return overColor.map((c, i) => Math.round(c * alpha + under[i] * (1 - alpha)));
}

/* ───────────────────── чтение значений из файлов сборки ───────────────── */

const proto = readFileSync(join(SRC, "theme-2026-proto.css"), "utf8");
const dash = readFileSync(join(SRC, "theme-2026-dashboard.css"), "utf8");

/** Набор токенов темы: светлая — из блока `.rh2{…}`, ночная — из блока темы. */
function tokenBlock(theme) {
  const marker = theme === "night" ? 'html[data-theme="royal-home-2026-night"] .rh2{' : ".rh2{color-scheme:light;";
  const at = proto.indexOf(marker);
  if (at < 0) throw new Error(`не найден блок токенов темы «${theme}» в theme-2026-proto.css`);
  const end = proto.indexOf("}", at);
  return proto.slice(at, end);
}

function token(block, name) {
  const m = new RegExp(`--${name}:\\s*([^;}]+)`).exec(block);
  if (!m) throw new Error(`токен --${name} не найден`);
  return m[1].trim();
}

/**
 * Токен, переопределённый для пульта в theme-2026-dashboard.css, перебивает
 * значение темы: иначе проверка считала бы по цвету, которого на этом экране
 * нет. Сейчас так переопределён `--faint` (см. разбор в самом CSS).
 */
function pultOverride(theme, name) {
  const scope = theme === "night" ? 'html\\[data-theme="royal-home-2026-night"\\] \\.rh2 \\.pult \\{' : "\\.rh2 \\.pult \\{";
  const m = new RegExp(`${scope}\\s*--${name}:\\s*([^;}]+)`).exec(dash);
  return m ? m[1].trim() : null;
}

/** Значение переменной внутри правила `.aurora` нужной темы. */
function auroraVar(theme, name) {
  const anchor =
    theme === "night" ? 'html[data-theme="royal-home-2026-night"] .rh2 .pult .aurora {' : ".rh2 .pult .aurora {";
  const at = dash.indexOf(anchor);
  if (at < 0) throw new Error(`не найдено правило .aurora темы «${theme}»`);
  const block = dash.slice(at, dash.indexOf("}", at));
  const m = new RegExp(`--${name}:\\s*([\\d.]+)%?`).exec(block);
  return m ? Number(m[1]) : null;
}

/** Прозрачность слоя авроры: `--dash-aurora-o` темы либо запасное значение из
 *  `opacity: var(--dash-aurora-o, X)`. */
function auroraOpacity(theme) {
  const own = auroraVar(theme, "dash-aurora-o");
  if (own !== null) return own;
  const m = /opacity:\s*var\(--dash-aurora-o,\s*([\d.]+)\)/.exec(dash);
  if (!m) throw new Error("не найдено запасное значение --dash-aurora-o");
  return Number(m[1]);
}

/** Доля чернильного токена, которым углублено пятно (в ночной теме — 0). */
function auroraInkShare(theme) {
  const own = auroraVar(theme, "dash-aurora-ink");
  if (own === null) throw new Error(`не найдена --dash-aurora-ink темы «${theme}»`);
  return own / 100;
}

/**
 * Доля цвета поверхности в стекле — из `color-mix` того правила, которое эту
 * поверхность и красит. Ищется по селектору, а не «первым попавшимся
 * color-mix»: в файле их несколько (карточка 72 %, плитка 62 %, узкий экран
 * 92 %), и взять не тот — значит проверить поверхность, которой нет.
 */
function shareAfter(anchor, tokenName) {
  const at = dash.indexOf(anchor);
  if (at < 0) throw new Error(`не найден блок «${anchor}» в theme-2026-dashboard.css`);
  const m = new RegExp(`color-mix\\(in srgb,\\s*var\\(--${tokenName}\\)\\s*(\\d+)%,\\s*transparent\\)`).exec(dash.slice(at));
  if (!m) throw new Error(`после «${anchor}» нет color-mix для --${tokenName}`);
  return Number(m[1]) / 100;
}

/* Пятна авроры в том же порядке, что в CSS: токен и его доля в градиенте. */
const AURORA_TOKENS = ["sky", "lav", "lime", "pink"];
const TEXT_TOKENS = ["ink", "body", "muted", "faint"];

let failures = 0;
const rows = [];

for (const theme of ["light", "night"]) {
  const block = tokenBlock(theme);
  const page = parseHex(token(block, "page"));
  const card = parseHex(token(block, "card"));
  const soft = parseHex(token(block, "soft"));
  const aOpacity = auroraOpacity(theme);
  // Карточка верхнего уровня: блок стекла §3(б).
  const gShare = shareAfter(".rh2 .pult .sections > .secwrap > .card {", "card");
  // Плитка внутри карточки: --card 62 % (светлая) / --soft 70 % (ночная).
  const tileShare = theme === "night" ? shareAfter('night"] .rh2 .pult .rest .ph {', "soft") : shareAfter(".rh2 .pult .rest .ph {", "card");
  const tileColor = theme === "night" ? soft : card;

  const inkShare = auroraInkShare(theme);

  for (const spot of AURORA_TOKENS) {
    // Цвет пятна: пастель, углублённая своим чернильным токеном.
    const spotColor = over(parseHex(token(block, `${spot}-ink`)), inkShare, parseHex(token(block, spot)));
    // Центр пятна: там слой непрозрачен полностью, значит вся его прозрачность.
    const spotAlpha = aOpacity;
    const backdrop = over(spotColor, spotAlpha, page);
    const glass = over(card, gShare, backdrop);
    const tile = over(tileColor, tileShare, glass);

    for (const [surfaceName, surface] of [["карточка", glass], ["плитка", tile]]) {
      for (const t of TEXT_TOKENS) {
        const fg = parseHex(pultOverride(theme, t) ?? token(block, t));
        const ratio = contrast(fg, surface);
        const ok = ratio >= THRESHOLD;
        if (!ok) failures += 1;
        rows.push({
          theme: theme === "light" ? "светлая" : "ночная",
          spot,
          surfaceName,
          t,
          ratio,
          ok,
          bg: `rgb(${surface.join(",")})`,
        });
      }
    }
  }
}

const w = (s, n) => String(s).padEnd(n);
console.log("КОНТРАСТ ТЕКСТА НА СТЕКЛЕ ПУЛЬТА (худший случай: центр пятна авроры)\n");
console.log(`${w("тема", 9)}${w("пятно", 7)}${w("поверхность", 13)}${w("текст", 8)}${w("фон", 18)}${w("контраст", 10)}итог`);
for (const r of rows) {
  console.log(
    `${w(r.theme, 9)}${w(r.spot, 7)}${w(r.surfaceName, 13)}${w("--" + r.t, 8)}${w(r.bg, 18)}${w(r.ratio.toFixed(2) + ":1", 10)}${r.ok ? "ок" : "МАЛО"}`,
  );
}
const worst = rows.reduce((a, b) => (b.ratio < a.ratio ? b : a));
console.log(
  `\nХудшая пара: ${worst.theme} · ${worst.spot} · ${worst.surfaceName} · --${worst.t} = ${worst.ratio.toFixed(2)}:1 (порог ${THRESHOLD}:1)`,
);
if (failures > 0) {
  console.error(`\n✖ Ниже порога: ${failures} из ${rows.length}`);
  process.exit(1);
}
console.log(`✓ Все ${rows.length} пар проходят ${THRESHOLD}:1`);
