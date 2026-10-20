import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * НИЧЕГО МЕЛЬЧЕ 13PX (правило владельца, разбор — ночная проверка 24.09.2026,
 * verify-2-ekrany-kod-teksty.md №2-№6 и verify-1-ekrany-e2e.md №5).
 *
 * `npm run audit:typeset` зелёный, а мелкий текст оставался — сторож сверяет
 * только «сгенерированный файл совпадает с темой», а не «мельче 13px нет
 * нигде». Четыре независимых места, где текст может оказаться мельче 13px
 * мимо этого сторожа:
 *   1. Tailwind-класс вида `text-[11px]`/`text-[12.5px]` в JSX.
 *   2. Инлайновый `style={{ fontSize: 12 }}` в JSX.
 *   3. Буквальный `font-size: 11.5px` в `index.css` (файл не собирается
 *      генератором и в область `gen-typeset.mjs` не входит).
 *   4. Токен `--fs-12` темы (`theme-2026-proto.css`, генерируемый файл —
 *      правится не он, а переопределение в `theme-2026-brand.css`), если его
 *      никто не поднял выше 13px.
 *
 * `StepPlace.tsx` — зона правки #823 (задание для другого исполнителя), сюда
 * не входит: см. `docs/agent-briefs/` и запись в `docs/journal/`.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const IGNORED = ["/dev/", "\\dev\\"];

/** Зона чужой правки — не трогать, снять после её вливания (см. журнал). */
const EXEMPT_FILES = ["property-wizard/StepPlace.tsx"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out
    .filter((f) => !IGNORED.some((skip) => f.includes(skip)))
    .filter((f) => !EXEMPT_FILES.some((skip) => f.replace(/\\/g, "/").endsWith(skip)));
}

const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

/** `text-[11px]`, `text-[12.5px]` — Tailwind произвольный размер мельче 13px. */
const TAILWIND_SMALL = /text-\[1[0-2](\.[0-9])?px\]/;

/** `fontSize: 12`, `fontSize: 11.5` — инлайновый стиль мельче 13px. */
const INLINE_SMALL = /fontSize:\s*1[0-2](\.[0-9])?\b/;

describe("ничего мельче 13px", () => {
  it("находит файлы исходников (иначе сторож проверяет пустоту)", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
  });

  it("ни один экран не использует Tailwind text-[..px] мельче 13px", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (COMMENT.test(line)) return;
        if (TAILWIND_SMALL.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("ни один экран не задаёт инлайновый fontSize мельче 13px", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (COMMENT.test(line)) return;
        if (INLINE_SMALL.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("index.css не задаёт буквальный font-size мельче 13px", () => {
    const file = path.join(SRC, "index.css");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const offenders: number[] = [];
    lines.forEach((line, i) => {
      if (COMMENT.test(line)) return;
      if (/font-size:\s*1[0-2](\.[0-9])?px/.test(line)) offenders.push(i + 1);
    });
    expect(offenders).toEqual([]);
  });

  it("theme-2026-brand.css поднимает --fs-12 выше 13px (эталон сам себя не переопределяет)", () => {
    const file = path.join(SRC, "theme-2026-brand.css");
    // Комментарии тоже упоминают "--fs-12: 12px" словами — вырезаем их, иначе
    // регулярка находит объяснение поломки вместо самой починки.
    const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Эталон (theme-2026-proto.css, генерируемый) объявляет --fs-12: 12px и
    // используется в 71 правиле темы. Без переопределения здесь весь текст на
    // этом токене остаётся мельче 13px, и никакой другой сторож этого не видит.
    const override = text.match(/--fs-12:\s*(\d+(?:\.\d+)?)px/);
    expect(override).not.toBeNull();
    expect(parseFloat(override![1])).toBeGreaterThanOrEqual(13);
  });
});
