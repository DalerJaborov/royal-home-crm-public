import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * НИ ОДНОГО ТЕХНИЧЕСКОГО СЛОВА НА ЭКРАНЕ НАСТРОЕК.
 *
 * Правило владельца: на экранах и в уведомлениях — только русский текст, без
 * технического жаргона (имя переменной, путь к файлу, английский API-термин).
 * Ночная проверка 24.09.2026 (находка P3 №10) нашла двенадцать таких строк в
 * `pages/settings/*.tsx`, `components/SecretKeyEditor.tsx` и
 * `pages/MarketingCenter.tsx` — «push уходит» вместо «уведомления уходят»,
 * «из .env сервера», «docs/telephony-whisper.md», голые «Client ID»/«Client
 * Secret»/«Refresh token», «через Display API». Сборка и типы такую строку не
 * ловят (это валидный TypeScript/JSX), поэтому единственный сторож — текстовый
 * grep по исходнику, как и у соседнего `noApiHrefs.test.ts`.
 *
 * Комментарии в исходнике (`//`, `/* … *\/`) не считаются — там путь к файлу
 * или английский термин уместен, это не то, что видит человек на экране.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../pages/settings");
const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * ПОЧЕМУ СЮДА ДОБАВЛЕН `components/marketing` (28.09.2026).
 * Сторож смотрел только экраны настроек и сам `MarketingCenter.tsx`, а панели,
 * которые тот экран рисует, лежат рядом в `components/marketing/*.tsx` и в
 * список не попадали. Живой случай: «chat_id канала задан» в
 * `ChannelsStatusPanel.tsx` — человек видит ту же техническую строку на том же
 * экране, но сторож её не видел. Класс закрывается не отдельной строчкой, а
 * папкой целиком: панель этого экрана — такой же экран.
 */
const PANELS_ROOT = path.join(SRC_ROOT, "components/marketing");

const TARGET_FILES = [
  ...fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => path.join(ROOT, f)),
  ...fs
    .readdirSync(PANELS_ROOT)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => path.join(PANELS_ROOT, f)),
  path.join(SRC_ROOT, "components/SecretKeyEditor.tsx"),
  path.join(SRC_ROOT, "pages/MarketingCenter.tsx"),
  // Список разговоров робота (02.10.2026, аудит экрана): текст ошибки про право слушать
  // запись содержал имя права.
  path.join(SRC_ROOT, "components/LiveVoiceSessions.tsx"),
];

/** Строка комментария — путь к файлу или английский термин там не нарушение. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * Вырезает блочные и JSX-комментарии (`/* … *\/`, `{/* … *\/}`) из текста файла,
 * не сдвигая номера строк: перевод строки внутри комментария остаётся,
 * остальное заменяется пробелом. Построчная проверка ниже (`COMMENT`) ловит
 * только однострочные комментарии и первую строку блочного — многострочный
 * `{/* … *\/}`, как в `ChannelsTab.tsx`, без этого протекал бы на вторую и
 * следующие строки блока.
 */
function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Разбирает строку кода на строковые литералы: `"…"`, `'…'`, `` `…` ``. */
function literalsOf(line: string): string[] {
  const out: string[] = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[2]);
  return out;
}

const HAS_CYRILLIC = /[а-яА-ЯёЁ]/;
/** Имена функций робота и прав доступа в строке, которую читает человек (02.10.2026:
 *  «правила для save_contact, end_call и escalate_to_human», «(calls.hearRecording)»). */
const TECH_IDENTIFIER =
  /\b(?:save_contact|end_call|escalate_to_human|transfer_to_agent|send_property_sms|search_properties|get_property)\b|\bcalls\.(?:hearRecording|transcripts|ownTranscripts)\b/;
/** «push» как отдельное слово — не `.push(` (вызов метода массива в коде). */
const BARE_PUSH = /(?<!\.)\bpush\b/;

type Offense = { file: string; line: number; why: string };

function scan(): Offense[] {
  const offenses: Offense[] = [];
  for (const file of TARGET_FILES) {
    const lines = stripBlockComments(fs.readFileSync(file, "utf8")).split("\n");
    const rel = path.relative(SRC_ROOT, file);
    lines.forEach((raw, i) => {
      if (COMMENT.test(raw)) return;
      const lineNo = i + 1;
      if (/\.env\b/.test(raw)) offenses.push({ file: rel, line: lineNo, why: ".env" });
      if (/docs\//.test(raw)) offenses.push({ file: rel, line: lineNo, why: "docs/" });
      if (/title="Client /.test(raw)) offenses.push({ file: rel, line: lineNo, why: 'title="Client ' });
      if (/title="Refresh token/.test(raw)) offenses.push({ file: rel, line: lineNo, why: 'title="Refresh token' });
      if (/Display API/.test(raw)) offenses.push({ file: rel, line: lineNo, why: "Display API" });
      if (/chat_id/.test(raw)) offenses.push({ file: rel, line: lineNo, why: "chat_id" });
      if (HAS_CYRILLIC.test(raw) && TECH_IDENTIFIER.test(raw)) {
        offenses.push({ file: rel, line: lineNo, why: `имя функции или права рядом с русским текстом: ${raw.trim().slice(0, 80)}` });
      }
      for (const lit of literalsOf(raw)) {
        if (HAS_CYRILLIC.test(lit) && BARE_PUSH.test(lit)) {
          offenses.push({ file: rel, line: lineNo, why: `"push" в русской строке: ${lit}` });
        }
      }
    });
  }
  return offenses;
}

describe("технические слова на экране настроек", () => {
  it("проверяет реальные файлы (иначе сторож проверяет пустоту)", () => {
    expect(TARGET_FILES.length).toBeGreaterThan(10);
    for (const f of TARGET_FILES) expect(fs.existsSync(f)).toBe(true);
  });

  it("ни один экран настроек не показывает техническое слово вместо русского текста", () => {
    expect(scan()).toEqual([]);
  });
});
