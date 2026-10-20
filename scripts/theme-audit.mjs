#!/usr/bin/env node
/**
 * Приёмка переноса темы «Royal Home 2026» счётом, а не на слово.
 *
 * ЗАЧЕМ. 08.09 волны переноса отчитались «сделано», а экраны остались прежними:
 * задание разрешало трогать только токены, и агенты честно его выполнили. Со
 * стороны отчётов всё было зелено, со стороны владельца ничего не изменилось.
 * Скрипт закрывает эту дыру: он считает в разметке экрана старые утилитарные
 * классы приложения против классов прототипа и не даёт назвать перенос
 * состоявшимся, пока старые преобладают.
 *
 *   node scripts/theme-audit.mjs            # все экраны, сводка
 *   node scripts/theme-audit.mjs Clients    # только совпадающие по имени
 *
 * Что считается:
 *   СТАРОЕ  — утилитарные классы прежнего оформления (bg-card, text-gray-500,
 *             rounded-lg и прочие; полный список ниже). Тема их перекрашивает,
 *             но разметка от этого не становится разметкой макета.
 *   МАКЕТ   — обёртка `rh2` и имена классов прототипа (.card, .row, .pill…),
 *             перенесённые дословно (см. apps/web/src/theme-2026-proto.css).
 *
 * Вердикт по экрану: «перенесён», если есть обёртка rh2 и классов макета
 * строго больше, чем старых; «частично», если обёртка есть, но старых не
 * меньше; «старый», если обёртки нет вовсе.
 *
 * ВТОРАЯ ПРОВЕРКА — мобильные правила без исключения тем 2026 (10.09.2026).
 * В index.css записан контракт: любое мобильное правило, которое НАВЯЗЫВАЕТ
 * ЦВЕТ (не форму и не радиусы), обязано нести `:not([data-theme^="royal-home-2026-"])`,
 * иначе оно перекрывает собственную палитру темы 2026. Контракт был только
 * текстом в комментарии и наступил на те же грабли дважды: сначала светлый
 * градиент фона на body, потом гарнитура Golos Text для оболочки. Ниже — счёт
 * вместо текста: скрипт разбирает старые таблицы стилей и выходит с кодом 1,
 * если нашлось хоть одно такое правило.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const WEB = join(ROOT, "apps", "web", "src");

/** Классы прежнего оформления. Ищем как отдельные слова в className. */
const OLD = [
  "bg-card", "bg-bg", "bg-hover-tint", "border-line", "border-line-soft",
  "rounded-lg", "rounded-md", "rounded-xl", "rounded-2xl",
  "text-gray-400", "text-gray-500", "text-gray-600", "text-gray-700",
  "bg-blue", "text-blue", "bg-red", "text-red",
];

/**
 * Имена классов прототипа. Список намеренно короткий и однозначный: это те
 * имена, которых в старом оформлении не встречалось ни разу, поэтому их
 * появление означает именно перенос макета, а не совпадение.
 */
const PROTO = [
  "scr", "pg-h", "sec-h", "sec-t", "card", "row", "av", "chip", "pill",
  "seg", "quiet", "empty", "tile", "tiles", "thumb", "lk", "aib", "ring9",
  "frozen-note", "load-bar", "bar-top", "trio", "pipe", "stg", "deal",
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/** Считает вхождения имени класса внутри строковых атрибутов className. */
function countClass(src, name) {
  const re = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?![\\w-])`, "g");
  return (src.match(re) || []).length;
}

/**
 * ОБОЛОЧКА (06.10.2026). Задание A завело правила (hex, дробный текст) для
 * оболочки как `warn`; задание B перевело Sidebar/Topbar/BottomNav/FabMenu/
 * AppLayout на идиому прототипа и токены, поэтому для них те же правила и счёт
 * старых классов теперь `fail` (SHELL_FILES_DONE). В `warn` остались только
 * наборы компонентов `components/ui/` и `components/rh2/`: их переводит задание C.
 * Снять после C: опустошить SHELL_FILES_PENDING.
 */
const SHELL_FILES_DONE = [
  "components/Sidebar.tsx",
  "components/Topbar.tsx",
  "components/BottomNav.tsx",
  "components/FabMenu.tsx",
  "layouts/AppLayout.tsx",
];
const SHELL_FILES_PENDING = ["components/ui/", "components/rh2/"];
const isShellPending = (file) => SHELL_FILES_PENDING.some((p) => file.includes(p));

const filter = process.argv[2]?.toLowerCase();
const shellFiles = [
  ...SHELL_FILES_DONE.map((p) => join(WEB, p)),
  ...walk(join(WEB, "components", "ui")),
  ...walk(join(WEB, "components", "rh2")),
];
const files = [...new Set(walk(join(WEB, "pages")).concat(walk(join(WEB, "components", "mobile")), shellFiles))];

const rows = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (filter && !basename(file).toLowerCase().includes(filter)) continue;
  const old = OLD.reduce((n, c) => n + countClass(src, c), 0);
  const proto = PROTO.reduce((n, c) => n + countClass(src, c), 0);
  // Обёртка бывает и своим классом, и общим компонентом-оболочкой из
  // components/rh2 (Rh2Screen и подобные): считаем оба случая.
  const wrapped =
    /className=("|'|\{`)[^"'`]*rh2/.test(src) ||
    /<Rh2[A-Z]\w*/.test(src) ||
    /components\/rh2/.test(src);
  if (old === 0 && proto === 0 && !wrapped) continue;
  // Вкладки и дочерние блоки экрана обёртки не содержат: она принадлежит
  // родителю. Поэтому файл без единого старого класса и с классами макета
  // считается перенесённым независимо от обёртки, иначе метрика соблазняет
  // дописывать вложенную обёртку ради числа (а она заново объявляет все
  // переменные темы и красит фон поверх страницы).
  const verdict =
    old === 0 && proto > 0 ? "перенесён" : !wrapped ? "старый" : proto > old ? "перенесён" : "частично";
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  rows.push({ file: rel, old, proto, verdict: isShellPending(rel) ? `${verdict} (оболочка, warn)` : verdict });
}

