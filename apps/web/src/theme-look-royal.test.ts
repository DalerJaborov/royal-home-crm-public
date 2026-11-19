import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOOK_TRUNCATE_OK } from "../tests/e2e/helpers/lookTruncation";

/**
 * СТОРОЖ «НОВОГО ВИДА»: без признака с сервера не меняется ни один пиксель.
 * Каждое правило theme-look-royal.css обязано начинаться с
 * :root[data-ui-look="royal"] (кадры ключей анимации — исключение).
 * `data-look` не годится: его уже занимает личная настройка «вид» (store/uiPrefs.ts).
 */
/** Commas inside :is()/:not() belong to one selector. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = []; let depth = 0; let current = "";
  for (const char of list) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; } else current += char;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/**
 * Раздел слоя по имени файла: `theme-look-royal-<пачка>.css` → `<пачка>`; основа
 * (`theme-look-royal.css`) раздела не имеет. Слой пачки обязан действовать только
 * на свой раздел — экран и окна с меткой `[data-ry-section="<пачка>"]`
 * (components/look/clients/RoyalSection.tsx), иначе он красит чужие экраны с
 * похожими классами и общий портал (ревью PR #278: «Подбор сотрудников»,
 * уведомления, окно входящего лида).
 */
export function lookSectionOf(file: string): string | undefined {
  return /^theme-look-royal-([\w-]+)\.css$/.exec(file)?.[1];
}

/** Метка раздела должна стоять в самом селекторе, а не внутри :is()/:not()/:has(). */
function topLevel(selector: string): string {
  let text = selector;
  for (let prev = ""; prev !== text;) { prev = text; text = text.replace(/\([^()]*\)/g, ""); }
  return text;
}

export function unscopedSelectors(css: string, section?: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bad: string[] = [];
  let depth = 0; let inKeyframes = -1; let buffer = "";
  for (const char of text) {
    if (char === "{") {
      const head = buffer.trim();
      buffer = "";
      if (head.startsWith("@")) {
        // Только раскладочные обёртки и свои кадры анимации (ry-*): @font-face,
        // @layer, @page и прочее меняли бы страницу и без признака.
        if (/^@(-webkit-)?keyframes\b/.test(head)) {
          inKeyframes = depth;
          if (!/^@(-webkit-)?keyframes\s+ry-[\w-]+$/.test(head)) bad.push(head);
        } else if (!/^@(media|supports|container)\b/.test(head)) bad.push(head);
        depth++;
        continue;
      }
      if (inKeyframes < 0) {
        for (const selector of splitTopLevel(head)) {
          if (!selector.startsWith(':root[data-ui-look="royal"]')) bad.push(selector);
          else if (section && !topLevel(selector).includes(`[data-ry-section="${section}"]`)) bad.push(selector);
        }
      }
      depth++;
    } else if (char === "}") {
      depth--; buffer = "";
      if (inKeyframes === depth) inKeyframes = -1;
    } else if (char === ";") { buffer = ""; } else buffer += char;
  }
  return bad;
}

/** Основа и слои экранов нового вида (theme-look-royal-<пачка>.css) — каждый под тем же сторожем. */
const LOOK_FILE = /^theme-look-royal(-[\w-]+)?\.css$/;
const lookFiles = readdirSync(new URL(".", import.meta.url)).filter((f) => LOOK_FILE.test(f)).sort();

describe("theme-look-royal*.css", () => {
  const css = readFileSync(new URL("./theme-look-royal.css", import.meta.url), "utf8");
  it("знает основу и слои разделов «Клиенты», «Чаты» и «Команда»", () => {
    expect(lookFiles).toEqual(expect.arrayContaining(["theme-look-royal.css", "theme-look-royal-clients.css", "theme-look-royal-chats.css", "theme-look-royal-team.css"]));
  });
  it("генератор шрифта (gen-typeset) пропускает каждый слой нового вида", () => {
    const gen = readFileSync(new URL("../../../scripts/gen-typeset.mjs", import.meta.url), "utf8");
    const skip = gen.match(/const ownScale = \(f\) => (\/.+\/)\.test\(f\);/);
    expect(skip, "gen-typeset.mjs обязан пропускать theme-look-royal*.css шаблоном").not.toBeNull();
    const pattern = new Function(`return ${skip![1]}`)() as RegExp;
    for (const file of lookFiles) expect(pattern.test(file), file).toBe(true);
    expect(pattern.test("theme-2026-clean.css")).toBe(false);
  });
  it.each(lookFiles)("%s: every rule is scoped to :root[data-ui-look=\"royal\"] (и к метке своего раздела у слоя пачки)", (file) => {
    expect(unscopedSelectors(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"), lookSectionOf(file))).toEqual([]);
  });
  it("раздел слоя берётся из имени файла; у основы раздела нет", () => {
    expect(lookSectionOf("theme-look-royal-clients.css")).toBe("clients");
    expect(lookSectionOf("theme-look-royal-team-settings.css")).toBe("team-settings");
    expect(lookSectionOf("theme-look-royal.css")).toBeUndefined();
  });
  it("сторож слоя пачки ловит правило без метки раздела (проверен поломкой)", () => {
    const clients = readFileSync(new URL("./theme-look-royal-clients.css", import.meta.url), "utf8");
    const leaks = [
      ':root[data-ui-look="royal"] .rh2 .sheet .pill',
      ':root[data-ui-look="royal"]:has(.clean-client-detail) body > .rh2 .sheet',
      ':root[data-ui-look="royal"] :is(.rh2[data-ry-section="clients"] .a, .b)',
      ':root[data-ui-look="royal"] .rh2[data-ry-section="chats"] .pill',
    ];
    expect(unscopedSelectors(`${clients}\n${leaks.map((s) => `${s} { color: red; }`).join("\n")}`, "clients")).toEqual(leaks);
  });
  it("the guard really catches an unscoped rule (сторож проверен поломкой)", () => {
    expect(unscopedSelectors(`${css}\n.clean-tab { color: red; }\n@media (min-width: 1px) { body, :root[data-ui-look="royal"] a { color: red; } }`))
      .toEqual([".clean-tab", "body"]);
    const atRules = `\n@font-face { font-family: X; src: url(x.woff2); }\n@layer base { :root[data-ui-look="royal"] a { color: red; } }\n@keyframes spin { to { opacity: 0; } }`;
    expect(unscopedSelectors(`${css}${atRules}`)).toEqual(["@font-face", "@layer base", "@keyframes spin"]);
  });
  it("основа и слои экранов подключены после всех прежних тем, основа — первой из них", () => {
    const index = readFileSync(new URL("./index.css", import.meta.url), "utf8");
    const imports = [...index.matchAll(/@import '\.\/(theme-[^']+\.css)'/g)].map((m) => m[1]);
    const first = imports.indexOf("theme-look-royal.css");
    expect(first).toBeGreaterThan(-1);
    const tail = imports.slice(first);
    expect(tail.every((f) => LOOK_FILE.test(f)), `после основы только слои нового вида: ${tail.join(", ")}`).toBe(true);
    // Каждый слой на диске подключён: забытый @import молча выключил бы экран.
    expect([...tail].sort()).toEqual(lookFiles);
  });
});

/**
 * `[class~="x"]` в любой записи (кавычки, без кавычек, пробелы вокруг `~=`, флаг `i`/`s`) —
 * тот же класс `.x` (ревью #303). Прочие формы атрибута класса (`^=`, `$=`, `=`, `|=`, `*=`)
 * классом не являются и в слоях запрещены (`classAttributeForms`), кроме исключения Tailwind-фона.
 */
export function normalizeClassAttr(css: string): string {
  return css.replace(/\[\s*class\s*~=\s*(["']?)([\w-]+)\1(?:\s+[is])?\s*\]/gi, ".$2");
}
/** Исключения: кнопки с Tailwind-фоном (`bg-…`) исключаются из перекраски — это не класс, а семейство. */
const CLASS_ATTR_ALLOWED = new Set(['[class*="bg-"]']);
/** Формы атрибута класса, которые сторожа не умеют читать как класс: в слоях их быть не должно. */
export function classAttributeForms(css: string): string[] {
  const text = normalizeClassAttr(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  return [...text.matchAll(/\[\s*class\s*[\^$*|]?=[^\]]*\]/gi)].map((m) => m[0]).filter((form) => !CLASS_ATTR_ALLOWED.has(form));
}

/** Правила файла как пары «селектор → тело» (самые внутренние блоки, @media прозрачны). */
function cssRules(css: string): { selector: string; body: string }[] {
  // `[class~="x"]` — тот же класс `.x`, только записанный атрибутом: сторожам он обязан быть
  // виден так же (до 19.11 так обходили смысловые и «выключенные» проверки, calls.css:542).
  const text = normalizeClassAttr(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim(), body: m[2] }))
    .filter((r) => !/^(from|to|\d+%)/.test(r.selector) && !r.selector.startsWith("@"));
}

/** Объявления тела правила: [свойство, значение без !important]. */
function declarations(body: string): [string, string][] {
  return body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const at = d.indexOf(":");
    return [d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).replace(/!important/i, "").trim()] as [string, string];
  });
}

/** Значения через пробел на верхнем уровне (calc(...) — одно значение). */
function topValues(value: string): string[] {
  const out: string[] = []; let depth = 0; let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Последнее составное звено селектора (то, к чему применяется правило). */
function subjectOf(selector: string): string {
  let depth = 0; let bracket = 0; let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "(") depth++; else if (ch === ")") depth--;
    else if (ch === "[") bracket++; else if (ch === "]") bracket--;
    else if (depth === 0 && bracket === 0 && /[\s>+~]/.test(ch)) start = i + 1;
  }
  return selector.slice(start);
}

