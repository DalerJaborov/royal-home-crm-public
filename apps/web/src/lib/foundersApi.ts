import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FounderContributionCreateInput, FounderContributionItem, FounderContributionUpdateInput, FounderItem, FounderTotals } from "@royal-home/shared";
import { api } from "./api";
import { assertClaudeFinanceWrite } from "./claudeFinanceApi";
import type { MyProfile } from "./meProfile";
import { useAuthStore } from "../store/auth";

/** Взносы учредителей: списки и итоги. Запись требует finance.manage, как и остальные деньги. */
export const foundersKeys = {
  all: ["founders"] as const,
  list: (includeDeleted: boolean) => ["founders", "list", includeDeleted] as const,
  totals: (month: string) => ["founders", "totals", month] as const,
  contributions: (month: string) => ["founders", "contributions", month] as const,
};

export function useFounders(includeDeleted = false) {
  return useQuery({ queryKey: foundersKeys.list(includeDeleted), queryFn: () => api<FounderItem[]>(`/founders${includeDeleted ? "?includeDeleted=1" : ""}`), staleTime: 30_000 });
}
export function useFounderTotals(month: string) {
  return useQuery({ queryKey: foundersKeys.totals(month), queryFn: () => api<FounderTotals>(`/founders/totals?month=${month}`), staleTime: 30_000 });
}
export function useFounderContributions(month: string) {
  return useQuery({ queryKey: foundersKeys.contributions(month), queryFn: () => api<FounderContributionItem[]>(`/founders/contributions?month=${month}`), staleTime: 30_000 });
}

function useFoundersMutation<T, R>(run: (value: T) => Promise<R>) {
  const qc = useQueryClient();
  const actorId = useAuthStore((s) => s.agent?.id);
  const epoch = useAuthStore((s) => s.sessionEpoch);
  return useMutation({
    mutationFn: (value: T) => {
      assertClaudeFinanceWrite(useAuthStore.getState(), { actorId, epoch, me: qc.getQueryData<MyProfile>(["me"]) });
      return run(value);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: foundersKeys.all }),
  });
}

export function useAddFounder() {
  return useFoundersMutation((name: string) => api<FounderItem>("/founders", { method: "POST", body: { name } }));
}
export function useUpdateFounder() {
  return useFoundersMutation(({ id, body }: { id: string; body: { name?: string; sortOrder?: number } }) => api<FounderItem>(`/founders/${id}`, { method: "PATCH", body }));
}
export function useDeleteFounder() {
  return useFoundersMutation((id: string) => api<FounderItem>(`/founders/${id}`, { method: "DELETE" }));
}
export function useRestoreFounder() {
  return useFoundersMutation((id: string) => api<FounderItem>(`/founders/${id}/restore`, { method: "PATCH" }));
}
export function useSaveContribution() {
  return useFoundersMutation(({ id, body, idempotencyKey }: { id?: string; body: FounderContributionCreateInput | FounderContributionUpdateInput; idempotencyKey?: string }) =>
    api<FounderContributionItem>(`/founders/contributions${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body, idempotencyKey }));
}
export function useDeleteContribution() {
  return useFoundersMutation((id: string) => api(`/founders/contributions/${id}`, { method: "DELETE" }));
}
export function useRestoreContribution() {
  return useFoundersMutation((id: string) => api(`/founders/contributions/${id}/restore`, { method: "PATCH" }));
}
