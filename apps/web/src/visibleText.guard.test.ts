import { baselineOnMain } from "./baselineVsMain";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@royal-home/shared";
import baseline from "./visibleText.baseline.json";

/**
 * СТОРОЖ ВИДИМЫХ ТЕКСТОВ (аудит 20.11.2026, классы К02, К03, К19; владелец: «даже тупые должны понять, что зачем нажимать»).
 * В строках кода .tsx (комментарии не в счёт) не должно появляться:
 *   1. эмодзи (значок слева от слов в подписях, чипах, заголовках: вместо них иконки lucide или ничего);
 *   2. слов ЗАГЛАВНЫМИ буквами длиннее четырёх (крик в пояснении; короткие вроде «ЖК», «ООО», «ГУВД» допустимы);
 *   3. кодов прав доступа (`reports.view`) внутри предложения или текста: человеку нужны слова, а не имя в реестре.
 * Старое перечислено в `visibleText.baseline.json` числом строк на файл и только убывает: новый файл или лишняя строка
 * краснят; исправили — уменьшите число (или уберите запись, устаревшая запись тоже краснит). Рост относительно `origin/main`
 * не принимается, даже если вписать число в файл: правку исключений проверяет сверка с главной веткой.
 * Обновить файл после починки: `UPDATE_VISIBLE_TEXT_BASELINE=1 npx vitest run src/visibleText.guard.test.ts`.
 */
type Kind = "emoji" | "caps" | "codes";
type Counts = Record<Kind, Record<string, number>>;

/** Значки-картинки (смайлы, символы, предупреждающие знаки). Галочки ✓ ✗ и стрелки — текстовые знаки, их не считаем; ✔ ✨ ⭐ ⏸ ⏰ ❤ ‼ считаем. */
export const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{2712}\u{2714}-\u{2716}\u{2718}-\u{27BF}\u{23E9}-\u{23FA}\u{2B50}-\u{2B55}\u{203C}\u{2049}\u{FE0F}]/u;
/** Слово заглавными кириллицей, 5 букв и больше (латинские имена вида AGENT, FAILED — это коды, не текст). */
export const SHOUTING = /(?<![\p{L}_])[А-ЯЁ]{5,}(?![\p{L}_])/u;

const PERMISSION_IDS = PERMISSIONS.map((p) => p.id as string);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Код права в предложении: внутри строки в кавычках, где есть русские слова, или в тексте между тегами. */
const CODE_IN_TEXT = new RegExp(
  `(?:["'\`][^"'\`\\n]*[а-яё][^"'\`\\n]*(?<![\\w.])(?:${PERMISSION_IDS.map(escape).join("|")})(?![\\w.])[^"'\`\\n]*["'\`])|(?:>[^<>{}\\n]*(?<![\\w.])(?:${PERMISSION_IDS.map(escape).join("|")})(?![\\w.])[^<>{}\\n]*<)`,
  "iu"
);

/** Строки кода без комментариев: строчных, блочных (в том числе многострочных) и JSX-комментариев. */
export function codeLines(source: string): Array<{ n: number; text: string }> {
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

export function classify(text: string): Kind[] {
  const kinds: Kind[] = [];
  if (EMOJI.test(text)) kinds.push("emoji");
  if (SHOUTING.test(text)) kinds.push("caps");
  if (CODE_IN_TEXT.test(text)) kinds.push("codes");
  return kinds;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "generated") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.d\.ts$/.test(full) && !/\.(test|spec)\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(srcDir, "visibleText.baseline.json");

function found(): Counts {
  const out: Counts = { emoji: {}, caps: {}, codes: {} };
  for (const file of walk(srcDir)) {
    const rel = path.relative(srcDir, file).split(path.sep).join("/");
    for (const l of codeLines(readFileSync(file, "utf8"))) {
      for (const kind of classify(l.text)) out[kind][rel] = (out[kind][rel] ?? 0) + 1;
    }
  }
  return out;
}

describe("видимые тексты: без эмодзи, крика заглавными и кодов прав", () => {
  if (process.env.UPDATE_VISIBLE_TEXT_BASELINE) {
    it("обновляет список исключений", () => {
      writeFileSync(BASELINE_FILE, JSON.stringify(found(), null, 1) + "\n");
    });
    return;
  }

  it("новых строк нет, список исключений только убывает", () => {
    const now = found();
    const allowed = baseline as Counts;
    const problems: string[] = [];
    for (const kind of ["emoji", "caps", "codes"] as Kind[]) {
      for (const [file, count] of Object.entries(now[kind])) {
        if (count > (allowed[kind][file] ?? 0)) problems.push(`${kind}: ${file}: ${count} (разрешено ${allowed[kind][file] ?? 0})`);
      }
      for (const [file, count] of Object.entries(allowed[kind])) {
        if ((now[kind][file] ?? 0) < count) problems.push(`${kind}: ${file}: в списке ${count}, в коде ${now[kind][file] ?? 0}: уменьшите visibleText.baseline.json`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("список исключений не вырос по сравнению с origin/main", () => {
    const res = baselineOnMain<Counts>("apps/web/src/visibleText.baseline.json", srcDir);
    expect(res.ok ? "" : res.why).toBe("");
    const main = res.ok ? res.main : null;
    if (!main) return;
    const grew: string[] = [];
    for (const kind of ["emoji", "caps", "codes"] as Kind[]) {
      for (const [file, count] of Object.entries((baseline as Counts)[kind])) {
        if (count > (main[kind]?.[file] ?? 0)) grew.push(`${kind}: ${file}: ${count} (на origin/main ${main[kind]?.[file] ?? 0})`);
      }
    }
    expect(grew).toEqual([]);
  });

  it("сторож проверен поломкой: ловит эмодзи, крик и код права, не трогает обычный текст", () => {
    expect(classify('<b>👍 Верно</b>')).toEqual(["emoji"]);
    expect(classify('title="⚠ без звука"')).toEqual(["emoji"]);
    expect(classify("Чат ТОЛЬКО по своим клиентам")).toEqual(["caps"]);
    expect(classify('const hint = "Видно, если есть право reports.view"')).toEqual(["codes"]);
    expect(classify("<span>agents.reset2fa</span>")).toEqual(["codes"]);
    for (const ok of ["Объект ЖК Диамонд, ООО Сомон, ГУВД", "✓ Утвердить", "Подождите…", 'can("reports.view") && <Link />', 'permission: "reports.view",', "WhatsApp и Instagram", "Озвучка готова"]) {
      expect(classify(ok), ok).toEqual([]);
    }
    expect(existsSync(BASELINE_FILE)).toBe(true);
  });
});
