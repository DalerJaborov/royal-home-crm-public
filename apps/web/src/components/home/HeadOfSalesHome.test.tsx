import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SalesControlHome } from "@royal-home/shared";
import type { TeamLive } from "../../hooks/useTeamLive";
import { HeadOfSalesHome } from "./HeadOfSalesHome";

const state = vi.hoisted(() => ({ actorId: "rop-a", analytics: true, team: true, reports: true }));
vi.mock("../../store/auth", () => ({ useAuthStore: <T,>(select: (value: { agent: { id: string; role: string } }) => T) => select({ agent: { id: state.actorId, role: "HEAD_OF_SALES" } }) }));
vi.mock("../../lib/permissions", () => ({ useCan: () => (permission: string) => permission === "dashboard.analytics" ? state.analytics : permission === "team.viewFull" ? state.team : permission === "reports.view" ? state.reports : false }));

const task = (overrides: Partial<SalesControlHome["tasks"][number]> = {}): SalesControlHome["tasks"][number] => ({
  id: "task-1", clientId: "client-1", clientShortId: 1024, clientName: "Тестовый клиент", title: "Уточнить планы по покупке",
  dueAt: "2026-10-27T08:00:00.000Z", responseAction: "RECEIPT", ...overrides,
});
const home = (overrides: Partial<SalesControlHome> = {}): SalesControlHome => ({ tasks: [task()], limited: false, actionsEnabled: true, ...overrides });
const team: TeamLive = { agents: [{ id: "agent-1", fullName: "Команда-сентинел", avatarUrl: null, activeLoad: 3, pendingAccept: 1, acceptedToday: 2, escalated: 0 }], unaccepted: [], unacceptedTotal: 0, escalatedTotal: 0, queuedTotal: 0 };

function render(data: SalesControlHome | undefined, options: { actor?: string; cachedActor?: string; otherActorData?: SalesControlHome; teamData?: TeamLive; permissions?: Partial<typeof state> } = {}) {
  state.actorId = options.actor ?? "rop-a";
  state.analytics = options.permissions?.analytics ?? true;
  state.team = options.permissions?.team ?? true;
  state.reports = options.permissions?.reports ?? true;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  if (data) queryClient.setQueryData(["rop-work", options.cachedActor ?? state.actorId], data);
  if (options.otherActorData) queryClient.setQueryData(["rop-work", "rop-b"], options.otherActorData);
  if (options.teamData) queryClient.setQueryData(["dashboard-team-live"], options.teamData);
  const html = renderToString(<QueryClientProvider client={queryClient}><MemoryRouter><HeadOfSalesHome /></MemoryRouter></QueryClientProvider>);
  queryClient.clear();
  return html.replace(/<!-- -->/g, "");
}

beforeEach(() => { state.actorId = "rop-a"; state.analytics = true; state.team = true; state.reports = true; });

describe("head of sales home SSR", () => {
  it("renders the actor-scoped work queue and neutral tasks without response actions", () => {
    const html = render(home({ tasks: [task({ responseAction: null })] }));
    expect(html).toContain("Уточнить планы по покупке");
    expect(html).toContain("В работе");
    expect(html).not.toContain("Принять в работу");
    expect(html).not.toContain("Сохранить отчёт");
  });

  it("does not render work cached for a different signed-in actor", () => {
    const html = render(home({ tasks: [] }), { actor: "rop-a", otherActorData: home({ tasks: [task({ title: "FOREIGN-ACTOR-QUEUE-SENTINEL" })] }) });
    expect(html).not.toContain("FOREIGN-ACTOR-QUEUE-SENTINEL");
    expect(html).toContain("Нет задач, требующих ответа");
  });

  it("hides cached team information when either team permission is missing", () => {
    const html = render(home(), { teamData: team, permissions: { analytics: false } });
    expect(html).not.toContain("Нагрузка команды");
    expect(html).not.toContain("Команда-сентинел");
    expect(html).not.toContain("3 клиентов");
  });

  it("does not offer response mutations while server actions are disabled", () => {
    const html = render(home({ actionsEnabled: false }));
    expect(html).toContain("Ответы по этим задачам временно недоступны");
    expect(html).not.toContain("Принять в работу");
    expect(html).toContain("Открыть клиента");
  });

  it("shows the empty queue and calendar next step", () => {
    const html = render(home({ tasks: [] }));
    expect(html).toContain("Нет задач, требующих ответа");
    expect(html).toContain("Открыть календарь");
  });
});
