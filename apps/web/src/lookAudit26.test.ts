import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * АУДИТ ВИДА 26.11.2026 (владелец: «оформление на новой теме исправь, пусть всё соответствует»).
 * Сторож держит итоги первой пачки, чтобы правка темы молча не вернула дефекты:
 *   1. фильтры «Показателей компании» (select/поле даты) — со скруглением токена, а не прямые углы;
 *   2. подпись поля даты/месяца/времени оставляет место под родной значок (не наезжает на него);
 *   3. подсказка «Включите уведомления» на узком экране переносит кнопки под текст.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

describe("аудит вида 26.11 — поля и подсказки", () => {
  it("фильтры директора: скругление токеном", () => {
    const css = strip(read("./theme-look-royal-director.css"));
    expect(css).toMatch(/\.dd-filter :is\(select, input\)\s*\{[^}]*border-radius:\s*var\(--rh-r-md\)/);
  });

  it("подпись поля даты резервирует место под значок", () => {
    const src = read("./components/look/fields/RuFields.tsx");
    expect(src).toMatch(/PICKER_ICON_RESERVE\s*=\s*\d+/);
    expect(src).toMatch(/paddingRight:\s*look \? `calc\(\$\{look\.paddingRight\} \+ \$\{PICKER_ICON_RESERVE\}px\)`/);
  });

  it("подсказка уведомлений на телефоне: текст на всю строку, кнопки ниже", () => {
    const css = strip(read("./theme-2026-brand.css"));
    expect(css).toMatch(/@media \(max-width: 480px\)\s*\{[^}]*\.quiet\.notif-banner\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.quiet\.notif-banner > \.txt\s*\{[^}]*flex:\s*1 1 100%/);
    expect(read("./components/NotificationsBanner.tsx")).toContain('className="quiet notif-banner"');
  });
});
