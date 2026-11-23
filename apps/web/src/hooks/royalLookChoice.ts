import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "../store/auth";

/**
 * ЛИЧНЫЙ АВАРИЙНЫЙ ВЫХОД ИЗ НОВОГО ИНТЕРФЕЙСА — ОДНО МЕСТО (21.11.2026).
 *
 * Новый интерфейс и «Новый вид» включены всем (hooks/useCleanShell.ts). Отказаться
 * можно только адресом: `?look=legacy` — прежний интерфейс на ЭТОЙ вкладке до её
 * закрытия, `?look=royal` — вернуться. Выбор живёт в sessionStorage, а не в
 * localStorage намеренно: раз «для всех», забытый когда-то отказ не должен годами
 * держать человека в старом интерфейсе. Прежние постоянные ключи (`rh-look:*`,
 * `rh-shell:*`, `rh-look-granted:*`) больше не читаются и стираются при входе.
 */
const KEY = "rh-look-optout";
const EVENT = "rh-look-change";
const RETIRED_PREFIXES = ["rh-look:", "rh-shell:", "rh-look-granted:"];

export function royalLookOverride(search: string): boolean | undefined {
  const value = new URLSearchParams(search).get("look");
  return value === "royal" ? true : value === "legacy" ? false : undefined;
}

/** Pure rule: granted AND the person has not opted out (URL first, then this tab's choice). */
export function royalLookEnabled(granted: boolean, override: boolean | undefined, saved: boolean | undefined): boolean {
  return granted && (override ?? saved ?? true);
}

function snapshot(agentId: string | undefined): boolean | undefined {
  if (!agentId) return undefined;
  try {
    return window.sessionStorage.getItem(`${KEY}:${agentId}`) === "1" ? false : undefined;
  } catch { return undefined; }
}

function subscribe(notify: () => void) {
  window.addEventListener(EVENT, notify);
  return () => window.removeEventListener(EVENT, notify);
}

/** Стереть прежние постоянные ключи выбора вида и оболочки (они больше ничего не решают). */
export function forgetRetiredLookKeys(storage: Pick<Storage, "length" | "key" | "removeItem"> | null = safeLocalStorage()): void {
  if (!storage) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && RETIRED_PREFIXES.some((p) => key.startsWith(p))) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch { /* Хранилище закрыто — ключи и так никто не читает. */ }
}
function safeLocalStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** Applies the personal emergency choice to the grant (granted = signed in). */
export function useRoyalLookChoice(granted: boolean): boolean {
  const { search } = useLocation();
  const agentId = useAuthStore((s) => s.agent?.id);
  const saved = useSyncExternalStore(subscribe, () => snapshot(agentId), () => undefined);
  const override = royalLookOverride(search);
  useEffect(() => {
    if (!granted || !agentId || override === undefined || (override ? undefined : false) === snapshot(agentId)) return;
    try {
      if (override) window.sessionStorage.removeItem(`${KEY}:${agentId}`);
      else window.sessionStorage.setItem(`${KEY}:${agentId}`, "1");
      window.dispatchEvent(new Event(EVENT));
    } catch { /* The URL still works when browser storage is unavailable. */ }
  }, [granted, agentId, override]);
  return royalLookEnabled(granted, override, saved);
}