rows.sort((a, b) => b.old - a.old);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("экран", 60), pad("старых", 8), pad("макета", 8), "вердикт");
for (const r of rows) console.log(pad(r.file, 60), pad(r.old, 8), pad(r.proto, 8), r.verdict);

/* Оболочка, переведённая заданием B: старых классов должно быть 0. */
const shellOldFails = rows.filter((r) => SHELL_FILES_DONE.some((p) => r.file.endsWith(p)) && r.old > 0);
for (const r of shellOldFails) console.log(`  FAIL  ${r.file}: старых классов ${r.old} (оболочка обязана быть на токенах и идиоме прототипа)`);
if (shellOldFails.length > 0) process.exitCode = 1;

const done = rows.filter((r) => r.verdict === "перенесён").length;
const shellOld = rows.filter((r) => r.verdict.includes("оболочка")).reduce((n, r) => n + r.old, 0);
console.log(
  `\nПеренесено ${done} из ${rows.length}. Старых классов всего: ${rows.reduce((n, r) => n + r.old, 0)}` +
    ` (из них в оболочке, warn до задания B: ${shellOld}).`,
);

/* ==========================================================================
 * Дробный размер текста и hex-цвета в разметке (06.10.2026, задание A)
 * ========================================================================== */

/**
 * Шкала текста контракта — 13/15/16/18/22/28, без половинок. Цвета в разметке
 * берутся из токенов темы (`var(--…)`, `text-blue`), а не литералом: литерал не
 * переживает ночную тему и смену акцента.
 *
 * HEX_ALLOWLIST — места, где литерал законен:
 *   files — фирменные цвета каналов и палитры карт (maplibre/Leaflet не читают
 *           CSS-переменные), tint-карта FabMenu;
 *   attrs — SVG `fill`/`stroke`/`stop-color`, где литерал рисует сам значок.
 * HEX_DEBT — живые нарушения, найденные при заведении правила; печатаются как
 * warn и ждут перевода на токены (не валят сборку, чтобы правило можно было
 * включить сразу). Сокращать список, не наращивать.
 */
const HEX_ALLOWLIST = {
  files: [
    "components/ChannelIcon.tsx",
    "components/FabMenu.tsx",
    "components/ClientDesiredPlacesMap.tsx",
    "components/LocationPicker.tsx",
    "components/property-wizard/MapPointPicker.tsx",
    "components/PropertyMapExplorer.tsx",
  ],
  attrs: /\b(fill|stroke|stop-?[Cc]olor|flood-?[Cc]olor)\s*[=:]/,
};
const HEX_DEBT = [
  "pages/PropertiesMap.tsx",
  "components/mobile/PropertyMobileBlocks.tsx",
  "components/property-wizard/StepMedia.tsx",
  "components/TranscriptView.tsx",
];
/** Игровые площадки разработчика (pages/dev) и тесты в эти правила не входят. */
const SKIP_NEW_RULES = ["pages/dev/", "__tests__"];

/** Убирает комментарии, сохраняя переводы строк: номера строк остаются верными. */
function blankTsxComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;{(,])\/\/.*$/gm, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

function walkAll(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      walkAll(p, out);
    } else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

