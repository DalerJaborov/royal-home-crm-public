import { useAuthStore } from "../store/auth";
import { useNarrowScreen } from "./useNarrowScreen";
import { useCleanShell } from "./useCleanShell";

/**
 * Прежний телефонный интерфейс агента (MobileAgentHome, components/mobile/*,
 * LegacyAgentTopbar, LegacyAgentPropertyView, своя нижняя панель).
 *
 * С 21.11.2026 новый интерфейс включён всем, и агентам на телефоне тоже
 * (hooks/useCleanShell.ts), поэтому эта развилка истинна только под личным
 * аварийным адресом `?look=legacy`. Сторож — hooks/__tests__/useCleanShellLook.test.tsx.
 */
export function legacyAgentMobileActive(narrow: boolean, role: string | undefined, clean: boolean): boolean {
  return narrow && role === "AGENT" && !clean;
}

export function useLegacyAgentMobile(): boolean {
  const narrow = useNarrowScreen();
  const role = useAuthStore((s) => s.agent?.role);
  const clean = useCleanShell();
  return legacyAgentMobileActive(narrow, role, clean);
}
