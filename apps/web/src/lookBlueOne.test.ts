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

/**
 * 27.11.2026 (пачка shell2, задание владельца «акцент как в макете»): синий «Нового вида» — синий макета
 * #2c66f2, в обеих темах (белый текст 4,9:1). Решение «синий один» держится так: в слое «Нового вида»
 * нет ни прежнего #1d5fe0, ни #255ef5, а все старые синие (заливка чистой оболочки, `--rgb-accent`,
 * `--pill` темы, `--acc` мастера, «Да» вопроса о показе) под этим видом сводятся к `--rh-ui-primary`.
 * Прежний вид (без признака) не меняется ни на пиксель: там по-прежнему #1d5fe0.
 */
describe("один синий акцент", () => {
  it("«Новый вид» берёт синий макета #2c66f2 — днём и ночью, и только его", () => {
    const css = read("./theme-look-royal.css");
    expect(css.match(/--rh-ui-primary:\s*(#[0-9a-f]{6})/gi)?.map((d) => d.split(/:\s*/)[1].toLowerCase())).toEqual(["#2c66f2", "#2c66f2"]);
    expect(css.match(/--rh-ui-solid:\s*(#[0-9a-f]{6})/gi)?.map((d) => d.split(/:\s*/)[1].toLowerCase())).toEqual(["#2c66f2", "#2c66f2"]);
    expect(css).toMatch(/--rh-ui-primary-rgb:\s*44 102 242;/);
    expect(css).not.toMatch(/#1d5fe0|#255ef5|#2f6bf0|#2a5fd9/i);
  });
  it("под «Новым видом» старые синие сведены к синему макета", () => {
    const css = read("./theme-look-royal.css");
    expect(css).toMatch(/:root\[data-ui-look="royal"\]\[data-shell\] \{ --clean-primary-fill: var\(--rh-ui-primary\);/);
    expect(css).toMatch(/:root\[data-ui-look="royal"\]:not\(\[data-theme="royal-home-2026-night"\]\) \{ --rgb-accent: var\(--rh-ui-primary-rgb\);/);
    expect(css).toMatch(/:root\[data-ui-look="royal"\] \.rh2 \.mh \{ --pill: var\(--rh-ui-primary\);/);
    expect(css).toMatch(/:root\[data-ui-look="royal"\] \.sq-card button\.sq-btn\.sq-btn-primary \{ background: var\(--rh-ui-primary\);/);
  });
  it("прежний вид (чистая оболочка без признака) и плашка обновления — прежний синий #1d5fe0", () => {
    expect(read("./theme-2026-clean.css")).toMatch(/--clean-primary-fill:\s*#1d5fe0/);
    expect(read("./components/updateBanner.css")).toContain("#1d5fe0");
  });
  it("счётчик в кнопке среза наследует цвет кнопки (на выбранной светло-синей вкладке не пропадает)", () => {
    expect(read("./theme-look-royal.css")).toMatch(
      /\[data-ui-look="royal"\]\[data-ui-look\] :is\(\.ry-seg, \.ry-tabs, \.seg\) > [^{]*\.n\s*\{[^}]*color:\s*inherit;\s*opacity:\s*1/,
    );
  });
  it("двойники не вернулись: в прежнем виде нет синего макета и старого #255ef5", () => {
    for (const f of ["./theme-2026-clean.css", "./components/updateBanner.css"]) {
      expect(read(f)).not.toMatch(/#2c66f2|#255ef5/i);
    }
  });
});
