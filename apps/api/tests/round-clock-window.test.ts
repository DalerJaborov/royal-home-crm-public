import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isWithinDushanbeWindow } from "../src/lib/dushanbeTime.js";
import { closedMsBeforeDue } from "../src/services/leads/shared.js";

/**
 * «Круглые сутки» в настройках теста — это "00:00"–"24:00".
 *
 * Найдено 24.09.2026: пять файлов писали "00:00"–"23:59" и падали ОДНУ МИНУТУ
 * В СУТКИ — попасть в неё можно только полным прогоном, начатым в нужную
 * минуту, поэтому падение выглядело как поломка чужой правки. Обе функции,
 * читающие эти часы, считают 23:59:00–23:59:59 закрытым временем:
 * `closedMsBeforeDue` добавляет паузу к сроку первого звонка, а
 * `isWithinDushanbeWindow` отвечает «нерабочее время», и заявка уходит в общую
 * очередь без агента.
 *
 * Значения-ловушки:
 *   "00:00"–"23:59" — закрыта последняя минута суток, ломает обе функции;
 *   "00:00"–"00:00" — пауза нулевая, но `isWithinDushanbeWindow` читает пустое
 *                     окно как «НИКОГДА», то есть раздача лидов не случится;
 *   "00:00"–"24:00" — верно для обеих.
 */
describe("круглосуточное окно в настройках тестов", () => {
  // 18:59:30 UTC = 23:59:30 по Душанбе — та самая минута.
  const lastMinute = new Date("2026-09-24T18:59:30Z");
  const midday = new Date("2026-09-24T07:00:00Z");

  it('"00:00"–"24:00" открыто и в последнюю минуту суток, и днём', () => {
    expect(isWithinDushanbeWindow("00:00", "24:00", lastMinute)).toBe(true);
    expect(isWithinDushanbeWindow("00:00", "24:00", midday)).toBe(true);
    expect(closedMsBeforeDue(lastMinute, 15, { start: "00:00", end: "24:00" })).toBe(0);
  });

  it('"00:00"–"23:59" закрывает последнюю минуту — из-за этого и падало', () => {
    expect(isWithinDushanbeWindow("00:00", "23:59", lastMinute)).toBe(false);
    expect(closedMsBeforeDue(lastMinute, 15, { start: "00:00", end: "23:59" })).toBeGreaterThan(0);
  });

  it('"00:00"–"00:00" для раздачи лидов значит «никогда», а не «всегда»', () => {
    expect(isWithinDushanbeWindow("00:00", "00:00", midday)).toBe(false);
  });

  it('ни один тест не выставляет workHoursEnd "23:59"', () => {
    const dir = join(import.meta.dirname, ".");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts") && f !== "round-clock-window.test.ts")
      .filter((f) => /workHoursEnd:\s*"23:59"/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders, 'круглые сутки задаются "24:00", а не "23:59"').toEqual([]);
  });
});
