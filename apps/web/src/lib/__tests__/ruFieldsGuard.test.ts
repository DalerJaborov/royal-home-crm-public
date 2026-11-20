import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ К01 (20.11.2026): родные контролы iPhone вместо своих.
 *
 * На iPhone `<input type="date|month|time|datetime-local">` рисует значение на языке телефона
 * («November 2026», «2:30 PM»), а `<audio controls>` — серый системный плеер с «00:00». Владелец видел это
 * на кадрах. Поэтому в экранах нет ни голого поля, ни родного плеера:
 *   - дата, месяц, время — `RuDateField`/`RuMonthField`/`RuTimeField`/`RuDateTimeField` (components/look/fields/RuFields);
 *   - запись и голосовое — `RhAudioPlayer` (components/look/RhAudioPlayer).
 * Сторож читает исходники (рендерить экраны здесь нечем), как noApiHrefs.test.ts.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Файлы, где родной тег — сама реализация общего компонента. */
const IMPLEMENTATION = ["components/look/fields/RuFields.tsx", "components/look/RhAudioPlayer.tsx"];

/** Исключения: файл → причина. Список только убывает. */
const AUDIO_EXCEPTIONS: Record<string, string> = {};
const FIELD_EXCEPTIONS: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) && !full.includes("__tests__")) out.push(full);
  }
  return out;
}

/** Теги `<name …>` целиком: скобки `{}` и кавычки считаются, `=>` в атрибутах не рвёт тег. */
function tagsOf(source: string, name: string): { tag: string; at: number }[] {
  const out: { tag: string; at: number }[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`<${name}`, from);
    if (at < 0) return out;
    const next = source[at + name.length + 1];
    if (next && /[\w-]/.test(next)) { from = at + 1; continue; }
    let depth = 0;
    let quote: string | null = null;
    let j = at + name.length + 1;
    for (; j < source.length; j++) {
      const c = source[j];
      if (quote) { if (c === "\\") j++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || (depth > 0 && c === "`")) { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ tag: source.slice(at, j + 1), at });
    from = j + 1;
  }
}

/** Комментарии не код: в них описывают прежний вид («<audio controls> рисовал…»). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const NATIVE_TYPE = /\btype=(?:"|'|\{["'`])(?:date|month|time|datetime-local)(?:"|'|["'`]\})/;

function nativeFieldOffences(source: string): string[] {
  return tagsOf(withoutComments(source), "input").filter(({ tag }) => NATIVE_TYPE.test(tag)).map(({ tag }) => tag.slice(0, 60).replace(/\s+/g, " "));
}
function nativeAudioOffences(source: string): string[] {
  return tagsOf(withoutComments(source), "audio").filter(({ tag }) => /\scontrols\b/.test(tag)).map(({ tag }) => tag.slice(0, 60).replace(/\s+/g, " "));
}

describe("родные контролы Safari (К01)", () => {
  const files = sourceFiles(SRC).map((full) => ({ full, rel: path.relative(SRC, full).split(path.sep).join("/") }));

  it("поле даты, месяца и времени — только через RuDateField/RuMonthField/RuTimeField/RuDateTimeField", () => {
    const offenders: string[] = [];
    for (const { full, rel } of files) {
      if (IMPLEMENTATION.includes(rel) || rel in FIELD_EXCEPTIONS) continue;
      const found = nativeFieldOffences(fs.readFileSync(full, "utf8"));
      if (found.length) offenders.push(`${rel}: ${found.join(" | ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("запись и голосовое — только через RhAudioPlayer, без <audio controls>", () => {
    const offenders: string[] = [];
    for (const { full, rel } of files) {
      if (IMPLEMENTATION.includes(rel) || rel in AUDIO_EXCEPTIONS) continue;
      const found = nativeAudioOffences(fs.readFileSync(full, "utf8"));
      if (found.length) offenders.push(`${rel}: ${found.join(" | ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("исключения не пустые слова: у каждого есть причина", () => {
    for (const reason of [...Object.values(AUDIO_EXCEPTIONS), ...Object.values(FIELD_EXCEPTIONS)]) expect(reason.length).toBeGreaterThan(8);
  });

  it("сам сторож ловит нарушение (проверка проверки)", () => {
    expect(nativeFieldOffences('<input className="inp" type="date" value={v} onChange={(e) => set(e.target.value)} />')).toHaveLength(1);
    expect(nativeFieldOffences("<input\n  type='month'\n  value={m}\n/>")).toHaveLength(1);
    expect(nativeFieldOffences('<input type={"time"} />')).toHaveLength(1);
    expect(nativeFieldOffences('<input type="text" /><input type="checkbox" />')).toHaveLength(0);
    expect(nativeAudioOffences('<audio controls preload="none" src={u} />')).toHaveLength(1);
    expect(nativeAudioOffences("<audio\n  src={u}\n  onEnded={() => x()}\n  controls\n/>")).toHaveLength(1);
    expect(nativeAudioOffences('<audio ref={r} src={u} preload="metadata" />')).toHaveLength(0);
  });
});
