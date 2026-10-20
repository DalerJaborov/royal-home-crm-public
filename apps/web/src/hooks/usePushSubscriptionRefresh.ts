import { useEffect } from "react";
import { registerOnServer } from "./usePushNotifications";

const KEY = "rh:push-refreshed-at";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Пора ли освежать подписку: не чаще раза в сутки. Хранилище недоступно — освежаем. */
export function pushRefreshDue(nowMs: number, storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    const last = Number(storage?.getItem(KEY) ?? 0);
    return !(last > 0 && nowMs - last < DAY_MS);
  } catch {
    return true;
  }
}

/**
 * «Освежает» подписку на уведомления при открытии приложения вошедшим сотрудником
 * (19.10.2026): сервер по этому маршруту ставит `lastSeenAt`, а по свежести
 * подписки решает, слать ли код входа пушем или сразу СМС. Только если подписка
 * уже есть — разрешение здесь не спрашиваем. Best-effort: отказ сети тихий.
 */
export function usePushSubscriptionRefresh(): void {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    if (!pushRefreshDue(Date.now(), storage)) return;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        if (!sub) return;
        await registerOnServer(sub);
        try {
          storage?.setItem(KEY, String(Date.now()));
        } catch {
          // Приватный режим — освежим при следующем открытии.
        }
      } catch {
        // Подписка — не повод пугать человека.
      }
    })();
  }, []);
}
