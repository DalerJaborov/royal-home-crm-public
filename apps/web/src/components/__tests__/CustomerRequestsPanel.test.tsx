import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { callbackRequestViewSchema } from "@royal-home/shared";
import { CustomerRequestsPanel } from "../chat/CustomerRequestsPanel";

const view = vi.hoisted(() => ({ agentId: "agent-a", allowed: true }));
vi.mock("../../store/auth", async importOriginal => ({ ...(await importOriginal<typeof import("../../store/auth")>()),
  useAuthStore: <T,>(select: (state: { agent: { id: string } | null }) => T) => select({ agent: view.agentId ? { id: view.agentId } : null }),
}));
vi.mock("../../lib/permissions", async importOriginal => ({ ...(await importOriginal<typeof import("../../lib/permissions")>()),
  useCan: () => () => view.allowed,
}));
const conversationId = "conversation-a";
function item(overrides: Record<string, unknown> = {}) {
  return callbackRequestViewSchema.parse({ id: "ec811ec4-3693-44d8-b071-b28654347e35", requestKind: "CALLBACK", lifecycleStatus: "QUEUED",
    lifecycleRevision: "7", assignedAgentId: null, acceptedAt: null, closureReason: null, topic: "Набрать вечером",
    channel: "INSTAGRAM", phone: null, requestedAt: "2026-10-15T10:00:00Z", conversationId,
    clientId: null, clientShortId: null, clientName: null, ...overrides });
}
function render(rows = [item()], cacheConversation = conversationId, cacheAgent = view.agentId) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["customer-requests", cacheConversation, cacheAgent], rows);
  const html = renderToString(<QueryClientProvider client={client}><CustomerRequestsPanel conversationId={conversationId} /></QueryClientProvider>);
  client.clear(); return html.replace(/<!-- -->/g, "");
}
beforeEach(() => { view.agentId = "agent-a"; view.allowed = true; });
describe("conversation-local customer requests SSR", () => {
  it("queued callback offers accept/close and never claims a completed call", () => {
    const html = render();
    expect(html).toContain("Принять в работу"); expect(html).toContain("Закрыть запрос");
    expect(html).not.toContain("Вернуть в очередь");
    expect(html).toContain("ещё не означает, что звонок состоялся");
  });
  it("accepted by me offers return/close, not another accept", () => {
    const html = render([item({ lifecycleStatus: "ACCEPTED", assignedAgentId: "agent-a" })]);
    expect(html).toContain("Вернуть в очередь"); expect(html).toContain("Закрыть запрос");
    expect(html).not.toContain("Принять в работу");
  });
  it("accepted by another staff member exposes no transition controls", () => {
    const html = render([item({ lifecycleStatus: "ACCEPTED", assignedAgentId: "agent-b" })]);
    expect(html).toContain("Принят другим сотрудником"); expect(html).not.toContain("<button");
  });
  it("another conversation or actor cache cannot become this conversation's panel", () => {
    expect(render([item({ topic: "FOREIGN-CONVERSATION-SENTINEL" })], "conversation-b")).not.toContain("FOREIGN-CONVERSATION-SENTINEL");
    expect(render([item({ topic: "FOREIGN-ACTOR-SENTINEL" })], conversationId, "agent-b")).not.toContain("FOREIGN-ACTOR-SENTINEL");
  });
  it("missing permission or signed-in actor hides a populated cached panel", () => {
    view.allowed = false; expect(render()).toBe("");
    view.allowed = true; view.agentId = ""; expect(render()).toBe("");
  });
});
