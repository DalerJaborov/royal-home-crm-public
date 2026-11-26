import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * АУДИТ ВИДА 26.11.2026, пачка 2 — зоны нажатия, зазоры, переполнение. Сторож держит итоги замера на стенде:
 *   1. «Источники заявок» на 320: строка «Показаны 6 из 7 каналов. Показать ещё» давала горизонтальный скролл страницы
 *      (`.state` — flex в одну строку, текст кнопки с nowrap вылезал за край);
 *   2. чип «Проверка / Задержка» на «Объектах»: вид 32 px, зона нажатия 44 (невидимое продолжение);
 *   3. ряд областей в шторке поиска не сжимается до текста, а листается;
 *   4. календарь на 320: ячейки шире (внутренний отступ карточки 8, зазор 2).
 * Ссылка-имя в строке клиента и чекбокс карточки объекта — НЕ дефекты: первая растянута на всю строку (::after inset 0),
 * второй лежит внутри подписи 44×44.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (f: string) => strip(readFileSync(new URL(f, import.meta.url), "utf8"));

describe("аудит вида 26.11 — пачка 2", () => {
  it("«Источники»: строка состояния переносится, кнопка-ссылка не сжимается", () => {
    const css = read("./theme-look-royal-analytics.css");
    expect(css).toMatch(/\.scr \.state \{ flex-wrap: wrap; \}/);
    expect(css).toMatch(/\.scr \.state > :is\(\.lnk, button\.lk\) \{ flex: none; max-width: 100%; \}/);
  });

  it("чип «Проверка»: зона нажатия 44 при виде 32", () => {
    const css = read("./theme-look-royal-objects.css");
    expect(css).toMatch(/\.ry-objects-pending::after \{ content: ""; position: absolute; inset: -6px -2px; \}/);
    expect(css).toMatch(/\.ry-objects-pending \{ position: relative; \}/);
  });

  it("шторка поиска: ряд областей листается, кнопки не сжимаются", () => {
    const css = read("./theme-look-royal.css");
    expect(css).toMatch(/\.sheet-b > \.hscroll > \.seg \{ flex-wrap: nowrap; width: max-content; max-width: none; \}/);
    expect(css).toMatch(/\.sheet-b > \.hscroll > \.seg > button \{ flex: none; \}/);
  });

  it("календарь на узком экране: отступ 8 и зазор 2", () => {
    const css = read("./theme-look-royal-calendar.css");
    expect(css).toMatch(/@media \(max-width: 359\.98px\) \{[^}]*\.mh \.card:has\(> \.cal\) \{ padding-inline: 8px; \}/);
    expect(css).toMatch(/\.mh \.card > \.cal \{ gap: 2px; \}/);
  });
});
