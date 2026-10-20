import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export type PushStatus =
  | "unsupported"
  | "server-disabled"
  | "loading"
  | "denied"
  | "subscribed"
  | "unsubscribed"
  | "error";

/**
 * Инкапсулирует весь цикл Web Push на клиенте: поддержка браузера → разрешение →
 * подписка через Service Worker → регистрация endpoint'а на сервере.
 * Один источник правды для переключателя в Настройках/Профиле.
 */
/** Регистрирует подписку за ТЕКУЩИМ вошедшим агентом (на сервере это upsert по endpoint). */
export async function registerOnServer(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  await api("/push/subscribe", { method: "POST", body: { endpoint: json.endpoint, keys: json.keys } });
}

export function usePushNotifications() {
  const [status, setStatus] = useState<PushStatus>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Общее ядро подписки: снимает при необходимости старую подписку (см. комментарий
  // ниже про смену VAPID-ключа) и регистрирует новую на сервере. НЕ трогает разрешение
  // браузера — вызывающий код сам решает, нужно ли (и можно ли) спрашивать permission.
  const doSubscribe = useCallback(async (config: PushConfig) => {
    if (!config.enabled || !config.publicKey) {
      setStatus("server-disabled");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    // Браузер бросает InvalidStateError, если уже есть подписка с ДРУГИМ
    // applicationServerKey (например, ключ VAPID перегенерировали на сервере) —
    // именно так push молча переставал работать: subscribe() падал без catch,
    // а PushSubscription на сервере оставалась пустой. Снимаем старую подписку
    // перед новой, чтобы ключ точно совпадал с актуальным серверным.
    const existing = await registration.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();

    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey) as BufferSource,
    });
    await registerOnServer(sub);
    setStatus("subscribed");
  }, []);

  const refresh = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    try {
      const config = await api<PushConfig>("/push/config");
      if (!config.enabled || !config.publicKey) {
        setStatus("server-disabled");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        // ПЕРЕПРИВЯЗЫВАЕМ подписку к текущему вошедшему. Раньше здесь стоял просто
        // выход: подписка есть — значит всё хорошо. На общем устройстве это давало
        // ту же ошибку, что когда-то кэш service worker (см. dropSwApiCache в
        // store/auth.ts): если снять подписку при выходе не удалось (не было сети),
        // строка в базе оставалась за ПРЕДЫДУЩИМ сотрудником — новый вошедший не
        // получал уведомлений вовсе, а прежний продолжал получать их на чужой теперь
        // телефон. `/push/subscribe` — upsert по endpoint, он чинит agentId.
        // Best-effort: подписка в браузере уже есть, отказ сети не повод пугать
        // человека баннером.
        await registerOnServer(sub).catch(() => {});
        setStatus("subscribed");
        return;
      }
      // Разрешение браузера уже есть (пользователь когда-то согласился), а самой
      // PushSubscription нет — типичный случай ротации VAPID-ключа на сервере или
      // браузер тихо почистил storage. Это НЕ решение пользователя отказаться от
      // уведомлений, поэтому не показываем баннер/диалог заново — пробуем молча
      // восстановить подписку тем же кодом, что использует ручной subscribe().
      if (Notification.permission === "granted") {
        try {
          await doSubscribe(config);
        } catch (err) {
          // Реальная ошибка (сеть/сервер) — покажем баннер, но без запроса
          // requestPermission(), см. subscribe() ниже.
          setStatus("error");
          setError(err instanceof Error ? err.message : "Не удалось включить уведомления");
        }
        return;
      }
      setStatus("unsubscribed");
    } catch {
      setStatus("unsubscribed");
    }
  }, [doSubscribe]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const subscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Если разрешение уже выдано — не дёргаем requestPermission() повторно.
      // Формально повторный вызов при "granted" не покажет диалог, но полагаться
      // на это неявное поведение браузера не нужно: проверяем явно.
      let permission = Notification.permission;
      if (permission === "default") {
        permission = await Notification.requestPermission();
      }
      if (permission !== "granted") {
        setStatus("denied");
        return;
      }
      const config = await api<PushConfig>("/push/config");
      await doSubscribe(config);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Не удалось включить уведомления");
    } finally {
      setBusy(false);
    }
  }, [doSubscribe]);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
        await sub.unsubscribe();
      }
      setStatus("unsubscribed");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Не удалось отключить уведомления");
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, subscribe, unsubscribe };
}
