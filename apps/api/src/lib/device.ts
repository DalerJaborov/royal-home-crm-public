/**
 * Лёгкий разбор user-agent без внешних зависимостей: нам не нужна точная модель
 * телефона — достаточно стабильной пары «браузер + ОС», чтобы отличать устройства
 * в журнале входов и ловить вход с нового устройства.
 */

function detectOs(ua: string): string | null {
  if (/windows nt/i.test(ua)) return "Windows";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return null;
}

function detectBrowser(ua: string): string | null {
  // Порядок важен: Edge/Opera/Samsung содержат "Chrome", Chrome содержит "Safari".
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung Browser";
  if (/yabrowser/i.test(ua)) return "Яндекс Браузер";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/chrome\//i.test(ua)) return "Chrome";
  if (/safari\//i.test(ua)) return "Safari";
  return null;
}

export interface DeviceInfo {
  /** Человекочитаемая метка: "Chrome · Windows", "Safari · iOS", "Неизвестное устройство". */
  label: string;
  /** Стабильный ключ для сравнения устройств между входами: "chrome|windows". */
  key: string;
}

export function parseDevice(userAgent: string | undefined): DeviceInfo {
  if (!userAgent) return { label: "Неизвестное устройство", key: "unknown" };
  const os = detectOs(userAgent);
  const browser = detectBrowser(userAgent);
  const label = [browser, os].filter(Boolean).join(" · ") || "Неизвестное устройство";
  const key = [browser ?? "?", os ?? "?"].join("|").toLowerCase();
  return { label, key };
}
