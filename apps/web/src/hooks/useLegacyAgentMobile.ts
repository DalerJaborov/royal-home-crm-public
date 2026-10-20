import { useAuthStore } from "../store/auth";
import { useNarrowScreen } from "./useNarrowScreen";
import { useCleanShell } from "./useCleanShell";

/** Preserve the agent's established phone UI while desktop Clean is reviewed. */
export function useLegacyAgentMobile(): boolean {
  const narrow = useNarrowScreen();
  const role = useAuthStore((s) => s.agent?.role);
  const clean = useCleanShell();
  return narrow && role === "AGENT" && !clean;
}
