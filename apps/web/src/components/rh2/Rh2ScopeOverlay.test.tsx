import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Rh2Inline } from "./Rh2Scope";

/**
 * Сторож класса «Tailwind-позиционирование на узле `.rh2` проигрывает теме»
 * (перепись 24.10.2026, P0: подсказка «Поставьте CRM на экран» оставалась в потоке).
 * Тема лежит в CSS без слоя и задаёт `.rh2{position:relative;margin:0}`; утилиты
 * Tailwind v4 — в слое, и бесслойное правило бьёт их при любой специфичности.
 */
const OVERLAY = "fixed inset-x-0 bottom-[calc(152px+env(safe-area-inset-bottom))] z-30 px-3 md:hidden";

describe("Rh2Inline: утилиты положения не на узле .rh2", () => {
  it("className уходит на внешнюю обёртку, а узел .rh2 остаётся без утилит", () => {
    const html = renderToStaticMarkup(<Rh2Inline className={OVERLAY}><i /></Rh2Inline>);
    const outer = html.match(/^<div class="([^"]*)"/)?.[1] ?? "";
    expect(outer).toBe(OVERLAY);
    const rh2 = html.match(/<div class="(rh2[^"]*)"/)?.[1] ?? "";
    expect(rh2).toBe("rh2 screens");
    expect(rh2).not.toMatch(/\b(fixed|sticky|absolute|inset-|z-\d)/);
  });

  it("без className обёртки нет: рамка внутри разметки не меняется", () => {
    const html = renderToStaticMarkup(<Rh2Inline><i /></Rh2Inline>);
    expect(html.startsWith('<div class="rh2 screens"')).toBe(true);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("исходники: нет литерального className с rh2 и утилитой положения/отступа", () => {
  const SRC = path.resolve(__dirname, "../..");
  const POSITIONAL = /^(?:[\w-]+:)*(fixed|sticky|absolute|relative|inset(?:-[\w[\]./()+,-]+)?|(?:top|bottom|left|right|z)-[\w[\]./()+,-]+|-?m[trblxy]?-[\w[\]./()+,-]+)$/;

  it("ни один className с токеном rh2 не несёт позиционирующих утилит Tailwind", () => {
    const bad: string[] = [];
    for (const file of walk(SRC)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/"([^"]*)"|`([^`]*)`/g)) {
          const tokens = (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean);
          if (!tokens.includes("rh2")) continue;
          const hit = tokens.filter((t) => POSITIONAL.test(t));
          if (hit.length) bad.push(`${path.relative(SRC, file)}:${i + 1} ${hit.join(" ")}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });
});
