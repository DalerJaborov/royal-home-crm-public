import { useEffect } from "react";
import { api } from "../lib/api";
import { registerOnServer, urlBase64ToUint8Array, type PushConfig } from "./usePushNotifications";

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

export interface PushRefreshDeps {
  pushManager: Pick<PushManager, "getSubscription" | "subscribe">;
  /** Notification.permission; нет API уведомлений — undefined. */
  permission: NotificationPermission | undefined;
  /** Пора ли освежать уже существующую подписку (раз в сутки). */
  due: boolean;
  loadConfig: () => Promise<PushConfig>;
  register: (sub: PushSubscription) => Promise<void>;
}

/**
 * ОДИН ШАГ ОСВЕЖЕНИЯ ПОДПИСКИ (без React — тестируется).
 *
 * ПОДПИСКИ НЕТ, А РАЗРЕШЕНИЕ ДАНО — ПОДПИСАТЬСЯ ЗАНОВО (21.11.2026). Полный сброс
 * обновления (lib/appUpdateReload.ts → снять service worker) уносит вместе с
 * воркером и push-подписку: она принадлежит регистрации. Раньше хук на этом
 * выходил (`if (!sub) return`), и сотрудник молча переставал получать
 * уведомления — разрешение в браузере есть, подписки нет, сервер шлёт в пустоту.
 * Теперь подписываемся тем же путём, что первичная подписка (ключ из
 * /push/config, регистрация на сервере), но разрешение НЕ спрашиваем: при
 * `default`/`denied` ничего не делаем. Проверка отсутствия подписки — локальная и
 * дешёвая, поэтому она идёт при каждом открытии, мимо суточного предела.
 */
export async function refreshPushSubscription(deps: PushRefreshDeps): Promise<"refreshed" | "resubscribed" | "skipped"> {
  const sub = await deps.pushManager.getSubscription();
  if (sub) {
    if (!deps.due) return "skipped";
    await deps.register(sub);
    return "refreshed";
  }
  if (deps.permission !== "granted") return "skipped";
  const config = await deps.loadConfig();
  if (!config.enabled || !config.publicKey) return "skipped";
  const fresh = await deps.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey) as BufferSource,
  });
  await deps.register(fresh);
  return "resubscribed";
}

/**
 * «Освежает» подписку на уведомления при открытии приложения вошедшим сотрудником
 * (19.10.2026): сервер по этому маршруту ставит `lastSeenAt`, а по свежести
 * подписки решает, слать ли код входа пушем или сразу СМС. Пропавшую подписку
 * при выданном разрешении восстанавливает (см. refreshPushSubscription).
 * Best-effort: отказ сети тихий.
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
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        const result = await refreshPushSubscription({
          pushManager: registration.pushManager,
          permission: typeof Notification === "undefined" ? undefined : Notification.permission,
          due: pushRefreshDue(Date.now(), storage),
          loadConfig: () => api<PushConfig>("/push/config"),
          register: registerOnServer,
        });
        if (result === "skipped") return;
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
