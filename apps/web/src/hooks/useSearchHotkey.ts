import { useEffect, useRef } from "react";

/**
 * Ctrl+K (на Mac Cmd+K) — открыть общий поиск. Одна функция на обе оболочки.
 * Клавиша узнаётся и по букве, и по месту на клавиатуре (`code` = KeyK): в русской и таджикской
 * раскладке та же клавиша даёт «л», и по одной букве подсказка «Ctrl K» в шапке нового вида молчала
 * бы у всей команды (ревью пачки shell2, 27.11.2026).
 */
export function isSearchHotkey(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "key"> & { code?: string }): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  return (typeof e.key === "string" && e.key.toLowerCase() === "k") || e.code === "KeyK";
}

/**
 * Горячая клавиша поиска. Клик-аудит 26.11.2026: обработчик жил только в `Sidebar`, а в
 * «чистой» оболочке (она у всех) бокового меню нет — Ctrl+K молча не работал, хотя в подсказках и
 * в коде помощника написано, что он открывает поиск. Теперь вешается из `Topbar` (он есть в обеих
 * оболочках) и из `Sidebar`; `enabled` не даёт двум местам открыть поиск одновременно.
 */
export function useSearchHotkey(enabled: boolean, open: () => void): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (!isSearchHotkey(e)) return;
      e.preventDefault();
      openRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
