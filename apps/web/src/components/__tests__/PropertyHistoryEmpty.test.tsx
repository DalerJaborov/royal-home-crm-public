import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PropertyHistoryCard } from "../PropertyHistoryCard";

/**
 * Вкладка «История» на компьютере открывалась совсем пустой (разбор карточки
 * объекта 24.09.2026, пункт F): карточка молча не рисовалась, когда записей нет
 * или смотреть их нельзя. Во вкладке теперь честная строка; в стопке секций
 * пустую карточку по-прежнему не рисуем.
 */
const render = (node: React.ReactElement) =>
  renderToString(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

describe("PropertyHistoryCard — пустое состояние", () => {
  it("во вкладке без права — объяснение, а не пустое место", () => {
    const html = render(<PropertyHistoryCard propertyId="p1" status="AVAILABLE" isResponsible={false} showEmpty />);
    expect(html).toContain("История объекта");
    expect(html).toContain("видят руководитель и агент этого объекта");
  });

  it("в стопке секций пустая карточка не рисуется", () => {
    const html = render(<PropertyHistoryCard propertyId="p1" status="AVAILABLE" isResponsible={false} />);
    expect(html).toBe("");
  });
});
