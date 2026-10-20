import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PropertyHistoryCard } from "../PropertyHistoryCard";

/**
 * Находка №147 (ночная проверка 24.09.2026): маркетинг и монтажёр видели на
 * вкладке «История» чужого объекта отказ, хотя сервер (routes/auditLog.ts) им
 * историю отдаёт. Права берутся из пресета роли, пока профиль не загрузился.
 */
const auth = vi.hoisted(() => ({ role: "AGENT" as string }));
vi.mock("../../store/auth", () => ({
  useAuthStore: <T,>(select: (s: { agent: { id: string; role: string } }) => T) =>
    select({ agent: { id: "someone", role: auth.role } }),
}));

const DENIED = "видят руководитель и агент этого объекта";

function render(role: string): string {
  auth.role = role;
  return renderToString(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PropertyHistoryCard propertyId="p1" status="AVAILABLE" isResponsible={false} showEmpty />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PropertyHistoryCard — доступ по правам, как на сервере", () => {
  it("маркетинг (properties.viewOwners) — отказа нет", () => {
    expect(render("MARKETING")).not.toContain(DENIED);
  });

  it("монтажёр (properties.editForeign) — отказа нет", () => {
    expect(render("EDITOR")).not.toContain(DENIED);
  });

  it("рядовой агент на чужом объекте — по-прежнему отказ", () => {
    expect(render("AGENT")).toContain(DENIED);
  });
});
