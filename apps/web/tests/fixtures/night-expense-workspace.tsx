// Actual workspace and hooks; transport is intercepted by the browser spec.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ExpensesWorkspace } from "../../src/components/finance/ExpensesWorkspace";
import { Toaster } from "../../src/components/ui/Toaster";
import { useAuthStore } from "../../src/store/auth";
import { initMobileUxFlag } from "../../src/hooks/useMobileUx";
import "../../src/index.css";
document.documentElement.dataset.theme = "royal-home-2026-light";
initMobileUxFlag();
const readOnly = new URLSearchParams(location.search).get("readonly") === "true";
useAuthStore.setState({ agent: { id: "synthetic-workspace-actor", fullName: "Synthetic workspace actor", phone: "fixture", role: readOnly ? "SHAREHOLDER" : "DIRECTOR" }, accessToken: "synthetic-fixture-only", hasSession: true });
const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
query.setQueryData(["me"], { permissions: readOnly ? ["finance.view"] : ["finance.view", "finance.manage"], readOnly });
Object.assign(window, { refreshWorkspaceExpenses: () => query.refetchQueries({ queryKey: ["expenses", "2026-10"], exact: true }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={query}><MemoryRouter><ExpensesWorkspace month="2026-10" canManage={!readOnly} usdToTjs={10} /><Toaster /></MemoryRouter></QueryClientProvider>);
