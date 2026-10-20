import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WaFirstContactStatus, WaTemplatesOverview } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Первое сообщение клиенту в WhatsApp (24.09.2026): кнопка в карточке клиента и
 * раздел в Настройках. Сервер — routes/clients/whatsappFirstContact.ts и
 * routes/whatsappTemplates.ts.
 */

export function useWaFirstContactStatus(clientId: string, enabled = true) {
  return useQuery({
    queryKey: ["client", clientId, "whatsapp-first"],
    queryFn: () => api<WaFirstContactStatus>(`/clients/${clientId}/whatsapp-first`),
    enabled,
    // Отказ по правам (чужая карточка) — не повод повторять: кнопки просто не будет.
    retry: false,
    staleTime: 60 * 1000,
  });
}

export function useSendWaFirstContact(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyShortId: number | null) =>
      api<WaFirstContactStatus>(`/clients/${clientId}/whatsapp-first`, { method: "POST", body: { propertyShortId } }),
    onSuccess: (data) => {
      qc.setQueryData(["client", clientId, "whatsapp-first"], data);
      // Сообщение легло в переписку клиента — карточка перечитает её.
      qc.invalidateQueries({ queryKey: ["client"] });
    },
    onError: () => qc.invalidateQueries({ queryKey: ["client", clientId, "whatsapp-first"] }),
  });
}

export function useWaTemplates(enabled = true) {
  return useQuery({
    queryKey: ["whatsapp-templates"],
    queryFn: () => api<WaTemplatesOverview>("/whatsapp-templates"),
    enabled,
  });
}

export function useSubmitWaTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<WaTemplatesOverview>("/whatsapp-templates/submit", { method: "POST" }),
    onSuccess: (data) => qc.setQueryData(["whatsapp-templates"], data),
  });
}

export function useRefreshWaTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<WaTemplatesOverview>("/whatsapp-templates?fresh=1"),
    onSuccess: (data) => qc.setQueryData(["whatsapp-templates"], data),
  });
}

export function useSetWaBusinessAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (businessAccountId: string) =>
      api<WaTemplatesOverview>("/whatsapp-templates/account", { method: "PATCH", body: { businessAccountId } }),
    onSuccess: (data) => qc.setQueryData(["whatsapp-templates"], data),
  });
}
