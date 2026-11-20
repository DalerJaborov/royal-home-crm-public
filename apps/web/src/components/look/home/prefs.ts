import { useMemo } from "react";
import { useAuthStore } from "../../../store/auth";
import { useUiPrefs } from "../../../store/uiPrefs";

/*
 * Личная раскладка главной (Профиль → Оформление) — отдельным модулем, чтобы её могли
 * читать и сами блоки, не замыкая импорт на реестр (реестр импортирует блоки).
 */
type StoredLayout = { order?: string[]; hidden?: string[] };

/**
 * Личная раскладка главной роли (Профиль → Оформление). Только своя: раскладка,
 * оставшаяся на общем устройстве от прежнего входа, не применяется.
 */
export function useHomeLayoutPrefs(role: string): { order?: readonly string[]; hidden: ReadonlySet<string> } {
  const actorId = useAuthStore((s) => s.agent?.id ?? null);
  const owner = useUiPrefs((s) => s.homeBlocksOwnerId);
  const layout = useUiPrefs((s) => (s.homeBlocks as Record<string, StoredLayout | undefined>)[role]);
  const own = owner !== null && owner === actorId ? layout : undefined;
  const hidden = useMemo(() => new Set(own?.hidden ?? []), [own]);
  return { order: own?.order, hidden };
}

