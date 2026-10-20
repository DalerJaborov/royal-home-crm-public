import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * СМС (23.09.2026): подключены ли, раздел в Настройках, рассылка объекта.
 * Сервер — routes/sms.ts и routes/properties/smsShare.ts.
 */

/** Подключены ли СМС — решает, показывать ли кнопки отправки. Реквизитов не содержит. */
export function useSmsStatus() {
  return useQuery({
    queryKey: ["sms", "status"],
    queryFn: () => api<{ configured: boolean }>("/sms/status"),
    staleTime: 5 * 60 * 1000,
  });
}

export interface SmsSettings {
  provider: "payom" | null;
  sender: string | null;
  tokenConfigured: boolean;
  tokenMasked: string | null;
  configured: boolean;
}

export function useSmsSettings(enabled = true) {
  return useQuery({
    queryKey: ["sms", "settings"],
    queryFn: () => api<SmsSettings>("/sms/settings"),
    enabled,
  });
}

export function useUpdateSmsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<{ provider: "payom" | null; apiToken: string; sender: string }>) =>
      api<SmsSettings>("/sms/settings", { method: "PATCH", body }),
    onSuccess: (data) => {
      qc.setQueryData(["sms", "settings"], data);
      qc.invalidateQueries({ queryKey: ["sms", "status"] });
    },
  });
}

export interface SmsShareResult {
  sent: number;
  items: { clientId: string; status: "sent" | "skipped" | "failed"; reason?: string }[];
}

export function useSmsShareProperty(propertyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clientIds: string[]) =>
      api<SmsShareResult>(`/properties/${propertyId}/sms-share`, { method: "POST", body: { clientIds } }),
    // Появились личные ссылки клиентов — список «открыл/не открыл» на карточке объекта.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["property", propertyId, "share-links"] }),
  });
}
