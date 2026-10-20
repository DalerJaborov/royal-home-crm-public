import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * E10 глубокой проверки 02.10.2026: сводка инсайтов собиралась в 09:00 дня
 * собрания за период «до 23:59 этого дня», а следующий период начинался с
 * полуночи следующего дня. События с 09:00 до конца дня собрания (а 31-го —
 * ещё и весь следующий день) не попадали ни в одну сводку.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const { insightDigestPeriod, isInsightMeetingDay } = await import("../src/lib/insightDigestPeriod.js");

/** Момент «ДД.ММ.ГГГГ ЧЧ:ММ по Душанбе». */
const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(Date.UTC(y, m - 1, d, h - 5, min));

describe("период сводки инсайтов — без зазоров", () => {
  it("за год соседние периоды стыкуются вплотную: конец одного + 1 мс = начало следующего", () => {
    const meetings: Date[] = [];
    for (let t = at(2026, 1, 1, 0).getTime(); t < at(2027, 1, 1, 0).getTime(); t += 86_400_000) {
      const day = new Date(t + 9 * 3_600_000); // 09:00 по Душанбе этого дня
      if (isInsightMeetingDay(day)) meetings.push(day);
    }
    expect(meetings).toHaveLength(24);
    for (let i = 1; i < meetings.length; i++) {
      const prev = insightDigestPeriod(meetings[i - 1]);
      const cur = insightDigestPeriod(meetings[i]);
      expect(cur.meetingAt.getTime()).toBe(meetings[i].getTime());
      expect(cur.periodStart.getTime()).toBe(prev.periodEnd.getTime() + 1);
    }
  });

  it("сводка 15.10 в 09:00 не обещает событий после момента сборки, а 15.10 14:00 входит в следующую", () => {
    const oct15 = insightDigestPeriod(at(2026, 10, 15));
    expect(oct15.periodEnd.getTime()).toBeLessThan(at(2026, 10, 15).getTime());
    const oct30 = insightDigestPeriod(at(2026, 10, 30));
    const afternoon = at(2026, 10, 15, 14).getTime();
    expect(afternoon).toBeGreaterThanOrEqual(oct30.periodStart.getTime());
    expect(afternoon).toBeLessThanOrEqual(oct30.periodEnd.getTime());
  });

  it("31-е и февраль: 31.10 входит в период к собранию 15.11, собрание февраля — 28-го", () => {
    const nov15 = insightDigestPeriod(at(2026, 11, 15));
    expect(at(2026, 10, 31, 12).getTime()).toBeGreaterThanOrEqual(nov15.periodStart.getTime());
    expect(insightDigestPeriod(at(2027, 2, 20)).meetingAt.getTime()).toBe(at(2027, 2, 28).getTime());
    expect(insightDigestPeriod(at(2027, 3, 15)).periodStart.getTime()).toBe(at(2027, 2, 28).getTime());
  });

  it("крон и кнопка «Собрать сейчас» берут период из одной функции", () => {
    for (const file of ["cron.ts", "routes/insights.ts"]) {
      const text = fs.readFileSync(path.join(SRC, file), "utf8");
      expect(text, file).toContain("insightDigestPeriod()");
      expect(text, file).not.toMatch(/periodEnd = new Date\(Date\.UTC\(y, m, (?:15|lastDay), 23, 59, 59\)/);
    }
  });
});
