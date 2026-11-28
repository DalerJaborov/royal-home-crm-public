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
    expect(body).toMatch(/padding-top:\s*calc\(\s*10px\s*\+\s*env\(safe-area-inset-top/);
  });

  it("под строкой состояния стоит закрашенная полоса: содержимое не проезжает под часами", () => {
    const body = blockOf(shell, ".clean-frame:has(> .clean-header-own)::before");
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/height:\s*env\(safe-area-inset-top/);
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
