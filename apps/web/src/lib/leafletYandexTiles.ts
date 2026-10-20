import type L from "leaflet";

/**
 * Подложка карты для Leaflet-компонентов: Яндекс с ключом, OSM без него —
 * тот же приём, что `PropertyMapExplorer.tsx` уже применяет для MapLibre
 * (`VITE_YANDEX_TILES_KEY`, официальный Tiles API, автоматический откат на
 * OpenStreetMap при отказе). Общий модуль, а не три копии: до 13.09.2026
 * `MapPointPicker.tsx`, `LocationPicker.tsx` и `ClientDesiredPlacesMap.tsx`
 * хардкодили `L.tileLayer("https://{s}.tile.openstreetmap.org/...")` каждый
 * по отдельности, без подложки Яндекса и без отката вообще (аудит мёртвого/
 * дублирующего кода).
 *
 * Leaflet, в отличие от MapLibre-подложки `PropertyMapExplorer.tsx`, не умеет
 * менять URL источника через `source.setTiles(...)` — вместо этого у самого
 * слоя `L.TileLayer` есть `setUrl(...)`, поэтому откат здесь делает вызывающий
 * компонент через `attachYandexFallback`, а не этот модуль напрямую.
 */

/** Явный шард не нужен — Яндекс отдаёт тайлы с одного домена (см. PropertyMapExplorer.tsx). */
export const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = "© OpenStreetMap";
export const YANDEX_ATTRIBUTION = "© Яндекс";

function yandexTileUrl(key: string): string {
  // Официальный Tiles API (yandex.com/maps-api/docs/tiles-api/request.html) —
  // {x}/{y}/{z} в фигурных скобках работают как обычный XYZ-шаблон и для
  // Leaflet (`L.tileLayer`), это просто URL, а не MapLibre-специфичный формат.
  // projection=web_mercator ОБЯЗАТЕЛЕН (21.09.2026). По умолчанию Tiles API
  // отдаёт плитки в эллиптической проекции WGS 84 (EPSG:3395), а Leaflet
  // считает в сферической (EPSG:3857): на широте Душанбе подложка уезжала на
  // ~20 км к северу — открытие мастера показывало горы у Гусгарфа вместо
  // города, а точка, поставленная пальцем по съехавшей картинке, ложилась в
  // базу с тем же сдвигом. На стенде ключа Яндекса нет (там OSM), поэтому
  // глазами на стенде это не видно.
  return `https://tiles.api-maps.yandex.ru/v1/tiles/?l=map&x={x}&y={y}&z={z}&lang=ru_RU&projection=web_mercator&apikey=${key}`;
}

/** Ключ из окружения сборки — тот же, что читает `PropertyMapExplorer.tsx`. */
export function yandexTilesKey(): string | undefined {
  return import.meta.env.VITE_YANDEX_TILES_KEY as string | undefined;
}

export interface TileConfig {
  url: string;
  attribution: string;
  /** true — подложка сейчас Яндекс (и для неё имеет смысл ловить отказ и откатывать на OSM). */
  isYandex: boolean;
}

/** Подложка на старте карты: Яндекс, если ключ задан сборкой, иначе сразу OSM
 *  (без ключа откатывать не с чего — дев без .env работает как раньше). */
export function primaryTileConfig(): TileConfig {
  const key = yandexTilesKey();
  return key ? { url: yandexTileUrl(key), attribution: YANDEX_ATTRIBUTION, isYandex: true } : { url: OSM_TILE_URL, attribution: OSM_ATTRIBUTION, isYandex: false };
}

/**
 * Вешает на слой подложки ЕДИНЫЙ обработчик `tileerror`, который либо тихо
 * откатывает Яндекс → OSM (первый же отказ, тот же приём, что `map.on("error",
 * …)` в `PropertyMapExplorer.tsx`), либо, если откатывать уже не на что,
 * зовёт `onUnrecoverable` — вызывающий компонент решает сам, что показать
 * (обычно то же «карта не загрузилась», что было у него для OSM раньше).
 *
 * Единый обработчик, а не два независимых слушателя одного события: если бы
 * «откат» и «сообщить об офлайне» слушали `tileerror` порознь, при обычном
 * отказе Яндекса срабатывали бы ОБА — и компонент показал бы «нет сети» в тот
 * самый момент, когда откат на OSM уже тихо сработал.
 *
 * Откатываем один раз, не на каждую упавшую плитку: несколько тайлов Яндекса
 * отказывают почти одновременно при неверном ключе/недоступном домене, без
 * флага `fellBack` слой дёргался бы туда-обратно на каждой.
 */
export function attachYandexFallback(
  tileLayer: L.TileLayer,
  config: TileConfig,
  onUnrecoverable: () => void
): void {
  let fellBack = false;
  tileLayer.on("tileerror", (e: L.TileErrorEvent) => {
    if (config.isYandex && !fellBack) {
      const failedUrl = e.tile?.src ?? "";
      // Фильтр по домену — как в PropertyMapExplorer.tsx: без него уже
      // ушедшие в полёт запросы к Яндексу, ответившие ошибкой ПОСЛЕ отката,
      // читались бы как второй, теперь уже OSM-овский, отказ.
      if (failedUrl.includes("yandex")) {
        fellBack = true;
        tileLayer.setUrl(OSM_TILE_URL);
        console.error("Карта: подложка Яндекса недоступна, переключено на OpenStreetMap");
        return;
      }
    }
    onUnrecoverable();
  });
}