const HALF_SIZE = /text-\[\d+\.\d+px\]/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const failHits = [];
const warnHits = [];
for (const file of [...walkAll(join(WEB, "pages")), ...walkAll(join(WEB, "components")), ...walkAll(join(WEB, "layouts"))]) {
  const rel = relative(WEB, file).replace(/\\/g, "/");
  if (SKIP_NEW_RULES.some((p) => rel.includes(p))) continue;
  const lines = blankTsxComments(readFileSync(file, "utf8")).split("\n");
  const allowFile = HEX_ALLOWLIST.files.includes(rel);
  lines.forEach((line, i) => {
    const hits = [];
    if (HALF_SIZE.test(line)) hits.push("дробный размер текста");
    if (!allowFile && HEX.test(line) && !HEX_ALLOWLIST.attrs.test(line)) hits.push("hex-цвет литералом");
    for (const what of hits) {
      const warn = isShellPending(rel) || (what.startsWith("hex") && HEX_DEBT.includes(rel));
      (warn ? warnHits : failHits).push(`apps/web/src/${rel}:${i + 1}  ${what}`);
    }
  });
}
console.log(`\nДробный размер текста и hex-цвета в разметке: fail ${failHits.length}, warn ${warnHits.length}.`);
for (const h of warnHits) console.log(`  warn  ${h}`);
for (const h of failHits) console.log(`  FAIL  ${h}`);
if (failHits.length > 0) process.exitCode = 1;

/* ==========================================================================
 * Мобильные правила без исключения тем «Royal Home 2026»
 * ========================================================================== */

/**
 * Старые таблицы стилей — те, что применяются к приложению независимо от темы.
 * Файлы самой темы 2026 (включая генерируемый `theme-2026-proto.css`) исключены:
 * они по определению принадлежат этой теме и перекрыть её не могут.
 */
const THEME_2026_CSS = /^(theme-2026-.*|theme-royal-home-2026|fonts-royal-home-2026)\.css$/;

/** Точная строка исключения из контракта в index.css. */
const EXCLUSION = ':not([data-theme^="royal-home-2026-"])';

/**
 * Признак «правило мобильное». Два независимых входа, потому что грабли были
 * оба раза разные: палитру задают через атрибут оболочки, а раскладку и фоны —
 * через ширину экрана.
 */
const MOBILE_SELECTOR = /\[data-mobile-ux\]/;
const MOBILE_AT_RULE = /max-width|pointer\s*:\s*coarse/;

/**
 * Свойства, через которые правило способно перекрыть облик темы. Форма
 * (радиусы, отступы, размеры, блюр) сюда не входит намеренно: контракт
 * разрешает общие для всех тем правила формы. `font-family` включена — это
 * второй случай из истории: гарнитура не цвет, но перекрывает облик так же
 * принудительно, и ловить её надо тем же счётчиком.
 */
const LOOK_PROP =
  /^(color|background|background-color|background-image|border(-(top|right|bottom|left))?(-color)?|border-image|box-shadow|text-shadow|outline|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color|color-scheme|font-family|--c-[\w-]+|--rgb-[\w-]+|--shadow-[\w-]+|--aurora|--drift-[\w-]+|--glass[\w-]*|--ff-[\w-]+|--font-[\w-]+)$/;

/**
 * Значение опасно, только если оно ЖЁСТКО ЗАДАЁТ облик, а не берёт его из
 * токенов темы. Это и есть водораздел: `background: var(--c-card-solid)` следует
 * за темой и в 2026 нарисует её цвет, а `background: #eef0f5` рисует чужой цвет
 * поверх любой темы. Оба исторических случая — светлый градиент на body и
 * Golos Text для оболочки — были именно жёсткими значениями.
 */
const LITERAL_COLOR =
  /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[\d.]|\b(white|black|silver|gray|grey|red|blue|green|yellow|orange|purple|violet|pink|brown|navy|teal|olive|maroon|lime|aqua|fuchsia|beige|ivory|gold)\b/;

