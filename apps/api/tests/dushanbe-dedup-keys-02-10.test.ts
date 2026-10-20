import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ф12 (аудит фона 02.10.2026): ключи «раз в день / раз в месяц» считались по
 * UTC или по часам процесса. Контейнер живёт в UTC, Душанбе — UTC+5: с 00:00
 * до 05:00 по Душанбе ключ принадлежит прошлым суткам (а первого числа —
 * прошлому месяцу). Награда «клиент выведен из светофора» за новый месяц молча
 * подавлялась как уже выданная, утренний пуш склеивался со вчерашним.
 *
 * Правило проекта (CLAUDE.md): границы суток и месяцев — только по Душанбе.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const FILES = [
  "lib/inactiveTrafficLight.ts",
  "lib/duplicateReview.ts",
  "lib/clientTrashAnomalyAlarm.ts",
  "lib/absenceReturn.ts",
  "lib/lostInactiveTrashSweep.ts",
];
const UTC_KEY = [/now\.toISOString\(\)\.slice\(0,\s*(?:7|10)\)/, /now\.getUTC(?:FullYear|Month|Date)\(\)/, /now\.toDateString\(\)/];

describe("ключи дедупа по суткам и месяцам — по Душанбе", () => {
  it("в файлах фона нет ключей по UTC и по часам процесса", () => {
    const found: string[] = [];
    for (const file of FILES) {
      const lines = fs.readFileSync(path.join(SRC, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (UTC_KEY.some((re) => re.test(line))) found.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("02.10 в 01:00 по Душанбе (= 01.10 20:00 UTC) — ключ месяца и суток уже октябрьский", async () => {
    const { dushanbeDayKey } = await import("@royal-home/shared");
    const at = new Date("2026-09-30T20:00:00.000Z"); // 01.10 01:00 по Душанбе
    expect(dushanbeDayKey(at)).toBe("2026-10-01");
    expect(dushanbeDayKey(at).slice(0, 7)).toBe("2026-10");
    expect(at.toISOString().slice(0, 7)).toBe("2026-09");
  });
});
