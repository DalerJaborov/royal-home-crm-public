import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * iPhone (PWA, строка состояния black-translucent), 28.11.2026: на «Чатах» и других экранах,
 * которые рисуют свою шапку, верх содержимого лежал ПОД часами и островом камеры — «ничего не
 * видно, пока не потянешь страницу вниз».
 *
 * Корень: вырез на телефоне оплачивала шапка оболочки (`.clean-header`: padding-top с
 * `env(safe-area-inset-top)`). Правило `.clean-header-own { display: none }` гасит её на экранах со
 * своей шапкой (метка ShellOwnHeader, «Чаты»), а поле выреза вместе с ней пропадало: `.app-main-col`
 * начинался на 10 px от края. Старое правило `.mh > .top` (theme-2026-mobile-shell.css, 7.4) ещё и
 * вычитает вырез отрицательным отступом, рассчитанным на прежнюю оболочку с `pt-[env(safe-area-inset-top)]`.
 *
 * Класс: любое место, где шапку оболочки убирают на телефоне, обязано вернуть вырез. Тест читает
 * исходники (vitest здесь без отрисовки): правило возврата на месте, «Чаты» вычитают вырез из своей
 * высоты, и шапку гасит только одно правило.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) => fs.readFileSync(path.join(SRC, name), "utf8");

/** Тело первого правила, чей селектор содержит `needle`. */
function blockOf(css: string, needle: string): string {
  const at = css.indexOf(needle);
  expect(at, `правило «${needle}» не найдено`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("экран без шапки оболочки не заходит под вырез телефона", () => {
  const shell = read("theme-2026-clean-mobile-shell.css");

  it("после скрытой шапки `.app-main-col` возвращает вырез в верхнее поле", () => {
    const body = blockOf(shell, '.clean-header-own ~ .app-main-col');
    expect(body).toMatch(/padding-top:\s*calc\(\s*10px\s*\+\s*var\(--clean-safe-top\)/);
  });

  it("под строкой состояния стоит закрашенная полоса: содержимое не проезжает под часами", () => {
    const body = blockOf(shell, ".clean-frame:has(> .clean-header-own)::before");
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/height:\s*var\(--clean-safe-top\)/);
    expect(body).toMatch(/pointer-events:\s*none/);
    const z = Number(/z-index:\s*(\d+)/.exec(body)?.[1]);
    // Ниже липкой `.top` (z 20) и шторок.
    expect(z).toBeLessThan(20);
  });

  it("шапку оболочки на телефоне гасит ровно одно правило (одна дверь)", () => {
    const hiders: string[] = [];
    for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith(".css"))) {
      const css = read(name);
      for (const m of css.matchAll(/([^{}]*\.clean-header-own[^{}]*)\{([^}]*)\}/g)) {
        if (/display:\s*none/.test(m[2]) && /mobile-ux/.test(m[1])) hiders.push(name);
      }
    }
    expect(hiders).toEqual(["theme-2026-clean-mobile-shell.css"]);
  });

  it("высота списка «Чатов» вычитает вырез (иначе страница вырастает на его величину)", () => {
    expect(read("theme-2026-clean.css")).toMatch(/\.clean-messages \.two>section \{[^}]*env\(safe-area-inset-top/);
    expect(read("theme-look-royal-chats.css")).toMatch(/--ry-chat-h:[^;]*env\(safe-area-inset-top/);
  });
});

describe("вырез считается одной схемой (одна переменная)", () => {
  const shell = read("theme-2026-clean-mobile-shell.css");

  it("`--clean-safe-top` определён ровно один раз и равен env(safe-area-inset-top)", () => {
    const defs: string[] = [];
    for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith(".css"))) {
      for (const m of read(name).matchAll(/--clean-safe-top\s*:\s*([^;]+);/g)) defs.push(`${name}: ${m[1].trim()}`);
    }
    expect(defs).toEqual(["theme-2026-clean-mobile-shell.css: env(safe-area-inset-top, 0px)"]);
  });

  it("правила чистой оболочки не читают env(safe-area-inset-top) напрямую", () => {
    // Одно исключение с запасным значением: `var(--clean-safe-top, env(...))` вне телефонной ветки.
    const offenders: string[] = [];
    for (const name of fs.readdirSync(SRC).filter((f) => /^theme-2026-clean.*\.css$/.test(f) || f === "theme-look-royal-chats.css")) {
      const css = read(name).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/[^;{}]*env\(safe-area-inset-top[^;{}]*/g)) {
        const line = m[0];
        if (/^\s*--clean-safe-top\s*:/.test(line)) continue;
        if (!/var\(--clean-safe-top\s*,\s*env\(safe-area-inset-top/.test(line)) offenders.push(`${name}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("`.mh > .top` в чистой оболочке вычитает вырез только после скрытой шапки оболочки", () => {
    expect(blockOf(shell, ".rh2 .mh > .top {")).toMatch(/margin-top:\s*0/);
    expect(blockOf(shell, ".clean-header-own ~ .app-main-col .rh2 .mh > .top")).toMatch(/margin-top:\s*calc\(\s*-1\s*\*\s*var\(--clean-safe-top\)/);
  });

  it("мёртвое правило `.app-shell { padding-top: max(8px, env(...)) }` не вернулось", () => {
    expect(read("theme-2026-clean.css")).not.toMatch(/\.app-shell\.clean-shell \{[^}]*padding-top:\s*max\(8px/);
  });
});

describe("шапка при сворачивании не двигает страницу (рывок «Календаря» 138→111)", () => {
  it("CleanShell отдаёт убавку высоты шапки полем под ней", () => {
    const tsx = fs.readFileSync(path.join(SRC, "components/clean/CleanShell.tsx"), "utf8");
    expect(tsx).toMatch(/\[data-ry-top\]\[data-scrolled\]/);
    expect(tsx).toMatch(/node\.style\.marginBottom\s*=\s*gap/);
    expect(tsx).toMatch(/node\.style\.marginBottom\s*=\s*""/); // и снимает при размонтировании
  });

  it("основная колонка не якорит прокрутку (иначе Chrome съедает убавку и верх «залипает»)", () => {
    expect(blockOf(read("theme-2026-clean-mobile-shell.css"), "[data-mobile-ux] .app-main-col {\n  overflow-anchor")).toMatch(/overflow-anchor:\s*none/);
  });
});
