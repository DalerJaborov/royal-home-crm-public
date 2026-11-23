import { useCleanShellSelection } from "../../../hooks/useCleanShell";

/**
 * «НОВЫЙ ВИД» ДЛЯ МАСТЕРА «НОВЫЙ ОБЪЕКТ» (пачка wizard; 21.11.2026 — вид у всех).
 *
 * Мастер живёт снаружи AppLayout и берёт признак сам. С 21.11.2026 решение не ждёт
 * ответа сервера (hooks/useCleanShell.ts), поэтому мигания на холодном заходе нет:
 * первый кадр сразу новый. Личный аварийный `?look=legacy` действует и здесь.
 */
/** Чистое правило (оставлено для прежних вызовов): вид есть, если он выдан или, пока ответа нет, запомнен. */
export function wizardLookGrant(serverGranted: boolean, pending: boolean, rememberedGrant: boolean): boolean {
  return serverGranted || (pending && rememberedGrant);
}

export function useWizardRoyalLook(): boolean {
  const { clean, look } = useCleanShellSelection();
  return clean && look === "royal";
}
