import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TransferRequestCreateInput, TransferRequestRespondInput, TransferRequestView } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Передача с подтверждением хозяина (16.11.2026): ждущие моего ответа (большое окно),
 * мои исходящие запросы, создание и ответ. Свежесть — живое событие `transfer.pending`
 * (lib/liveEvents.ts) плюс запасной опрос раз в минуту.
 */
export const TRANSFER_INCOMING_KEY = ["transfer-requests", "incoming"] as const;

export function useIncomingTransferRequests(enabled = true) {
  return useQuery({
    queryKey: TRANSFER_INCOMING_KEY,
    queryFn: () => api<{ items: TransferRequestView[] }>("/transfer-requests/incoming").then((r) => r.items),
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

function invalidateAfterTransfer(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["transfer-requests"] });
  qc.invalidateQueries({ queryKey: ["properties"] });
  qc.invalidateQueries({ queryKey: ["property"] });
  qc.invalidateQueries({ queryKey: ["clients"] });
  qc.invalidateQueries({ queryKey: ["client"] });
}

export function useRespondTransferRequest(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TransferRequestRespondInput) =>
      api<{ request: TransferRequestView }>(`/transfer-requests/${id}/respond`, { method: "POST", body }),
    meta: { silent: true },
    onSettled: () => invalidateAfterTransfer(qc),
  });
}

export type CreateTransferResult = {
  pending: boolean;
  immediate: boolean;
  created?: boolean;
  request?: TransferRequestView;
};

export function useCreateTransferRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TransferRequestCreateInput) =>
      api<CreateTransferResult>("/transfer-requests", { method: "POST", body }),
    meta: { silent: true },
    onSuccess: () => invalidateAfterTransfer(qc),
  });
}
