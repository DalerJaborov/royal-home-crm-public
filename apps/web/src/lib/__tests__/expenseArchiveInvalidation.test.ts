import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateExpenseQueries } from "../../hooks/useFinance";

/**
 * Расходы (глубокая проверка 02.10.2026, F7).
 *
 * 1. Удаление расхода гасило ["expenses"] и ["finance-summary"], но не
 *    ["expenses-archive"] (ключ другой строкой, префиксом не задевается): архив
 *    до пяти минут не показывал только что удалённую строку.
 * 2. Удаление ШАБЛОНА повторяющегося расхода — жёсткое, без корзины, — шло
 *    одним нажатием «Удалить» в строке. Теперь — через подтверждение.
 */
describe("правка расходов гасит и архив", () => {
  it("после удаления расхода архив помечен устаревшим", () => {
    const qc = new QueryClient();
    qc.setQueryData(["expenses-archive", {}], []);
    invalidateExpenseQueries(qc);
    expect(qc.getQueryState(["expenses-archive", {}])?.isInvalidated).toBe(true);
  });
});

describe("удаление шаблона повторяющегося расхода", () => {
  it("идёт через окно подтверждения, а не одним нажатием", () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../components/finance/RecurringSection.tsx");
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    expect(text).not.toMatch(/onClick=\{\(\) => \{\s*remove\.mutate\(row\.id\);/);
    expect(text).toMatch(/<ConfirmDialog/);
  });
});
