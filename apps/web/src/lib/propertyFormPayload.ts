/**
 * Мелкие правила сборки формы объекта (PropertyFormModal) вынесены сюда, чтобы
 * их можно было проверить без отрисовки формы. Аудит 04.10.2026 (FORMS02/04/07).
 */

/**
 * Версия для оптимистичной блокировки при правке. Берём ту, что была при
 * ОТКРЫТИИ формы, а не живую из подписки на карточку: форма хранит поля от
 * открытия, и если запрос карточки обновился (фокус окна, опрос раз в минуту) и
 * принёс чужую правку, то живая версия вместе со старыми полями проходила
 * проверку на сервере и затирала чужую цену. С версией открытия сервер отвечает
 * 409 и человек видит конфликт (FORMS02).
 */
export function versionForSave(openedVersion: number | undefined, live: number | undefined): number | undefined {
  return openedVersion !== undefined ? openedVersion : live;
}

/**
 * Ссылка Instagram в PATCH. Пустую строку при создании не шлём вовсе, а при
 * правке, если у объекта ссылка была, шлём явный null: иначе ключа в запросе нет,
 * сервер считает поле нетронутым и ссылка возвращается (FORMS04). Если у объекта
 * её и не было, ничего не шлём: поле не менялось, и закрытое до одобрения
 * правило (agentReelLinkClosed) не срабатывает зря.
 */
export function instagramUrlPayload(
  isEdit: boolean,
  value: string,
  saved: string | null | undefined
): { instagramUrl?: string | null } {
  if (value.trim()) return { instagramUrl: value };
  return isEdit && saved ? { instagramUrl: null } : {};
}

/**
 * Точка на карте в PATCH. Новую или сдвинутую шлём парой; сброс точки (coords
 * стала null при сохранённой точке) шлёт lat и lng как null обе разом: схема
 * принимает очистку только парой (FORMS04). Неизменённую точку не шлём: сервер
 * читал бы её как «поставлено руками» и не пересчитывал бы после смены адреса.
 */
export function coordsPayload(
  isEdit: boolean,
  coords: { lat: number; lng: number } | null,
  saved: { lat?: string | number | null; lng?: string | number | null } | undefined
): { lat?: number | null; lng?: number | null } {
  const hadPoint = saved?.lat != null && saved?.lng != null;
  if (coords) {
    const changed = !isEdit || coords.lat !== Number(saved?.lat) || coords.lng !== Number(saved?.lng);
    return changed ? { lat: coords.lat, lng: coords.lng } : {};
  }
  return isEdit && hadPoint ? { lat: null, lng: null } : {};
}
