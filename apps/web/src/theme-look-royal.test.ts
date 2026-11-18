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
  it("знает основу и слой раздела «Клиенты»", () => {
    expect(lookFiles).toEqual(expect.arrayContaining(["theme-look-royal.css", "theme-look-royal-clients.css"]));
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

/**
 * Смысловые кнопки старой темы (ревью «Клиентов», 18.11): правило, красящее
 * `.pill`/`.rh-btn`, не должно перебивать `.danger` (и warn/ok/gold…) — «Удалить»,
 * «В корзину» остаются красными. Разрешено: исключение `:not(:is(.danger…` в
 * селекторе или правило, прямо называющее смысловой вариант (`.danger`, `.btn-call`…).
 */
const SEMANTIC = /\.(danger|crit|warn|ok|gold|hot|btn-call|btn-fab)\b/;

export function semanticButtonLeaks(css: string): string[] {
  return cssRules(css)
    .filter((r) => /(^|[;\s{])(background(-color)?|color)\s*:/.test(r.body))
    .flatMap((r) => splitTopLevel(r.selector))
    .filter((s) => /\.(pill|rh-btn)\b/.test(s) && !s.includes(":not(:is(.danger") && !SEMANTIC.test(s));
}

/**
 * Запас под полоску iPhone у подвала и последнего тела шторки задаёт
 * theme-royal-home-2026.css. Слой может менять отступы `.sheet-f`/`.sheet-b`, только
 * если сам же возвращает запас для `.sheet.bottom .sheet-f` и
 * `.sheet.bottom .sheet-b:last-child` (env(safe-area-inset-bottom)).
 */
export function safeAreaOverrides(css: string): string[] {
  const rules = cssRules(css);
  const restores = (target: RegExp) => rules.some((r) => target.test(r.selector) && /env\(safe-area-inset-bottom\)/.test(r.body));
  if (restores(/\.sheet\.bottom \.sheet-f\b/) && restores(/\.sheet\.bottom \.sheet-b:last-child/)) return [];
  return rules
    .filter((r) => /\.sheet-(f|b)\b/.test(r.selector) && /(^|[;\s])padding(-bottom)?\s*:/.test(r.body) && !/env\(safe-area-inset-bottom\)/.test(r.body))
    .map((r) => r.selector);
}

describe("слои разделов: смысловые кнопки и запас iPhone", () => {
  const sectionFiles = lookFiles.filter((f) => lookSectionOf(f));
  it("знает слой раздела «Объекты»", () => {
    expect(lookFiles).toContain("theme-look-royal-objects.css");
    expect(lookSectionOf("theme-look-royal-objects.css")).toBe("objects");
  });
  it.each(sectionFiles)("%s: смысловые кнопки не перекрашены, запас iPhone не тронут", (file) => {
    const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(semanticButtonLeaks(css)).toEqual([]);
    expect(safeAreaOverrides(css)).toEqual([]);
  });
  it("сторожа проверены поломкой", () => {
    const css = readFileSync(new URL("./theme-look-royal-objects.css", import.meta.url), "utf8");
    expect(unscopedSelectors(`${css}\n:root[data-ui-look="royal"] .rh2 .sheet .pill { color: red; }`, "objects"))
      .toEqual([':root[data-ui-look="royal"] .rh2 .sheet .pill']);
    expect(semanticButtonLeaks(`${css}\n:root[data-ui-look="royal"] [data-ry-section="objects"] .card .pill { background: blue; }`))
      .toEqual([':root[data-ui-look="royal"] [data-ry-section="objects"] .card .pill']);
    expect(safeAreaOverrides(`${css}\n@media (max-width: 1px) { :root[data-ui-look="royal"] .sheet[data-ry-section="objects"] .sheet-f { padding: 0; } }`))
      .toEqual([':root[data-ui-look="royal"] .sheet[data-ry-section="objects"] .sheet-f']);
  });
});
