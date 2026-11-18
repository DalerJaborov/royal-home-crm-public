import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
  it("знает основу и слои разделов «Клиенты» и «Чаты»", () => {
    expect(lookFiles).toEqual(expect.arrayContaining(["theme-look-royal.css", "theme-look-royal-clients.css", "theme-look-royal-chats.css"]));
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

/** Правила файла как пары «селектор → тело» (самые внутренние блоки, @media прозрачны). */
function cssRules(css: string): { selector: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
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

/**
 * ДОЛГ, найденный усиленным сторожем 18.11.2026 (PR #280) в уже выкаченных слоях.
 * Сторож не ослаблен: ровно эти селекторы известны и переданы владельцу пачки, любая
 * НОВАЯ находка красит прогон. Починили — убрать строку отсюда (список только убывает).
 */
const KNOWN_DEBT: Record<string, string[]> = {
  "theme-look-royal-clients.css": [
    // исключают только .danger/.gold — .crit/.warn/.ok/.hot перекрасятся
    ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"] .pill:not(.ghost):not(.soft):not(.danger):not(.gold):not(.btn-call):not(.btn-fab)',
    ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"] .pill:not(.ghost):not(.soft):not(.danger):not(.gold):not(.btn-call):not(.btn-fab):hover:not(:disabled)',
    ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"] .pill:is(.ghost, .soft):not(.danger)',
    ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"] .pill:is(.ghost, .soft):not(.danger):hover:not(:disabled)',
    ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"] .scr.clean-client-detail .clean-client-header .acts .pill:not(.ghost) ~ .pill:not(.ghost):not(.soft):not(.danger):not(.gold)',
    ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"] .scr.clean-client-detail .clean-client-header .acts .pill:not(.ghost) ~ * .pill:not(.ghost):not(.soft):not(.danger):not(.gold)',
    // голый button в шторке без исключения смысловых вариантов
    ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"] .sheet .rh-filters button',
    ':root[data-ui-look="royal"] .rh2[data-ry-section="clients"] .sheet .rh-filters button[aria-pressed="true"]',
  ],
  "theme-look-royal-chats.css": [
    // кнопка «к последнему» красится без исключения смысловых вариантов
    ':root[data-ui-look="royal"] .ry-chats[data-ry-section="chats"] .clean-jump-latest .pill',
  ],
};

describe("слои разделов: смысловые кнопки, запас iPhone, соседи метки", () => {
  const sectionFiles = lookFiles.filter((f) => lookSectionOf(f));
  it("знает слой раздела «Объекты»", () => {
    expect(lookFiles).toContain("theme-look-royal-objects.css");
    expect(lookSectionOf("theme-look-royal-objects.css")).toBe("objects");
  });
  it.each(sectionFiles)("%s: смысловые кнопки не перекрашены, запас iPhone не тронут, из раздела не выходит", (file) => {
    const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(semanticButtonLeaks(css)).toEqual(KNOWN_DEBT[file] ?? []);
    expect(safeAreaOverrides(css)).toEqual([]);
    expect(siblingEscapes(css, lookSectionOf(file)!)).toEqual([]);
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
