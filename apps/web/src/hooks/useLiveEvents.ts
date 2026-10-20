import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../store/auth";
import { startLiveEvents } from "../lib/liveEvents";

/**
 * Поток живых событий на всю вкладку. Подключается один раз в AppLayout —
 * выше него нет ничего, что переживало бы смену раздела, а ниже поток
 * пересоздавался бы на каждом переходе.
 *
 * Само соединение идемпотентно (см. lib/liveEvents.ts): даже если хук окажется
 * в двух местах, сокет останется один.
 */
export function useLiveEvents(): void {
  const queryClient = useQueryClient();
  const hasSession = useAuthStore((s) => s.hasSession);
  const readOnly = useAuthStore((s) => s.agent?.role === "SHAREHOLDER" || s.agent?.readOnly === true);

  useEffect(() => {
    // The server blocks ticket POSTs for read-only accounts. Their queries
    // retain normal polling; do not start an endless forbidden reconnect loop.
    if (!hasSession || readOnly) return;
    const manager = startLiveEvents(queryClient);
    return () => manager.stop();
  }, [hasSession, readOnly, queryClient]);
}
