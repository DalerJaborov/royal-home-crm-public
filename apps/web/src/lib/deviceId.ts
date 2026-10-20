const STORAGE_KEY = "royal-home-device-id";

/** Случайный id, который остаётся стабильным для этого браузера/профиля (localStorage,
 * не sessionStorage — переживает перезагрузку и новые вкладки). Отправляется на сервер
 * заголовком X-Device-Id при логине — так две РАЗНЫЕ физические машины с одинаковым
 * браузером+ОС (частый случай в офисе на одинаковых Windows-компьютерах) не схлопываются
 * в одну запись Session, что иначе тихо ломало и лимит на 3 устройства, и алерт
 * «вход с нового устройства» (см. apps/api/src/lib/deviceKey.ts). */
export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    // localStorage недоступен (приватный режим и т.п.) — сервер откатится на UA-эвристику.
    return "";
  }
}
