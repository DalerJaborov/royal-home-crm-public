import { describe, expect, it } from "vitest";
import { exactDateTime } from "../format";

describe("дата со временем не рвётся", () => {
  it("между датой и временем неразрывный пробел: «20.11 / 02:20» на две строки не ложится (вид split, К10)", () => {
    const text = exactDateTime("2026-11-20T21:20:00.000Z");
    expect(text).toMatch(/^\d{2}\.\d{2} \d{2}:\d{2}$/);
  });
});

import { formatPricePerSqm, formatWait } from "../format";

describe("число не отрывается от единицы", () => {
  it("«1 ч 23 мин», «41 минуту» и «3 дня» — неразрывными пробелами", () => {
    expect(formatWait(83)).toBe("1 ч 23 мин");
    expect(formatWait(41)).toBe("41 минуту");
    expect(formatWait(3 * 24 * 60)).toBe("3 дня");
  });
  it("цена за метр не рвётся по « / »", () => {
    expect(formatPricePerSqm(5_000_000, 100, "TJS")).not.toMatch(/ /);
    expect(formatPricePerSqm(5_000_000, 100, "TJS")).toContain(" / м²");
  });
});
