import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tileTone } from "./tileTone";

/**
 * ЦВЕТ ПЛИТКИ ПО СМЫСЛУ (20.11.2026): одна функция и сторож, что главные руководителей
 * берут вариант плитки только из неё.
 */
describe("tileTone", () => {
  it("ноль — спокойная серая при любом смысле; нет числа — обычная белая", () => {
    for (const meaning of ["urgent", "attention", "good", "info"] as const) {
      expect(tileTone(meaning, 0), meaning).toBe("calm");
      expect(tileTone(meaning, null), meaning).toBe("plain");
      expect(tileTone(meaning, undefined), meaning).toBe("plain");
      expect(tileTone(meaning, Number.NaN), meaning).toBe("plain");
    }
  });

  it("больше нуля: срочное — красная, есть что сделать — лайм, хорошо — зелёная, справка — белая", () => {
    expect(tileTone("urgent", 3)).toBe("crit");
    expect(tileTone("attention", 1)).toBe("brand");
    expect(tileTone("good", 2)).toBe("ok");
    expect(tileTone("info", 9)).toBe("plain");
  });

  it("чёрную плитку тревоги не выдаёт никогда", () => {
    const all = (["urgent", "attention", "good", "info"] as const).flatMap((m) => [-1, 0, 1, 99, null].map((v) => tileTone(m, v)));
    expect(all).not.toContain("ink");
  });
});

/**
 * Сторож: в блоках главных руководителей у RhTile нет буквального `variant="…"` — цвет
 * считает tileTone(). Главные агента, монтажёра и маркетинга пока на прежних вариантах
 * (их ведут другие пачки) — они в списке «ещё не переведены», и этот список только убывает.
 */
const GUARDED = ["home/blocks/director.tsx", "home/blocks/rop.tsx", "home/blocks/leader.tsx", "home/blocks/manager.tsx"];
const NOT_YET = ["home/blocks/agent.tsx", "home/blocks/editor.tsx", "home/blocks/marketing.tsx"];
// От «<RhTile» до «variant="» в пределах одного тега (стрелки `=>` в свойствах тег не обрывают).
const LITERAL = /<RhTile\b(?:(?!\/>|<RhTile)[\s\S])*?\svariant="/;

function literalTileVariants(source: string): number {
  return [...source.matchAll(new RegExp(LITERAL.source, "g"))].length;
}

describe("сторож: плитки руководителей красятся только через tileTone()", () => {
  it("ни одного буквального variant у RhTile в блоках руководителей", () => {
    for (const file of GUARDED) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(literalTileVariants(source), file).toBe(0);
    }
  });

  it("сторож ловит буквальный вариант (проверен поломкой)", () => {
    expect(literalTileVariants('<RhTile key="x" variant="ink" icon="flame" label="Горит" value={0} />')).toBe(1);
    expect(literalTileVariants('<RhTile\n  variant="brand"\n  icon="x" />')).toBe(1);
    expect(literalTileVariants('<RhTile variant={tileTone("urgent", n)} icon="x" />')).toBe(0);
    expect(literalTileVariants('<RhTile to={go(() => 1)} label="a" variant="crit" />')).toBe(1);
    expect(literalTileVariants('<RhTile variant={v} /><RhRow variant="x" />')).toBe(0);
    expect(literalTileVariants('<RhTile to={go(() => 1)} label="a" variant="crit" />')).toBe(1);
    expect(literalTileVariants('<RhTile variant={v} /><RhRow variant="x" />')).toBe(0);
  });

  it("список «ещё не переведены» не содержит файлов, которые уже переведены (только убывает)", () => {
    for (const file of NOT_YET) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(literalTileVariants(source), `${file} уже без буквальных вариантов — перенесите его в GUARDED`).toBeGreaterThan(0);
    }
  });
});
