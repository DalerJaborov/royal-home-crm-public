import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { customerAgentOwnerStateSchema } from "@royal-home/shared";
import { CustomerAgentRolloutSection } from "./CustomerAgentRolloutSection";

vi.mock("../../lib/api", () => ({ api: vi.fn(), ApiError: class extends Error {} }));
const state = customerAgentOwnerStateSchema.parse({
  policyRevision: "3", contractVersion: "scoped", rolloutMode: "ACTIVE",
  activeAgentRevisionId: "a".repeat(64), rollout: null, capabilities: {},
  scopes: [{ endpointScopeId: "10000000-0000-4000-8000-000000000001", channel: "INSTAGRAM",
    surface: "dm", displayLabel: "Royal Home Info", writeAssurance: "per_event_required" }],
  moreScopes: false, counts: [{ lane: "CORE", count: "2" }], disabled: ["SHADOW", "PHONE"],
  stickyScope: "new_unassigned_only", existingPromotion: "not_implemented",
  dailyCap: "not_configured", configId: "royal-customer-g36-tools-20261015-v2",
});
function render(value?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (value) client.setQueryData(["settings", "customer-agent"], value);
  return renderToStaticMarkup(<QueryClientProvider client={client}><CustomerAgentRolloutSection /></QueryClientProvider>);
}
describe("Customer agent owner settings", () => {
  it("cannot publish before server state arrives", () => {
    const html = render();
    expect(html).toContain("Загружаем состояние");
    expect(html).not.toContain("Включить текстового агента");
  });
  it("uses the account title, exposes limited scope and does not publish without acknowledgements", () => {
    const html = render(state);
    expect(html).toContain("Royal Home Info");
    expect(html).toContain("Новый бот: 2");
    expect(html).toContain("Параллельное сравнение, голос");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Опубликовать изменения/);
    expect(html).toContain("отсутствие настроенного дневного лимита");
  });
  it("rejects malformed server state rather than guessing account ownership", () => {
    expect(customerAgentOwnerStateSchema.safeParse({ ...state, scopes: [{ ...state.scopes[0], endpointScopeId: "caller-picked" }] }).success).toBe(false);
  });
  it("keeps the distinct résumé-protocol acknowledgement unchecked by default", () => {
    const html = render(state);
    const acknowledgement = html.match(/Обновить вопросы и анкеты кандидатов[\s\S]*?<input[^>]*>/)?.[0];
    expect(acknowledgement).toBeDefined();
    expect(acknowledgement).not.toContain('checked=""');
    expect(html).toContain("Решение о найме принимает человек");
    expect(render({ ...state, rolloutMode: "OFF" })).not.toContain("Обновить вопросы и анкеты кандидатов");
  });
  it("keeps quality/continuity consent separate and unchecked until the owner selects it", () => {
    const html = render(state);
    const acknowledgement = html.match(/Обновить качество и продолжение диалога[\s\S]*?<input[^>]*>/)?.[0];
    expect(acknowledgement).toBeDefined();
    expect(acknowledgement).not.toContain('checked=""');
    expect(acknowledgement).toContain("Требуется действующее подтверждение администратора");
    expect(acknowledgement).toContain("права CRM и лимиты остаются прежними");
    expect(acknowledgement).toContain("Реальная отправка вложений включается отдельно");
    expect(render({ ...state, rolloutMode: "OFF" })).not.toContain("Обновить качество и продолжение диалога");
  });
  it("offers retained50 refresh only from a complete active policy, with an explicit reason", () => {
    const ready = customerAgentOwnerStateSchema.parse({ ...state, rollout: {
      version: 1, cohortId: "10000000-0000-4000-8000-000000000002", candidateRevisionId: state.activeAgentRevisionId,
      percentBasisPoints: 5000, allowed: state.scopes.map(({ endpointScopeId, channel, surface }) => ({ endpointScopeId, channel, surface })),
    } });
    const html = render(ready);
    expect(html).toContain("Сохраняет текущую долю 50%");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Обновить версию бота/);
    expect(render(state)).not.toContain("Обновить версию бота");
    expect(render({ ...ready, rolloutMode: "OFF" })).not.toContain("Обновить версию бота");
  });
});
