import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientKind, ClientSource, ClientStatus } from "@royal-home/shared";
import { api } from "../lib/api";

export interface DuplicateClient {
  id: string;
  fullName: string;
  phone: string;
  status: ClientStatus;
  source: ClientSource;
  createdAt: string;
  assignedAgent: { id: string; fullName: string } | null;
  _count: { interactions: number; deals: number };
}

export interface DuplicateGroup {
  // "identity" — совпадение телефона/Telegram (надёжный сигнал). "nameAndPhone" —
  // раздел L, уровень 4 (03.09.2026): похожее имя + похожий (не идентичный) номер,
  // сигнал слабее — см. комментарий в routes/clients/duplicates.ts.
  reason: "identity" | "nameAndPhone";
  clients: DuplicateClient[];
}

export function useDuplicates(enabled = true) {
  return useQuery({
    queryKey: ["client-duplicates"],
    queryFn: () => api<DuplicateGroup[]>("/clients/duplicates"),
    enabled,
    staleTime: 5 * 60 * 1000,
    // Без этого унаследовал бы общий 60с (queryClient.ts) — список дублей
    // меняется редко, опрашивать чаще staleTime незачем.
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useMergeClients() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { primaryId: string; duplicateId: string; force?: boolean }) =>
      api("/clients/merge", { method: "POST", body }),
    // silent: оба вызывающих отчитываются сами и точнее — MergeClientModal своим
    // «Карточки объединены — „Имя“ перенесена в эту», DuplicatesModal плашкой с
    // ошибкой над списком (а на успехе группа дубликатов просто исчезает).
    // Общий тост вставал поверх них вторым сообщением (аудит 22.08.2026, раунд 5).
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client-duplicates"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["client-similar-notes"] });
    },
  });
}

export interface SimilarNotesClient {
  id: string;
  shortId: number;
  fullName: string;
  phone: string;
  kind: ClientKind;
  requirementsNotes: string | null;
  similarity: number;
}

/** Подсказка «похожее описание» на карточке клиента (владелец 19.08.2026) — см.
 *  GET /clients/:id/similar-notes и комментарий там же про живой случай (клиент
 *  писал с одного номера, звонил с другого). */
export function useSimilarNotes(clientId: string | undefined) {
  return useQuery({
    queryKey: ["client-similar-notes", clientId],
    queryFn: () => api<SimilarNotesClient[]>(`/clients/${clientId}/similar-notes`),
    enabled: !!clientId,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

/** «Это разные люди» — отклонить подсказку похожести, чтобы не всплывала снова
 *  для этой же пары карточек (владелец 19.08.2026, см. POST .../dismiss). */
export function useDismissSimilarClient(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (otherId: string) => api(`/clients/${clientId}/similar-notes/${otherId}/dismiss`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client-similar-notes", clientId] });
    },
  });
}
