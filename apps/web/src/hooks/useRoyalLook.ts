import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { useCleanShellSelection } from "./useCleanShell";

/**
 * «НОВЫЙ ВИД» (облик `royal`) — 18.11.2026.
 *
 * Включается ТОЛЬКО сервером: `/ui-shell` присылает `look: "royal"` сотрудникам
 * из списка в Настройках → «Новый вид» и только поверх включённой чистой
 * оболочки. Клиент может лишь отказаться от него для себя (`?look=legacy`) и
 * вернуться (`?look=royal`); выбор запоминается на учётку, как `?shell=`.
 * `?look=royal` не включает вид тому, кому сервер его не дал.
 */
const KEY = "rh-look";
const EVENT = "rh-look-change";

export function royalLookOverride(search: string): boolean | undefined {
  const value = new URLSearchParams(search).get("look");
  return value === "royal" ? true : value === "legacy" ? false : undefined;
}

/** Pure rule: server grant AND clean shell AND the person has not opted out. */
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
    if (!serverGranted || !agentId || override === undefined || override === snapshot(agentId)) return;
    try {
      window.localStorage.setItem(`${KEY}:${agentId}`, override ? "royal" : "legacy");
      window.dispatchEvent(new Event(EVENT));
    } catch { /* The URL still works when browser storage is unavailable. */ }
  }, [serverGranted, agentId, override]);
  return royalLookEnabled(serverGranted, override, saved);
}

/** Is «Новый вид» on for the signed-in person right now. Shares the `/ui-shell` query. */
export function useRoyalLook(): boolean {
  const { clean, look } = useCleanShellSelection();
  return useRoyalLookChoice(clean && look === "royal");
}

/**
 * Атрибут `data-ui-look="royal"` на <html>: стоит, только пока `royal` истинно.
 * Закрыто по умолчанию — ошибка, выключение, отказ или выход снимают его.
 */
export function useLookAttribute(royal: boolean): void {
  useLayoutEffect(() => {
    if (royal) document.documentElement.dataset.uiLook = "royal";
    else delete document.documentElement.dataset.uiLook;
    return () => { delete document.documentElement.dataset.uiLook; };
  }, [royal]);
}

/**
 * ПАМЯТЬ УСТРОЙСТВА для страниц без входа (пачка records, 20.11.2026): экран входа,
 * ссылка на объект и отчёт владельцу не знают сотрудника и не спрашивают сервер,
 * поэтому новый вид там включает флаг `rh-look-device = "royal"`. Ставит и снимает
 * его ТОЛЬКО AppLayout по итоговому признаку: новый вид есть — флаг стоит; ответ
 * сервера пришёл без вида (выключили, отказ, ошибка) — флаг снят; выход из учётки —
 * снят. Пока ответа нет (`pending`), флаг не трогается: загрузка — не решение.
 */
export const DEVICE_LOOK_KEY = "rh-look-device";

type DeviceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function deviceStorage(): DeviceStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** Записать итог на устройство: `true` — поставить флаг, `false` — снять. */
export function rememberDeviceLook(royal: boolean, storage: DeviceStorage | null = deviceStorage()): void {
  if (!storage) return;
  try {
    if (royal) storage.setItem(DEVICE_LOOK_KEY, "royal");
    else storage.removeItem(DEVICE_LOOK_KEY);
  } catch { /* Хранилище закрыто — страницы без входа покажут прежний вид. */ }
}

/** Стоит ли на устройстве флаг нового вида. */
export function deviceLookRemembered(storage: Pick<Storage, "getItem"> | null = deviceStorage()): boolean {
  try { return storage?.getItem(DEVICE_LOOK_KEY) === "royal"; } catch { return false; }
}

/** AppLayout: держит флаг устройства равным признаку; выход из учётки снимает его. */
export function useDeviceLookMemory(royal: boolean, pending: boolean): void {
  useEffect(() => {
    if (!pending) rememberDeviceLook(royal);
  }, [royal, pending]);
  useEffect(() => useAuthStore.subscribe((state, prev) => {
    if (prev.agent && !state.agent) rememberDeviceLook(false);
  }), []);
}
