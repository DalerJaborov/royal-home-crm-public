// Synthetic intercepted transport only: actual component, query/mutation hooks and toast.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ClaudeExpenseTable } from "../../src/components/finance/ClaudeExpenseTable";
import { Toaster } from "../../src/components/ui/Toaster";
import { useAuthStore } from "../../src/store/auth";
import { initMobileUxFlag } from "../../src/hooks/useMobileUx";
import "../../src/index.css";

document.documentElement.dataset.theme = "royal-home-2026-light";
initMobileUxFlag();
const readOnly = new URLSearchParams(location.search).get("readonly") === "true";
useAuthStore.setState({
  agent: { id: "synthetic-finance-actor", fullName: "Synthetic finance actor", phone: "fixture", role: readOnly ? "SHAREHOLDER" : "DIRECTOR" },
  accessToken: "synthetic-fixture-only", hasSession: true,
});
const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
query.setQueryData(["me"], { permissions: readOnly ? ["finance.view"] : ["finance.view", "finance.manage"], readOnly });
// Refresh through the real page query while the confirmation retains its opening snapshot.
Object.assign(window, { refreshExpenseFixture: () => query.refetchQueries({ queryKey: ["expenses", "claude-page"] }) });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={query}><MemoryRouter>
    <ClaudeExpenseTable month="2026-10" canManage={!readOnly} onEdit={() => undefined} />
    <Toaster />
  </MemoryRouter></QueryClientProvider>
);
