import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ночная проверка 24.09.2026, находка №7: телефон `/calendar` — «‹»,
 * «Сегодня», «›» внахлёст. Причина — `MobileCalendar.tsx` рисует ряд классом
 * `wrap` внутри `.rh2 .mh` (не `.scr`), а зазор и квадратные иконки-кнопки
 * (`proto.css:2941,2695`) действуют только в `.rh2 .scr .wrap`. Починка:
 * второй класс `cal-nav` на том же ряду + правило рядом, в
 * theme-2026-mobile-shell.css (рукописный, не генерируется — правка в
 * генерируемый proto.css молча стёрлась бы при следующей синхронизации).
 *
 * Тест читает исходники — vitest здесь без jsdom, отрисовать и замерить
 * прямоугольники нечем; читаем, что разметка и правило вообще на месте.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("ряд навигации месяца на телефоне (находка №7)", () => {
  it("MobileCalendar.tsx: ряд «‹ Сегодня ›» несёт класс cal-nav", () => {
    const text = fs.readFileSync(path.join(ROOT, "components/mobile/MobileCalendar.tsx"), "utf8");
    expect(text).toMatch(/className="wrap cal-nav"/);
  });

  it("theme-2026-mobile-shell.css: .cal-nav — flex-ряд с зазором и квадратными иконками", () => {
    const css = fs.readFileSync(path.join(ROOT, "theme-2026-mobile-shell.css"), "utf8");
    const navBlock = css.match(/html\[data-mobile-ux\] \.rh2 \.mh \.cal-nav\s*\{[^}]*\}/);
    expect(navBlock).not.toBeNull();
    expect(navBlock![0]).toMatch(/display:\s*flex/);
    expect(navBlock![0]).toMatch(/gap:\s*8px/);

    const iconBlock = css.match(/html\[data-mobile-ux\] \.rh2 \.mh \.cal-nav \.pill\.icon\s*\{[^}]*\}/);
    expect(iconBlock).not.toBeNull();
    expect(iconBlock![0]).toMatch(/width:\s*44px/);
  });
});
