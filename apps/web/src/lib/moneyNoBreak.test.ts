import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ «СУММА НЕ РВЁТСЯ» (ревью #328, 20.11.2026).
 *
 * «3 220,70 / с.» и «1,3 / млн с.» на узком телефоне — перенос между числом и валютой.
 * Одна дверь — `formatMoney`/`formatMoneyExact` (lib/format.ts) и `glueNumbers`
 * (lib/glueNumbers.ts) ставят неразрывный пробел. Здесь ловится обход: в коде подпись
 * «с.» после числа или выражения через ОБЫЧНЫЙ пробел — шаблон `${x} с.`, JSX `{x} с.`,
 * строка `" с."`. Неразрывный пробел пишется видимо: ` ` в строке, `{" "}` в JSX.
 * Комментарии, тесты и песочницы (`pages/dev`) не считаются.
 */
const SRC = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/lib\/?$/, "");
const BROKEN = /[}\d)] с\.|" с\."/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "dev" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Код без комментариев: блоки и строки `//` (кроме `://` в адресах). */
export function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function brokenMoney(text: string): number[] {
  return codeOnly(text).split("\n").flatMap((line, i) => (BROKEN.test(line) ? [i + 1] : []));
}

describe("сумма с «с.» — только с неразрывным пробелом", () => {
  it("в apps/web/src нет «… с.» через обычный пробел", () => {
    expect(files(SRC).length, "сторож видит исходники").toBeGreaterThan(300);
    const bad = files(SRC).flatMap((file) => brokenMoney(readFileSync(file, "utf8")).map((line) => `${relative(SRC, file)}:${line}`));
    expect(bad).toEqual([]);
  });
  it("сторож проверен поломкой", () => {
    expect(brokenMoney("const a = `${nums(x)} с.`;")).toEqual([1]);
    expect(brokenMoney("<b>{nums(x)} с.</b>")).toEqual([1]);
    expect(brokenMoney('const t = " с.";')).toEqual([1]);
    expect(brokenMoney("const a = `${nums(x)}\\u00a0с.`;\n// пример: 2 000 с.\n/** «1 999,50 с.» */")).toEqual([]);
  });
});
