import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "../chunkLoadError";

/**
 * ЛЕНИВАЯ ЗАГРУЗКА — ТОЛЬКО ЧЕРЕЗ lib/lazyWithReload.ts (17.11.2026, аудит F2-6).
 *
 * Правило «только lazyWithReload» было записано комментарием в App.tsx, но ничем
 * не сторожилось — и пять поверхностей оболочки («+», указатель загрузок, панель
 * ИИ, поиск, шторка проверки объекта) грузились голым `lazy`. После выката кусок
 * со старым хешем уже вычищен из кэша, `lazy` бросает, и экран целиком уходил в
 * «Что-то пошло не так» вместо перезагрузки под новую сборку.
 *
 * Сторож — тест, а не правило eslint: конфиг линтера в этом репозитории
 * защищён от правок хуком. Тест идёт в `npm run test:web`, то есть в precheck и CI.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOOR = path.join("lib", "lazyWithReload.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const RAW_LAZY = [/import\s*\{[^}]*\blazy\b[^}]*\}\s*from\s*["']react["']/, /\bReact\.lazy\s*\(/];

function usesRawLazy(source: string): boolean {
  return RAW_LAZY.some((re) => re.test(source));
}

describe("ленивая загрузка — одна дверь", () => {
  it("находит файлы исходников (иначе сторож проверяет пустоту)", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
  });

  it("никто, кроме lazyWithReload, не зовёт React.lazy напрямую", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => path.relative(SRC, file) !== DOOR)
      .filter((file) => usesRawLazy(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("сторож краснеет на голом lazy (поломка нарочно)", () => {
    expect(usesRawLazy(`import { lazy, Suspense } from "react";`)).toBe(true);
    expect(usesRawLazy(`const X = React.lazy(() => import("./X"));`)).toBe(true);
    expect(usesRawLazy(`import { Suspense } from "react";\nimport { lazyWithReload } from "../lib/lazyWithReload";`)).toBe(false);
  });

  it("узнаёт отказ загрузки куска сборки во всех трёх браузерных формулировках", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/a-1.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
});
