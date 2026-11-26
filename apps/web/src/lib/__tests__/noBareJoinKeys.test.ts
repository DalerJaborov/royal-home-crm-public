import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Клик-аудит 26.11.2026, вкладка «Каналы связи»: две соседние настройки «сбрасывались» ключом
 * `key={список.join("\n")}`. Пока оба списка пусты, ключ у обоих — пустая строка: React
 * ругался «two children with the same key» и мог показать один блок дважды или не показать вовсе.
 *
 * Класс: ключ, собранный из содержимого списка (`.join(...)`), без постоянной приставки. Две такие
 * соседние строки сталкиваются, когда содержимое одинаково, чаще всего — пусто.
 * Правило: ключ из `.join(` пишется шаблоном с приставкой — key={`имя:${...join(...)}`}.
 */
const SRC = join(__dirname, "..", "..");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (full.endsWith(".tsx") && !full.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

/** key={...} без обратной кавычки в начале, внутри которого есть `.join(`. */
const BARE_JOIN_KEY = /key=\{(?!`)[^{}]*\.join\(/;

describe("ключи списков из .join() — с приставкой", () => {
  it("в экранах нет голого key={….join(…)}", () => {
    const bad: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (BARE_JOIN_KEY.test(line)) bad.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("сторож видит нарушение (проверка самого сторожа)", () => {
    expect(BARE_JOIN_KEY.test('<A key={(list ?? []).join("\\n")} />')).toBe(true);
    expect(BARE_JOIN_KEY.test('<A key={`fb:${(list ?? []).join("\\n")}`} />')).toBe(false);
  });
});