function hardcoded(prop, value) {
  // Имя переменной внутри var() — не значение: убираем, чтобы `--rgb-*` в
  // `rgb(var(--rgb-g400) / 0.5)` не читалось как литерал. Запасное значение
  // (`var(--x, #fff)`) остаётся видимым: оно как раз может перекрыть тему.
  const v = value.replace(/var\(\s*--[\w-]+/g, "var(");
  if (prop === "color-scheme") return true; // принудительная схема — всегда чужая
  if (prop === "font-family") return !/^\s*(var\(|inherit|unset|initial|revert)/.test(v);
  return LITERAL_COLOR.test(v);
}

/** Заменяет комментарии пробелами, сохраняя переводы строк (нужны номера строк). */
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Разбор без зависимостей: в этих файлах нет вложенности CSS (`&` не
 * встречается ни разу), поэтому хватает счёта фигурных скобок с учётом строк.
 * Возвращает список объявлений с их селектором и цепочкой @-правил.
 */
function parseDeclarations(css) {
  const out = [];
  const stack = [];
  let buf = "";
  let line = 1;
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "\n") line++;
    if (quote) {
      buf += ch;
      if (ch === quote && css[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "{") {
      stack.push({ prelude: buf.trim().replace(/\s+/g, " "), line });
      buf = "";
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else if (ch === ";") {
      const decl = buf.trim();
      buf = "";
      const top = stack[stack.length - 1];
      if (!top || !decl || top.prelude.startsWith("@")) continue;
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      out.push({
        prop: decl.slice(0, colon).trim().toLowerCase(),
        value: decl.slice(colon + 1).trim(),
        selector: top.prelude,
        at: stack.filter((s) => s.prelude.startsWith("@")).map((s) => s.prelude),
        line: top.line,
      });
    } else {
      buf += ch;
    }
  }
  return out;
}

/**
 * Правило считается защищённым, если КАЖДАЯ его часть (селекторы через запятую
 * независимы) либо несёт исключение из контракта, либо и так адресована
 * конкретной теме через `[data-theme=…]`.
 */
function guarded(selector) {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .every((part) => part.includes(EXCLUSION) || /\[data-theme[~^|$*]?=/.test(part));
}

/** Ищет мобильные правила без исключения тем в одном исходнике. */
function unguardedMobileRules(name, src) {
  const found = new Map();
  for (const d of parseDeclarations(blankComments(src))) {
    const mobile = MOBILE_SELECTOR.test(d.selector) || d.at.some((a) => MOBILE_AT_RULE.test(a));
    if (!mobile || !LOOK_PROP.test(d.prop) || !hardcoded(d.prop, d.value) || guarded(d.selector)) continue;
    const key = `${name}:${d.line}`;
    if (!found.has(key)) found.set(key, { name, line: d.line, selector: d.selector, props: new Set() });
    found.get(key).props.add(d.prop);
  }
  return [...found.values()];
}

const cssFiles = readdirSync(WEB).filter((f) => f.endsWith(".css") && !THEME_2026_CSS.test(f));
const risky = cssFiles.flatMap((name) => unguardedMobileRules(name, readFileSync(join(WEB, name), "utf8")));

/**
 * Контрольный образец. Проверка, которая ничего не нашла, и проверка, которая
 * сломалась, печатают одну и ту же строку «нет» — а «нет» никто не
 * перепроверяет. Поэтому счётчик прогоняется по кусочку CSS, воспроизводящему
 * оба реальных случая (жёсткий градиент на body и Golos Text для оболочки), и
 * по их защищённым двойникам: он обязан поймать ровно два первых и ни одного
 * второго, иначе весь раздел объявляется сломанным.
 */
const PROBE = `
html[data-mobile-ux] body { background-image: linear-gradient(180deg, #f5f5f9, #eef0f5); }
html[data-mobile-ux] body { font-family: "Golos Text", sans-serif; }
html[data-mobile-ux]:not([data-theme^="royal-home-2026-"]) body { background: #eef0f5; }
@media (max-width: 1023px) { .x { color: var(--c-ink); box-shadow: var(--shadow-md); } }
@media (max-width: 1023px) { .y { border-radius: 22px; backdrop-filter: blur(12px); } }
`;
const probe = unguardedMobileRules("probe.css", PROBE);
if (probe.length !== 2) {
  console.error(
    `\nСЧЁТЧИК МОБИЛЬНЫХ ПРАВИЛ СЛОМАН — контрольный образец дал ${probe.length} вместо 2.` +
      "\nРезультату ниже верить нельзя. Чинить scripts/theme-audit.mjs.",
  );
  process.exitCode = 1;
}

console.log(`\nМобильные правила без исключения тем 2026 (файлов проверено: ${cssFiles.length}):`);
if (risky.length === 0) {
  console.log("  нет — контракт соблюдён.");
} else {
  for (const r of risky.sort((a, b) => a.name.localeCompare(b.name) || a.line - b.line)) {
    const sel = r.selector.length > 90 ? `${r.selector.slice(0, 87)}…` : r.selector;
    console.log(`  apps/web/src/${r.name}:${r.line}  ${sel}\n      навязывает: ${[...r.props].join(", ")}`);
  }
  console.log(
    `\nНайдено ${risky.length}. Каждому такому правилу нужен ${EXCLUSION}` +
      "\n(или переезд в theme-royal-home-2026.css / theme-2026-*.css), иначе оно перекрывает" +
      "\nсобственную палитру темы 2026 на телефоне. Контракт: apps/web/src/index.css.",
  );
  process.exitCode = 1;
}
