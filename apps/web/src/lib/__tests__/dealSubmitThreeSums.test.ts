import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Закрытие сделки — три суммы руками (владелец 25.11.2026): за сколько
 * фактически продали, сколько получает агент, сколько получает компания.
 * Цена продажи не подставляется из объявления, процентов в форме нет.
 */
const src = readFileSync(
  fileURLToPath(new URL("../../components/DealSubmitModal.tsx", import.meta.url)),
  "utf8",
);

describe("окно закрытия сделки: три суммы руками", () => {
  it("цена продажи не подставляется из цены объявления", () => {
    expect(src).not.toMatch(/useState\([^)]*listedPriceNum/);
    expect(src).toMatch(/useState\(initial\?\.soldPrice \? String\(Number\(initial\.soldPrice\)\) : ""\)/);
  });

  it("три поля с понятными подписями и без процентов", () => {
    expect(src).toContain("За сколько фактически продали?");
    expect(src).toContain("Получает агент");
    expect(src).toContain("Получает компания");
    expect(src).not.toMatch(/%\s*<|процент(ом|а)?<\/span>/);
  });
});
