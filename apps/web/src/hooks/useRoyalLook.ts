import { useEffect, useLayoutEffect } from "react";
import { useAuthStore } from "../store/auth";
import { useCleanShellSelection } from "./useCleanShell";
import { useRoyalLookChoice } from "./royalLookChoice";

/**
 * «НОВЫЙ ВИД» (облик `royal`) — 18.11.2026.
 *
 * Личный выбор вида (`?look=`, запоминание на учётку) переехал в
 * hooks/royalLookChoice.ts (пачка B, 20.11.2026): его читает и выбор оболочки,
 * а оттуда сюда импорт создал бы цикл. Имена переизлучаются — прежние импорты
 * отсюда работают как раньше.
 */
export { royalLookEnabled, royalLookOverride, useRoyalLookChoice } from "./royalLookChoice";

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
