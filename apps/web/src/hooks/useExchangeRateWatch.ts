import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { invalidateAfterSettingsChange } from "./useSettings";

/** Состояние стража курса доллара (владелец 28.11.2026): свежесть, скачок на подтверждении, подписи со старым курсом. */
export interface ExchangeRateStatus {
  rate: number | null;
  updatedAt: string | null;
  source: string | null;
  ageHours: number | null;
  stale: boolean;
  staleAfterHours: number;
  jumpLimitPct: number;
  pending: { rate: number; at: string | null; changePct: number | null } | null;
  alertPct: number;
  siteResyncEnabled: boolean;
  alertsEnabled: boolean;
  siteUsdCount: number;
  staleCaptions: { code: string; channels: string[] }[];
}

export interface CaptionRefreshSummary {
  queued: number;
  manual: { code: string; channels: string[] }[];
  skipped: number;
  remaining: number;
}

const KEY = ["exchange-rate-status"];

export function useExchangeRateStatus(enabled = true) {
  return useQuery<ExchangeRateStatus>({ queryKey: KEY, queryFn: () => api("/exchange-rate/status"), enabled, staleTime: 15_000 });
}

function useAfter() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: KEY });
    invalidateAfterSettingsChange(qc);
  };
}

export function useConfirmPendingRate() {
  const after = useAfter();
  return useMutation({ mutationFn: () => api<{ rate: number }>("/exchange-rate/confirm-pending", { method: "POST" }), onSuccess: after });
}

export function useDismissPendingRate() {
  const after = useAfter();
  return useMutation({ mutationFn: () => api<{ ok: boolean }>("/exchange-rate/dismiss-pending", { method: "POST" }), onSuccess: after });
}

export function useResyncSitePrices() {
  const after = useAfter();
  return useMutation({ mutationFn: () => api<{ count: number }>("/exchange-rate/resync-site", { method: "POST" }), onSuccess: after });
}

export function useRefreshRateCaptions() {
  const after = useAfter();
  return useMutation({ mutationFn: () => api<CaptionRefreshSummary>("/exchange-rate/refresh-captions", { method: "POST" }), onSuccess: after });
}

export function useSetRateAlertPct() {
  const after = useAfter();
  return useMutation({
    mutationFn: (alertPct: number) => api<{ alertPct: number }>("/exchange-rate/config", { method: "PATCH", body: { alertPct } }),
    onSuccess: after,
  });
}
