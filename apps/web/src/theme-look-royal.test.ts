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

export function unscopedSelectors(css: string): string[] {
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

/**
 * Слои «Нового вида» по разделам (theme-look-royal-<раздел>.css, 18.11.2026)
 * проверяются тем же сторожем, что и основа: список берётся из папки, поэтому
 * новый слой попадает под проверку сам, без правки этого теста.
 */
const LAYERS = readdirSync(new URL(".", import.meta.url)).filter((name) => /^theme-look-royal(-[a-z0-9-]+)?\.css$/.test(name)).sort();

/** Имя файла слоя → метка раздела: theme-look-royal-objects.css → "objects"; основа — без метки. */
export function sectionOf(fileName: string): string | null {
  return /^theme-look-royal-([a-z0-9-]+)\.css$/.exec(fileName)?.[1] ?? null;
}

/** Правила файла как пары «селектор → тело» (самые внутренние блоки, @media прозрачны). */
function cssRules(css: string): { selector: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim(), body: m[2] }))
    .filter((r) => !/^(from|to|\d+%)/.test(r.selector) && !r.selector.startsWith("@"));
}

/**
 * Протечка в чужие разделы (класс найден ревью «Клиентов», 18.11): у слоя раздела
 * КАЖДЫЙ селектор обязан нести метку `[data-ry-section="<раздел>"]`. Её ставят
 * только экраны и шторки этого раздела, поэтому ни общие классы экранов, ни
 * порталы `body > .rh2` (уведомления, входящий лид) слой не задевают.
 */
export function unmarkedSelectors(css: string, section: string): string[] {
  const mark = `[data-ry-section="${section}"]`;
  return cssRules(css).flatMap((r) => splitTopLevel(r.selector)).filter((s) => !s.includes(mark));
}

/**
 * Смысловые кнопки старой темы: правило, красящее `.pill`/`.rh-btn`, не должно
 * перебивать `.danger` (и warn/ok/gold…) — «Удалить», «В корзину» остаются красными.
 * Разрешено: селектор с исключением `:not(:is(.danger…` или правило про саму `.danger`.
 */
export function semanticButtonLeaks(css: string): string[] {
  return cssRules(css)
    .filter((r) => /(^|[;\s{])(background(-color)?|color)\s*:/.test(r.body))
    .flatMap((r) => splitTopLevel(r.selector))
    .filter((s) => /\.(pill|rh-btn)\b/.test(s) && !s.includes(":not(:is(.danger") && !/\.danger\b/.test(s));
}

/** Запас под полоску iPhone у подвала и последнего тела шторки задаёт theme-royal-home-2026.css — не перебивать. */
export function safeAreaOverrides(css: string): string[] {
  return cssRules(css)
    .filter((r) => /\.sheet-(f|b)\b/.test(r.selector) && /(^|[;\s])padding(-bottom)?\s*:/.test(r.body))
    .map((r) => r.selector);
}

describe("слои разделов «Нового вида»", () => {
  const sections = LAYERS.filter((name) => sectionOf(name));
  it.each(sections)("%s: каждый селектор с меткой своего раздела", (name) => {
    const css = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    expect(unmarkedSelectors(css, sectionOf(name)!)).toEqual([]);
  });
  it.each(sections)("%s: смысловые кнопки не перекрашены, запас iPhone не тронут", (name) => {
    const css = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    expect(semanticButtonLeaks(css)).toEqual([]);
    expect(safeAreaOverrides(css)).toEqual([]);
  });
  it("сторожа раздела проверены поломкой", () => {
    const css = readFileSync(new URL("./theme-look-royal-objects.css", import.meta.url), "utf8");
    expect(sectionOf("theme-look-royal-objects.css")).toBe("objects");
    expect(sectionOf("theme-look-royal.css")).toBeNull();
    expect(unmarkedSelectors(`${css}\n:root[data-ui-look="royal"] .rh2 .sheet .pill { color: red; }`, "objects"))
      .toEqual([':root[data-ui-look="royal"] .rh2 .sheet .pill']);
    expect(semanticButtonLeaks(`${css}\n:root[data-ui-look="royal"] [data-ry-section="objects"] .card .pill { background: blue; }`))
      .toEqual([':root[data-ui-look="royal"] [data-ry-section="objects"] .card .pill']);
    expect(safeAreaOverrides(`${css}\n@media (max-width: 1px) { :root[data-ui-look="royal"] .sheet[data-ry-section="objects"] .sheet-f { padding: 0; } }`))
      .toEqual([':root[data-ui-look="royal"] .sheet[data-ry-section="objects"] .sheet-f']);
  });
});

describe("theme-look-royal*.css", () => {
  const css = readFileSync(new URL("./theme-look-royal.css", import.meta.url), "utf8");
  it("finds the base layer and the section layers", () => {
    expect(LAYERS).toContain("theme-look-royal.css");
    expect(LAYERS).toContain("theme-look-royal-objects.css");
  });
  it.each(LAYERS)("every rule of %s is scoped to :root[data-ui-look=\"royal\"]", (name) => {
    expect(unscopedSelectors(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"))).toEqual([]);
  });
  it("the guard really catches an unscoped rule (сторож проверен поломкой)", () => {
    expect(unscopedSelectors(`${css}
.clean-tab { color: red; }
@media (min-width: 1px) { body, :root[data-ui-look="royal"] a { color: red; } }`))
      .toEqual([".clean-tab", "body"]);
    const atRules = `
@font-face { font-family: X; src: url(x.woff2); }
@layer base { :root[data-ui-look="royal"] a { color: red; } }
@keyframes spin { to { opacity: 0; } }`;
    expect(unscopedSelectors(`${css}${atRules}`)).toEqual(["@font-face", "@layer base", "@keyframes spin"]);
  });
  it("base first, then section layers, after every other theme layer; each layer imported", () => {
    const index = readFileSync(new URL("./index.css", import.meta.url), "utf8");
    const imports = [...index.matchAll(/@import '\.\/(theme-[^']+\.css)'/g)].map((m) => m[1]);
    const firstLook = imports.indexOf("theme-look-royal.css");
    expect(firstLook).toBeGreaterThan(-1);
    const tail = imports.slice(firstLook);
    expect(tail.every((name) => LAYERS.includes(name))).toBe(true);
    expect([...tail].sort()).toEqual(LAYERS);
  });
});
