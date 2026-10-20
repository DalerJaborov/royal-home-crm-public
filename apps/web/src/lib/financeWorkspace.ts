export const FINANCE_WORKSPACES = ["expenses", "recurring", "calendar", "table", "overview", "payouts"] as const;
export type FinanceWorkspace = typeof FINANCE_WORKSPACES[number];

export function financeWorkspace(value: string | null): FinanceWorkspace {
  return FINANCE_WORKSPACES.find((workspace) => workspace === value) ?? "expenses";
}

/** Clone so browser history snapshots and unrelated shell/filter params survive. */
export function financeWorkspaceSearch(previous: URLSearchParams, workspace: FinanceWorkspace): URLSearchParams {
  const next = new URLSearchParams(previous);
  if (workspace === "expenses") next.delete("workspace");
  else next.set("workspace", workspace);
  return next;
}
