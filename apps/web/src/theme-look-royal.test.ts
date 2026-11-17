import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/** Все слои «Нового вида»: основа и файлы разделов (theme-look-royal-<раздел>.css). */
const LAYER_FILES = readdirSync(fileURLToPath(new URL(".", import.meta.url)))
  .filter((name) => /^theme-look-royal(-[a-z0-9-]+)?\.css$/.test(name))
  .sort();

describe("theme-look-royal*.css", () => {
  const css = readFileSync(new URL("./theme-look-royal.css", import.meta.url), "utf8");
  it("finds the base layer and every section layer", () => {
    expect(LAYER_FILES).toContain("theme-look-royal.css");
    expect(LAYER_FILES).toContain("theme-look-royal-chats.css");
  });
  it.each(LAYER_FILES)("%s: every rule is scoped to :root[data-ui-look=\"royal\"]", (file) => {
    expect(unscopedSelectors(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"))).toEqual([]);
  });
  it("the guard really catches an unscoped rule (сторож проверен поломкой)", () => {
    expect(unscopedSelectors(`${css}\n.clean-tab { color: red; }\n@media (min-width: 1px) { body, :root[data-ui-look="royal"] a { color: red; } }`))
      .toEqual([".clean-tab", "body"]);
    const atRules = `\n@font-face { font-family: X; src: url(x.woff2); }\n@layer base { :root[data-ui-look="royal"] a { color: red; } }\n@keyframes spin { to { opacity: 0; } }`;
    expect(unscopedSelectors(`${css}${atRules}`)).toEqual(["@font-face", "@layer base", "@keyframes spin"]);
  });
  it("is imported after every other theme layer; section layers follow the base", () => {
    const index = readFileSync(new URL("./index.css", import.meta.url), "utf8");
    const imports = [...index.matchAll(/@import '\.\/(theme-[^']+\.css)'/g)].map((m) => m[1]);
    const base = imports.indexOf("theme-look-royal.css");
    expect(base).toBeGreaterThanOrEqual(0);
    // После основы — только слои разделов нового вида, и каждый файл слоя подключён.
    expect(imports.slice(base + 1).every((name) => /^theme-look-royal-[a-z0-9-]+\.css$/.test(name))).toBe(true);
    expect([...imports.slice(base)].sort()).toEqual(LAYER_FILES);
  });
  it("the typeset generator skips every layer file (own 13+ scale)", () => {
    const gen = readFileSync(new URL("../../../scripts/gen-typeset.mjs", import.meta.url), "utf8");
    const skip = gen.match(/const OWN_SCALE = (\/.+\/);/);
    expect(skip, "gen-typeset.mjs must skip theme-look-royal*.css by pattern").not.toBeNull();
    const pattern = new Function(`return ${skip![1]}`)() as RegExp;
    for (const file of LAYER_FILES) expect(pattern.test(file), file).toBe(true);
    expect(pattern.test("theme-2026-clean.css")).toBe(false);
  });
});
