import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MOBILE_UX_QUERY } from "../useMobileUx";
import { NARROW_QUERY } from "../useNarrowScreen";

/**
 * Две точки перелома оболочки (контракт 06.10.2026): телефон < 820 px, широкий
 * десктоп >= 1180 px. Число живёт в `screens` tailwind.config.js, а JS-запросы
 * хуков берут на единицу меньше. Тест ловит день, когда кто-то сдвинет одно и
 * забудет другое: тогда `md:` в разметке и признак `data-mobile-ux` на <html>
 * переключались бы на разной ширине.
 */
function screenPx(name: "md" | "lg"): number {
  const src = readFileSync(new URL("../../../tailwind.config.js", import.meta.url), "utf8");
  const m = src.match(new RegExp(`screens:\\s*\\{[^}]*\\b${name}:\\s*"(\\d+)px"`));
  if (!m) throw new Error(`screens.${name} не найден в tailwind.config.js`);
  return Number(m[1]);
}

describe("точки перелома оболочки", () => {
  it("tailwind: md = 820, lg = 1180", () => {
    expect(screenPx("md")).toBe(820);
    expect(screenPx("lg")).toBe(1180);
  });

  it("MOBILE_UX_QUERY = (md - 1) или (lg - 1) с пальцем", () => {
    const md = screenPx("md") - 1;
    const lg = screenPx("lg") - 1;
    expect(MOBILE_UX_QUERY).toBe(`(max-width: ${md}px), (max-width: ${lg}px) and (pointer: coarse)`);
  });

  it("NARROW_QUERY = (md - 1)", () => {
    expect(NARROW_QUERY).toBe(`(max-width: ${screenPx("md") - 1}px)`);
  });
});
