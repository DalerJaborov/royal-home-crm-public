import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ ОБЩЕГО СПИСКА ЭКСПОРТОВ (`packages/shared/src/index.ts`, 03.10.2026).
 *
 * Каждая новая фича дописывает туда строку `export * from "./x.js";`, и параллельные
 * ветки конфликтуют в этом файле всякий раз (за один день его разводили руками восемь
 * раз, включая вложенные маркеры при слиянии «крест-накрест»). Строку защищает
 * драйвер `merge=union` в .gitattributes, а этот тест ловит то, что драйвер не поймает:
 *  - забытые маркеры конфликта, закоммиченные вместе с кодом;
 *  - одну и ту же строку дважды (union объединяет строки обеих сторон, и если обе
 *    ветки дописали одну строку по-разному расположенную, дубль мог проскочить);
 *  - строку, чей файл удалили или переименовали: сборка shared упала бы только в CI.
 * Порядок строк не проверяется — он не важен для работы.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));
const barrelPath = join(root, "packages", "shared", "src", "index.ts");
const text = readFileSync(barrelPath, "utf8");
const lines = text.split(/\r?\n/);
const exportLines = lines.map((l) => l.trim()).filter((l) => l.startsWith("export * from"));

describe("packages/shared/src/index.ts", () => {
  it("не содержит маркеров конфликта слияния", () => {
    const markers = lines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /^(<{7}|={7}|>{7}|\|{7})(\s|$)/.test(l));
    expect(markers, `маркеры конфликта в index.ts: строки ${markers.map((m) => m.n).join(", ")}`).toEqual([]);
  });

  it("каждая строка `export * from` встречается один раз", () => {
    const seen = new Set<string>();
    const dupes = exportLines.filter((l) => (seen.has(l) ? true : (seen.add(l), false)));
    expect(dupes, `повторяются: ${dupes.join(" | ")}`).toEqual([]);
  });

  it("каждая строка `export * from` имеет разобранный вид и существующую цель", () => {
    const bad: string[] = [];
    for (const line of exportLines) {
      const m = /^export \* from "\.\/([^"]+)\.js";$/.exec(line);
      if (!m) {
        bad.push(`${line} — нестандартный вид, ожидалось export * from "./x.js";`);
        continue;
      }
      const target = join(root, "packages", "shared", "src", `${m[1]}.ts`);
      if (!existsSync(target)) bad.push(`${line} — нет файла packages/shared/src/${m[1]}.ts`);
    }
    expect(bad).toEqual([]);
  });

  it("список не пуст (страж читает тот файл, а не пустоту)", () => {
    expect(exportLines.length).toBeGreaterThan(10);
  });
});
