import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ЦИФРЫ «НОВОГО ВИДА» (пачка shell2, 27.11.2026, REPORT п. 8: «1 2:52», «27.1 1»). Разрыв давали табличные
 * цифры Onest, включённые всему тексту: `font-feature-settings: 'tnum'` на body (index.css) и
 * `font-variant-numeric: tabular-nums` на `.rh2`/`.clean`. Под новым видом текст — обычные цифры, числа —
 * Geist (`--rh-ui-font-num`). Сторож не даёт вернуть табличные цифры всему тексту.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const royal = strip(readFileSync(new URL("./theme-look-royal.css", import.meta.url), "utf8"));

describe("цифры нового вида", () => {
  it("body под новым видом без 'tnum', текст .rh2/.clean — обычные цифры", () => {
    const body = /:root\[data-ui-look="royal"\] body \{ font-feature-settings: ([^;]+); \}/.exec(royal)?.[1] ?? "";
    expect(body).toBeTruthy();
    expect(body).not.toMatch(/tnum/);
    expect(royal).toMatch(/:root\[data-ui-look="royal"\] \.rh2 \{ font-variant-numeric: normal; \}/);
  });
  it("числа — Geist, буквы — Onest", () => {
    expect(royal).toMatch(/--rh-ui-font-num:\s*"Geist",\s*"Onest"/);
    const fonts = strip(readFileSync(new URL("./fonts-royal-home-2026.css", import.meta.url), "utf8"));
    expect(fonts).toMatch(/font-family:\s*"Geist";[\s\S]*?url\("\/fonts\/geist-latin\.woff2"\)/);
  });
});
