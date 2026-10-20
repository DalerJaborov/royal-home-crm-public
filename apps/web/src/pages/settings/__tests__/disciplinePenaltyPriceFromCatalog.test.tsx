import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * «Цена штрафа» за бездействие — только в таблице баллов (глубокая проверка
 * 02.10.2026, C11; решение владельца «да, по советам»).
 *
 * Поле «Цена штрафа, баллов» в «Дисциплине» ни на что не влияло: счёт агента
 * снимал цену из таблицы баллов Royal Score. Экран его больше не показывает и
 * при сохранении не отправляет — две цены одного штрафа не живут на двух экранах.
 */
const mutateAsync = vi.fn(async () => ({}));
vi.mock("../../../hooks/useSettings", () => ({
  useSettings: () => ({
    data: { inactivityWarnAfterDays: 3, inactivityPenaltyAfterDays: 5, inactivityPenaltyPoints: 5 },
  }),
  useUpdateSettings: () => ({ mutateAsync, isPending: false, isError: false, error: null }),
}));
vi.mock("../../../components/MutationError", () => ({ MutationError: () => null }));

const { DisciplineSection } = await import("../DisciplineTab");

describe("«Дисциплина»: цена штрафа за бездействие", () => {
  it("на экране нет поля «Цена штрафа», есть ссылка на таблицу баллов", () => {
    const html = renderToString(<DisciplineSection />).replace(/<!-- -->/g, "");
    expect(html).toContain("Штраф через, дней");
    expect(html).not.toContain("Цена штрафа");
    expect(html).toContain("в таблице баллов");
  });

  it("при сохранении поле не отправляется (ни в начальные значения формы, ни в запрос)", () => {
    const src = readFileSync(fileURLToPath(new URL("../DisciplineTab.tsx", import.meta.url)), "utf8");
    expect(src).not.toMatch(/inactivityPenaltyPoints\s*:/);
  });
});
