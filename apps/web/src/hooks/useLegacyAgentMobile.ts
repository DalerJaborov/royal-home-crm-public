import { useAuthStore } from "../store/auth";
import { useNarrowScreen } from "./useNarrowScreen";
import { useCleanShell } from "./useCleanShell";

/**
 * Прежний телефонный интерфейс агента (MobileAgentHome, components/mobile/*,
 * LegacyAgentTopbar, LegacyAgentPropertyView, своя нижняя панель).
 *
 * Только для агента на узком экране БЕЗ чистой оболочки. «Новый вид» включает
 * чистую оболочку и на телефоне агента (hooks/shellDevicePolicy.ts, пачка B
 * 20.11.2026), поэтому при новом виде эта развилка всегда ложна: одна оболочка
 * на всех устройствах. Сторож — __tests__/useLegacyAgentMobile.test.tsx и
 * tests/e2e/one-shell.spec.ts.
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
