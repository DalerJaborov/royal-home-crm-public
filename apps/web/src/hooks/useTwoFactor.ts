import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { MyProfile } from "./useMe";

export function useSetupTotp() {
  return useMutation({
    mutationFn: () => api<{ qrCodeDataUrl: string; secret: string }>("/me/2fa/setup", { method: "POST" }),
  });
}

export function useConfirmTotp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api<{ totpEnabled: boolean }>("/me/2fa/confirm", { method: "POST", body: { code } }),
    onSuccess: () => {
      qc.setQueryData<MyProfile | undefined>(["me"], (prev) => (prev ? { ...prev, totpEnabled: true } : prev));
    },
  });
}

export function useDisableTotp() {
  const qc = useQueryClient();
  return useMutation({
    // Отключение — только по коду из приложения (пароль больше не принимается,
    // иначе украденный пароль снимал бы 2FA). Потерян телефон → сброс директором.
    mutationFn: (code: string) =>
      api<{ totpEnabled: boolean }>("/me/2fa/disable", { method: "POST", body: { code } }),
    onSuccess: () => {
      qc.setQueryData<MyProfile | undefined>(["me"], (prev) => (prev ? { ...prev, totpEnabled: false } : prev));
    },
  });
}
