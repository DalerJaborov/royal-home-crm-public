import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

/**
 * Аудит 04.10.2026, WEB-PAGES22: пока настройки не загружены, форма Royal Score
 * имела активную кнопку «Сохранить» и могла затереть настроенные цены событий
 * пустым набором и значениями по умолчанию.
 */
const state: { settings: unknown } = { settings: undefined };

vi.mock("../../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../hooks/useSettings")>();
  return {
    ...actual,
    useSettings: () => ({ data: state.settings }),
    useUpdateSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

import { RoyalScoreEventsSection } from "../TeamTab";

const render = () =>
  renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <RoyalScoreEventsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** Кнопка «Сохранить»: достаём её тег целиком. */
const saveButton = (html: string) => /<button[^>]*>Сохранить<\/button>/.exec(html)?.[0] ?? "";

describe("Royal Score: сохранение до загрузки настроек", () => {
  it("настройки не пришли: кнопка «Сохранить» заблокирована", () => {
    state.settings = undefined;
    const button = saveButton(render());
    expect(button).not.toBe("");
    expect(button).toContain("disabled");
  });

  it("настройки пришли: кнопка доступна", () => {
    state.settings = { royalScoreEnabled: true, royalScoreEventPoints: {}, royalScoreWindowDays: 30, royalScoreStartingScore: 100 };
    const button = saveButton(render());
    expect(button).not.toBe("");
    expect(button).not.toContain("disabled");
  });
});
