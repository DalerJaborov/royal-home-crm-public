import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "../store/auth";

/**
 * ЛИЧНЫЙ ВЫБОР «НОВОГО ВИДА» — ОДНО МЕСТО (пачка B «одна оболочка», 20.11.2026).
 *
 * Жил в hooks/useRoyalLook.ts, а тот сам читает выбор оболочки (useCleanShell).
 * Теперь выбор оболочки должен знать личный отказ от вида ДО решения: «Новый вид»
 * снимает запрет чистой оболочки на телефоне агента, а `?look=legacy` возвращает
 * агента в прежний телефонный интерфейс. Чтобы не завести цикл импортов
 * (useCleanShell → useRoyalLook → useCleanShell), правило вынесено сюда, и оба
 * модуля берут его отсюда; useRoyalLook.ts переизлучает имена, прежние импорты
 * не тронуты.
 *
 * Включается вид ТОЛЬКО сервером: `/ui-shell` присылает `look: "royal"`
 * сотрудникам из списка в Настройках → «Новый вид». Клиент может лишь отказаться
 * от него для себя (`?look=legacy`) и вернуться (`?look=royal`); выбор
 * запоминается на учётку. `?look=royal` не включает вид тому, кому сервер его не дал.
 */
const KEY = "rh-look";
const EVENT = "rh-look-change";

export function royalLookOverride(search: string): boolean | undefined {
  const value = new URLSearchParams(search).get("look");
  return value === "royal" ? true : value === "legacy" ? false : undefined;
}

/** Pure rule: server grant AND the person has not opted out. */
export function royalLookEnabled(serverGranted: boolean, override: boolean | undefined, saved: boolean | undefined): boolean {
  return serverGranted && (override ?? saved ?? true);
}

function snapshot(agentId: string | undefined): boolean | undefined {
  if (!agentId) return undefined;
  try {
    const value = window.localStorage.getItem(`${KEY}:${agentId}`);
    return value === "royal" ? true : value === "legacy" ? false : undefined;
  } catch { return undefined; }
}

function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener(EVENT, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(EVENT, notify);
  };
}

/** Applies the personal choice to a server grant that the caller already has. */
export function useRoyalLookChoice(serverGranted: boolean): boolean {
  const { search } = useLocation();
  const agentId = useAuthStore((s) => s.agent?.id);
  const saved = useSyncExternalStore(subscribe, () => snapshot(agentId), () => undefined);
  const override = royalLookOverride(search);
  useEffect(() => {
    // Remember only for a person who actually has the look; others' URLs change nothing.
    // Idempotent: several observers of one grant write the same value at most once.
    if (!serverGranted || !agentId || override === undefined || override === snapshot(agentId)) return;
    try {
      window.localStorage.setItem(`${KEY}:${agentId}`, override ? "royal" : "legacy");
      window.dispatchEvent(new Event(EVENT));
    } catch { /* The URL still works when browser storage is unavailable. */ }
  }, [serverGranted, agentId, override]);
  return royalLookEnabled(serverGranted, override, saved);
}