/** Содержимое всех `:not(...)` (с вложенными скобками) и остаток без них. */
function notGroups(selector: string): { inside: string[]; rest: string } {
  const inside: string[] = []; let rest = ""; let i = 0;
  while (i < selector.length) {
    if (selector.startsWith(":not(", i)) {
      let depth = 1; let j = i + 5;
      for (; j < selector.length && depth; j++) { if (selector[j] === "(") depth++; if (selector[j] === ")") depth--; }
      inside.push(selector.slice(i + 5, j - 1)); i = j;
    } else rest += selector[i++];
  }
  return { inside, rest };
}

/** Смысловые варианты кнопок старой темы и токены их смысла в новом виде. */
const MEANING: Record<string, RegExp | null> = {
  danger: /--rh-ui-crit/, crit: /--rh-ui-crit/, warn: /--rh-ui-warn/, hot: /--rh-ui-warn/, ok: /--rh-ui-ok/,
  // У «золотой» кнопки старой темы своего токена в новом виде нет — её цвет не трогают.
  gold: null,
};
const SEMANTIC_VARIANTS = Object.keys(MEANING);
/** Варианты формы (звонок, плавающая), а не смысла: их оформляют намеренно. */
const SHAPE_VARIANT = /\.(btn-call|btn-fab)\b/;
const NEUTRAL_COLOR = /^(transparent|currentcolor|inherit|none)$/i;
const COLOR_PROP = /^(background(-color)?|color)$/;

/**
 * Смысловые кнопки старой темы (ревью «Клиентов» и PR #280, 18.11): правило,
 * красящее кнопку (`.pill`, `.rh-btn`; в шторке — и голый `button`), обязано либо
 * исключить ВСЕ смысловые варианты (`:not(:is(.danger, .crit, .warn, .ok, .gold, .hot…))`),
 * либо, если прямо называет вариант, красить только токенами его смысла
 * (`.danger` → `--rh-ui-crit*`, `.warn` → `--rh-ui-warn*`, `.ok` → `--rh-ui-ok*`).
 * Так ловятся `.sheet .pill.danger{background:primary}`, `:is(.pill):is(.danger,.ghost)`
 * и `.pill:not(:is(.danger))` (warn/ok не исключены).
 */
