/**
 * КАНДИДАТЫ НА СЛИЯНИЕ ДОСЬЕ. Код находит их сам, решает только человек с
 * правом объединять дубликаты: склеенные досье двух людей означают чужой бюджет
 * и чужой адрес в ответе бота.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContactCategory } from "@royal-home/shared";
import { api } from "../lib/api";

export interface ContactLinkProfile {
  id: string;
  displayName: string | null;
  category: ContactCategory;
  messagesIn: number;
  lastSeenAt: string;
}

export interface ContactLinkCandidate {
  id: string;
  reason: string;
  createdAt: string;
  left: ContactLinkProfile;
  right: ContactLinkProfile;
}

export function useContactLinks(enabled = true) {
  return useQuery({
    queryKey: ["contact-links"],
    queryFn: async () => (await api<{ items: ContactLinkCandidate[] }>("/contacts/links")).items,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Решение по кандидату. Обновляем и очередь, и диалоги: то же досье висит на
 * всех переписках человека, и оставить в открытой вкладке «похоже, это один
 * человек» после слияния значило бы показать решение, которое уже принято.
 */
export function useDecideContactLink() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { id: string; decision: "confirm" | "dismiss" }>({
    mutationFn: ({ id, decision }) => api<{ ok: boolean }>(`/contacts/links/${id}/${decision}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact-links"] });
      qc.invalidateQueries({ queryKey: ["conversations"], exact: false });
    },
  });
}
