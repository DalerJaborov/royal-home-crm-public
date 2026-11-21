import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Нижнее меню: ОДНА переменная на все экраны (аудит К06, 21.11.2026). Конец страницы не должен уезжать под
 * меню, а плавающие панели над ним не должны считать его высоту своими числами.
 */
const SRC = join(__dirname, "..", "..");
const lookFiles = readdirSync(SRC).filter((f) => /^theme-look-royal(-[\w-]+)?\.css$/.test(f));
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("нижнее меню: общая переменная оболочки", () => {
  const base = strip(readFileSync(join(SRC, "theme-look-royal.css"), "utf8"));

  it("--rh-nav-h и --rh-nav-clear объявлены только в файле токенов", () => {
    for (const name of ["--rh-nav-h", "--rh-nav-clear"]) {
      const owners = lookFiles.filter((f) => new RegExp(`${name}\\s*:`).test(strip(readFileSync(join(SRC, f), "utf8"))));
      expect(owners, name).toEqual(["theme-look-royal.css"]);
    }
  });

  it("запас страницы под меню берётся из переменной, а не из своих чисел", () => {
    const values = [...base.matchAll(/\.app-main-col\s*\{[^}]*padding-bottom\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(values.filter((v) => v === "var(--rh-nav-clear)").length).toBeGreaterThanOrEqual(2); // телефон и сенсорный планшет
    expect(values.filter((v) => /safe-area/.test(v) && /\b(96|102|104)px/.test(v))).toEqual([]);
  });

  it("слои разделов не заводят свою переменную высоты меню", () => {
    const own = lookFiles.filter((f) => /--ry-nav-clear/.test(strip(readFileSync(join(SRC, f), "utf8"))));
    expect(own).toEqual([]);
  });

  it("панель подбора встаёт на общую переменную", () => {
    const clients = strip(readFileSync(join(SRC, "theme-look-royal-clients.css"), "utf8"));
    expect(clients).toMatch(/\.client-match-toolbar\s*\{\s*bottom:\s*calc\(var\(--rh-nav-h\)/);
  });
});
