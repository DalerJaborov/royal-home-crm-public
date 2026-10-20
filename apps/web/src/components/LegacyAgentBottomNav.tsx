import { BottomNavSurface } from "./BottomNav";

/** Compatibility entry point; the legacy variant uses the canonical navigation. */
export function LegacyAgentBottomNav() {
  return <BottomNavSurface variant="legacy-agent" />;
}
