import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TransferRequestRespondInput, TransferRequestView } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Передача РОП — уведомление директору (16.11.2026): ждущие решения (большое окно директора) и ответ
 * «Подтвердить» / «Отклонить». Свежесть — живое событие `transfer.pending` (lib/liveEvents.ts) плюс запасной опрос.
 */
export const TRANSFER_PENDING_KEY = ["transfer-requests", "pending"] as const;

export function usePendingTransferReviews(enabled = true) {
  return useQuery({
    queryKey: TRANSFER_PENDING_KEY,
    queryFn: () => api<{ items: TransferRequestView[] }>("/transfer-requests/pending").then((r) => r.items),
    enabled,
    // Окно нельзя пропустить: даже без живого потока проверяем раз в минуту.
    refetchInterval: 60_000,
  });
}

export function useOutgoingTransferRequests(enabled = true) {
  return useQuery({
    queryKey: ["transfer-requests", "outgoing"],
    queryFn: () => api<{ items: TransferRequestView[] }>("/transfer-requests/outgoing").then((r) => r.items),
    enabled,
  });
}

export function useRespondTransferRequest(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TransferRequestRespondInput) =>
      api<{ request: TransferRequestView }>(`/transfer-requests/${id}/respond`, { method: "POST", body }),
    meta: { silent: true },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["transfer-requests"] });
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["property"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["client"] });
    },
  });
}
