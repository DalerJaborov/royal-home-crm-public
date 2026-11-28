import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ «РАМКИ ВИДНЫ» (28.11.2026). Владелец: «в настройках и в левом меню не видны границы и кнопки».
 * Причина — токены `--rh-ui-ring` (.06) и `--rh-ui-sep` (.08) давали рамку 1,1:1 к фону, и «сильная» линия была
 * слабее обычной. Здесь токены меряются: рамка карточки/кнопки не слабее 1,5:1, поле — 3:1 (WCAG 1.4.11),
 * ring сильнее sep.
 */
const css = readFileSync(new URL("./theme-look-royal.css", import.meta.url), "utf8");

function block(startMarker: string): string {
  const i = css.indexOf(startMarker);
  expect(i, `нет блока ${startMarker}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("}", i));
}
function token(b: string, name: string): string {
  const m = b.match(new RegExp(`${name}:\s*([^;]+);`));
  expect(m, `нет токена ${name}`).not.toBeNull();
  return m![1].trim();
}
function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function lum([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** rgba(r,g,b,a) поверх фона → итоговый цвет. */
function over(rgba: string, bg: [number, number, number]): [number, number, number] {
  const m = rgba.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  expect(m, `не rgba: ${rgba}`).not.toBeNull();
  const a = Number(m![4]);
  return [1, 2, 3].map((i) => Math.round(Number(m![i]) * a + bg[i - 1] * (1 - a))) as [number, number, number];
}

const themes = [
  { name: "светлая", marker: ':root[data-ui-look="royal"] {', fieldMarker: null },
  { name: "тёмная", marker: null, fieldMarker: null },
];

describe("рамки и границы видны на обеих темах", () => {
  const light = block(':root[data-ui-look="royal"] {');
  const darkStart = css.indexOf("--rh-ui-bg: #0e1014");
  const dark = css.slice(css.lastIndexOf("{", darkStart), css.indexOf("}", darkStart));
  for (const [name, b] of [["светлая", light], ["тёмная", dark]] as const) {
    it(`${name}: рамка кнопки/карточки ≥ 1,5:1, ring сильнее sep`, () => {
      const bg = rgb(token(b, "--rh-ui-bg"));
      const card = rgb(token(b, "--rh-ui-card"));
      const ring = token(b, "--rh-ui-ring");
      const sep = token(b, "--rh-ui-sep");
      expect(ratio(over(ring, card), card), `ring ${ring} на карточке`).toBeGreaterThanOrEqual(1.5);
      expect(ratio(over(ring, bg), bg), `ring ${ring} на фоне`).toBeGreaterThanOrEqual(1.5);
      expect(ratio(over(ring, card), card)).toBeGreaterThan(ratio(over(sep, card), card));
      expect(ratio(over(sep, card), card), `sep ${sep}`).toBeGreaterThanOrEqual(1.15);
    });
  }
  it("поле: --rh-ui-field-line ≥ 3:1 к карточке, обе темы", () => {
    const fl = [...css.matchAll(/--rh-ui-field-line:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
    expect(fl.length).toBeGreaterThanOrEqual(2);
    const cards = [rgb(token(light, "--rh-ui-card")), rgb(token(dark, "--rh-ui-card"))];
    fl.slice(0, 2).forEach((c, i) => expect(ratio(rgb(c), cards[i]), c).toBeGreaterThanOrEqual(3));
  });
  it("рамка полей настроек берёт field-line, а не слабую линию", () => {
    expect(css).toMatch(/\.fld input[^{]*\{\s*border-color:\s*var\(--rh-ui-field-line\)/);
  });
});
void themes;
