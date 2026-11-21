import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ «НАЗАД» (21.11.2026): шаг по истории назад — только в hooks/useGoBack.ts (решение — lib/goBack.ts).
 * Голый `navigate(-1)`, `history.back()` или `history.go(-…)` в любом другом файле снова даёт кнопку, которая
 * уводит из приложения или в чужой раздел. Комментарии не считаются.
 */
const SRC = join(__dirname, "..", "..");
const ALLOWED = new Set(["hooks/useGoBack.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const BACK = /\bnavigate\(\s*-\s*1\s*\)|\bhistory\.back\s*\(|\bhistory\.go\s*\(\s*-/;

describe("«Назад» — одна дверь", () => {
  const files = walk(SRC);
  it("сторож видит исходники (не пустой список)", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it("шаг по истории назад есть только в hooks/useGoBack.ts", () => {
    const offenders = files
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .filter((rel) => !ALLOWED.has(rel) && BACK.test(stripComments(readFileSync(join(SRC, rel), "utf8"))));
    expect(offenders).toEqual([]);
  });
  it("сама дверь на месте", () => {
    expect(BACK.test(stripComments(readFileSync(join(SRC, "hooks/useGoBack.ts"), "utf8")))).toBe(true);
  });
  it("стрелка шапки идёт через дверь, а не переходом на раздел", () => {
    const topbar = stripComments(readFileSync(join(SRC, "components/Topbar.tsx"), "utf8"));
    expect(topbar).toMatch(/useGoBack\(shellBack/);
  });
});
