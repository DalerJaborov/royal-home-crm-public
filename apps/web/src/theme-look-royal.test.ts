import { readFileSync } from "node:fs";
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

describe("theme-look-royal.css", () => {
  const css = readFileSync(new URL("./theme-look-royal.css", import.meta.url), "utf8");
  it("every rule is scoped to :root[data-ui-look=\"royal\"]", () => {
    expect(unscopedSelectors(css)).toEqual([]);
  });
  it("the guard really catches an unscoped rule (сторож проверен поломкой)", () => {
    expect(unscopedSelectors(`${css}\n.clean-tab { color: red; }\n@media (min-width: 1px) { body, :root[data-ui-look="royal"] a { color: red; } }`))
      .toEqual([".clean-tab", "body"]);
    const atRules = `\n@font-face { font-family: X; src: url(x.woff2); }\n@layer base { :root[data-ui-look="royal"] a { color: red; } }\n@keyframes spin { to { opacity: 0; } }`;
    expect(unscopedSelectors(`${css}${atRules}`)).toEqual(["@font-face", "@layer base", "@keyframes spin"]);
  });
  it("is imported after every other theme layer", () => {
    const index = readFileSync(new URL("./index.css", import.meta.url), "utf8");
    const imports = [...index.matchAll(/@import '\.\/(theme-[^']+\.css)'/g)].map((m) => m[1]);
    expect(imports.at(-1)).toBe("theme-look-royal.css");
  });
});
