import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Safari до 16.4 (macOS и iOS) не знает взгляда назад в регулярках — (?<= и (?<!.
 * Литерал с ним роняет SyntaxError на разборе ВСЕГО модуля: 19.10.2026 так CRM
 * не открывалась в Safari на MacBook — регулярка сидела в packages/shared, а он
 * грузится стартовым чанком. Код, попадающий в браузер, его не использует.
 */
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const DIRS = ["apps/web/src", "packages/shared/src"];
const LOOKBEHIND = /\(\?<[=!]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Строки кода без комментариев: в пояснениях упоминать (?<! можно. */
function codeLines(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"));
}

describe("регулярки без взгляда назад (Safari < 16.4)", () => {
  it("в браузерном коде нет (?<= и (?<!", () => {
    const offenders = DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))).flatMap((file) =>
      codeLines(readFileSync(file, "utf8"))
        .filter((line) => LOOKBEHIND.test(line))
        .map((line) => `${relative(ROOT, file)}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
