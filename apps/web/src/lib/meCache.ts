/**
 * Ответ PATCH /me и POST /me/avatar — урезанная карточка (id, имя, телефон,
 * почта, роль, фото): прав, привязки Telegram, признака двухфакторного входа в
 * нём нет. Раньше он целиком ложился в кэш ["me"], и «Профиль» падал на
 * `permissions.includes` сразу после сохранения (аудит 23.09.2026, №33).
 * Сливаем поверх прежнего профиля; полный профиль потом перечитывается.
 */
export function mergeMeCache<T extends object>(old: T | undefined, patch: Partial<T>): T | undefined {
  return old ? { ...old, ...patch } : old;
}
