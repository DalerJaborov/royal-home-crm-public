/**
 * Цвета карты — ЛИТЕРАЛОМ, не `var(--…)` (12.09.2026, блок N плана):
 * MapLibre (как и Leaflet до него) кладёт цвет в стиль слоя как обычную
 * JS-строку, а не в CSS каскад — `var(--c-x)` там ничего не резолвит и не
 * подхватывает смену темы сам. Чтобы карта всё равно следовала теме (тёмная/
 * светлая), читаем токен ОДИН РАЗ через `getComputedStyle` — тем самым
 * получаем литерал, актуальный для текущей темы, вместо того чтобы прибивать
 * цвет гвоздями (см. предупреждение задания про презентационные атрибуты SVG
 * — тот же принцип, просто другой рендерер).
 */

function readRgbToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  // Токены темы хранят «R G B» (пробелом) — тот же формат, что использует
  // rgb(var(--rgb-x) / alpha) по всему приложению (theme-royal-home-2026.css).
  return `rgb(${raw.replace(/\s+/g, ",")})`;
}

export interface MapPriceColors {
  /** Дешевле — низкая треть цены за метр. */
  low: string;
  /** Середина. */
  mid: string;
  /** Дороже — верхняя треть. */
  high: string;
  /** Дом/пузырёк, на который сейчас смотрит агент (тап) — свой цвет, не из
   *  цены, иначе выделение сливалось бы с одной из трёх ступеней. */
  selected: string;
  /** Метка «мой объект» в режиме «Все» — отличимый акцент, токен темы. */
  mine: string;
}

export function readMapPriceColors(): MapPriceColors {
  return {
    // Запасные значения — ГОТОВЫМ цветом `rgb(...)`, а не «R,G,B» (19.09.2026).
    // Ветка с найденным токеном возвращает `rgb(...)`, а запасная отдавала
    // голый «79,207,138» — такой литерал MapLibre не разбирает, `addLayer`
    // падает проверкой краски, и слой остаётся вообще без цвета. Сейчас все
    // темы токены задают, так что не стреляло, но мина лежала заряженной.
    low: readRgbToken("--rgb-green", "rgb(79,207,138)"),
    mid: readRgbToken("--rgb-amber", "rgb(229,176,74)"),
    high: readRgbToken("--rgb-red", "rgb(240,127,134)"),
    selected: readRgbToken("--rgb-accent", "rgb(21,23,26)"),
    mine: readRgbToken("--rgb-accent", "rgb(21,23,26)"),
  };
}

/** Ступень цены (0 дешевле — 2 дороже) по терцилям с сервера (`priceScale`,
 *  GET /properties/map) — единая шкала для пузырьков и заливки домов. */
export function priceTier(pricePerSqm: number | null, scale: { low: number; high: number } | null): 0 | 1 | 2 {
  if (pricePerSqm == null || !scale) return 1;
  if (pricePerSqm <= scale.low) return 0;
  if (pricePerSqm <= scale.high) return 1;
  return 2;
}

export function tierColor(tier: 0 | 1 | 2, colors: MapPriceColors): string {
  return tier === 0 ? colors.low : tier === 1 ? colors.mid : colors.high;
}
