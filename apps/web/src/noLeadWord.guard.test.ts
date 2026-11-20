import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import baseline from "./noLeadWord.baseline.json";

/**
 * СТОРОЖ СЛОВА «ЛИД» В ТЕКСТАХ ДЛЯ СОТРУДНИКОВ (владелец 20.11.2026: «Лид ждёт принятия» → «Заявка ждёт принятия»; правило
 * владельца: лид → заявка, бытовыми словами; ревью #338 нашло забытые строки в Clients.tsx и Notifications.tsx).
 *
 * Два стража:
 *  1. Фронт: в каждой строке КОДА (комментарии не в счёт) каждого .tsx-файла слово «лид» (лид, лида, лиды, лидов…) — это видимый
 *     текст. Файлы, где оно ещё осталось (настройки, финансы, отчёты, источники — разделы других веток), перечислены в
 *     `noLeadWord.baseline.json` с числом строк. Список только убывает: новый файл или лишняя строка краснят; исправили —
 *     уменьшите число или уберите запись (устаревшая запись тоже краснит).
 *  2. Сервер: в ответах-сообщениях маршрутов (`apps/api/src/routes/**`: `error:` и `message:`) слова «лид» нет совсем.
 */
const WORD = /(?<![а-яёa-z])[Лл]ид(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?![а-яёa-z])/u;

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "generated") continue;
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

/** Строки кода без комментариев: строчных, блочных (в том числе многострочных) и JSX-комментариев. */
function codeLines(source: string): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  let block = false;
  source.split(/\r?\n/).forEach((line, i) => {
    let rest = line;
    let kept = "";
    while (rest.length) {
      if (block) {
        const end = rest.indexOf("*/");
        if (end === -1) { rest = ""; break; }
        block = false; rest = rest.slice(end + 2); continue;
      }
      const start = rest.indexOf("/*");
      const slash = rest.search(/(^|[^:])\/\//);
      if (slash !== -1 && (start === -1 || slash < start)) { kept += rest.slice(0, slash + (rest[slash] === "/" ? 0 : 1)); rest = ""; break; }
      if (start === -1) { kept += rest; rest = ""; break; }
      kept += rest.slice(0, start);
      const end = rest.indexOf("*/", start + 2);
      if (end === -1) { block = true; rest = ""; break; }
      rest = rest.slice(end + 2);
    }
    out.push({ n: i + 1, text: kept });
  });
  return out;
}

describe("слово «лид» в текстах для сотрудников", () => {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  it("фронт: новых файлов и новых строк со словом нет, список исключений только убывает", () => {
    const found: Record<string, number> = {};
    for (const file of walk(srcDir, (f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))) {
      const hits = codeLines(readFileSync(file, "utf8")).filter((l) => WORD.test(l.text)).length;
      if (hits) found[path.relative(srcDir, file).split(path.sep).join("/")] = hits;
    }
    const allowed = baseline as Record<string, number>;
    const grew = Object.entries(found).filter(([file, count]) => count > (allowed[file] ?? 0)).map(([file, count]) => `${file}: ${count} (разрешено ${allowed[file] ?? 0})`);
    const shrank = Object.entries(allowed).filter(([file, count]) => (found[file] ?? 0) < count).map(([file, count]) => `${file}: в списке ${count}, в коде ${found[file] ?? 0} — обновите noLeadWord.baseline.json`);
    expect({ grew, shrank }).toEqual({ grew: [], shrank: [] });
  });
  it("сервер: в ответах-сообщениях маршрутов слова «лид» нет", () => {
    const routes = path.resolve(srcDir, "../../api/src/routes");
    const leaks: string[] = [];
    for (const file of walk(routes, (f) => f.endsWith(".ts"))) {
      for (const line of codeLines(readFileSync(file, "utf8"))) {
        if (WORD.test(line.text) && /\b(error|message)\s*:/.test(line.text)) leaks.push(`${path.relative(routes, file)}:${line.n}`);
      }
    }
    expect(leaks).toEqual([]);
  });
  it("сторож проверен поломкой: слово ловится во всех формах и не ловится в «клиент», «солидный»", () => {
    for (const bad of ["Не удалось принять лид", "Новые лиды", "стоимость лида", "Лидов за месяц", "лиде"]) expect(WORD.test(bad), bad).toBe(true);
    for (const ok of ["клиент", "солидный", "Лидия", "лидер", "идеально", "Заявка ждёт принятия"]) expect(WORD.test(ok), ok).toBe(false);
    expect(codeLines("const a = 1; // лид в комментарии\n/* лид\n   тоже */ const b = 'лид';").filter((l) => WORD.test(l.text)).map((l) => l.n)).toEqual([3]);
  });
});
