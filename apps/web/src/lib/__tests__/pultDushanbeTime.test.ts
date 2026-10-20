import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ночная проверка 24.09.2026, находка №10: на ПК время читалось в поясе
 * браузера директора (`toLocaleTimeString`/`toLocaleDateString` без
 * `timeZone`), на телефоне — по Душанбе (`dushanbeTime()`, lib/date.ts).
 * Починены четыре места пульта (PultHero2026.tsx, ActionRow.tsx,
 * PultCompanySections2026.tsx ×2). Остальные 67 вызовов по сайту — хвост,
 * записанный в docs/journal/2026-09-24-sait-chetyre-melochi.md, этот сторож
 * их не проверяет и не должен: полный список — отдельная задача.
 */
const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

// 06.10.2026: PultHero2026 и PultCompanySections2026 заменены одним экраном
// DirectorHome (контракт, задание E4), сторож переехал вместе с ними.
const FILES = ["components/pult/DirectorHome.tsx", "components/pult/ActionRow.tsx"];

/** `toLocaleTimeString(...)` / `toLocaleDateString(...)` без `timeZone` в аргументах. */
const BARE_LOCALE = /toLocale(?:Time|Date)String\(/;

describe("время пульта — по Душанбе, не по браузеру (находка №10)", () => {
  for (const file of FILES) {
    it(`${file}: нет голого toLocale(Time|Date)String`, () => {
      const full = path.join(SRC_ROOT, file);
      const text = fs.readFileSync(full, "utf8");
      // Каждый вызов toLocale*String должен читать timeZone где-то в следующих
      // ~120 символах (сам вызов может переноситься на пределы объекта опций),
      // либо не встречаться вовсе — обе починки заменили вызовы на dushanbeTime/dushanbeDate.
      const offenders: number[] = [];
      let match: RegExpExecArray | null;
      const re = new RegExp(BARE_LOCALE, "g");
      while ((match = re.exec(text))) {
        const windowText = text.slice(match.index, match.index + 160);
        if (!windowText.includes("timeZone")) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(line);
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${file}: зовёт dushanbeTime/dushanbeDate из lib/date`, () => {
      const full = path.join(SRC_ROOT, file);
      const text = fs.readFileSync(full, "utf8");
      expect(/dushanbe(Time|Date)\(/.test(text)).toBe(true);
    });
  }
});
