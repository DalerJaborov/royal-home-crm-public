import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ownerQuestionViewSchema } from "@royal-home/shared";
import { OwnerQuestionsBanner } from "../OwnerQuestionsBanner";

const view = vi.hoisted(() => ({ allowed: true }));
vi.mock("../../lib/permissions", async importOriginal => ({ ...(await importOriginal<typeof import("../../lib/permissions")>()),
  useCan: () => () => view.allowed,
}));
function item(overrides: Record<string, unknown> = {}) {
  return ownerQuestionViewSchema.parse({ id: "c31698bf-4665-478f-8d3f-a4ce1b80b9a9", question: "Остаётся ли мебель?", askedAt: "2026-10-15T10:00:00Z",
    clientId: null, clientShortId: null, clientName: null, propertyId: null, propertyShortId: null, propertyTitle: null,
    propertyPrice: null, propertyCurrency: null, propertyThumbUrl: null, answer: null, answeredAt: null, managedRevision: "3", deliveryStatus: "QUEUED", ...overrides });
}
function render(row = item()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["owner-questions"], { items: [row] });
  const html = renderToString(<QueryClientProvider client={client}><MemoryRouter><OwnerQuestionsBanner /></MemoryRouter></QueryClientProvider>);
  client.clear(); return html.replace(/<!-- -->/g, "");
}
beforeEach(() => { view.allowed = true; });
describe("managed owner question SSR", () => {
  it("unanswered managed question saves an answer without claiming auto-delivery", () => {
    const html = render();
    expect(html).toContain("Сохранить ответ"); expect(html).toContain("автоматическая отправка пока недоступна");
    expect(html).toContain("<textarea"); expect(html).not.toContain("Ответить клиенту");
  });
  it("answered HELD is read-only with saved text and no delivered/sent claim", () => {
    const html = render(item({ answer: "Мебель остаётся.", answeredAt: "2026-10-15T10:01:00Z", managedRevision: "4", deliveryStatus: "HELD" }));
    expect(html).toContain("Мебель остаётся."); expect(html).toContain("клиенту ещё не доставлен");
    expect(html).not.toContain("<textarea"); expect(html).not.toContain("Сохранить ответ");
    expect(html).not.toContain("Ответ отправлен клиенту");
  });
  it("legacy unanswered question preserves its existing send action", () => {
    const html = render(item({ managedRevision: null, deliveryStatus: null }));
    expect(html).toContain("Ответить клиенту"); expect(html).toContain("<textarea");
  });
  it("dashboard permission still gates a populated question cache", () => {
    view.allowed = false; expect(render()).toBe("");
  });
});
