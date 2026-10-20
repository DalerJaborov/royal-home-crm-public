import { afterEach, describe, expect, it, vi } from "vitest";
import { PAUSE_OPTIONS } from "../botPauseOptions";

/**
 * «До конца дня» у паузы бота — до конца дня ПО ДУШАНБЕ (глубокая проверка
 * 02.10.2026, F16). Раньше `setHours(23, 59…)` в поясе устройства: из Стамбула
 * (UTC+3) пауза заканчивалась в 01:59 следующего дня по Душанбе.
 */
const endOfDay = PAUSE_OPTIONS.find((o) => o.label === "До конца дня")!;

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TZ;
});

describe("пауза бота «До конца дня»", () => {
  it("с устройства в Стамбуле — до 23:59 по Душанбе", () => {
    process.env.TZ = "Europe/Istanbul";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T15:00:00.000Z")); // 20:00 в Душанбе
    expect(endOfDay.minutesFromNow()).toBe(240);
  });
});
