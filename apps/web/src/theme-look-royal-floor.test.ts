import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ «ПОЛ НЕ СЖИМАЕТ» (ревью #351, 21.11.2026). Поднимать мелкий текст на телефоне можно адресно
 * (ветка ≤ 767.98 в theme-2026-typeset.css от `gen:typeset`), но нельзя правилом по имени тега с `!important`
 * в слоях вида: оно сжимало цену объекта 32 → 15 и плитку главной 20 → 15.
 */
const dir = new URL("./", import.meta.url);
const look = readdirSync(dir).filter((f) => /^theme-look-royal(-[\w-]+)?\.css$/.test(f));

describe("пол текста на телефоне не сжимает крупное", () => {
  it.each(look)("%s: нет `font-size: … !important` на голых p, small, dt, dd", (file) => {
    const css = readFileSync(new URL(file, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const bad = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, head, body]) => /font-size:[^;]*!important/.test(body))
      // голый селектор: после снятия :root[…] и [атрибутов] ни одного класса, а на конце — тег абзаца
      .filter(([, head]) => head.split(",").some((sel) => !/\./.test(sel.replace(/\[[^\]]*\]/g, "")) && /(?:^|[\s>+~])(?:p|small|dt|dd)\s*$/.test(sel.trim())))
      .map(([, head]) => head.trim().slice(0, 100));
    expect(bad).toEqual([]);
  });
  it("телефонная ветка typeset не трогает классы нового вида (ry-*) и календарь", () => {
    const css = readFileSync(new URL("theme-2026-typeset.css", dir), "utf8");
    const phone = css.slice(css.lastIndexOf("@media (max-width: 767.98px) {"));
    expect(phone.length).toBeGreaterThan(100);
    expect(phone).not.toMatch(/\.ry-/);
    expect(phone).not.toMatch(/cal/);
  });
});
