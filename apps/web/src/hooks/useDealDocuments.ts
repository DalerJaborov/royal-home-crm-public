import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DealDocumentKind } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Документы сделки (Пачка 14, 11.09.2026) — чек-лист перед закрытием (свидетельство
 * собственности, договор, паспорт, квитанция). Роуты — apps/api/src/routes/dealDocuments.ts.
 */
export interface DealDocument {
  id: string;
  kind: DealDocumentKind;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  uploadedByName: string;
}

export function useDealDocuments(dealId: string | null) {
  return useQuery({
    queryKey: ["deal-documents", dealId],
    queryFn: () => api<DealDocument[]>(`/deals/${dealId}/documents`),
    enabled: !!dealId,
  });
}

export function useUploadDealDocument(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, kind }: { file: File; kind: DealDocumentKind }) => {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      return api<DealDocument>(`/deals/${dealId}/documents`, { method: "POST", body: form });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deal-documents", dealId] }),
  });
}

export function useDeleteDealDocument(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api<void>(`/deals/${dealId}/documents/${documentId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deal-documents", dealId] }),
  });
}

export interface DealPayoutStatus {
  stage: string;
  realtorPayoutAt: string | null;
  realtorPayoutById: string | null;
  realtorPayoutNote: string | null;
}

/** Статус выплаты — GET /deals/:id/payout (основной список сделок этих полей не
 *  отдаёт, см. докстринг apps/api/src/routes/dealPayout.ts). */
export function useDealPayoutStatus(dealId: string | null) {
  return useQuery({
    queryKey: ["deal-payout", dealId],
    queryFn: () => api<DealPayoutStatus>(`/deals/${dealId}/payout`),
    enabled: !!dealId,
  });
}

/** Отметить комиссию по сделке выплаченной (POST /deals/:id/payout). Идемпотентно
 *  на сервере — повторный вызов на уже выплаченной сделке вернёт 409. */
export function useDealPayout(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note?: string) => api<{ realtorPayoutAt: string }>(`/deals/${dealId}/payout`, { method: "POST", body: { note } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deals"] });
      qc.invalidateQueries({ queryKey: ["deal-payout", dealId] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
    },
  });
}
