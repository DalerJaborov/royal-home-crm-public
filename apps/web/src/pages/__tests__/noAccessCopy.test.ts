import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Клик-аудит 26.11.2026: на «Интеграциях» и «Резервных копиях» без прав стояло «нет права на журнал
 * ошибок» — внутреннее название права, человеку непонятное и не про этот экран. Пять экранов
 * системной группы (право auditLog.view) говорят одно и то же простыми словами.
 */
const PAGES = ["Backups", "Integrations", "Health", "StuckWork", "ChannelDetail"];

describe("экраны системной группы без прав: простые слова", () => {
  for (const name of PAGES) {
    it(`${name}: без «права на журнал ошибок»`, () => {
      const src = readFileSync(join(__dirname, "..", `${name}.tsx`), "utf8");
      expect(src).not.toContain("право на журнал ошибок");
      expect(src).toContain("попросите директора");
    });
  }
});
