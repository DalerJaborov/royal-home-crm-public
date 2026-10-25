import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ЗОНЫ НАЖАТИЯ НА ТЕЛЕФОНЕ ≥ 44 PX (перепись экранов 24.10.2026, зона F2).
 *
 * Невидимые накладки темы (`inset:-Npx`) недобирали до 44: рамка 1px не входит в
 * накладку (40px → 42), лента с `overflow-x:auto` резала накладку (`.lane`), а у
 * вкладок раздела (`.seg-ai`, ScreenTabs) накладки не было вовсе. Исправление живёт
 * в `theme-2026-brand.css` (негенерируемый файл, подключён после тем): общий токен
 * `--tap-pad` и правила под `@media (max-width: 819px)`. CSS в jsdom не считается —
 * тест читает исходник и сторожит, что правила на месте (образец —
 * `brandCssOverrides.test.ts`).
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const brand = fs.readFileSync(path.join(SRC, "theme-2026-brand.css"), "utf8");

/** Тело блока `@media (max-width: 819px) { … }`, объявленного в разделе зон нажатия. */
function phoneBlock(): string {
  const marker = brand.indexOf("ЗОНЫ НАЖАТИЯ НА ТЕЛЕФОНЕ");
  expect(marker).toBeGreaterThan(-1);
  const start = brand.indexOf("@media (max-width: 819px) {", marker);
  expect(start).toBeGreaterThan(-1);
  return brand.slice(start);
}

describe("theme-2026-brand.css — зоны нажатия 44 px на телефоне", () => {
  it("токен --tap-pad добирает до 44 по размеру самого элемента", () => {
    expect(brand).toMatch(/--tap-pad:\s*min\(0px,\s*calc\(\(100% - 44px\) \/ 2\)\)/);
  });

  it("кнопки шапки: накладка .sh-btn::after и минимум 44 у «Профиль и выход»", () => {
    const css = phoneBlock();
    expect(css).toMatch(/html \.sh-btn::after\s*\{[^}]*inset:\s*var\(--tap-pad\)/);
    expect(css).toMatch(/\[data-topbar-me\] button\[aria-label="Профиль и выход"\][^{]*\{[^}]*min-height:\s*44px/);
  });

  it("вкладки и фильтры rh2: накладка с учётом рамки", () => {
    expect(phoneBlock()).toMatch(
      /\.rh2 \.scr \.seg\.rh-tabs button::after,\s*\.rh2 \.scr \.rh-filters button::after\s*\{[^}]*inset:\s*var\(--tap-pad\) 0/,
    );
  });

  it("вкладки раздела ScreenTabs (.seg-ai): накладка и вертикальный запас ленты", () => {
    const css = phoneBlock();
    expect(css).toMatch(/\.rh2 \.seg-ai :is\(a, button\)\[data-f\]::before\s*\{[^}]*inset:\s*var\(--tap-pad\) 0/);
    expect(css).toMatch(/html:not\(\[data-shell="clean"\]\) \.rh2 \.seg-ai\s*\{[^}]*padding-block:\s*4px/);
  });

  it("чипы MhList (.fchips, .lane .f) используют --tap-pad, лента .lane не режет накладку", () => {
    const css = phoneBlock();
    expect(css).toMatch(/\.rh2 \.mh \.fchips button::before,\s*\.rh2 \.mh \.lane \.f::before[^{]*\{[^}]*inset:\s*var\(--tap-pad\) 0/);
    expect(css).toMatch(/\.rh2 \.mh \.lane:not\(\.lane-sticky\)\s*\{[^}]*padding-block:\s*5px/);
  });

  it("растянутая ссылка строки .rh-row-link не затронута правилами зон нажатия", () => {
    expect(phoneBlock()).not.toMatch(/rh-row-link|a\.lk/);
  });
});
