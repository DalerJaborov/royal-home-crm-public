import { describe, expect, it } from "vitest";
import { addBusinessDays, isDushanbeWeekend } from "../src/lib/businessDays.js";

/** Резерв объекта на сделке (Путь покупателя) — 3 РАБОЧИХ дня, суббота и
 *  воскресенье не считаются. Проверяем чистую функцию расчёта. */

describe("isDushanbeWeekend", () => {
  it("суббота и воскресенье — выходные", () => {
    // 2026-08-08 — суббота, 2026-08-09 — воскресенье (UTC, но Душанбе UTC+5 не сдвигает день на этих датах в полдень UTC).
    expect(isDushanbeWeekend(new Date("2026-08-08T06:00:00Z"))).toBe(true);
    expect(isDushanbeWeekend(new Date("2026-08-09T06:00:00Z"))).toBe(true);
  });

  it("будни — не выходные", () => {
    expect(isDushanbeWeekend(new Date("2026-08-05T06:00:00Z"))).toBe(false); // среда
    expect(isDushanbeWeekend(new Date("2026-08-07T06:00:00Z"))).toBe(false); // пятница
  });
});

describe("addBusinessDays", () => {
  it("без выходных на пути — просто N суток", () => {
    // Понедельник + 3 рабочих дня = четверг (вт, ср, чт — все будни).
    const from = new Date("2026-08-03T10:00:00Z"); // понедельник
    const result = addBusinessDays(from, 3);
    expect(result.getUTCDay()).toBe(4); // четверг
    expect(result.toISOString()).toBe("2026-08-06T10:00:00.000Z");
  });

  it("пятница + 3 рабочих дня перепрыгивает выходные — попадает на среду", () => {
    // Пятница → пн(1), вт(2), ср(3) — сб/вс пропущены без счёта.
    const from = new Date("2026-08-07T10:00:00Z"); // пятница
    const result = addBusinessDays(from, 3);
    expect(result.getUTCDay()).toBe(3); // среда
    expect(result.toISOString()).toBe("2026-08-12T10:00:00.000Z");
  });

  it("время суток сохраняется — не обнуляется до полуночи", () => {
    const from = new Date("2026-08-03T14:37:00Z");
    const result = addBusinessDays(from, 1);
    expect(result.getUTCHours()).toBe(14);
    expect(result.getUTCMinutes()).toBe(37);
  });
});