export function semanticButtonLeaks(css: string): string[] {
  const bad: string[] = [];
  for (const rule of cssRules(css)) {
    const colors = declarations(rule.body).filter(([prop]) => COLOR_PROP.test(prop));
    if (!colors.length) continue;
    for (const selector of splitTopLevel(rule.selector)) {
      const subject = subjectOf(selector);
      const { inside, rest } = notGroups(subject);
      const isButton = /\.(pill|rh-btn)\b/.test(rest) || (/\.sheet\b/.test(selector) && /(^|[\s(,>])button\b/.test(rest));
      if (!isButton) continue;
      const named = SEMANTIC_VARIANTS.filter((v) => new RegExp(`\\.${v}\\b`).test(rest));
      if (named.length) {
        const ok = colors.every(([, value]) => NEUTRAL_COLOR.test(value) || named.every((v) => MEANING[v]?.test(value)));
        if (!ok) bad.push(selector);
        continue;
      }
      if (SHAPE_VARIANT.test(rest)) continue;
      const excluded = inside.join(" ");
      if (!SEMANTIC_VARIANTS.every((v) => new RegExp(`\\.${v}\\b`).test(excluded))) bad.push(selector);
    }
  }
  return bad;
}

/** Нижняя составляющая отступа в объявлении (padding: 1–4 значения, padding-block: 1–2). */
function bottomPadding(prop: string, value: string): string | null {
  const v = topValues(value);
  if (prop === "padding") return v.length >= 3 ? v[2] : v[0] ?? null;
  if (prop === "padding-block") return v[1] ?? v[0] ?? null;
  if (prop === "padding-bottom" || prop === "padding-block-end") return v[0] ?? null;
  return null;
}
const REAL_ENV = (value: string) => /env\(\s*safe-area-inset-bottom/.test(value) && !/(\b0(px|rem|em)?\s*\*\s*env\(|env\([^)]*\)\s*\*\s*0(px|rem|em)?\b)/.test(value);
const ZERO = (value: string) => /^0(px|rem|em|%)?$/.test(value) || (/env\(/.test(value) && !REAL_ENV(value));

/**
 * Запас под полоску iPhone у подвала и последнего тела шторки (theme-royal-home-2026.css):
 * обнулять нижний отступ `.sheet-f`/`.sheet-b` можно, только если в ТОМ ЖЕ правиле
 * есть настоящий `env(safe-area-inset-bottom)` — не `calc(0px * env(...))`.
 * Краснеют `padding: 0 !important`, `padding-block: 0`, `padding-bottom: calc(0px * env())`.
 */
export function safeAreaOverrides(css: string): string[] {
  return cssRules(css).flatMap((rule) => splitTopLevel(rule.selector).filter((selector) => {
    if (!/\.sheet-(f|b)\b/.test(subjectOf(selector))) return false;
    const pads = declarations(rule.body).map(([prop, value]) => bottomPadding(prop, value)).filter((v): v is string => v !== null);
    return pads.some(ZERO) && !pads.some(REAL_ENV);
  }));
}

/**
 * Выход из своего раздела соседним комбинатором: `[data-ry-section="x"] ~ …` или
 * `.rh2[data-ry-section="x"] + …` красит соседей метки — чужой экран или портал.
 * Соседи ВНУТРИ раздела (`[метка] .a + .b`) законны: оба под меткой.
 */
export function siblingEscapes(css: string, section: string): string[] {
  const mark = `[data-ry-section="${section}"]`;
  return cssRules(css).flatMap((rule) => splitTopLevel(rule.selector)).filter((selector) => {
    const top = topLevel(selector);
    const at = top.indexOf(mark);
    if (at < 0) return false;
    // Хвост того же составного звена (классы, атрибуты, псевдоклассы), затем первый комбинатор.
    const next = /^[^\s>+~]*\s*([>+~])?/.exec(top.slice(at + mark.length));
    return next?.[1] === "+" || next?.[1] === "~";
  });
}

/** Специфичность селектора [id, класс/атрибут/псевдокласс, элемент]: :is/:not/:has — по самому тяжёлому аргументу, :where — 0. */
export function specificity(selector: string): [number, number, number] {
  const spec: [number, number, number] = [0, 0, 0];
  let i = 0;
  const add = (other: [number, number, number]) => { spec[0] += other[0]; spec[1] += other[1]; spec[2] += other[2]; };
  const heavier = (a: [number, number, number], b: [number, number, number]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === "#") { spec[0]++; i++; while (i < selector.length && /[\w-]/.test(selector[i])) i++; }
    else if (ch === ".") { spec[1]++; i++; while (i < selector.length && /[\w-]/.test(selector[i])) i++; }
    else if (ch === "[") { spec[1]++; while (i < selector.length && selector[i] !== "]") i++; i++; }
    else if (selector.startsWith("::", i)) { spec[2]++; i += 2; while (i < selector.length && /[\w-]/.test(selector[i])) i++; }
    else if (ch === ":") {
      const m = /^:([\w-]+)(\()?/.exec(selector.slice(i))!;
      i += m[0].length;
      if (m[2]) {
        let depth = 1; const from = i;
        for (; i < selector.length && depth; i++) { if (selector[i] === "(") depth++; if (selector[i] === ")") depth--; }
        const args = selector.slice(from, i - 1);
        if (m[1] === "where") continue;
        if (["is", "not", "has", "matches"].includes(m[1])) {
          let best: [number, number, number] = [0, 0, 0];
          for (const arg of splitTopLevel(args)) { const s = specificity(arg); if (heavier(s, best)) best = s; }
          add(best);
        } else spec[1]++;
      } else spec[1]++;
    } else if (/[a-zA-Z*]/.test(ch)) {
      const from = i; while (i < selector.length && /[\w-*]/.test(selector[i])) i++;
      if (selector.slice(from, i) !== "*") spec[2]++;
    } else i++;
  }
  return spec;
}

const specOrder = (s: [number, number, number]) => s[0] * 1e6 + s[1] * 1e3 + s[2];

const DISABLED_IN = /:disabled|\[disabled\]/;
const EXCLUDES_DISABLED = /:not\((:disabled|\[disabled\]|:is\(:disabled[^)]*\))\)|:enabled/;
/** Вид/смысл кнопки, а не сама кнопка: в «свои классы кнопок» не попадают. */
const NOT_A_CONTROL = (cls: string) => SEMANTIC_VARIANTS.includes(cls) || /^(ghost|soft|sm|icon|is-loading)$/.test(cls);

/** Кнопки старой темы и основы — всегда кнопки. */
const BASE_CONTROLS = ["pill", "rh-btn", "ry-btn"];

/**
 * Свои классы кнопок слоя: у которых в том же слое есть своё правило `:disabled`.
 * Модификатор — не кнопка (хвост ревью #286, 19.11): в `.cw2-btn.end:disabled` кнопка —
 * `cw2-btn`, а `end` лишь её вариант («Завершить»); прежде `end` считался кнопкой, и
 * абзац состояния `.cw2-state.end` требовал приглушения, как выключенная кнопка, — слой
 * обходил это записью `p.cw2-state[class~="end"]`. Класс в составном звене с несколькими
 * классами — модификатор, если рядом стоит уже известная кнопка (общая или встреченная в
 * `:disabled` одна в своём звене). Если известной кнопки в звене нет, кнопками считаются
 * все его классы: сторож лучше покраснеет лишний раз, чем пропустит кнопку.
 */
function controlClasses(rules: { selector: string }[]): Set<string> {
  const compounds: string[][] = [];
  for (const rule of rules) for (const selector of splitTopLevel(rule.selector)) {
    const subject = subjectOf(selector);
    if (!DISABLED_IN.test(subject) || EXCLUDES_DISABLED.test(subject)) continue;
    // `:is(.a, .b.c)` — каждый аргумент своим звеном
    for (const part of notGroups(subject).rest.split(/[\s(),]+/)) {
      const classes = [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]).filter((c) => !NOT_A_CONTROL(c));
      if (classes.length) compounds.push(classes);
    }
  }
  const known = new Set(BASE_CONTROLS);
  for (const classes of compounds) if (classes.length === 1) known.add(classes[0]);
  const capable = new Set<string>();
  for (const classes of compounds) {
    const bases = classes.filter((c) => known.has(c));
    for (const c of bases.length ? bases : classes) capable.add(c);
  }
  return capable;
}

/** «Тип цели» кнопки: `.pill`, `.rh-btn`, `.ry-btn`, `button` и свои классы кнопок слоя. */
function targetTypes(rest: string, capable: Set<string>): string[] {
  const types = [...rest.matchAll(/\.([\w-]+)/g)].map((m) => m[1]).filter((c) => /^(pill|rh-btn|ry-btn)$/.test(c) || capable.has(c));
  if (/(^|[\s(,>])button\b/.test(rest)) types.push("button");
  return [...new Set(types)];
}

/** Без частей «выключена» и веса-заглушки: по нему правило приглушения сверяется с перекраской «один к одному». */
const withoutDisabled = (selector: string) => selector
  .replace(/:is\(\s*(:disabled|\[disabled\]|\[aria-disabled="true"\])(\s*,\s*(:disabled|\[disabled\]|\[aria-disabled="true"\]))*\s*\)/g, "")
  .replace(/:disabled|\[disabled\]|:not\(#ry-dim\)/g, "").replace(/\s+/g, " ").trim();

/** Префикс правила — только корень вида и метка раздела (и, может быть, `.scr`): правило на весь раздел. */
const SECTION_WIDE = /^:root\[data-ui-look="royal"\](\[data-mobile-ux\])?(\s+[\w.-]*(\[data-ry-section="[\w-]+"\])[\w.-]*)?(\s+\.scr)?$/;

/**
 * Выключенная кнопка (третье ревью PR 279, ревью PR 286). Каждое правило слоя,
 * перекрашивающее кнопку (фон или цвет у `.pill`/`.rh-btn`/`.ry-btn`/`button` или у своего
 * класса кнопки), обязано быть ПОКРЫТО правилом приглушения `:disabled` с `opacity`:
 *  - либо правилом на весь раздел, в списке которого есть тип цели перекраски и которое не
 *    легче её (иначе недоступная «Сохранить» горит синим, как доступная);
 *  - либо её же селектором с `:disabled` («один к одному», как в слое team).
 * Сравнивать один вес мало: правило с весом id тяжелее всего, но не покрывает кнопку,
 * которой нет в его списке (`.ry-zzz button` при правиле только для `.pill`).
 * Возвращает непокрытые перекраски.
 */
export function disabledDimGaps(css: string): string[] {
  const rules = cssRules(css);
  const capable = controlClasses(rules);
  const broad: { types: string[]; weight: number }[] = [];
  const exact = new Set<string>();
  const repaints: string[] = [];
  for (const rule of rules) {
    const decls = declarations(rule.body);
    for (const selector of splitTopLevel(rule.selector)) {
      const subject = subjectOf(selector);
      const rest = notGroups(subject).rest;
      const types = targetTypes(rest, capable);
      if (!types.length || EXCLUDES_DISABLED.test(subject)) continue;
      if (DISABLED_IN.test(subject)) {
        // своё оформление выключенной кнопки — не перекраска; приглушение — только с opacity
        if (!decls.some(([prop]) => prop === "opacity")) continue;
        exact.add(withoutDisabled(selector));
        const prefix = topLevel(selector.slice(0, selector.length - subject.length)).replace(/[\s>]+$/, "");
        if (SECTION_WIDE.test(prefix)) broad.push({ types, weight: specOrder(specificity(selector)) });
      } else if (decls.some(([prop, value]) => COLOR_PROP.test(prop) && !NEUTRAL_COLOR.test(value))) repaints.push(selector);
    }
  }
  return repaints.filter((selector) => {
    if (exact.has(withoutDisabled(selector))) return false;
    const types = targetTypes(notGroups(subjectOf(selector)).rest, capable);
    const weight = specOrder(specificity(selector));
    return !broad.some((dim) => dim.weight >= weight && types.some((t) => dim.types.includes(t)));
  });
}

/** Поверхность (карточка, фон страницы) — не смысл и не чужой смысл: фоном смысловой плашки допустима. */
const SURFACE = /^var\(--rh-ui-(card|bg|raised)\)$/;

/**
 * Смысловой цвет НЕ кнопки (плашки, точки, подписи; ревью 18.11, пачка debt): правило,
 * прямо называющее смысловой вариант (`.chip.warn`, `.dot.crit`, `:is(.crit, .hot)`),
 * красит только токенами ЕГО смысла, нейтрально или фоном-поверхностью. Так ловится
 * `.chip:is(.crit, .danger, .hot){background: crit}` — «На проверке» (`.hot` = внимание,
 * components/rh2/Chip.tsx) горело срочным красным в «Клиентах» до 18.11.
 */
export function semanticColorLeaks(css: string): string[] {
  const bad: string[] = [];
  for (const rule of cssRules(css)) {
    const colors = declarations(rule.body).filter(([prop]) => COLOR_PROP.test(prop));
    if (!colors.length) continue;
    for (const selector of splitTopLevel(rule.selector)) {
      const { rest } = notGroups(subjectOf(selector));
      const named = SEMANTIC_VARIANTS.filter((v) => new RegExp(`\\.${v}\\b`).test(rest));
      if (!named.length) continue;
      const ok = colors.every(([prop, value]) => NEUTRAL_COLOR.test(value)
        || (prop !== "color" && SURFACE.test(value))
        || named.every((v) => MEANING[v]?.test(value)));
      if (!ok) bad.push(selector);
    }
  }
  return bad;
}

const REACTION_PROP = /^(background(-color)?|color|transform|box-shadow|border(-color)?|opacity)$/;

/**
 * Выключенная кнопка «живая» под мышью и пальцем (пачка debt, 18.11): `:hover`/`:active`,
 * меняющие фон, цвет, обводку или размер кнопки (`.pill`/`.rh-btn`/`.ry-btn`/`button` и
 * любой класс, у которого в том же слое есть своё правило `:disabled`), обязаны исключить
 * выключенную — `:not(:disabled)` или `:enabled`. Так ловятся `.ry-btn:active{scale}` и
 * `.ry-menu > button:hover{background}` основы и «Чатов» до 18.11.
 */
export function disabledReactions(css: string): string[] {
  const rules = cssRules(css);
  const capable = controlClasses(rules);
  const bad: string[] = [];
  for (const rule of rules) {
    if (!declarations(rule.body).some(([prop, value]) => REACTION_PROP.test(prop) && !/^none$/i.test(value))) continue;
    for (const selector of splitTopLevel(rule.selector)) {
      const subject = subjectOf(selector);
      if (!/:(hover|active)\b/.test(subject) || EXCLUDES_DISABLED.test(subject)) continue;
      if (targetTypes(notGroups(subject).rest, capable).length) bad.push(selector);
    }
  }
  return bad;
}

/**
 * СТОРОЖ СКРЫТИЯ ТЕКСТА — общий для всех слоёв нового вида (перенесён из пачки team,
 * ревью PR 279 и PR 286). Ни одно правило не прячет и не режет текст: ни `display:none`,
 * ни нулевой размер/высота/прозрачность, ни зажим строк, ни многоточие. Разрешены только
 * перечисленные ЦЕЛИКОМ селекторы, и только чисто декоративное или дубль, у которого текст
 * есть рядом (заголовок-дубль, полосы прокрутки, маркер раскрытия, шапка таблицы, подписи
 * цифр на своём месте, имя человека в меню). Строку с данными чинят в слое: перенос.
 */
/*
 * Сторож читает ОБЪЯВЛЕНИЯ (свойство → значение), а не текст тела правила (хвосты ревью
 * #285/#286, 19.11): прежние регулярки по тексту ошибались в обе стороны —
 *  - не видели обрезку высотой `0`, `var(--x)` и `calc(...)` (ловили только цифру 1–9);
 *  - `text-overflow: clip` содержит подстроку `overflow: clip` и вместе с высотой
 *    краснел, хотя без `overflow` ничего не режется; так же `--x-display: none`.
 */
const ZERO_LEN = /^(0|0?\.0+)(px|rem|em|%|vh|vw|dvh|svh|lh)?$/i;
/** Высота «по содержимому» — не режет: всё прочее (цифры, 0, var(), calc(), clamp()) считается заданной. */
const CONTENT_SIZE = /^(auto|none|fit-content|min-content|max-content|inherit|initial|unset|revert|revert-layer)$/i;
const hidesAlone = ([prop, value]: [string, string]) =>
  (prop === "display" && /^none$/i.test(value))
  || (prop === "visibility" && /^(hidden|collapse)$/i.test(value))
  || ((prop === "font-size" || prop === "opacity" || prop === "max-height" || prop === "max-block-size") && ZERO_LEN.test(value))
  || (/^(-webkit-)?line-clamp$/.test(prop) && !/^none$/i.test(value))
  || (prop === "clip-path" && !/^none$/i.test(value))
  || (prop === "text-overflow" && !/^clip$/i.test(value))
  || (prop === "clip" && /^rect\(/i.test(value));
/** Обрезка без многоточия (ревью 18.11, второе): режущий `overflow` вместе с запретом переноса, заданной высотой или нулевой шириной — текст режется молча. */
const clipsBox = ([prop, value]: [string, string]) => /^overflow(-x|-y|-block|-inline)?$/.test(prop) && /\b(hidden|clip)\b/i.test(value);
const clipsText = ([prop, value]: [string, string]) =>
  (prop === "white-space" && /^(nowrap|pre)$/i.test(value))
  || ((prop === "text-wrap" || prop === "text-wrap-mode") && /\bnowrap\b/i.test(value))
  || (/^(max-)?(height|block-size)$/.test(prop) && !CONTENT_SIZE.test(value))
  || (/^(max-)?(width|inline-size)$/.test(prop) && ZERO_LEN.test(value));
const hidesText = (body: string) => {
  const decls = declarations(body).filter(([prop]) => !prop.startsWith("--"));
  return decls.some(hidesAlone) || (decls.some(clipsBox) && decls.some(clipsText));
};
const R = ':root[data-ui-look="royal"]';
export const HIDING_ALLOWED = new Set<string>([
  // team: заголовок-дубль на телефоне, полосы прокрутки, крестик поиска, шапка таблицы и
  // подписи цифр на своих местах, маркер раскрытия, имя в меню профиля
  `${R}[data-mobile-ux] [data-ry-section="team"] .ry-title[data-dup]`,
  `${R} [data-ry-section="team"]:is(.ry-set, .ry-teamp, .ry-member, .ry-activity) .seg-ai::-webkit-scrollbar`,
  `${R} [data-ry-section="team"] .ry-search input::-webkit-search-cancel-button`,
  `${R}[data-mobile-ux] [data-ry-section="team"] .ry-set-tasks::-webkit-scrollbar`,
  `${R} [data-ry-section="team"] .ry-mhead`,
  `${R} [data-ry-section="team"] .ry-mhead > :last-child`,
  `${R} [data-ry-section="team"] .ry-mrow .ry-stat small`,
  `${R} .ry-teamp[data-ry-section="team"] details.clean-team-recognition > summary::-webkit-details-marker`,
  `${R} .ry-activity[data-ry-section="team"] .scr .seg::-webkit-scrollbar`,
  `${R} [data-ry-section="team"] .ry-pmenu-head b`,
  // Полосы прокрутки, маркеры раскрытия, пустая распорка, точки галереи при ленте миниатюр,
  // линия под шапкой до прокрутки — декор.
  `${R} .ry-chats[data-ry-section="chats"] .ry-chats-more > summary::-webkit-details-marker`,
  `${R} .ry-chats[data-ry-section="chats"] .ry-chat-quick::-webkit-scrollbar`,
  `${R} .rh2[data-ry-section="clients"] .scr.clean-client-detail .ry-ctabs::-webkit-scrollbar`,
  `${R} [data-ry-section="deals"] .ry-deals-stages::-webkit-scrollbar`,
  `${R} .ry-objects-page.rh2.screens[data-ry-section="objects"] .seg-ai::-webkit-scrollbar`,
  `${R} .ry-objects-page.rh2.screens[data-ry-section="objects"] .clean-property-catalog > .hscroll::-webkit-scrollbar`,
  `${R} .ry-objects-page.rh2.screens[data-ry-section="objects"] .clean-catalog-tools > summary::-webkit-details-marker`,
  `${R} .ry-objects-page.rh2.screens[data-ry-section="objects"] .bulk .spacer`,
  `${R} .ry-object-page.rh2.screens[data-ry-section="objects"] .ry-gal .rh-gallery-dots`,
  `${R} [data-ry-section="objects"] .ry-gal-thumbs::-webkit-scrollbar`,
  `${R} .ry-object-page.rh2.screens[data-ry-section="objects"] .clean-property-deal-disclosure > summary::-webkit-details-marker`,
  `${R} .ry-object-page.rh2.screens[data-ry-section="objects"] .rh-tabs-scroll::-webkit-scrollbar`,
  `${R} .clean-shell .clean-header::after`,
  // Значки при подписи (подпись рядом видна): кнопки инструментов, вкладки карточки на
  // телефоне, значок тихой плашки на телефоне, аватар ответственного на ПК (имя — в колонке),
  // «Нет фото» в списке объектов (значок «нет фото» на месте).
  `${R} .rh2[data-ry-section="clients"].clean-clients-page .ry-clients-tools .ry-btn svg`,
  `${R}[data-mobile-ux] .rh2[data-ry-section="clients"] .scr.clean-client-detail .ry-ctab svg`,
  `${R}[data-mobile-ux] .clean-shell #main > .rh2.screens > .scr > .card.tight > .quiet > svg`,
  `${R} .rh2[data-ry-section="clients"].clean-clients-page .ry-crow-agent-av`,
  `${R} [data-ry-section="objects"] .ry-obj-grid[data-view="rows"] .ry-obj-nophoto-text`,
  `${R} [data-ry-section="objects"] .ry-obj-grid[data-view="cards"] .ry-obj-nophoto-text`,
  // Дубли: заголовок экрана на телефоне (он же в шапке; для чтеца остаётся), короткая и
  // длинная подпись вкладки (видна одна из двух), подписи колонок для чтеца и шапка таблицы
  // на телефоне (на ПК — видимая шапка), имя отправителя в пузыре (оно в шапке переписки),
  // состояние объекта: пилюлей на фото или текстом в строке — одно из двух, свёрнутая
  // кнопка «Фильтры» (тело фильтров раскрыто в «Ещё»), название CRM при узком меню (значок).
  `${R}[data-mobile-ux] [data-ry-section="deals"] .ry-deals-head h1`,
  `${R}[data-mobile-ux] [data-ry-section="objects"] .ry-objects-head h1`,
  `${R} .rh2[data-ry-section="clients"] .scr.clean-client-detail .ry-ctab-short`,
  `${R}[data-mobile-ux] .rh2[data-ry-section="clients"] .scr.clean-client-detail .ry-ctab-long`,
  `${R} .rh2[data-ry-section="clients"].clean-clients-page .ry-crow-label-phone`,
  `${R} .rh2[data-ry-section="clients"].clean-clients-page .ry-crow-label`,
  `${R} .rh2[data-ry-section="clients"].clean-clients-page .ry-clist-head`,
  `${R} .ry-chats[data-ry-section="chats"] .clean-conversation .bub:not(.me) > .who`,
  `${R} [data-ry-section="objects"] .ry-obj-state`,
  `${R} [data-ry-section="objects"] .ry-obj-grid[data-view="rows"] .ry-obj-photo > .ry-obj-pill`,
  `${R} [data-ry-section="objects"] .ry-obj-grid[data-view="cards"] .ry-obj-photo > .ry-obj-pill`,
  `${R} .ry-chats[data-ry-section="chats"] .ry-chats-more-body .clean-inbox-filters > summary`,
  `${R}:not([data-mobile-ux]) .clean-shell .clean-brand b`,
  // Узкое меню ПК (< 1200) — одни значки; подпись в title и для чтеца (решение основы).
  `${R}:not([data-mobile-ux]) .clean-shell .ry-nav-label`,
  // Телефонная навигация «список ↔ переписка ↔ карточка»: экран переключён, а не текст скрыт.
  `${R} .ry-chats[data-ry-section="chats"][data-chat-active="thread"] .ry-chats-head`,
  `${R} .ry-chats[data-ry-section="chats"] .two[data-conversation-selected] > section[aria-label="Диалоги"]`,
  `${R} .ry-chats[data-ry-section="chats"] .two > section.clean-conversation-placeholder`,
  `${R} .ry-chats[data-ry-section="chats"] .clean-conversation-workspace[data-context-open] > .clean-conversation-timeline`,
  // Имена людей в списках можно резать многоточием (бриф переноса, «Дополнение 18.11»);
  // имя клиента в строке списка — вместе с запросом, который весь повторён строкой ниже.
  // Ответственного в строке клиента НЕ режем ни на какой ширине (владелец 19.11: «полные имена»).
  `${R} .ry-chats[data-ry-section="chats"] .ry-chat-name`,
  `${R} .ry-chats[data-ry-section="chats"] .ry-chat-who-tx b`,
  `${R} .rh2[data-ry-section="clients"].clean-clients-page .ry-crow-name`,
  `${R} [data-ry-section="objects"] .ry-obj-agent > span:last-child`,
  `${R} .ry-team-person b`,
  // ПОД ВОПРОСОМ (вынесено владельцу пачек в отчёте PR 286): последняя реплика в списке
  // чатов — одной строкой (полный текст в переписке); номер карточки и источник в строке
  // клиента на телефоне (они в карточке; так закреплено e2e new-look-clients).
  `${R} .ry-chats[data-ry-section="chats"] .ry-chat-last`,
  `${R} .rh2[data-ry-section="clients"].clean-clients-page .ry-crow-pc-only`,
  // Рамки фиксированного размера под картинку, инициалы (1-2 буквы в круге) и полоску без
  // текста: `overflow:hidden` + высота в цифрах режет только скругление и картинку, не слова
  // (сторож обрезки без многоточия, ревью 18.11, второе).
  `${R} .ry-avatar`,
  `${R} .ry-bar`,
  // Рамка двух панелей «Чатов» на ПК (высота `var(--ry-chat-h)`): список и переписка
  // прокручиваются ВНУТРИ (`.pane-scroll`, лента переписки), рамка режет только скругление.
  // До 19.11 сторож высоту через var() не видел вовсе.
  `${R} .ry-chats[data-ry-section="chats"] .two > section`,
  `${R} [data-ry-section="deals"] .ry-deal-thumb`,
  `${R} [data-ry-section="objects"] .ry-gal-thumbs > button`,
  // calls: полоса прокрутки ленты фильтров (прокрутка пальцем остаётся) и стрелка-украшение
  // плитки на узком экране (вся плитка — ссылка с подписью). Второй, скрытый h1 переключателя
  // на телефоне убран из разметки (19.11): заголовок экрана один — в шапке.
  `${R} .ry-calls.rh2.screens[data-ry-section="calls"] .hscroll::-webkit-scrollbar`,
  `${R} .ry-telephony.rh2.screens[data-ry-section="calls"] .tiles .tile .tile-go`,
  // money: полоса прокрутки ленты вкладок (прокрутка пальцем остаётся) и значок искр при быстром
  // вводе — украшение, подпись и поле рядом (знак ИИ в интерфейсе не подчёркиваем).
  `${R} [data-ry-section="money"] .cef-toolbar .cef-main-tabs::-webkit-scrollbar`,
  `${R} [data-ry-section="money"] .cef-line-input > svg.lucide-sparkles`,
  // marketing: полосы прокрутки ленты вкладок раздела и лент срезов/статусов (прокрутка
  // пальцем и колесом остаётся, сами вкладки видны).
  `${R} .rh2.screens[data-ry-section="marketing"] .seg-ai::-webkit-scrollbar`,
  `${R} .rh2.screens[data-ry-section="marketing"] .hscroll::-webkit-scrollbar`,
  // marketing: значок-картинка у комментария на телефоне — украшение (aria-hidden), публикация
  // открывается ссылкой «Открыть публикацию» в той же карточке.
  `${R}[data-mobile-ux] .rh2.screens[data-ry-section="marketing"] .scr .cmt > .thumb`,
  // control: тот же значок искр у «Разобрать сейчас» в шапке «Обучения бота» — украшение, подпись рядом.
  `${R} .ry-control[data-ry-section="control"] .pg-h .acts svg.lucide-sparkles`,
  // analytics: полосы прокрутки лент вкладок и переключателей (прокрутка пальцем остаётся).
  `${R} .rh2[data-ry-section="analytics"] .scr .seg-ai::-webkit-scrollbar`,
  `${R} .rh2[data-ry-section="analytics"] .scr .hscroll::-webkit-scrollbar`,
]);
export function hiddenTextSelectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => hidesText(body))
    .flatMap(([, head]) => splitTopLevel(head.trim()))
    .filter((selector) => !selector.startsWith("@") && !/^(from|to|\d+%)$/.test(selector) && !HIDING_ALLOWED.has(selector));
}

/**
 * Многоточие и зажим строк — только у того, что e2e-помощник ширин пропускает обрезанным
 * (`tests/e2e/helpers/lookTruncation.ts`, одно место на оба сторожа, 19.11.2026): иначе
 * сторож слоёв разрешил бы многоточие белым списком, а e2e краснел бы на нём — или
 * наоборот, e2e пропускал бы то, чего слой не заявлял.
 */
export function truncationOutsideList(css: string): string[] {
  return cssRules(css)
    .filter((rule) => declarations(rule.body).some(([prop, value]) =>
      (prop === "text-overflow" && /^ellipsis$/i.test(value)) || (/^(-webkit-)?line-clamp$/.test(prop) && !/^none$/i.test(value))))
    .flatMap((rule) => splitTopLevel(rule.selector))
    .filter((selector) => !LOOK_TRUNCATE_OK.some((ok) => selector.replace(/\s+/g, " ").endsWith(` ${ok}`)));
}

describe("все слои нового вида: смысловые цвета, выключенные кнопки, запас iPhone, соседи метки", () => {
  it.each(lookFiles)("%s: ничего не прячет и не режет текст, кроме белого списка точных селекторов", (file) => {
    expect(truncationOutsideList(readFileSync(new URL(`./${file}`, import.meta.url), "utf8")), "многоточие вне LOOK_TRUNCATE_OK").toEqual([]);
    expect(hiddenTextSelectors(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"))).toEqual([]);
  });
  it.each([
    "display: none", "visibility: hidden", "font-size: 0", "max-height: 0", "opacity: 0",
    "-webkit-line-clamp: 2", "clip-path: inset(50%)", "text-overflow: ellipsis", "clip: rect(0 0 0 0)",
  ])("сторож скрытия ловит «%s» в любом слое (проверен поломкой)", (declaration) => {
    for (const file of lookFiles) {
      const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const section = lookSectionOf(file);
      const leak = `${R} ${section ? `[data-ry-section="${section}"] ` : ""}.ry-zzz-text`;
      expect(hiddenTextSelectors(`${css}\n${leak} { ${declaration}; }`), file).toEqual([leak]);
    }
    // в белом списке — только ТОЧНЫЙ селектор: соседний под тем же классом краснеет
    expect(hiddenTextSelectors(`${R} [data-ry-section="team"] .ry-mrow .ry-stat small.x { ${declaration}; }`)).toHaveLength(1);
  });
  it.each([
    "overflow: hidden; white-space: nowrap", "overflow: hidden; max-height: 40px", "overflow-x: hidden; height: 20px",
    "overflow: clip; white-space: nowrap", "clip: rect(1px, 1px, 1px, 1px)",
    // хвосты ревью #285/#286 (19.11): высота нулём, через var() и calc(), логическая высота,
    // перенос, выключенный text-wrap, нулевая ширина, обрезка одной осью в паре с другой
    "overflow: hidden; height: 0", "overflow: hidden; height: 0px", "overflow-y: hidden; max-height: var(--ry-zzz-h)",
    "overflow: hidden; height: calc(2 * 1.4em)", "overflow: hidden auto; block-size: clamp(20px, 3vh, 40px)",
    "overflow: clip; max-block-size: 3lh", "overflow: hidden; text-wrap: nowrap", "overflow: hidden; width: 0",
    "overflow: hidden !important; height: 0 !important",
  ])("сторож ловит обрезку без многоточия «%s» (проверен поломкой)", (body) => {
    const leak = `${R} .ry-zzz`;
    expect(hiddenTextSelectors(`${leak} { ${body}; }`)).toEqual([leak]);
    // скругление и высота строки без обрезки — не нарушение
    expect(hiddenTextSelectors(`${leak} { overflow: hidden; border-radius: 8px; line-height: 20px; min-height: 40px; }`)).toEqual([]);
  });
  it("плашка «Уведомления заблокированы» снова обрезана — красный (ровно ошибка до 18.11)", () => {
    const base = readFileSync(new URL("./theme-look-royal.css", import.meta.url), "utf8");
    const Q = `${R} .clean-shell #main > .rh2.screens > .scr > .card.tight > .quiet > .txt`;
    expect(hiddenTextSelectors(`${base}\n${Q} { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }`)).toEqual([Q]);
  });
  it.each([
    // ложные тревоги прежнего сторожа (ревью #286): `text-overflow` — не `overflow`
    "text-overflow: clip; height: 40px", "text-overflow: clip; white-space: nowrap; max-height: 3em",
    // высота по содержимому не режет; своё свойство (`--x-…`) — не объявление свойства
    "overflow: hidden; height: auto", "overflow: hidden; max-height: none", "overflow: hidden; height: fit-content",
    "--ry-zzz-display: none; --ry-zzz-opacity: 0", "overflow: hidden; --ry-zzz-h: 0; white-space: normal",
    "overflow: visible; height: 0", "overflow-wrap: anywhere; height: 40px", "font-size: 0.9rem; opacity: .6",
  ])("сторож НЕ краснеет на «%s» (обрезки нет)", (body) => {
    expect(hiddenTextSelectors(`${R} .ry-zzz { ${body}; }`)).toEqual([]);
  });
  it("многоточие только у имён из общего списка e2e (проверен поломкой)", () => {
    const chats = readFileSync(new URL("./theme-look-royal-chats.css", import.meta.url), "utf8");
    const H = `${R} .ry-chats[data-ry-section="chats"]`;
    expect(truncationOutsideList(chats)).toEqual([]);
    // сумма или статус с многоточием — вне списка: краснеет, даже если попал в белый список скрытия
    expect(truncationOutsideList(`${chats}\n${H} .ry-chat-sum { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n${H} .ry-chat-status { -webkit-line-clamp: 1; }`))
      .toEqual([`${H} .ry-chat-sum`, `${H} .ry-chat-status`]);
    // хвост селектора сверяется целиком: похожее имя класса — не то же самое
    expect(truncationOutsideList(`${H} .ry-chat-name-sum { text-overflow: ellipsis; }\n${H} .x-ry-chat-name { text-overflow: ellipsis; }`)).toHaveLength(2);
    expect(LOOK_TRUNCATE_OK).toContain(".ry-chat-name");
  });
  it.each(lookFiles)("%s: класс записан классом, а не атрибутом (кроме [class*=\"bg-\"])", (file) => {
    expect(classAttributeForms(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"))).toEqual([]);
  });
  it("все записи `[class~=]` — тот же класс; `^=`, `$=`, `=`, `|=` и чужой `*=` запрещены (проверен поломкой)", () => {
    const C = ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"]';
    for (const form of ['[class~="crit"]', "[class~='crit']", "[class~=crit]", '[class ~= "crit"]', '[ class~="crit" i]', '[class~="crit" s]', '[CLASS~="crit"]']) {
      expect(normalizeClassAttr(`${C} .chip${form}`), form).toBe(`${C} .chip.crit`);
      expect(semanticColorLeaks(`${C} .chip${form} { background: var(--rh-ui-primary); }`), form).toEqual([`${C} .chip.crit`]);
    }
    const bad = ['[class^="ry-"]', '[class$="-btn"]', '[class="pill danger"]', '[class|="ry"]', '[class*="danger"]', '[class *= "crit" i]'];
    for (const form of bad) expect(classAttributeForms(`${C} .chip${form} { color: red; }`), form).toEqual([form]);
    expect(classAttributeForms(`${C} .pill:not(:is(.danger, [class*="bg-"])) { color: red; }
${C} .chip[class~="crit" i] { color: red; }`)).toEqual([]);
  });
  it("`[class~=\"x\"]` видно сторожам как `.x`: модификатор кнопки — не кнопка (проверен поломкой)", () => {
    const calls = readFileSync(new URL("./theme-look-royal-calls.css", import.meta.url), "utf8");
    const W = ':root[data-ui-look="royal"] .ry-cw[data-ry-section="calls"]';
    // абзац состояния с классом «end» (вариант кнопки «Завершить») — не кнопка: без обхода
    expect(calls).toContain(`${W} .cw2-state.end {`);
    expect(calls).not.toMatch(/\[class~=/);
    expect(disabledDimGaps(calls)).toEqual([]);
    // а сама кнопка «Завершить» без приглушения — снова красная
    const undimmed = calls.replace(/, \.cw2-btn, button\):is\(:disabled/, ", button):is(:disabled");
    expect(undimmed).not.toBe(calls);
    expect(disabledDimGaps(undimmed)).toContain(`${W} .cw2-btn.end`);
    // смысловая плашка, записанная атрибутом, — та же смысловая плашка
    const C = ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"]';
    expect(semanticColorLeaks(`${C} .chip[class~="crit"] { background: var(--rh-ui-primary); }`)).toEqual([`${C} .chip.crit`]);
    expect(semanticButtonLeaks(`${C} .card [class~='pill'] { background: blue; }`)).toEqual([`${C} .card .pill`]);
    // в звене без известной кнопки все классы — кнопки (строго), с известной — модификаторы
    const H = ':root[data-ui-look="royal"] [data-ry-section="calls"]';
    expect(disabledDimGaps(`${H} .ry-zzz-row .ry-zzz-btn.big:disabled { opacity: .5; }\n${H} .ry-zzz-label.big { color: red; }`)).toEqual([`${H} .ry-zzz-label.big`]);
    expect(disabledDimGaps(`${H} .ry-zzz-btn:disabled { opacity: .5; }\n${H} .ry-zzz-row .ry-zzz-btn.big:disabled { opacity: .5; }\n${H} .ry-zzz-label.big { color: red; }`)).toEqual([]);
    // база с одним лишь модификатором в :disabled — всё равно кнопка
    expect(disabledDimGaps(`${H} .ry-zzz-row .ry-zzz-btn.big:disabled { opacity: .5; }\n${H} .ry-zzz-btn { background: blue; }`)).toEqual([`${H} .ry-zzz-btn`]);
  });
  const sectionFiles = lookFiles.filter((f) => lookSectionOf(f));
  it("знает слой раздела «Объекты»", () => {
    expect(lookFiles).toContain("theme-look-royal-objects.css");
    expect(lookSectionOf("theme-look-royal-objects.css")).toBe("objects");
  });
  it("знает слой раздела «Сделки» и ловит в нём поломки (проверен поломкой)", () => {
    expect(lookFiles).toContain("theme-look-royal-deals.css");
    expect(lookSectionOf("theme-look-royal-deals.css")).toBe("deals");
    const css = readFileSync(new URL("./theme-look-royal-deals.css", import.meta.url), "utf8");
    const P = ':root[data-ui-look="royal"] .ry-deals-page.rh2.screens[data-ry-section="deals"]';
    // чужая метка, правило без метки, смысловая кнопка чужим цветом, запас iPhone, сосед метки
    expect(unscopedSelectors(`${css}\n:root[data-ui-look="royal"] .rh2[data-ry-section="objects"] .dcard { color: red; }\n:root[data-ui-look="royal"] .kan-col { color: red; }`, "deals"))
      .toEqual([':root[data-ui-look="royal"] .rh2[data-ry-section="objects"] .dcard', ':root[data-ui-look="royal"] .kan-col']);
    expect(semanticButtonLeaks(`${css}\n${P} .card.tight > .wrap .pill { background: var(--rh-ui-press); }`)).toEqual([`${P} .card.tight > .wrap .pill`]);
    expect(safeAreaOverrides(`${css}\n:root[data-ui-look="royal"] .rh2[data-ry-section="deals"] .sheet .sheet-f { padding: 0; }`))
      .toEqual([':root[data-ui-look="royal"] .rh2[data-ry-section="deals"] .sheet .sheet-f']);
    expect(siblingEscapes(`${css}\n${P} ~ .rh2 .pill { color: red; }`, "deals")).toEqual([`${P} ~ .rh2 .pill`]);
  });
  it("знает слой раздела «Маркетинг» и ловит в нём поломки (проверен поломкой)", () => {
    expect(lookFiles).toContain("theme-look-royal-marketing.css");
    expect(lookSectionOf("theme-look-royal-marketing.css")).toBe("marketing");
    const css = readFileSync(new URL("./theme-look-royal-marketing.css", import.meta.url), "utf8");
    const M = ':root[data-ui-look="royal"] .rh2.screens[data-ry-section="marketing"]';
    // правило без метки и с чужой меткой; общий портал без метки
    expect(unscopedSelectors(`${css}
:root[data-ui-look="royal"] .rh2 .tiles .tile { color: red; }
:root[data-ui-look="royal"] .rh2[data-ry-section="money"] .chip { color: red; }`, "marketing"))
      .toEqual([':root[data-ui-look="royal"] .rh2 .tiles .tile', ':root[data-ui-look="royal"] .rh2[data-ry-section="money"] .chip']);
    // красная «Удалить» синим, «На проверке» (.hot) срочным красным, срез без исключения смысла
    expect(semanticButtonLeaks(`${css}
${M} .sheet .pill.danger { background: var(--rh-ui-primary); }
${M} .acts .pill { background: var(--rh-ui-primary); }`))
      .toEqual([`${M} .sheet .pill.danger`, `${M} .acts .pill`]);
    expect(semanticColorLeaks(`${css}
${M} .chip:is(.crit, .hot) { background: var(--rh-ui-crit); }`)).toEqual([`${M} .chip:is(.crit, .hot)`]);
    // выключенная кнопка: без правила приглушения перекраска кнопки — красная
    const undimmed = css.replace(/:is\(\.pill, \.rh-btn, \.ry-btn, button\):is\(:disabled, \[disabled\], \[aria-disabled="true"\]\):not\(#ry-dim\)/, ".ry-zzz:disabled");
    expect(undimmed).not.toBe(css);
    expect(disabledDimGaps(undimmed)).not.toEqual([]);
    // скрытие текста, запас iPhone, сосед метки
    expect(hiddenTextSelectors(`${css}
${M} .tiles .tile small { display: none; }`)).toEqual([`${M} .tiles .tile small`]);
    expect(safeAreaOverrides(`${css}
${M} .sheet.bottom .sheet-f { padding-bottom: 0; }`)).toEqual([`${M} .sheet.bottom .sheet-f`]);
    expect(siblingEscapes(`${css}
${M} ~ .rh2 .pill { color: red; }`, "marketing")).toEqual([`${M} ~ .rh2 .pill`]);
  });
  it("«Маркетинг»: бледнеет только сплошная кнопка шапки, после которой есть ещё сплошная (ревью #307)", () => {
    // Ошибка первой версии: `:not(:last-child)` бледнил ЕДИНСТВЕННУЮ сплошную «Повторить упавшие»,
    // стоящую первой перед серыми кнопками карточки ролика. Цвет на настоящей странице сверяет e2e
    // new-look-marketing.spec.ts; здесь — что правило снова не стало «по позиции».
    const css = readFileSync(new URL("./theme-look-royal-marketing.css", import.meta.url), "utf8");
    const dimmed = (text: string) => cssRules(text).flatMap((r) => splitTopLevel(r.selector))
      .filter((sel) => /\.pg-h \.acts > \.pill/.test(sel) && !/:hover/.test(sel));
    const rules = dimmed(css);
    expect(rules.length).toBeGreaterThan(0);
    for (const sel of rules) {
      expect(sel, "бледнить по соседней сплошной, а не по позиции").toMatch(/:has\(~ \.pill(:not\(\.[\w-]+\))+\)/);
      expect(sel).not.toMatch(/:(last|first)-child|:nth-/);
    }
    const broken = css.replace(/:has\(~ \.pill(:not\(\.[\w-]+\))+\)/g, ":not(:last-child)");
    expect(broken).not.toBe(css);
    expect(() => { for (const sel of dimmed(broken)) expect(sel).toMatch(/:has\(~ \.pill/); }).toThrow();
  });
  it("знает слой экранов контроля и ловит в нём поломки (проверен поломкой)", () => {
    expect(lookFiles).toContain("theme-look-royal-control.css");
    expect(lookSectionOf("theme-look-royal-control.css")).toBe("control");
    const css = readFileSync(new URL("./theme-look-royal-control.css", import.meta.url), "utf8");
    const K = ':root[data-ui-look="royal"] .ry-control[data-ry-section="control"]';
    // правило без метки и с чужой меткой
    expect(unscopedSelectors(`${css}\n:root[data-ui-look="royal"] .rh2 .scr .tile { color: red; }\n:root[data-ui-look="royal"] .rh2[data-ry-section="team"] .quiet { color: red; }`, "control"))
      .toEqual([':root[data-ui-look="royal"] .rh2 .scr .tile', ':root[data-ui-look="royal"] .rh2[data-ry-section="team"] .quiet']);
    // смысловая кнопка общим синим, «внимание» срочным красным, срез «Контроля» обрезан многоточием
    expect(semanticButtonLeaks(`${css}\n${K} .quiet .pill { background: var(--rh-ui-primary); }`)).toEqual([`${K} .quiet .pill`]);
    expect(semanticColorLeaks(`${css}\n${K} .chip.warn { background: var(--rh-ui-crit); }`)).toEqual([`${K} .chip.warn`]);
    expect(hiddenTextSelectors(`${css}\n${K} .scr .quiet .txt { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }`)).toEqual([`${K} .scr .quiet .txt`]);
    // без правила приглушения выключенная «Повторить» горела бы как доступная
    const undimmed = css.replace(/:root\[data-ui-look="royal"\] \[data-ry-section="control"\] :is\(\.pill[^\n]*\n/, "");
    expect(undimmed).not.toBe(css);
    expect(disabledDimGaps(undimmed)).not.toEqual([]);
  });
  it("знает слой раздела «Аналитика» и ловит в нём поломки (проверен поломкой)", () => {
    expect(lookFiles).toContain("theme-look-royal-analytics.css");
    expect(lookSectionOf("theme-look-royal-analytics.css")).toBe("analytics");
    const css = readFileSync(new URL("./theme-look-royal-analytics.css", import.meta.url), "utf8");
    const P = ':root[data-ui-look="royal"] .rh2[data-ry-section="analytics"]';
    // чужая метка и правило без метки
    expect(unscopedSelectors(`${css}
:root[data-ui-look="royal"] .rh2[data-ry-section="money"] .tile { color: red; }
:root[data-ui-look="royal"] .rh2 .bars { color: red; }`, "analytics"))
      .toEqual([':root[data-ui-look="royal"] .rh2[data-ry-section="money"] .tile', ':root[data-ui-look="royal"] .rh2 .bars']);
    // «Удалить кампанию» стала синей; «Обновить» без исключения смысловых
    expect(semanticButtonLeaks(`${css}
${P} .pill.danger { background: var(--rh-ui-primary); }
${P} .acts .pill { background: var(--rh-ui-primary); }`))
      .toEqual([`${P} .pill.danger`, `${P} .acts .pill`]);
    // название канала в кольце снова режется многоточием (ровно поведение старой темы)
    expect(hiddenTextSelectors(`${css}
${P} .scr .donut .keys button .nm2 { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }`))
      .toEqual([`${P} .scr .donut .keys button .nm2`]);
    // запас iPhone у шторки «Отложить №…» и сосед метки
    expect(safeAreaOverrides(`${css}
${P} .sheet .sheet-f { padding: 0; }`)).toEqual([`${P} .sheet .sheet-f`]);
    expect(siblingEscapes(`${css}
${P} + .rh2 .pill { color: red; }`, "analytics")).toEqual([`${P} + .rh2 .pill`]);
    // выключенная кнопка без приглушения перебитым весом
    expect(disabledDimGaps(css.replace(':not(#ry-dim) { opacity: .5; cursor: not-allowed; }', ' { opacity: .5; cursor: not-allowed; }'))).not.toEqual([]);
  });
  it("знает слой мастера и формы объекта (wizard) и ловит в нём поломки (проверен поломкой)", () => {
    expect(lookFiles).toContain("theme-look-royal-wizard.css");
    expect(lookSectionOf("theme-look-royal-wizard.css")).toBe("wizard");
    const css = readFileSync(new URL("./theme-look-royal-wizard.css", import.meta.url), "utf8");
    const Z = ':root[data-ui-look="royal"] .rh2[data-ry-section="wizard"]';
    // правило без метки и с чужой меткой (мастер носит те же .chip/.tile/.ghost, что главная и пульт)
    expect(unscopedSelectors(`${css}
:root[data-ui-look="royal"] .rh2 .wiz .chip { color: red; }
:root[data-ui-look="royal"] .rh2[data-ry-section="objects"] .wiz .blk { color: red; }`, "wizard"))
      .toEqual([':root[data-ui-look="royal"] .rh2 .wiz .chip', ':root[data-ui-look="royal"] .rh2[data-ry-section="objects"] .wiz .blk']);
    // «Удалить черновик?» в окне подтверждения синим; «Осталось: …» (.chip.warn) срочным красным
    expect(semanticButtonLeaks(`${css}
${Z} > .scr > .sheet .pill.danger { background: var(--rh-ui-primary); }
${Z} .sheet-f .pill { background: var(--rh-ui-primary); }`)).toEqual([`${Z} > .scr > .sheet .pill.danger`, `${Z} .sheet-f .pill`]);
    expect(semanticColorLeaks(`${css}
${Z} .wiz .chip.warn { background: var(--rh-ui-crit); }`)).toEqual([`${Z} .wiz .chip.warn`]);
    // «Осталось: фото, район, цена» снова в одну строку с обрезкой
    expect(hiddenTextSelectors(`${css}
${Z} .wiz .chip { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }`)).toEqual([`${Z} .wiz .chip`]);
    // запас iPhone у шторки и у подвала формы правки, сосед метки
    expect(safeAreaOverrides(`${css}
${Z} > .scr > .sheet.bottom .sheet-f { padding-bottom: 0; }`)).toEqual([`${Z} > .scr > .sheet.bottom .sheet-f`]);
    expect(siblingEscapes(`${css}
${Z} ~ .rh2 .pill { color: red; }`, "wizard")).toEqual([`${Z} ~ .rh2 .pill`]);
    // без правила приглушения выключенная «Создать объект» горела бы как доступная
    const undimmed = css.replace(/:root\[data-ui-look="royal"\] \[data-ry-section="wizard"\] :is\(\.pill[^\n]*\n/, "");
    expect(undimmed).not.toBe(css);
    expect(disabledDimGaps(undimmed)).not.toEqual([]);
  });
  it("«Удалить» кампанию воронки красная по признаку смысла, а не по порядку ссылок (ревью #304)", () => {
    const css = readFileSync(new URL("./theme-look-royal-analytics.css", import.meta.url), "utf8");
    const P = ':root[data-ui-look="royal"] .rh2[data-ry-section="analytics"]';
    const rule = cssRules(css).find((r) => r.selector === `${P} .scr button.lnk[data-variant="danger"]`);
    expect(rule?.body ?? "", "правило красной ссылки по data-variant").toMatch(/color:\s*var\(--rh-ui-crit-text\)/);
    expect(css, "хрупкое правило по соседству ссылок вернулось").not.toMatch(/button\.lnk\s*\+\s*button\.lnk/);
    // Обе ветки (ПК и телефон) ставят признак ровно на «Удалить»: снятый признак — красный тест.
    for (const file of ["./pages/settings/FunnelTab.tsx", "./components/mobile/MobileFunnel.tsx"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src, file).toMatch(/<button className="lnk" type="button" data-variant="danger" onClick=\{onDelete\}>\s*Удалить\s*<\/button>/);
      expect(src.match(/data-variant="danger"/g)?.length, file).toBe(1);
    }
  });
  // Без списков долга (KNOWN_DEBT / DISABLED_DIM_DEBT закрыты 18.11, пачка debt): каждый
  // слой, основа тоже, обязан быть чистым. Находка чинится в слое, а не вписывается сюда.
  it.each(lookFiles)("%s: смысловые кнопки и плашки не перекрашены, запас iPhone не тронут", (file) => {
    const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(semanticButtonLeaks(css)).toEqual([]);
    expect(semanticColorLeaks(css)).toEqual([]);
    expect(safeAreaOverrides(css)).toEqual([]);
  });
  it.each(sectionFiles)("%s: из своего раздела не выходит", (file) => {
    const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(siblingEscapes(css, lookSectionOf(file)!)).toEqual([]);
  });
  it.each(lookFiles)("%s: выключенная кнопка приглушена не слабее перекраски и не отзывается на мышь и палец", (file) => {
    const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(disabledDimGaps(css)).toEqual([]);
    expect(disabledReactions(css)).toEqual([]);
  });
  it("списков долга у сторожа нет: находку чинят в слое, а не прощают", () => {
    const self = readFileSync(new URL("./theme-look-royal.test.ts", import.meta.url), "utf8");
    expect(self).not.toMatch(/\b[A-Z_]*DEBT[A-Z_]*\s*:\s*Record</);
    expect(self).not.toMatch(/\?\?\s*(\[\]|null)\)/);
  });
  it("новые сторожа проверены поломкой: смысловая плашка, «живая» выключенная кнопка, слабое приглушение", () => {
    const clients = readFileSync(new URL("./theme-look-royal-clients.css", import.meta.url), "utf8");
    const objects = readFileSync(new URL("./theme-look-royal-objects.css", import.meta.url), "utf8");
    const base = readFileSync(new URL("./theme-look-royal.css", import.meta.url), "utf8");
    const C = ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"]';
    // «На проверке» (.hot) срочным красным — ровно та ошибка «Клиентов» до 18.11
    expect(semanticColorLeaks(`${clients}\n${C} .chip:is(.crit, .danger, .hot) { background: var(--rh-ui-crit); }`))
      .toEqual([`${C} .chip:is(.crit, .danger, .hot)`]);
    expect(semanticColorLeaks(`${clients}\n${C} .dot.ok { background: var(--rh-ui-primary); }\n${C} .quiet.warn { color: var(--rh-ui-card); }`))
      .toEqual([`${C} .dot.ok`, `${C} .quiet.warn`]);
    expect(semanticColorLeaks(`${C} .chip.warn { background: var(--rh-ui-warn-soft); color: var(--rh-ui-warn); }\n${C} .quiet.crit { background: var(--rh-ui-card); }`)).toEqual([]);
    // наведение и нажатие без исключения выключенной
    expect(disabledReactions(`${base}\n:root[data-ui-look="royal"] .ry-btn:active { transform: scale(.97); }`))
      .toEqual([':root[data-ui-look="royal"] .ry-btn:active']);
    expect(disabledReactions(`${base}\n:root[data-ui-look="royal"] .ry-round:disabled { opacity: .5; }\n:root[data-ui-look="royal"] .ry-round:hover { background: red; }`))
      .toEqual([':root[data-ui-look="royal"] .ry-round:hover']);
    expect(disabledReactions(`${C} .pill:hover:not(:disabled) { background: red; }\n${C} .pill:enabled:active { transform: scale(.9); }\n${C} .row:hover { background: red; }`)).toEqual([]);
    // приглушение без веса id снова слабее перекраски — долг вернулся бы
    for (const css of [clients, objects]) {
      const weak = css.replace(/:not\(#ry-dim\)/g, "");
      expect(weak).not.toBe(css);
      expect(disabledDimGaps(weak)).not.toEqual([]);
      expect(disabledDimGaps(css)).toEqual([]);
    }
  });
  it("сторож выключенной кнопки проверен поломкой (без правила приглушения — красный)", () => {
    const team = readFileSync(new URL("./theme-look-royal-team.css", import.meta.url), "utf8");
    const broken = team.replace(/\/\* Выключенная кнопка[\s\S]*?\}\n/, "");
    expect(broken).not.toBe(team);
    expect(disabledDimGaps(broken)).not.toEqual([]);
    // и правило слабее перекраски не засчитывается
    const weak = ':root[data-ui-look="royal"] .pill:not(.ghost):not(.danger) { background: red; }\n:root[data-ui-look="royal"] .pill:disabled { opacity: .5; }';
    expect(disabledDimGaps(weak)).toEqual([':root[data-ui-look="royal"] .pill:not(.ghost):not(.danger)']);
    // ревью PR 286: правило с весом id тяжелее всего, но покрывает только свой список кнопок
    const chats = readFileSync(new URL("./theme-look-royal-chats.css", import.meta.url), "utf8");
    const H = ':root[data-ui-look="royal"] .ry-chats[data-ry-section="chats"]';
    expect(disabledDimGaps(`${chats}\n${H} .ry-zzz button { background: var(--rh-ui-primary); }`)).toEqual([]);
    const narrow = chats.replace(":is(.pill, .rh-btn, .ry-btn, button):is(:disabled, [disabled], [aria-disabled=\"true\"]):not(#ry-dim)", ":is(.pill, .rh-btn):is(:disabled, [disabled], [aria-disabled=\"true\"]):not(#ry-dim)");
    expect(narrow).not.toBe(chats);
    expect(disabledDimGaps(`${narrow}\n${H} .ry-zzz button { background: var(--rh-ui-primary); }`)).toContain(`${H} .ry-zzz button`);
    // своя кнопка слоя (класс со своим :disabled) — тоже тип цели
    expect(disabledDimGaps(`${H} .ry-zzz-btn:disabled { color: grey; }\n${H} .ry-zzz-btn { background: var(--rh-ui-primary); }`)).toEqual([`${H} .ry-zzz-btn`]);
    // узкое правило приглушения не покрывает кнопку в другом месте раздела
    expect(disabledDimGaps(`${H} .ry-menu > button:disabled { opacity: .5; }\n${H} .ry-zzz button { background: var(--rh-ui-primary); }`)).toEqual([`${H} .ry-zzz button`]);
    // «один к одному», как в слое team, — покрыто
    expect(disabledDimGaps(`${H} .ry-zzz button { background: var(--rh-ui-primary); }\n${H} .ry-zzz button:is(:disabled, [disabled]) { opacity: .5; }`)).toEqual([]);
    expect(specificity(':root[data-ui-look="royal"] .a:where(.b, .c) > :is(.d, #e)')).toEqual([1, 3, 0]);
  });
  it("сторожа проверены поломкой", () => {
    const css = readFileSync(new URL("./theme-look-royal-objects.css", import.meta.url), "utf8");
    const P = ':root[data-ui-look="royal"] .rh2[data-ry-section="objects"]';
    const leaks = (extra: string) => semanticButtonLeaks(`${css}\n${extra}`);
    expect(unscopedSelectors(`${css}\n:root[data-ui-look="royal"] .rh2 .sheet .pill { color: red; }`, "objects"))
      .toEqual([':root[data-ui-look="royal"] .rh2 .sheet .pill']);
    // (а) смысловой вариант токеном чужого смысла
    expect(leaks(`${P} .sheet .pill.danger { background: var(--rh-ui-primary); }`)).toEqual([`${P} .sheet .pill.danger`]);
    expect(leaks(`${P} .sheet .pill.danger { background: var(--rh-ui-crit); color: var(--rh-ui-crit-fg); }`)).toEqual([]);
    // (б) вариант через :is, неполное исключение, голый button в шторке, общий .pill
    expect(leaks(`${P} :is(.pill):is(.danger, .ghost) { background: var(--rh-ui-primary); }`)).toEqual([`${P} :is(.pill):is(.danger, .ghost)`]);
    expect(leaks(`${P} .pill:not(:is(.danger)) { background: blue; }`)).toEqual([`${P} .pill:not(:is(.danger))`]);
    expect(leaks(`${P} .sheet .sheet-f button { background: var(--rh-ui-primary); }`)).toEqual([`${P} .sheet .sheet-f button`]);
    expect(leaks(`${P} .card .pill { background: blue; }`)).toEqual([`${P} .card .pill`]);
    // (в) обнуление отступа шторки без настоящего env в том же правиле
    const safe = (extra: string) => safeAreaOverrides(`${css}\n${extra}`);
    expect(safe(`${P} .sheet .sheet-f { padding: 0 !important; }`)).toEqual([`${P} .sheet .sheet-f`]);
    expect(safe(`${P} .sheet .sheet-b { padding-block: 0; }`)).toEqual([`${P} .sheet .sheet-b`]);
    expect(safe(`@media (max-width: 1px) { ${P} .sheet.bottom .sheet-f { padding-bottom: calc(0px * env(safe-area-inset-bottom)); } }`))
      .toEqual([`${P} .sheet.bottom .sheet-f`]);
    expect(safe(`${P} .sheet .sheet-f { padding: 0; padding-bottom: calc(16px + env(safe-area-inset-bottom)); }`)).toEqual([]);
    // (г) соседний комбинатор сразу после метки
    expect(siblingEscapes(`${css}\n:root[data-ui-look="royal"] [data-ry-section="objects"] ~ .x { color: red; }\n${P} + .rh2 .pill { color: red; }`, "objects"))
      .toEqual([':root[data-ui-look="royal"] [data-ry-section="objects"] ~ .x', `${P} + .rh2 .pill`]);
  });
});
