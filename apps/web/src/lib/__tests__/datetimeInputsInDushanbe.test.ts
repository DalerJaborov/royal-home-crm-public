import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dushanbeLocalToIso, isoToDushanbeLocal } from "@royal-home/shared";

/**
 * ПОЛЕ «ДАТА И ВРЕМЯ» — В ЧАСАХ ДУШАНБЕ (глубокая проверка 02.10.2026, F5).
 *
 * Перенос показа/задачи в календаре (общий обработчик ПК и телефона) заполнял
 * поле `toLocalDateTimeInput` и отправлял `new Date(at).toISOString()` — оба в
 * поясе УСТРОЙСТВА. Владелец из Стамбула (UTC+3) видел в строке показ «16:00»,
 * в поле переноса «14:00», вписывал «16:00» — и клиенту уходило «перенесён на
 * 18:00». Правильная пара — isoToDushanbeLocal/dushanbeLocalToIso из shared.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** Известное исключение с причиной: анкеты кандидатов — зона другого исполнителя
 *  (тот же класс, время собеседования; передано в отчёте 02.10.2026). */
const KNOWN = new Set(["components/VacancyStageActions.tsx"]);

describe("поле datetime-local заполняется и читается по Душанбе", () => {
  it("ни один экран с полем «дата и время» не берёт пояс устройства", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (KNOWN.has(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (/toLocalDateTimeInput\(/.test(text) && !rel.startsWith("lib/date.ts")) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });

  it("пара переводов не зависит от пояса устройства", () => {
    const prev = process.env.TZ;
    process.env.TZ = "Europe/Istanbul";
    try {
      expect(isoToDushanbeLocal("2026-10-03T11:00:00.000Z")).toBe("2026-10-03T16:00");
      expect(new Date(dushanbeLocalToIso("2026-10-03T16:00")!).toISOString()).toBe("2026-10-03T11:00:00.000Z");
    } finally {
      process.env.TZ = prev;
    }
  });
});
