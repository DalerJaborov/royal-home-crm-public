import type { RoyalIconName } from "./royalIconData";

/**
 * Значок раздела по адресу. Один словарь на боковое меню ПК, нижнее меню
 * телефона и главную, чтобы у одного пункта везде был один значок и один цвет
 * круга (замечание дизайнера 18.11: цвет круга не зависит от номера строки).
 */
const BY_PATH: Record<string, RoyalIconName> = {
  "/": "house",
  "/calendar": "calendar-days",
  "/messages": "messages-square",
  "/comments": "message-circle",
  "/calls": "phone-call",
  "/telephony": "headphones",
  "/clients": "users",
  "/deals": "handshake",
  "/properties": "building-2",
  "/properties/map": "map-pin",
  "/market": "trend-up",
  "/site-changes": "globe",
  "/team": "users-round",
  "/activity": "list-checks",
  "/oversight": "eye",
  "/vacancies": "user-plus",
  "/security": "shield-check",
  "/finance": "banknote",
  "/reports": "chart-no-axes-column",
  "/sources": "target",
  "/insights": "lightbulb",
  "/ads": "megaphone",
  "/marketing": "storefront",
  "/social-videos": "clapperboard",
  "/pipeline": "image",
  "/funnel": "stack",
  "/settings": "settings",
  "/health": "gauge",
  "/integrations": "plug",
  "/backups": "key",
  "/stuck-work": "hourglass",
  "/ai-learning": "bot",
  "/archive": "archive",
  "/notifications": "bell",
  "/more": "layout-dashboard",
};

export function royalIconForPath(path: string): RoyalIconName {
  return BY_PATH[path] ?? "layout-dashboard";
}

/**
 * Пастельный тон круга за разделом (0–5). Тона подобраны так, чтобы НЕ
 * совпадать со смысловыми «срочно» (красный) и «внимание» (янтарный): в наборе
 * нет бежевого и розового (разбор психолога 18.11, §2).
 */
const TONE: Record<string, number> = {
  "/": 0, "/clients": 0, "/messages": 1, "/properties": 2, "/finance": 3, "/team": 4,
  "/calendar": 5, "/calls": 2, "/deals": 3, "/reports": 4, "/settings": 5, "/archive": 5,
};
export function royalToneForPath(path: string): number {
  if (path in TONE) return TONE[path];
  let hash = 0;
  for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}
