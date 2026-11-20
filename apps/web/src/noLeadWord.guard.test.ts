import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import baseline from "./noLeadWord.baseline.json";
import { baselineOnMain } from "./baselineVsMain";

/** Версия способа подсчёта: 2 — строки фронта и все строки текста сервера, в том числе многострочные шаблоны. */
const SCOPE = "multiline-v2";

/**
 * СТОРОЖ СЛОВА «ЛИД» В ТЕКСТАХ ДЛЯ СОТРУДНИКОВ (владелец 20.11.2026: «Лид ждёт принятия» → «Заявка ждёт принятия»; правило
 * владельца: лид → заявка, бытовыми словами; ревью #338 нашло забытые строки в Clients.tsx и Notifications.tsx).
 *
 * Два стража:
 *  1. Фронт: в каждой строке КОДА (комментарии не в счёт) каждого .tsx-файла слово «лид» (лид, лида, лиды, лидов…) — это видимый
 *     текст. Файлы, где оно ещё осталось (настройки, финансы, отчёты, источники — разделы других веток), перечислены в
 *     `noLeadWord.baseline.json` с числом строк. Список только убывает: новый файл или лишняя строка краснят; исправили —
 *     уменьшите число или уберите запись (устаревшая запись тоже краснит).
 *  2. Сервер: каждая строка кода в `apps/api/src` (кроме консольных логов и сравнений со старым текстом), в том числе строки
 *     многострочных шаблонов, — те же правила и тот же список (ключи `api/…`); маршруты, приём заявок и уведомления первого
 *     звонка в списке быть не могут.
 */
/** Строки сервера, которые не показываются людям: журнал консоли и сравнения со старым текстом в базе (`contains`, регулярки). Всё остальное в `apps/api/src` — текст для людей, в том числе многострочные шаблоны. */
const SERVER_NOT_TEXT = /console\.(error|warn|log)|contains\s*:|startsWith|endsWith|\bre:|\.test\(|\.match\(/;
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
  /** Подсчёт строк со словом: фронт (.tsx и .ts — тексты, подписи, уведомления) и поля уведомлений/ответов сервера. */
  function found(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const file of walk(srcDir, (f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith(".d.ts"))) {
      const hits = codeLines(readFileSync(file, "utf8")).filter((l) => WORD.test(l.text)).length;
      if (hits) out[path.relative(srcDir, file).split(path.sep).join("/")] = hits;
    }
    const apiSrc = path.resolve(srcDir, "../../api/src");
    for (const file of walk(apiSrc, (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))) {
      const hits = codeLines(readFileSync(file, "utf8")).filter((l) => WORD.test(l.text) && !SERVER_NOT_TEXT.test(l.text)).length;
      if (hits) out[`api/${path.relative(apiSrc, file).split(path.sep).join("/")}`] = hits;
    }
    return out;
  }
  if (process.env.UPDATE_LEAD_WORD_BASELINE) {
    it("обновляет список исключений", () => {
      const sorted = Object.fromEntries(Object.entries(found()).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(path.join(srcDir, "noLeadWord.baseline.json"), JSON.stringify({ _scope: SCOPE, ...sorted }, null, 1) + "\n");
    });
    return;
  }
  /** Список без служебного ключа `_scope`. */
  const listed = (b: Record<string, unknown>): Record<string, number> => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "_scope")) as Record<string, number>;
  it("список исключений не вырос по сравнению с origin/main", () => {
    const res = baselineOnMain<Record<string, unknown>>("apps/web/src/noLeadWord.baseline.json", srcDir);
    expect(res.ok ? "" : res.why).toBe("");
    const main = res.ok ? res.main : null;
    // Способ подсчёта поменялся (ревью #341: считаются и строки многострочных серверных шаблонов): список с другим `_scope`
    // сравнивать со старым нечестно, он шире по определению. Сверка включается со следующей правки.
    if (!main || main._scope !== SCOPE) return;
    const onMain = listed(main);
    const grew = Object.entries(listed(baseline as Record<string, unknown>)).filter(([file, count]) => count > (onMain[file] ?? 0)).map(([file, count]) => `${file}: ${count} (на origin/main ${onMain[file] ?? 0})`);
    expect(grew).toEqual([]);
  });
  it("новых файлов и новых строк со словом нет, список исключений только убывает", () => {
    const now = found();
    const allowed = listed(baseline as Record<string, unknown>);
    const grew = Object.entries(now).filter(([file, count]) => count > (allowed[file] ?? 0)).map(([file, count]) => `${file}: ${count} (разрешено ${allowed[file] ?? 0})`);
    const shrank = Object.entries(allowed).filter(([file, count]) => (now[file] ?? 0) < count).map(([file, count]) => `${file}: в списке ${count}, в коде ${now[file] ?? 0} — обновите noLeadWord.baseline.json`);
    expect({ grew, shrank }).toEqual({ grew: [], shrank: [] });
  });
  it("сервер: в маршрутах (apps/api/src/routes) и в уведомлениях агентам слова «лид» нет совсем", () => {
    const allowed = Object.keys(listed(baseline as Record<string, unknown>));
    expect(allowed.filter((file) => file.startsWith("api/routes/") || /^api\/(services\/leads|jobs)\/.*(intake|firstCall|Notify)/.test(file))).toEqual([]);
  });
  it("сторож проверен поломкой: слово ловится во всех формах и не ловится в «клиент», «солидный»", () => {
    for (const bad of ["Не удалось принять лид", "Новые лиды", "стоимость лида", "Лидов за месяц", "лиде"]) expect(WORD.test(bad), bad).toBe(true);
    for (const ok of ["клиент", "солидный", "Лидия", "лидер", "идеально", "Заявка ждёт принятия"]) expect(WORD.test(ok), ok).toBe(false);
    expect(codeLines("const a = 1; // лид в комментарии\n/* лид\n   тоже */ const b = 'лид';").filter((l) => WORD.test(l.text)).map((l) => l.n)).toEqual([3]);
  });
});
