/**
 * Адрес push-подписки ЭТОГО браузера — или undefined, если подписки нет, нет
 * сервис-воркера или он не отозвался за `timeoutMs` (`serviceWorker.ready` без
 * зарегистрированного воркера не разрешается никогда).
 *
 * Нужен подтверждению личности (17.11.2026): сервер не шлёт код пушем на то же
 * устройство, которое код просит (apps/api/src/lib/loginSmsCode.ts).
 */
export async function currentPushEndpoint(timeoutMs = 1500): Promise<string | undefined> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
    if (typeof window === "undefined" || !("PushManager" in window)) return undefined;
    const sub = await Promise.race([
      navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription()),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return sub?.endpoint ?? undefined;
  } catch {
    return undefined;
  }
}
