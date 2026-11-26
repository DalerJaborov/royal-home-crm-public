import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ОДИН СИНИЙ И СЧЁТЧИК В СРЕЗЕ (аудит вида 26.11.2026). Решение владельца: акцент один, #1D5FE0. Замер стенда показал три
 * почти одинаковых: #2c66f2 (кнопки «Нового вида»), #255ef5 (заливка кнопок чистой оболочки), #1d5fe0 (только
 * в theme-2026-brand.css) — рядом на одном экране они читались как разные кнопки. Сторож не пускает прежние
 * значения обратно в слои светлой темы.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (f: string) => strip(readFileSync(new URL(f, import.meta.url), "utf8"));

describe("один синий акцент", () => {
  it("светлая тема «Нового вида» берёт #1d5fe0", () => {
    const css = read("./theme-look-royal.css");
    expect(css).toMatch(/--rh-ui-primary:\s*#1d5fe0/);
    expect(css).toMatch(/--rh-ui-solid:\s*#1d5fe0/);
  });
  it("чистая оболочка и плашка обновления — тот же синий", () => {
    expect(read("./theme-2026-clean.css")).toMatch(/--clean-primary-fill:\s*#1d5fe0/);
    expect(read("./components/updateBanner.css")).toContain("#1d5fe0");
  });
  it("счётчик в кнопке среза наследует цвет кнопки (на выбранной светло-синей вкладке не пропадает)", () => {
    expect(read("./theme-look-royal.css")).toMatch(
      /\[data-ui-look="royal"\]\[data-ui-look\] :is\(\.ry-seg, \.ry-tabs, \.seg\) > [^{]*\.n\s*\{[^}]*color:\s*inherit;\s*opacity:\s*1/,
    );
  });
  it("двойники не вернулись", () => {
    for (const f of ["./theme-look-royal.css", "./theme-2026-clean.css", "./components/updateBanner.css"]) {
      expect(read(f)).not.toMatch(/#2c66f2|#255ef5/i);
    }
  });
});
