import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * КАЖДАЯ ДАТА НА ЭКРАНЕ ПЕЧАТАЕТСЯ В ЧАСАХ ДУШАНБЕ, А НЕ УСТРОЙСТВА.
 *
 * `toLocaleDateString("ru-RU")` без `timeZone` берёт пояс браузера. Для агента в
 * Душанбе это незаметно, а владелец, открывший CRM из Стамбула (UTC+3), видел одну
 * встречу под двумя числами (случай 01.08.2026, шапка `lib/date.ts`). Ночная
 * проверка 01.10.2026 (№177) нашла ещё два десятка таких мест; починены правкой
 * пояса, а этот сторож не даёт им вернуться.
 *
 * Что считается нарушением — вызов, который печатает ДАТУ или ВРЕМЯ без `timeZone`:
 *   • `toLocaleDateString(...)` и `toLocaleTimeString(...)` — всегда;
 *   • `toLocaleString(...)`, если получатель `new Date(...)` либо в настройках есть
 *     поля даты/времени (day, month, year, hour, minute, weekday, dateStyle,
 *     timeStyle). Числа (`n.toLocaleString("ru-RU")`) не затрагиваются.
 * Комментарии в счёт не идут — разбирается дерево, а не текст.
 *
 * Если пояс действительно не нужен (например, подпись месяца по заранее
 * вычисленной «настенной» дате в UTC) — задайте `timeZone: "UTC"` явно: это
 * видно и читателю, и сторожу.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATE_METHODS = new Set(["toLocaleDateString", "toLocaleTimeString"]);
const DATE_OPTION_KEYS = new Set(["day", "month", "year", "hour", "minute", "second", "weekday", "dateStyle", "timeStyle"]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

interface Finding {
  where: string;
  text: string;
}

/** Нарушения в тексте одного файла: вызовы печати даты без timeZone. */
export function findDatesWithoutZone(fileName: string, source: string): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const isDateMethod = DATE_METHODS.has(method);
      if (isDateMethod || method === "toLocaleString") {
        const options = node.arguments[1];
        const keys = new Set<string>();
        let optionsOpaque = false;
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const p of options.properties) {
            if (ts.isSpreadAssignment(p)) optionsOpaque = true;
            else if (p.name) keys.add(p.name.getText(sf).replace(/["']/g, ""));
          }
        } else if (options) {
          optionsOpaque = true;
        }
        const receiverIsDate = /^new Date\(/.test(node.expression.expression.getText(sf));
        const looksLikeDate = isDateMethod || receiverIsDate || [...keys].some((k) => DATE_OPTION_KEYS.has(k));
        // Настройки переданы переменной или спредом — пояс может быть внутри; смотрим на место сборки отдельно.
        if (looksLikeDate && !keys.has("timeZone") && !optionsOpaque) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          found.push({ where: `${path.relative(SRC, fileName).split(path.sep).join("/")}:${line + 1}`, text: node.getText(sf).split("\n")[0].slice(0, 100) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("сторож: дата печатается в часах Душанбе", () => {
  const find = (code: string) => findDatesWithoutZone("x.tsx", code);

  it("ловит дату без timeZone и не трогает числа и комментарии", () => {
    expect(find(`const a = d.toLocaleDateString("ru-RU");`)).toHaveLength(1);
    expect(find(`const a = new Date(x).toLocaleString("ru-RU");`)).toHaveLength(1);
    expect(find(`const a = when.toLocaleString("ru-RU", { day: "numeric", hour: "2-digit" });`)).toHaveLength(1);
    expect(find(`const a = d.toLocaleTimeString("ru-RU", { hour: "2-digit" });`)).toHaveLength(1);
    expect(find(`const a = n.toLocaleString("ru-RU");`)).toHaveLength(0);
    expect(find(`const a = n.toLocaleString("ru-RU", { minimumFractionDigits: 1 });`)).toHaveLength(0);
    expect(find(`// d.toLocaleDateString("ru-RU")\nconst a = 1;`)).toHaveLength(0);
    expect(find(`const a = d.toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe" });`)).toHaveLength(0);
    expect(find(`const a = d.toLocaleDateString("ru-RU", { timeZone: TZ, ...opts });`)).toHaveLength(0);
  });

  it("во всём apps/web/src нет даты без часового пояса", () => {
    const all = sourceFiles(SRC).flatMap((f) => findDatesWithoutZone(f, fs.readFileSync(f, "utf8")));
    expect(all.map((f) => `${f.where}  ${f.text}`)).toEqual([]);
  // This audit parses the entire source tree; concurrent API/browser checks can
  // exceed Vitest's 5s default without any date violation. Keep all assertions.
  }, 30_000);
});
