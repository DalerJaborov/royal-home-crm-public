import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anchorOutsideGrid, localDayKey, shiftedAnchor, weekDays } from "../calendarWeek";

/** Аудит 04.10.2026, WEB-PAGES19: «Неделя» показывала неделю первоначального месяца, а не выбранного дня. */
const keys = (days: Date[]) => days.map(localDayKey);

describe("неделя календаря от выбранного дня", () => {
  const viewDate = new Date(2026, 9, 4, 12); // 4 октября: экран открыт на этом месяце

  it("выбран 20 октября: неделя 19-25 октября, а не 28 сентября - 4 октября", () => {
    const days = weekDays({ mode: "day", key: "2026-10-20" }, viewDate);
    expect(localDayKey(days[0])).toBe("2026-10-19");
    expect(localDayKey(days[6])).toBe("2026-10-25");
  });

  it("режим «просрочено» дня не выбирает: неделя от viewDate", () => {
    const days = weekDays({ mode: "overdue" }, viewDate);
    expect(keys(days)).toEqual([
      "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    ]);
  });

  it("сдвиг на следующую неделю идёт через границу месяца", () => {
    const next = shiftedAnchor({ mode: "day", key: "2026-10-28" }, viewDate, 1);
    expect(localDayKey(next)).toBe("2026-11-04");
    expect(keys(weekDays({ mode: "day", key: localDayKey(next) }, viewDate))[0]).toBe("2026-11-02");
    const prev = shiftedAnchor({ mode: "day", key: "2026-10-02" }, viewDate, -1);
    expect(localDayKey(prev)).toBe("2026-09-25");
  });

  it("якорь за пределами сетки месяца требует переключить месяц", () => {
    // сетка октября 2026: с 28 сентября по 8 ноября (42 дня)
    const first = new Date(2026, 8, 28);
    const last = new Date(2026, 10, 8);
    expect(anchorOutsideGrid(new Date(2026, 10, 8, 12), first, last)).toBe(false);
    expect(anchorOutsideGrid(new Date(2026, 8, 28, 12), first, last)).toBe(false);
    expect(anchorOutsideGrid(new Date(2026, 10, 9, 12), first, last)).toBe(true);
    expect(anchorOutsideGrid(new Date(2026, 8, 27, 12), first, last)).toBe(true);
  });
});

describe("Calendar", () => {
  const src = readFileSync(fileURLToPath(new URL("../../pages/Calendar.tsx", import.meta.url)), "utf8");
  it("строит неделю от выбранного дня и даёт навигацию по неделям на обоих обликах", () => {
    expect(src).toContain("weekDays(selected, viewDate)");
    expect(src.match(/<WeekNav/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
