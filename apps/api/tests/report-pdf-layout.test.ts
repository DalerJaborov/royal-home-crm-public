import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderReportPdf } from "../src/lib/reportPdf/render.js";
import { sampleFinanceInProgress, sampleFinanceSent, sampleTeam } from "./helpers/reportPdfSample.js";

/**
 * СТРАЖ ВЁРСТКИ PDF-ОТЧЁТОВ (27.11.2026, до включения месячной рассылки).
 * Ловит то, что глазами заметили на образцах: «с..», невшитый шрифт (символ, которого нет
 * в Onest, уходит в Helvetica), текст мельче 9 pt и страницы из одной строки.
 */
const ROOT = path.join(import.meta.dirname, "..");
const REPORT_DIR = path.join(ROOT, "src", "lib", "reportPdf");

const samples: [string, () => ReactElement][] = [
  ["финансовый, как уходит по рассылке", sampleFinanceSent],
  ["финансовый, идущий месяц с прогнозом", sampleFinanceInProgress],
  ["по команде и заявкам", sampleTeam],
];

/** Разворачивает функциональные компоненты и собирает весь печатный текст документа. */
function collectText(node: ReactNode, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => collectText(n, out));
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function") return collectText((el.type as (p: unknown) => ReactNode)(el.props), out);
  return collectText(el.props.children, out);
}

/** Какие символы есть в Onest: читаем таблицу символов из самого TTF (cmap format 4/12 через fontkit react-pdf). */
async function onestGlyphs() {
  const fontkit = (await import("fontkit")) as unknown as { openSync(p: string): { hasGlyphForCodePoint(cp: number): boolean } };
  const open = fontkit.openSync ?? (fontkit as unknown as { default: typeof fontkit }).default.openSync;
  return open(path.join(ROOT, "assets", "fonts", "report", "Onest-Regular.ttf"));
}

describe("PDF-отчёты: вёрстка", () => {
  for (const [name, make] of samples) {
    it(`${name}: нет «с..», все символы есть в Onest, в файле нет невшитых шрифтов`, async () => {
      const text = collectText(make());
      expect(text.length).toBeGreaterThan(50);
      expect(text.filter((t) => /с\.\./.test(t))).toEqual([]);
      const font = await onestGlyphs();
      const missing = new Set<string>();
      for (const ch of text.join("")) {
        const cp = ch.codePointAt(0)!;
        if (cp > 32 && !font.hasGlyphForCodePoint(cp)) missing.add(ch);
      }
      expect([...missing]).toEqual([]);

      const raw = (await renderReportPdf(make() as never)).toString("latin1");
      // Словарь шрифта лежит в файле открытым текстом (сжаты только потоки); имя вида «ABCDEF+Onest-Bold».
      const fonts = [...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+_-]+)/g)].map((m) => m[1]!.replace(/^[A-Z]{6}\+/, ""));
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.filter((f) => !f.startsWith("Onest"))).toEqual([]);
    }, 60_000);

    it(`${name}: нет почти пустых страниц`, async () => {
      if (spawnSync("pdftotext", ["-v"]).error) return; // нет poppler — остальные проверки выше всё равно работают
      const dir = mkdtempSync(path.join(tmpdir(), "rh-pdf-"));
      try {
        const file = path.join(dir, "r.pdf");
        writeFileSync(file, await renderReportPdf(make() as never));
        const res = spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
        const pages = res.stdout.split("\f").filter((p) => p.trim().length > 0);
        expect(pages.length).toBeGreaterThan(2);
        // Страница 1 — обложка. На остальных, кроме шапки и подвала, должно быть не меньше шести строк.
        pages.slice(1).forEach((p, i) => {
          const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
          expect(lines.length, `страница ${i + 2} почти пустая: ${lines.join(" | ").slice(0, 160)}`).toBeGreaterThanOrEqual(8);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }

  it("в исходниках вёрстки нет текста мельче 9 pt (чтение с телефона)", () => {
    const small: string[] = [];
    for (const f of ["kit.tsx", "financeDocument.tsx", "teamDocument.tsx"]) {
      readFileSync(path.join(REPORT_DIR, f), "utf8").split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)) if (Number(m[1]) < 9) small.push(`${f}:${i + 1} ${m[0]}`);
      });
    }
    expect(small).toEqual([]);
  });
});
