import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * НИ ОДНОЙ ССЫЛКИ БРАУЗЕРА НА АДРЕС CRM.
 *
 * `<a href="/api/v1/...">` и `<img|audio|video src="/api/v1/...">` уходят без
 * заголовка `Authorization`, а CRM авторизует только по нему — сервер отвечает
 * 401, и поломка выглядит как «ничего не происходит»: ни ошибки на экране, ни
 * записи в журнале. Сборка и типы такую строку пропускают, поэтому единственный
 * сторож — этот тест.
 *
 * Правильный приём — `lib/downloadFile.ts` (или `api(..., { responseType:
 * "blob" })` там, где файл нужен плеером, а не скачиванием).
 *
 * Поймано 19.09.2026: документ сделки открывал пустую вкладку, «скачать шаблон»
 * в «Настройках» не скачивал ничего. До этого тот же класс чинили 10.08.2026 на
 * записи разговора.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Файлы-площадки (`pages/dev/*`) в прод-сборку не входят и живут на заглушках. */
const IGNORED = ["/dev/", "\\dev\\"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out.filter((f) => !IGNORED.some((skip) => f.includes(skip)));
}

/** `href="/api/v1/..."`, `href={`/api/v1/...`}` и то же самое для `src`. */
const BROWSER_LINK = /\b(?:href|src)=\{?\s*[`"]\/api\/v1\//;

/** Строка комментария: разбор этой же поломки описан словами в нескольких
 *  файлах, и сторож не должен принимать объяснение за нарушение. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

describe("ссылки на адреса CRM", () => {
  it("находит файлы исходников (иначе сторож проверяет пустоту)", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
  });

  it("ни один экран не тянет файл CRM ссылкой браузера", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (COMMENT.test(line)) return;
        if (BROWSER_LINK.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
