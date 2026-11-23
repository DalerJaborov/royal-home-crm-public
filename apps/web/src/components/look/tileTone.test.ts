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
 * Сторож: у КАЖДОЙ плитки RhTile в блоках главных руководителей вариант задаёт вызов
 * `variant={tileTone(…)}` — не строка, не `{"ink"}`, не тернарник `{x ? "ink" : "plain"}`,
 * не переменная. Главные агента, монтажёра и маркетинга пока на прежних вариантах (их
 * ведут другие пачки) — они в списке «ещё не переведены», и этот список только убывает.
 */
const GUARDED = ["home/blocks/dashboardHome.tsx", "home/blocks/director.tsx", "home/blocks/rop.tsx", "home/blocks/leader.tsx", "home/blocks/manager.tsx"];
const NOT_YET = ["home/blocks/agent.tsx", "home/blocks/editor.tsx", "home/blocks/marketing.tsx"];

/** Теги `<RhTile …>` целиком: до `>` или `/>` вне фигурных скобок (стрелки `=>` внутри `{}` тег не обрывают). */
function rhTileTags(source: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf("<RhTile", from);
    if (start < 0) return tags;
    const after = source[start + "<RhTile".length];
    if (after && /[\w$]/.test(after)) { from = start + 1; continue; }
    let depth = 0;
    let quote: string | null = null;
    let i = start + 1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) { if (ch === quote && source[i - 1] !== "\\") quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push(source.slice(start, i + 1));
    from = i + 1;
  }
}

/** Теги плиток, чей вариант задан не вызовом tileTone(). */
function tilesWithoutTone(source: string): string[] {
  return rhTileTags(source).filter((tag) => !/\svariant=\{tileTone\(/.test(tag));
}

describe("сторож: плитки руководителей красятся только через tileTone()", () => {
  it("у каждой плитки в блоках руководителей variant={tileTone(…)}", () => {
    let seen = 0;
    for (const file of GUARDED) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      seen += rhTileTags(source).length;
      expect(tilesWithoutTone(source), file).toEqual([]);
    }
    // Плитки найдены вовсе — иначе сторож молча ничего не проверял бы.
    expect(seen).toBeGreaterThan(10);
  });

  it("сторож ловит строку, {\"ink\"}, тернарник и переменную (проверен поломкой)", () => {
    const bad = [
      '<RhTile key="x" variant="ink" icon="flame" label="Горит" value={0} />',
      '<RhTile\n  variant="brand"\n  icon="x" />',
      '<RhTile variant={"ink"} icon="x" />',
      '<RhTile variant={x > 0 ? "ink" : "plain"} icon="x" />',
      '<RhTile to={go(() => 1)} label="a" variant={(n) > 1 ? "crit" : "calm"} />',
      '<RhTile variant={v} icon="x" />',
      '<RhTile icon="x" label="без варианта" />',
    ];
    for (const tag of bad) expect(tilesWithoutTone(tag), tag).toHaveLength(1);
    const good = [
      '<RhTile variant={tileTone("urgent", n)} icon="x" />',
      '<RhTile to={go(() => 1)} note={a > b ? "x" : "y"} variant={tileTone("info", (a ?? 0) > 1 ? 1 : 0)} />',
    ];
    for (const tag of good) expect(tilesWithoutTone(tag), tag).toEqual([]);
    // Соседние теги и похожие имена не путаются с плиткой.
    expect(rhTileTags('<RhTiles variant="x" /><RhTile variant={tileTone("good", 1)} /><RhRow variant="x" />')).toHaveLength(1);
  });

  it("список «ещё не переведены» не содержит файлов, которые уже переведены (только убывает)", () => {
    for (const file of NOT_YET) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(tilesWithoutTone(source).length, `${file} уже весь на tileTone — перенесите его в GUARDED`).toBeGreaterThan(0);
    }
  });
});
