/**
 * Точка, поставленная долгим тапом на карте объектов
 * (`PropertiesMap.tsx::handleLongPress`) и прочитанная мастером объекта
 * (`PropertyWizard.tsx`) при открытии.
 *
 * Отдельный файл, а не импорт друг у друга: `PropertiesMap.tsx` и
 * `PropertyWizard.tsx` — разные ленивые куски сборки (правило проекта,
 * «Разделы грузятся по мере открытия», App.tsx). Импорт именованного экспорта
 * из чужого модуля тянет за собой весь модуль целиком — ESM не выполняется
 * частично, — и слил бы оба куска в один при первом же открытии любого из них.
 * Поэтому здесь нет ни одной внешней зависимости.
 */
export const PENDING_PIN_KEY = "rh_pending_map_pin";

/**
 * Срок годности точки. `sessionStorage` живёт до закрытия вкладки, а переход
 * «долгий тап → мастер» занимает секунды: без срока точка, поставленная утром
 * и брошенная, молча всплыла бы вечером в чужом черновике.
 */
const PIN_TTL_MS = 10 * 60 * 1000;

export type PendingMapPin = { lat: number; lng: number };

/** Положить точку перед переходом в мастер. Приватный режим браузера — молча ничего. */
export function savePendingMapPin(lat: number, lng: number): void {
  try {
    sessionStorage.setItem(PENDING_PIN_KEY, JSON.stringify({ lat, lng, at: Date.now() }));
  } catch {
    /* приватный режим браузера — точку просто не подставим в мастер */
  }
}

/**
 * Забрать точку: читает и СРАЗУ удаляет запись, чтобы одна и та же координата
 * не подставилась дважды. Просроченная или испорченная запись — то же, что её
 * отсутствие.
 */
export function takePendingMapPin(): PendingMapPin | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PENDING_PIN_KEY);
    sessionStorage.removeItem(PENDING_PIN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const pin = JSON.parse(raw) as Partial<PendingMapPin> & { at?: number };
    if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) return null;
    if (typeof pin.at !== "number" || Date.now() - pin.at > PIN_TTL_MS) return null;
    return { lat: pin.lat as number, lng: pin.lng as number };
  } catch {
    return null;
  }
}

/** Выход из системы: чужая точка не должна достаться следующему вошедшему на том же устройстве. */
export function clearPendingMapPin(): void {
  try {
    sessionStorage.removeItem(PENDING_PIN_KEY);
  } catch {
    /* приватный режим браузера — чистить нечего */
  }
}
