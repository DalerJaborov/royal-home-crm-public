import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { circlePolygon } from "../lib/geoDistance";
import {
  propertiesToGeoJson,
  clustersToGeoJson,
  buildingsToGeoJson,
  clusterLabel,
  clusterPlaque,
  priceLabel,
} from "../lib/mapGeoJson";
import { readMapPriceColors } from "../lib/themeMapColors";
import { useThemeId } from "../store/uiPrefs";
import { THEMES } from "../lib/themes";
import { fetchReverseGeocode } from "../lib/reverseGeocode";
import { createLongPress } from "../lib/mapLongPress";
import { emptyMapClickAction, mapCardFacts, nearbySummary } from "../lib/mapCardFacts";
import { openRouteNative } from "../lib/openRoute";
import type { MapCluster, MapProperty, PropertiesMapResponse } from "../hooks/usePropertiesMap";

/**
 * Холст карты объектов (12.09.2026, docs/geo-match-plan-12-09.md, блок N) —
 * MapLibre GL JS, а не Leaflet (правка владельца 12.09.2026). Изначально
 * движок выбрали ради объёмных 3D-домов — см. «НАКЛОН КАМЕРЫ» ниже, эта
 * причина отпала 14.09.2026, но `fill-extrusion` остался как обычная плоская
 * заливка дома по цене (высота всегда 0 — см. `lib/mapGeoJson.ts`), MapLibre
 * при этом всё равно нужен: клик по контуру дома, три яруса по масштабу,
 * тёмная тема подложки — ничего из этого Leaflet не даёт бесплатно так же
 * просто.
 *
 * ПЯТЬ ПРАВИЛ ОБЛИКА (план, блок N) — как они реализованы здесь:
 *  1. Главное — объекты: `fitBounds` по `bounds` с сервера при первой загрузке
 *     и при каждой смене набора (см. эффект ниже), а не пустой город.
 *  2. Ни слоёв, ни легенд, ни настроек: один холст, три яруса переключаются
 *     САМИ по масштабу (см. `applyZoomTier`), никакого тумблера режима.
 *  3. Цвет = цена, и больше ничего: `tier` (0/1/2, терцили `priceScale`)
 *     красит и пузырьки, и заливку домов той же шкалой из `lib/themeMapColors.ts`.
 *     Исключение по прямому решению владельца — «свой объект» и «выбранный
 *     дом» несут СВОЙ цвет поверх ценового, это не тарификация, а адресность.
 *  4. Подписи словами: кластеры — то же самое, что и было на Leaflet
 *     (`«82-й мкр · 14 объектов · от 58 000»`, `lib/mapGeoJson.ts`), просто
 *     текстовым `symbol`-слоем, а не HTML div-иконкой.
 *  5. Всегда понятно, где ты: подпись кластера остаётся видна, пока не
 *     раскрылась в пузырьки/дома — она и есть навигация по городу.
 *
 * ТРИ ЯРУСА ПО МАСШТАБУ (без слоёв/настроек — правило 2): дальше `FAR_MAX_ZOOM`
 * — кластеры по микрорайону/району; между ним и `CLOSE_MIN_ZOOM` — пузырьки
 * цены на каждый геокодированный объект; ближе `CLOSE_MIN_ZOOM` — дома
 * контуром (плоским, БЕЗ объёма — см. ниже), плюс пузырьки для объектов, чья
 * точка не попала ни в один контур (иначе они пропадали бы вблизи — старый
 * баг новой картой не повторяем).
 *
 * НАКЛОН КАМЕРЫ (pitch) — УБРАН ОКОНЧАТЕЛЬНО, второй раз за 14.09.2026, и
 * больше не возвращать без прямой просьбы владельца. Хронология одного дня:
 *   1. Наклон 50° мешал — «карта кривой становится, выключи» → убрали совсем.
 *   2. Без наклона `fill-extrusion` не может выглядеть объёмным НИКАК (сверху
 *      вниз любая высота читается плоским пятном) — то есть «3д не вижу»
 *      было точным описанием, не багом. Починили: наклон 35° + домам без
 *      этажности (89% контуров) — скромный default-подъём для рендера.
 *      Пофиксили даже гонку анимаций, из-за которой наклон не применялся —
 *      численно подтвердили `map.getPitch() === 35` на живом проде.
 *   3. Владелец посмотрел на РАБОТАЮЩИЙ наклон и решил: «никакого эффекта
 *      нет, лучше убрать». Разница с шагом 1 — на этот раз наклон технически
 *      работал, просто не понравился по факту, не из-за перекоса подложки.
 * Вывод: объёмный вид домов в этом проекте — тупиковая ветка при бесплатных
 * растровых тайлах (Яндекс/OSM) и данных, где реальная этажность есть только
 * у 1 528 из 24 325 домов. `fill-extrusion` остался, но чисто как способ
 * покрасить контур дома по цене плоской заливкой (высота 0 всегда,
 * `DEFAULT_UNKNOWN_HEIGHT_FLOORS` тоже убран из `lib/mapGeoJson.ts`) —
 * дешевле было бы поменять тип слоя на `fill`, но `fill-extrusion` с высотой
 * 0 рендерится идентично и трогать работающий слой лишний раз незачем.
 *
 * ПОДЛОЖКА — тайлы Яндекса (растровые, официальный Tiles API —
 * yandex.com/maps-api/docs/tiles-api/request.html), ключ из
 * `VITE_YANDEX_TILES_KEY`; нет ключа ИЛИ тайлы отказали в рантайме (см.
 * обработчик "error" ниже) — OpenStreetMap, в обоих случаях без пустого
 * холста (решение владельца 12.09.2026). Требования Яндекса (лого, копирайт,
 * ссылка на условия, «открыть в Картах») — угол карты, см. копирайт-плашку в
 * `PropertiesMap.tsx` (рисуется поверх холста React-ом, не средствами
 * MapLibre — тексту нужны свои ссылки и клики; гасится вместе с откатом на
 * OSM через `onBasemapFallback`).
 *
 * «СПЯЩАЯ» КАРТА ДО ПЕРВОГО КЛИКА — приём из старого Leaflet-компонента
 * (`PropertyMapView.tsx`): прокрутка мышью не должна воровать прокрутку
 * страницы, пока по карте не кликнули явно.
 */

const FAR_MAX_ZOOM = 14;
const CLOSE_MIN_ZOOM = 16;

/**
 * ПОДПИСИ — DOM, А НЕ СИМВОЛЬНЫЕ СЛОИ (19.09.2026, владелец: «карта работает
 * некорректно, задумана графика и оформление, чтобы объекты видели»).
 *
 * ПОЧЕМУ НА КАРТЕ НЕ БЫЛО ВООБЩЕ НИЧЕГО. Плашки кластеров и подписи цен были
 * символьными слоями (`type:"symbol"` + `text-field`), а в стиле карты тут же,
 * рядом, НЕ БЫЛО поля `glyphs` — карта собирается вручную
 * (`{version:8, sources, layers}`), и адрес глифов туда никто не положил ни в
 * одном коммите за всю историю экрана. Без `glyphs` символьный слой не может
 * получить шрифт, и MapLibre роняет НЕ подпись, а весь разбор тайла: тайл
 * GeoJSON-источника, у которого в кадре есть видимый символьный слой, уходит в
 * `errored`, и с этого источника не рисуется НИ ОДИН слой — включая
 * круги-пузырьки. Отсюда «на холсте нет ни одного маркера ни при каком зуме»:
 * на зуме <14 бился источник `clusters`, на 14…16 — `properties`. Зависимость
 * от зума сбивала с толку и уводила поиск на подложку и прод-окружение
 * (docs/TASKS.md, запись «карта пустая» висела заблокированной).
 *
 * ПОЧЕМУ DOM, А НЕ ПОЧИНКА `glyphs`. Глифы MapLibre — это pbf-диапазоны,
 * нарезанные из шрифта: либо чужой сервер (правило репозитория — внешние
 * зависимости не подключать), либо генерация и хранение бинарных диапазонов в
 * `public/` ради двух подписей. DOM-маркер вместо этого берёт шрифт
 * интерфейса — кириллица «82-й мкр · 14 объектов» рисуется тем же
 * начертанием, что вся CRM, — и даёт настоящую прямоугольную плашку, которой
 * символьный слой без спрайта не умеет (прежний код изображал её точкой
 * `circle-radius: 4` с halo текста). Заодно уходит вторая ошибка: слой
 * `clusters-label` добавлялся РАНЬШЕ `clusters-bg`, то есть тёмный круг
 * рисовался ПОВЕРХ собственной подписи.
 *
 * ЦЕНА РЕШЕНИЯ — маркеров не бывает много: плашки кластеров это десятки (один
 * на район), подписи цен ограничены кадром и потолком `PRICE_LABEL_CAP`.
 * Пузырьки, дома и «рядом со мной» остались слоями MapLibre — их тысячи, и
 * DOM для них не годится.
 */
/** Сколько подписей цен рисуем разом. Ограничение не по вкусу, а по смыслу:
 *  подписи, налезающие друг на друга, нечитаемы, а кадр со 1500 объектами
 *  всё равно читают зумом, а не чтением каждой цифры. */
const PRICE_LABEL_CAP = 80;

/** Есть мышь (наведение и точный указатель) — колесо приближает сразу, а над
 *  объектом всплывает карточка. На телефоне и планшете — нет. */
const FINE_POINTER =
  typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;

/**
 * Растровая подложка (Яндекс/OSM) — светлая всегда, своей тёмной версии у
 * бесплатного тарифа нет. В тёмной теме тайлы как есть выжигали яркий белый
 * прямоугольник на холсте посреди тёмного интерфейса (виден на любом зуме,
 * пойман на самом первом дизайн-проходе 14.09.2026, не только в углу — по
 * всей площади карты). Приглушаем стандартными paint-свойствами растрового
 * слоя MapLibre, а не CSS-фильтром на канвас: фильтр захватил бы заодно и
 * наши собственные слои (пузырьки/дома/кластеры), которым все три темы
 * (light/dark/OS) уже назначают свой цвет через `readMapPriceColors`.
 *
 * Значения подобраны заново 14.09.2026 (владелец: «не понравилась тёмная
 * карта, неправильная, лучше просто чёрное») — первая версия только гасила
 * яркость (max 0.55) и сильно вымывала цвет (-0.4), из-за чего подложка
 * выглядела мутной, будто плохая инверсия, а не настоящей тёмной картой.
 * Здесь темнее (max 0.28 — заметно ближе к чёрному) и с ПОДНЯТЫМ, не
 * опущенным контрастом (+0.15) — так дороги и подписи остаются читаемыми на
 * тёмном фоне, а не тонут вместе с ним; насыщенность тронута меньше (-0.15
 * вместо -0.4), чтобы цвет не вымывался в грязно-серый.
 */
function basemapPaint(dark: boolean): maplibregl.RasterLayerSpecification["paint"] {
  return dark ? { "raster-brightness-max": 0.28, "raster-saturation": -0.15, "raster-contrast": 0.15 } : {};
}

/**
 * MapLibre строит свой воркер тайлов через собственную `getWorkerUrl()`, а не
 * через стандартный `new Worker(new URL(...))`, который бандлеры умеют
 * разобрать статически, — Vite поэтому не видит этот воркер и не включает
 * его в сборку сам. Источники GeoJSON (кластеры, пузырьки, дома) в этом
 * случае навсегда остаются в состоянии «загружается»: `setData` отрабатывает
 * на главном потоке, а тайлы для рендера никогда не приходят — ни одной
 * ошибки в консоли при этом нет, просто пустая карта.
 *
 * Пробовали `import ... from "maplibre-gl/dist/maplibre-gl-worker.mjs?url"` —
 * Vite копирует файл как есть, но сам воркер импортирует соседний чанк
 * библиотеки (`./maplibre-gl-shared.mjs`, ~500 КБ разбора тайлов), а `?url`
 * копирует ровно один файл и не тянет за ним эту зависимость: воркер падал
 * на разборе module-импорта без единого сообщения на главном потоке (браузер
 * прячет детали ошибок парсинга внутри воркера).
 *
 * Рабочее решение — вынести ОБА файла (воркер и его чанк) статикой в
 * `public/vendor/maplibre/`, рядом друг с другом под теми же именами, как их
 * ждёт относительный импорт внутри воркера: Vite отдаёт `public/` как есть и
 * в dev, и в проде, без хеширования и без анализа зависимостей — то, что
 * здесь и нужно. `setWorkerUrl` — единственный официальный способ подсказать
 * MapLibre, где лежит воркер; вызывается один раз при загрузке модуля, до
 * создания первой карты.
 *
 * ⚠ При обновлении версии `maplibre-gl` эти два файла обязаны обновиться
 * вместе с зависимостью — `npm run sync-maplibre-worker` (см. package.json)
 * копирует их заново из `node_modules/maplibre-gl/dist`.
 */
maplibregl.setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

export interface PropertyMapExplorerHandle {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
}

export function PropertyMapExplorer({
  data,
  currentAgentId,
  selectedId,
  onSelectProperty,
  onSelectBuilding,
  onSelectCluster,
  onLongPressMap,
  onBasemapFallback,
  onBasemapUnavailable,
  nearMe,
  searchPin,
  handleRef,
  hoveredId = null,
  onHoverProperty,
  onEmptyClick,
  cardOpen = false,
}: {
  data: PropertiesMapResponse;
  currentAgentId: string | null;
  /** id объекта ИЛИ дома, на который сейчас смотрят (лента карточек либо тап) —
   *  красится отдельным цветом поверх ценового (правило 3, исключение). */
  selectedId: string | null;
  onSelectProperty: (id: string) => void;
  onSelectBuilding: (id: string) => void;
  onSelectCluster: (id: string) => void;
  onLongPressMap: (lat: number, lng: number) => void;
  /** Подложка Яндекса отказала и заменена на OSM (см. обработчик "error" ниже) —
   *  родитель обязан погасить копирайт-плашку «© Яндекс», иначе OSM-тайлы
   *  показываются под чужим копирайтом (условия Яндекса того и требуют
   *  наоборот: плашка только пока их тайлы реально на холсте). Необязательный —
   *  старые вызовы (если появятся) просто не узнают о переключении. */
  onBasemapFallback?: () => void;
  /** Ни Яндекс, ни OSM не отдают тайлы (см. обработчик "error" ниже) — родитель
   *  показывает честную строку поверх холста вместо тихо пустой серой карты.
   *  Необязательный — старые вызовы просто не узнают о полном отказе. */
  onBasemapUnavailable?: () => void;
  nearMe: { lat: number; lng: number } | null;
  /** Результат поиска по слову/подсказке (`PropertiesMap.tsx`, поле поиска) —
   *  раньше `flyTo` только перемещал камеру, БЕЗ метки на месте: владелец
   *  14.09.2026 поймал вживую — «ввожу адрес, показывается просто картинка,
   *  никакой отметки нет, где дом — ищу сам». Классический маркер-«капля»
   *  MapLibre (как в Google/Яндекс.Картах), не наш ценовой пузырёк — держится
   *  на любом зуме, независимо от яруса. null — метки нет (ничего не искали
   *  либо начали новый поиск руками). */
  searchPin: { lat: number; lng: number } | null;
  /** Императивный доступ для «перелететь к месту» (поиск) — проще, чем тащить
   *  весь стейт карты в родителя, а дублировать состояние Map внутри React
   *  бессмысленно (карта и так владеет своей камерой). */
  handleRef: React.MutableRefObject<PropertyMapExplorerHandle | null>;
  /** Объект под мышкой в СПИСКЕ слева — его плашка на карте подсвечивается
   *  (25.09.2026, «как в Яндексе»: ведёшь по списку — видно, где это). */
  hoveredId?: string | null;
  /** Мышь зашла на плашку/пузырёк объекта (id) или ушла (null) — родитель
   *  подсвечивает карточку в списке. */
  onHoverProperty?: (id: string | null) => void;
  /** Нажатие мимо объектов при открытой карточке — родитель её закрывает
   *  (см. emptyMapClickAction). */
  onEmptyClick?: () => void;
  /** Поверх карты открыта карточка объекта или дома (не просто подсвечена
   *  карточка в списке) — нажатие мимо закрывает её. */
  cardOpen?: boolean;
}) {
  /**
   * СВЕЖИЕ ОБРАБОТЧИКИ РОДИТЕЛЯ ДЛЯ СОБЫТИЙ КАРТЫ (24.09.2026). Подписки на
   * клик по пузырьку/дому/плашке и «moveend → syncLabels» ставятся ОДИН раз — в
   * инициализации и в «load». Раньше они держали пропсы первого кадра: у
   * родителя обработчики читают его данные (`ribbonItems`, `data.clusters`), и
   * объект, пришедший со следующим фоновым обновлением (раз в минуту), по клику
   * на свой пузырёк не находился — камера не летела, карточка не прокручивалась.
   * Ref переписывается на каждом рендере, подписки зовут через него.
   */
  const handlersRef = useRef({
    onSelectProperty,
    onSelectBuilding,
    onSelectCluster,
    onLongPressMap,
    onBasemapFallback,
    onBasemapUnavailable,
    onHoverProperty,
    onEmptyClick,
  });
  handlersRef.current = {
    onSelectProperty,
    onSelectBuilding,
    onSelectCluster,
    onLongPressMap,
    onBasemapFallback,
    onBasemapUnavailable,
    onHoverProperty,
    onEmptyClick,
  };
  const themeId = useThemeId();
  const isDark = THEMES.find((t) => t.id === themeId)?.isDark ?? false;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  /** Подложка Яндекса недоступна (неверный ключ, недоступный домен, сетевой
   *  сбой) — переключаем ОДИН раз на OSM вместо пустого холста навсегда. Без
   *  этого отказ подложки (см. обработчик "error" ниже) оставлял карту без
   *  базовых тайлов на весь сеанс — ни кластеров, ни улиц, только то немногое,
   *  что рисуют GeoJSON-источники поверх (см. CLAUDE.md про внешние вызовы:
   *  отказ обязан быть терпимым, не тонуть молча и не парализовать экран). */
  const yandexFallbackDoneRef = useRef(false);
  /** Счётчик подряд отказавших тайлов ЛЮБОЙ подложки — Яндекса (до отката на
   *  OSM) и самого OSM (после отката или когда ключа не было вовсе). Нужен
   *  отдельно от yandexFallbackDoneRef: тот держит факт «Яндекс уже заменили
   *  один раз», а не «подложки нет совсем» (найдено 20.09.2026 — если недоступны
   *  ОБА источника, холст остаётся пустым без единой подписи, см.
   *  docs/breakage-audit-night-20-09.md п.4). Любой успешный тайл (`load`,
   *  обработчик ниже) сбрасывает счётчик — временная просадка сети не должна
   *  копиться в постоянный отказ. */
  const basemapErrorStreakRef = useRef(0);
  const basemapUnavailableFiredRef = useRef(false);
  const activeRef = useRef(false);
  // `map.loaded()` не годится флагом готовности: он требует, чтобы ВСЕ
  // источники (включая растровую подложку) догрузили все тайлы, а подложка
  // догружает их постоянно при любом панорамировании — флаг может не стать
  // `true` очень долго. «load» — событие ОДНОРАЗОВОЕ: если данные карты
  // (эффект ниже) проверяют готовность уже ПОСЛЕ того, как «load» отработал,
  // повторная подписка `map.once("load", …)` никогда не сработает. Поэтому
  // готовность — свой флаг, выставленный внутри обработчика «load» этого же
  // файла, а не показание самой карты.
  const styleReadyRef = useRef(false);
  /** То же «load отработал», но состоянием — для эффектов окраса ниже («моё»,
   *  выбранное, тёмная подложка, «рядом со мной»). Ref их не перезапускает: на
   *  первом показе они отрабатывали ДО «load», выходили на `!styleReadyRef` и
   *  больше не звались, пока не сменится что-то из зависимостей, — отсюда «своих
   *  объектов не видно обводкой, пока не кликнешь куда-нибудь» (24.09.2026). */
  const [styleReady, setStyleReady] = useState(false);
  /** Последний «залей источники данными» — если данные пришли раньше, чем
   *  отработало «load», сохраняем сюда и запускаем ОДИН РАЗ из самого
   *  обработчика «load» (см. styleReadyRef выше) — не второй подпиской на то
   *  же одноразовое событие. */
  const pendingDataRef = useRef<(() => void) | null>(null);
  /** `fitBounds` — только на ПЕРВУЮ выдачу данных. Без этого флага каждый
   *  фоновый рефетч (TanStack Query возвращает новый объект `data` при любом
   *  обновлении — окно снова в фокусе, вкладка вернулась активной) заново
   *  дёргал `fitBounds` и отбрасывал камеру к виду «весь город», отменяя и
   *  перелёт по клику на карточку/кластер, и ручной зум — карта выглядела
   *  так, будто в ней ничего не кликается. */
  const didFitRef = useRef(false);
  /** Маркер результата поиска (см. пропс `searchPin`) — один на холст, вне
   *  GeoJSON-источников: обычный DOM-маркер MapLibre, видимый на любом зуме,
   *  не участвует в трёх ярусах кластеров/пузырьков/домов. */
  const searchPinMarkerRef = useRef<maplibregl.Marker | null>(null);
  /** Плашки кластеров и подписи цен — DOM-маркеры (см. «ПОДПИСИ — DOM» выше).
   *  Живут вне GeoJSON-источников, поэтому пересобираются руками: на новых
   *  данных, на смене яруса зума и на каждом сдвиге кадра. */
  const labelMarkersRef = useRef<maplibregl.Marker[]>([]);
  /** Последние данные карты для пересборки подписей — `syncLabels` вызывается и
   *  из обработчиков карты (zoom/moveend), куда пропс `data` не доходит. */
  const labelDataRef = useRef<{ clusters: MapCluster[]; properties: MapProperty[] } | null>(null);
  /** Ярус, под который подписи собраны сейчас. «zoom» у MapLibre срабатывает на
   *  КАЖДЫЙ кадр анимации зума, а пересборка подписей — работа с DOM: без этой
   *  отметки десятки узлов снимались и ставились заново по многу раз за один
   *  жест. Сам зум внутри яруса ничего в подписях не меняет, а сдвиг кадра
   *  дособерёт «moveend» (он же приходит и в конце зума). */
  const labelTierRef = useRef<"far" | "medium" | "close" | null>(null);
  /** Выбранный объект — для плашек цен, которые собираются в `syncLabels`, а он
   *  вызывается и из обработчиков карты, зарегистрированных один раз при
   *  монтировании: пропс `selectedId` туда доходит значением первого кадра.
   *  Ref держит актуальное; сама подсветка уже собранных плашек обновляется
   *  отдельным эффектом ниже, без пересборки DOM. */
  const selectedIdRef = useRef<string | null>(selectedId);
  /** Долгое нажатие на пустом месте — «завести объект здесь». Таймер, допуск
   *  на дрожание пальца и отметка «уже сработало» (обычный клик того же жеста не
   *  должен ЕЩЁ и открыть попап адреса поверх уходящего экрана) — в
   *  lib/mapLongPress.ts, там же разбор щипка двумя пальцами (24.09.2026). */
  const longPressRef = useRef<ReturnType<typeof createLongPress<maplibregl.LngLat>> | null>(null);
  /** Попап адреса по клику на пустое место карты (см. эффект ниже) — один на
   *  холст, новый клик закрывает старый, а не копит их друг на друге. */
  const addressPopupRef = useRef<maplibregl.Popup | null>(null);
  /** Карточка-подсказка при наведении мыши на объект (25.09.2026). Одна на
   *  карту: новая заменяет прежнюю. */
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);
  const hoveredIdRef = useRef<string | null>(hoveredId);
  const cardOpenRef = useRef(cardOpen);
  cardOpenRef.current = cardOpen;
  /** Обратный геокодер (Nominatim) по этому же клику — новый клик до ответа
   *  обязан отменить предыдущий запрос, не только скрыть его результат:
   *  политика сервиса против «догоняющих» запросов на ту же сессию. */
  const geocodeAbortRef = useRef<AbortController | null>(null);

  // ---- Инициализация карты один раз. ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const yandexKey = import.meta.env.VITE_YANDEX_TILES_KEY as string | undefined;
    const basemapSource: maplibregl.RasterSourceSpecification = yandexKey
      ? {
          type: "raster",
          // Официальный Tiles API (yandex.com/maps-api/docs/tiles-api/request.html,
          // проверено 14.09.2026 на живом ключе владельца — предыдущий URL
          // (vec0{1-4}.maps.yandex.net) был из недостоверного источника и не
          // резолвился вообще, DNS NXDOMAIN). Один домен, без шардов по
          // поддоменам — RPS-лимит (30/с на бесплатном тарифе) держит сам
          // сервер, а не клиент.
          //
          // `projection=web_mercator` ОБЯЗАТЕЛЕН (найдено 14.09.2026 на живом
          // проде — «карта показывает горы вместо города», подпись владельца
          // «полностью показывает неправильно»). У Tiles API по умолчанию
          // (без параметра) — `wgs84_mercator`, эллиптическая проекция со
          // СВОЕЙ нумерацией тайлов; MapLibre (как и вообще все x/y/z-клиенты
          // — OSM, Google, Mapbox) считает x/y по стандартной СФЕРИЧЕСКОЙ
          // Web Mercator (EPSG:3857). Для одних и тех же x/y/z две проекции
          // отдают РАЗНЫЕ географические тайлы — та же плитка 12/2830/1570,
          // которая должна показывать центр Душанбе, без этого параметра
          // отдавала горы Варзоба в ~15 км к северу. Проверено побайтово:
          // `curl` той же плитки с `&projection=web_mercator` показывает
          // «Чорбог»/«проспект Рудаки» — то же самое, что и у OSM.
          tiles: [
            `https://tiles.api-maps.yandex.ru/v1/tiles/?l=map&x={x}&y={y}&z={z}&lang=ru_RU&projection=web_mercator&apikey=${yandexKey}`,
          ],
          tileSize: 256,
          attribution: "© Яндекс",
        }
      : {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap",
        };

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: { basemap: basemapSource },
        layers: [{ id: "basemap", type: "raster", source: "basemap", paint: basemapPaint(isDark) }],
      },
      center: [68.78, 38.56],
      zoom: 12,
      // Прокрутка/жест зума выключены до первого клика — «спящая» карта,
      // приём из старого компонента (PropertyMapView.tsx): иначе прокрутка
      // страницы над картой воровалась картой, а не листала страницу.
      // С мышью колесо приближает сразу, как в Яндекс и Google Картах
      // (25.09.2026: «как будто картинка» — колесо листало страницу, пока по
      // карте не кликнули). На телефоне колеса нет, «спящий» режим остаётся.
      scrollZoom: FINE_POINTER,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    // Отказ тайла/источника не должен тонуть молча (правило CLAUDE.md про
    // внешние вызовы) — карта из-за одной неудачной плитки не падает, но
    // причину стоит видеть в консоли, а не гадать по пустому месту на холсте.
    map.on("error", (e) => {
      console.error("Карта объектов:", e.error);
      // Подложка Яндекса отказывает КАЖДОЙ плиткой одинаково (неверный ключ,
      // недоступный домен) — по первому же отказу переключаем на OSM, а не
      // копим одинаковые ошибки в консоли, оставляя холст пустым до конца сеанса.
      //
      // НАЙДЕНО 17.09.2026 НА ЖИВОМ ПРОДЕ: домен тайлов сменился на
      // tiles.api-maps.yandex.ru ещё 14.09.2026 (см. комментарий у basemapSource
      // выше), а это условие продолжало искать старый "maps.yandex.net" —
      // никогда не совпадало, откат ни разу не срабатывал, и любой реальный
      // отказ Яндекса (например 403) оставлял холст пустым НАВСЕГДА, без единой
      // плитки OSM. Проверяем по общему "yandex", как уже сделано в
      // lib/leafletYandexTiles.ts (мастер объекта) — тот же класс отказа.
      const failedUrl = (e.error as { url?: string } | undefined)?.url ?? "";
      if (yandexKey && !yandexFallbackDoneRef.current && failedUrl.includes("yandex")) {
        yandexFallbackDoneRef.current = true;
        const source = map.getSource("basemap") as maplibregl.RasterTileSource | undefined;
        source?.setTiles(["https://tile.openstreetmap.org/{z}/{x}/{y}.png"]);
        handlersRef.current.onBasemapFallback?.();
        console.error("Карта объектов: подложка Яндекса недоступна, переключено на OpenStreetMap");
      }

      // ОБА ИСТОЧНИКА НЕДОСТУПНЫ (найдено 20.09.2026, breakage-audit-night-20-09.md
      // п.4): откат выше спасает только от отказа Яндекса — если следом (или
      // вместо ключа) недоступен и OSM, холст остаётся серым и пустым без единой
      // подписи. `failedUrl` пуст у ошибок стиля/слоёв (не тайлов) — считаем
      // только реальные отказы сети. Порог, а не первая же ошибка: единичный
      // обрыв одной плитки — не повод пугать честной строкой, точки объектов на
      // карте всё равно видны. Отдельного console.error здесь нарочно нет:
      // каждый отказавший тайл уже залогирован строкой выше — вторая строка
      // была бы неотличима от постороннего отказа сети для e2e-проверки
      // (tests/e2e/pages/crm.page.ts::namesForeignFetchFailure видит по URL в
      // тексте отказа только СЕТЕВЫЕ сообщения, эта строка чужой адрес не
      // называла и красила прогон /properties/map).
      if (failedUrl) {
        basemapErrorStreakRef.current += 1;
        if (basemapErrorStreakRef.current >= 4 && !basemapUnavailableFiredRef.current) {
          basemapUnavailableFiredRef.current = true;
          handlersRef.current.onBasemapUnavailable?.();
        }
      }
    });

    if (FINE_POINTER) activeRef.current = true;
    map.on("click", () => {
      if (!activeRef.current) {
        activeRef.current = true;
        map.scrollZoom.enable();
      }
    });
    // Любой клик первым делом гасит прошлый попап адреса — иначе они копятся
    // друг на друге, пока не откроется новый (см. showAddressPopup ниже).
    map.on("click", () => {
      addressPopupRef.current?.remove();
      addressPopupRef.current = null;
    });

    map.on("load", () => {
      map.addSource("clusters", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("properties", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("buildings", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("near-me", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

      const colors = readMapPriceColors();
      const tierColorExpr = ["match", ["get", "tier"], 0, colors.low, 1, colors.mid, colors.high] as const;

      // Ярус «далеко» — тёмная плашка с подписью словами (правило 4/5). Плашки
      // и подписи цен рисуются DOM-маркерами (см. syncLabels ниже), а не
      // символьными слоями MapLibre — почему именно так, разобрано в
      // «ПОДПИСИ — DOM, А НЕ СИМВОЛЬНЫЕ СЛОИ» в шапке файла.

      // Ярус «средне» — пузырьки цены, заливка по терцилям (правило 3).
      map.addLayer({
        id: "bubbles",
        type: "circle",
        source: "properties",
        paint: {
          "circle-radius": 9,
          "circle-color": tierColorExpr as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>,
          "circle-stroke-width": ["case", ["==", ["get", "id"], ""], 1.5, 1.5] as unknown as number,
          "circle-stroke-color": "#ffffff",
        },
      });
      // Ярус «близко» — дома контуром/объёмом (правило 3, тепловая карта — тот
      // же слой, не отдельный режим).
      map.addLayer({
        id: "buildings-extrusion",
        type: "fill-extrusion",
        source: "buildings",
        paint: {
          "fill-extrusion-color": tierColorExpr as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>,
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-opacity": 0.85,
        },
      });
      // Объекты, не попавшие ни в один контур дома, — пузырьком, даже вблизи
      // (иначе молча пропадали бы, старый баг новой картой не повторяем).
      map.addLayer({
        id: "bubbles-unmatched",
        type: "circle",
        source: "properties",
        filter: ["==", ["get", "buildingId"], ""],
        paint: {
          "circle-radius": 9,
          "circle-color": tierColorExpr as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });

      // «Рядом со мной» — точка агента + зона 500 м (только когда включено).
      map.addLayer({
        id: "near-me-fill",
        type: "fill",
        source: "near-me",
        filter: ["==", ["get", "kind"], "circle"],
        paint: { "fill-color": colors.mine, "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: "near-me-line",
        type: "line",
        source: "near-me",
        filter: ["==", ["get", "kind"], "circle"],
        paint: { "line-color": colors.mine, "line-width": 1.5 },
      });
      map.addLayer({
        id: "near-me-dot",
        type: "circle",
        source: "near-me",
        filter: ["==", ["get", "kind"], "point"],
        paint: { "circle-radius": 6, "circle-color": colors.mine, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      });

      applyZoomTier(map);
      map.on("zoom", () => applyZoomTier(map));
      // Подписи цен отсекаются по кадру, значит после сдвига кадра их надо
      // пересобрать: `zoom` при обычном панорамировании не срабатывает.
      map.on("moveend", () => syncLabels(map));

      map.on("click", "bubbles", (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) handlersRef.current.onSelectProperty(id);
      });
      map.on("click", "bubbles-unmatched", (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) handlersRef.current.onSelectProperty(id);
      });
      map.on("click", "buildings-extrusion", (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) handlersRef.current.onSelectBuilding(id);
      });
      for (const layer of ["bubbles", "bubbles-unmatched", "buildings-extrusion"]) {
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }
      // Пузырёк под мышью — та же карточка-подсказка, что у плашки цены.
      for (const layer of ["bubbles", "bubbles-unmatched"]) {
        map.on("mousemove", layer, (e: maplibregl.MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.id as string | undefined;
          const prop = id ? labelDataRef.current?.properties.find((p) => p.id === id) : undefined;
          if (prop) showHoverCard(map, prop);
        });
        map.on("mouseleave", layer, () => hideHoverCard());
      }

      // Клик на пустое место карты (мимо кластера/пузырька/дома) — «как в
      // настоящей карте» (владелец 14.09.2026, живая проверка: «адреса на
      // карте не кликабельные как в настоящей карте»): показываем, что это за
      // место, а не оставляем клик мёртвым. Раньше единственной реакцией на
      // пустое место было ДОЛГОЕ нажатие, сразу уводящее в мастер нового
      // объекта — без предпросмотра адреса и без объяснения, почему обычный
      // тап ничего не делает.
      // Плашки кластеров сюда не входят: они DOM-маркеры и гасят свой клик сами
      // (`stopPropagation`), до этого обработчика он не доходит.
      const interactiveLayers = ["bubbles", "bubbles-unmatched", "buildings-extrusion"];
      map.on("click", (e: maplibregl.MapMouseEvent) => {
        if (longPressRef.current?.consumeFired()) return;
        const hits = map.queryRenderedFeatures(e.point, { layers: interactiveLayers.filter((id) => map.getLayer(id)) });
        if (hits.length > 0) return;
        if (emptyMapClickAction(cardOpenRef.current) === "close-card") {
          handlersRef.current.onEmptyClick?.();
          return;
        }
        showAddressPopup(map, e.lngLat);
      });

      styleReadyRef.current = true;
      pendingDataRef.current?.();
      pendingDataRef.current = null;
      setStyleReady(true);
    });

    // Попап адреса по клику на пустое место (см. регистрацию клика внутри
    // "load" выше) — загрузка, потом факт или честный отказ, без ложного
    // «нет ответа». Отдельная функция, а не инлайн в обработчике клика: её
    // же зовёт кнопка «Создать объект здесь» внутри попапа.
    //
    // Источник адреса — Nominatim (OpenStreetMap), НЕ наш справочник домов
    // (`GET /geo/lookup`): владелец поймал вживую, что справочник иногда
    // называет РАЗНУЮ улицу для соседних точек одного дома (контуры соседних
    // домов на плане смыкаются впритык, «ближайший дом в 30 м» иногда берёт не
    // тот) — «хочу как в Гугле и Яндексе, нажимаешь и видишь всё правильно».
    // Тот же провайдер и тот же разбор ответа, что и в мастере объекта на шаге
    // «Где» (`property-wizard/useReverseGeocode.ts` → `lib/reverseGeocode.ts`).
    const showAddressPopup = (map: maplibregl.Map, lngLat: maplibregl.LngLat) => {
      hideHoverCard();
      geocodeAbortRef.current?.abort();
      const controller = new AbortController();
      geocodeAbortRef.current = controller;

      // КАРТОЧКА МЕСТА (25.09.2026). Владелец про прежнее окно: «дешёвое окно,
      // некрасивое, просто тупо с адресом… видно, что какая-то странная карта».
      // Теперь как в Яндекс Картах: адрес крупно, район, что рядом в продаже
      // (по объектам, уже нарисованным на карте) и две кнопки.
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: "map-place-popup",
        // Сторону MapLibre выбирает сам: у края холста карточка разворачивается
        // внутрь, а не обрезается.
        offset: 10,
        maxWidth: "300px",
      }).setLngLat(lngLat);
      const card = document.createElement("div");
      card.className = "map-place-card";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "map-place-close";
      close.setAttribute("aria-label", "Закрыть");
      close.textContent = "×";
      close.addEventListener("click", () => {
        popup.remove();
        if (addressPopupRef.current === popup) addressPopupRef.current = null;
      });
      const title = document.createElement("b");
      title.className = "map-place-title is-loading";
      title.textContent = "Ищу адрес…";
      const district = document.createElement("span");
      district.className = "map-place-sub";
      card.append(close, title, district);
      const near = nearbySummary(lngLat.lat, lngLat.lng, labelDataRef.current?.properties ?? []);
      if (near) {
        const nearEl = document.createElement("span");
        nearEl.className = "map-place-near";
        nearEl.textContent = near;
        card.appendChild(nearEl);
      }
      const acts = document.createElement("div");
      acts.className = "map-place-acts";
      const create = document.createElement("button");
      create.type = "button";
      create.className = "pill sm";
      create.textContent = "Создать объект здесь";
      create.addEventListener("click", () => {
        handlersRef.current.onLongPressMap(lngLat.lat, lngLat.lng);
        popup.remove();
      });
      const route = document.createElement("button");
      route.type = "button";
      route.className = "pill ghost sm";
      route.textContent = "Маршрут";
      route.addEventListener("click", () => openRouteNative(lngLat.lat, lngLat.lng, !FINE_POINTER));
      acts.append(create, route);
      card.appendChild(acts);
      popup.setDOMContent(card).addTo(map);
      addressPopupRef.current = popup;

      fetchReverseGeocode(lngLat.lat, lngLat.lng, controller.signal)
        .then((result) => {
          if (addressPopupRef.current !== popup) return; // уже кликнули в другое место
          title.classList.remove("is-loading");
          title.textContent = result.address || "Адрес не определён";
          district.textContent = result.districtName ?? "";
        })
        .catch((err: unknown) => {
          if (addressPopupRef.current !== popup) return;
          if (err instanceof DOMException && err.name === "AbortError") return; // отменено новым кликом
          title.classList.remove("is-loading");
          title.textContent = "Не удалось определить адрес";
        });
    };

    // Долгое нажатие на пустом месте карты — «завести объект здесь». Щипок
    // двумя пальцами и палец на плашке цены жест НЕ запускают — см.
    // lib/mapLongPress.ts (24.09.2026).
    const longPress = createLongPress<maplibregl.LngLat>({
      delayMs: 550,
      moveTolerancePx: 8,
      onFire: (lngLat) => handlersRef.current.onLongPressMap(lngLat.lat, lngLat.lng),
    });
    longPressRef.current = longPress;
    const touchCount = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) =>
      (e.originalEvent as TouchEvent).touches?.length ?? 0;
    const cancelLongPress = () => longPress.cancel();
    const startLongPress = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      longPress.start(
        {
          x: e.point.x,
          y: e.point.y,
          touchCount: touchCount(e),
          // Плашки цен и кластеров — DOM-маркеры в той же обёртке, их нажатие
          // долетает до карты; мастер открывается только с самого холста.
          onCanvas: e.originalEvent.target === map.getCanvas(),
        },
        e.lngLat
      );
    };
    const moveLongPress = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      longPress.move({ x: e.point.x, y: e.point.y, touchCount: touchCount(e) });
    };
    map.on("mousedown", startLongPress);
    map.on("touchstart", startLongPress);
    map.on("mousemove", moveLongPress);
    map.on("touchmove", moveLongPress);
    map.on("mouseup", cancelLongPress);
    map.on("touchend", cancelLongPress);
    map.on("touchcancel", cancelLongPress);
    map.on("dragstart", cancelLongPress);
    // Масштабирование щипком — тоже не долгое нажатие, даже если второй палец
    // коснулся раньше, чем MapLibre прислал touchstart с двумя касаниями.
    map.on("zoomstart", cancelLongPress);

    // MapLibre выставляет "load" только изнутри собственного цикла рендера
    // (requestAnimationFrame) — а его браузер полностью останавливает вкладке
    // в фоне (вкладка открыта не активной, свёрнутое окно). Если карта монтируется
    // в таком состоянии (open in background, инструмент автоматизации), rAF не
    // тикает ни разу — стиль и источники готовы, но "load"/`styleReadyRef`
    // никогда не срабатывают, и добавленные позже данные молча копятся в
    // `pendingDataRef`, ничего не рисуя, пока вкладка не станет видимой. Один
    // кадр по возврату видимости выводит карту из этого состояния.
    const onVisible = () => {
      if (document.visibilityState === "visible") map.triggerRepaint();
    };
    document.addEventListener("visibilitychange", onVisible);

    mapRef.current = map;
    handleRef.current = {
      // Зум по умолчанию 15, а не 16 (19.09.2026). 16 — это ровно
      // `CLOSE_MIN_ZOOM`, то есть ярус «близко», где ценовые пузырьки гаснут:
      // клик по карточке в списке прилетал на зум, на котором объект виден
      // только контуром своего дома, а у объекта без контура (или когда
      // `buildings` пуст) — не виден вообще. Выглядело как «кликнул карточку,
      // и объект пропал». 15 оставляет пузырёк на холсте.
      //
      // Но 15 — НИЖНЯЯ граница, а не цель (24.09.2026): человек, уже
      // приблизившийся до 17, по клику на карточку улетал ОБРАТНО на 15 —
      // «нажал объект, а карта отъехала». Без явного зума камера не отдаляется.
      flyTo: (lat, lng, zoom) => {
        activeRef.current = true;
        map.scrollZoom.enable();
        map.flyTo({ center: [lng, lat], zoom: zoom ?? Math.max(map.getZoom(), 15), essential: true });
      },
    };

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      geocodeAbortRef.current?.abort();
      addressPopupRef.current?.remove();
      addressPopupRef.current = null;
      hideHoverCard();
      searchPinMarkerRef.current?.remove();
      searchPinMarkerRef.current = null;
      for (const m of labelMarkersRef.current) m.remove();
      labelMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
      handleRef.current = null;
      cancelLongPress();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Пересобрать DOM-подписи под текущий ярус зума и кадр (см. «ПОДПИСИ — DOM»
   * в шапке файла). Снимаем все и ставим заново: маркеров десятки, а
   * сопоставление «какой маркер какому объекту» стоило бы дороже самой
   * пересборки и давало бы расхождения при смене данных.
   */
  function syncLabels(map: maplibregl.Map) {
    for (const m of labelMarkersRef.current) m.remove();
    labelMarkersRef.current = [];

    const payload = labelDataRef.current;
    if (!payload) return;

    const zoom = map.getZoom();
    const far = zoom < FAR_MAX_ZOOM;
    const medium = !far && zoom < CLOSE_MIN_ZOOM;

    const add = (lng: number, lat: number, el: HTMLElement) => {
      // `anchor` и `offset` повторяют прежние символьные слои: плашка по центру
      // точки кластера, цена — под пузырьком, чтобы не закрывать его цвет.
      const marker = new maplibregl.Marker({ element: el, anchor: el.dataset.anchor === "top" ? "top" : "center" })
        .setLngLat([lng, lat])
        .addTo(map);
      labelMarkersRef.current.push(marker);
    };

    if (far) {
      for (const c of payload.clusters) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "map-plaque";
        // Коротко на плашке, полностью — подсказкой: см. `clusterPlaque`
        // (lib/mapGeoJson.ts) и владельца 21.09.2026 про длинные подписи.
        el.textContent = clusterPlaque(c);
        el.title = clusterLabel(c);
        // Клик по плашке = клик по кластеру. Раньше кликабельной была точка
        // радиусом 4 px — попасть в неё на телефоне почти невозможно.
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          handlersRef.current.onSelectCluster(c.id);
        });
        add(c.lng, c.lat, el);
      }
      return;
    }

    // ЦЕНЫ РИСУЮТСЯ И ВБЛИЗИ (21.09.2026). Раньше здесь стояло
    // `if (!medium) return;` — плашки цен жили только на ярусе 14…16 и гасли
    // при дальнейшем приближении. Владелец: «должны быть маленькие цветные
    // плашки с ценой, а у нас это есть, только если приблизить, странно
    // конечно» — то есть человек находил их случайно и терял, не поняв, за что
    // они пропали. Вблизи объект и так виден контуром своего дома, но цена —
    // единственное, ради чего карту открывают, и прятать её не за что.
    // `medium` остаётся объявленным: по нему считается ярус (labelTierRef).
    void medium;

    // Только то, что в кадре, и не больше потолка: подписи вне кадра не видны,
    // а сотни налезающих друг на друга нечитаемы.
    const bounds = map.getBounds();
    let shown = 0;
    for (const prop of payload.properties) {
      if (shown >= PRICE_LABEL_CAP) break;
      if (prop.lat == null || prop.lng == null) continue;
      if (!bounds.contains([prop.lng, prop.lat])) continue;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "map-price";
      el.classList.toggle("is-active", prop.id === selectedIdRef.current);
      el.classList.toggle("is-hover", prop.id === hoveredIdRef.current);
      el.dataset.anchor = "top";
      el.dataset.propId = prop.id;
      el.textContent = priceLabel(prop.price, prop.currency);
      // Нажимается сама плашка, а не кружок радиусом 4 px под ней — тем же
      // приёмом, что и у плашки кластера выше.
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        hideHoverCard();
        handlersRef.current.onSelectProperty(prop.id);
      });
      if (FINE_POINTER) {
        el.addEventListener("mouseenter", () => showHoverCard(map, prop));
        el.addEventListener("mouseleave", () => hideHoverCard());
      }
      add(prop.lng, prop.lat, el);
      shown += 1;
    }
  }

  function applyZoomTier(map: maplibregl.Map) {
    const zoom = map.getZoom();
    const far = zoom < FAR_MAX_ZOOM;
    const close = zoom >= CLOSE_MIN_ZOOM;
    const medium = !far && !close;
    setVis(map, "bubbles", medium);
    setVis(map, "buildings-extrusion", close);
    setVis(map, "bubbles-unmatched", close);
    // Подписи — DOM-маркеры, у них нет `visibility`: пересобираем, но только
    // когда ярус правда сменился (см. labelTierRef).
    const tier = far ? "far" : close ? "close" : "medium";
    if (labelTierRef.current !== tier) {
      labelTierRef.current = tier;
      syncLabels(map);
    }
  }

  // ---- Данные карты пришли/обновились — заливаем источники и подгоняем кадр. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const priceScale = data.priceScale;
    const apply = () => {
      const propsGeo = propertiesToGeoJson(data.properties, priceScale);
      (map.getSource("properties") as maplibregl.GeoJSONSource | undefined)?.setData(propsGeo);
      // Источник `clusters` остаётся заполненным, хотя плашки рисуются
      // DOM-маркерами: слоёв на нём сейчас нет (значит и стоимости никакой —
      // MapLibre не разбирает источник, который никто не читает), но кластеры
      // обязаны быть на месте, если понадобится слой поверх них (тепловая
      // карта из плана, блок I). Одна строка дешевле, чем вспоминать потом,
      // где взять эти данные.
      (map.getSource("clusters") as maplibregl.GeoJSONSource | undefined)?.setData(clustersToGeoJson(data.clusters));
      (map.getSource("buildings") as maplibregl.GeoJSONSource | undefined)?.setData(
        buildingsToGeoJson(data.buildings, priceScale)
      );
      if (data.bounds && !didFitRef.current) {
        didFitRef.current = true;
        map.fitBounds(
          [
            [data.bounds.minLng, data.bounds.minLat],
            [data.bounds.maxLng, data.bounds.maxLat],
          ],
          { padding: 60, maxZoom: 15, duration: 0 }
        );
      }
      // Подписи — DOM, не слои: их не обновляет `setData`, надо пересобрать
      // самим, и обязательно ПОСЛЕ fitBounds, чтобы кадр для отсечки по
      // границам был уже новый.
      labelDataRef.current = { clusters: data.clusters, properties: data.properties };
      // Данные новые — пересобрать надо независимо от яруса.
      labelTierRef.current = null;
      applyZoomTier(map);
    };
    if (styleReadyRef.current) apply();
    else pendingDataRef.current = apply;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ---- Своя метка (интейк-агент = текущий) — окрас поверх ценового. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current || !map.getLayer("bubbles")) return;
    const colors = readMapPriceColors();
    const mineExpr = [
      "case",
      ["==", ["get", "intakeAgentId"], currentAgentId ?? "__none__"],
      colors.mine,
      "#ffffff",
    ] as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>;
    for (const layer of ["bubbles", "bubbles-unmatched"]) {
      map.setPaintProperty(layer, "circle-stroke-color", mineExpr);
      map.setPaintProperty(layer, "circle-stroke-width", [
        "case",
        ["==", ["get", "intakeAgentId"], currentAgentId ?? "__none__"],
        3,
        1.5,
      ] as unknown as number);
    }
    // `isDark` в зависимостях не читается внутри — он здесь ТОЛЬКО чтобы
    // `readMapPriceColors()` перечитала CSS-токены после смены темы. Токены
    // сами по себе не событие, эффект без них не перезапустился бы, и цвет
    // «моего» пузырька молча оставался бы от прошлой темы до перезагрузки
    // страницы (пойман на дизайн-проходе 14.09.2026).
  }, [currentAgentId, data, isDark, styleReady]);

  // ---- Подсветка выбранной плашки цены. Отдельно от эффекта ниже: тот красит
  // СЛОИ MapLibre, а плашки — обычные DOM-маркеры, до которых paint-свойства не
  // доходят. Пересобирать их ради одного класса дорого и заметно (десятки узлов
  // снимаются и ставятся заново), поэтому класс переставляется на месте. ----
  useEffect(() => {
    selectedIdRef.current = selectedId;
    for (const marker of labelMarkersRef.current) {
      const el = marker.getElement();
      if (!el.dataset.propId) continue;
      el.classList.toggle("is-active", el.dataset.propId === selectedId);
    }
  }, [selectedId]);

  // ---- Наведение на карточку в списке — плашка этого объекта выходит вперёд. ----
  useEffect(() => {
    hoveredIdRef.current = hoveredId;
    for (const marker of labelMarkersRef.current) {
      const el = marker.getElement();
      if (!el.dataset.propId) continue;
      el.classList.toggle("is-hover", el.dataset.propId === hoveredId);
    }
  }, [hoveredId]);

  // ---- Выбранный объект/дом — свой цвет поверх ценового (правило 3, решение
  // владельца по выделению). То же самое про `isDark`, что и в эффекте выше —
  // иначе терции цены (bubbles/buildings-extrusion) не подхватывают тему. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    const colors = readMapPriceColors();
    const tierColorExpr = ["match", ["get", "tier"], 0, colors.low, 1, colors.mid, colors.high];
    const withSelection = (idField: string) => [
      "case",
      ["==", ["get", idField], selectedId ?? "__none__"],
      colors.selected,
      tierColorExpr,
    ];
    if (map.getLayer("bubbles")) {
      map.setPaintProperty(
        "bubbles",
        "circle-color",
        withSelection("id") as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>
      );
    }
    if (map.getLayer("bubbles-unmatched")) {
      map.setPaintProperty(
        "bubbles-unmatched",
        "circle-color",
        withSelection("id") as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>
      );
    }
    if (map.getLayer("buildings-extrusion")) {
      map.setPaintProperty(
        "buildings-extrusion",
        "fill-extrusion-color",
        withSelection("id") as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>
      );
    }
  }, [selectedId, isDark, styleReady]);

  // ---- Подложка под тёмную тему — своей тёмной подложки у бесплатного тарифа
  // нет, приглушаем яркость/насыщенность растра (см. basemapPaint выше). ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current || !map.getLayer("basemap")) return;
    const paint = basemapPaint(isDark);
    map.setPaintProperty("basemap", "raster-brightness-max", paint?.["raster-brightness-max"] ?? 1);
    map.setPaintProperty("basemap", "raster-saturation", paint?.["raster-saturation"] ?? 0);
    map.setPaintProperty("basemap", "raster-contrast", paint?.["raster-contrast"] ?? 0);
  }, [isDark, styleReady]);

  // ---- «Рядом со мной» — точка + зона 500 м. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    const source = map.getSource("near-me") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    if (!nearMe) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    source.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { kind: "circle" },
          geometry: { type: "Polygon", coordinates: [circlePolygon(nearMe.lat, nearMe.lng, 500)] },
        },
        {
          type: "Feature",
          properties: { kind: "point" },
          geometry: { type: "Point", coordinates: [nearMe.lng, nearMe.lat] },
        },
      ],
    });
    map.flyTo({ center: [nearMe.lng, nearMe.lat], zoom: 15, essential: true });
  }, [nearMe, styleReady]);

  // ---- Метка результата поиска — обычный маркер-«капля» MapLibre, не наш
  // ценовой слой (см. пропс `searchPin` выше). `flyTo` сам камеру уже двигал —
  // этому эффекту остаётся только поставить/убрать саму метку. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!searchPin) {
      searchPinMarkerRef.current?.remove();
      searchPinMarkerRef.current = null;
      return;
    }
    if (searchPinMarkerRef.current) {
      searchPinMarkerRef.current.setLngLat([searchPin.lng, searchPin.lat]);
    } else {
      searchPinMarkerRef.current = new maplibregl.Marker({ color: "#e02424" })
        .setLngLat([searchPin.lng, searchPin.lat])
        .addTo(map);
    }
  }, [searchPin]);

  /**
   * Карточка при наведении мыши (25.09.2026) — фото, цена, комнаты и где это,
   * над самой точкой. Только с мышью: на телефоне наведения нет, там сразу
   * нажатие. Собирается из DOM-узлов, не строкой HTML: название и описание
   * места набирают люди.
   */
  function showHoverCard(map: maplibregl.Map, prop: MapProperty) {
    if (!FINE_POINTER || prop.lat == null || prop.lng == null) return;
    // Объект уже открыт карточкой внизу — вторая карточка над ним лишняя.
    if (prop.id === selectedIdRef.current) return;
    if (hoverPopupRef.current?.getElement()?.dataset.propId === prop.id) return;
    hideHoverCard(false);
    const facts = mapCardFacts(prop);
    const card = document.createElement("div");
    card.className = "map-hover-card";
    if (prop.coverPhotoUrl) {
      const img = document.createElement("img");
      img.src = prop.coverPhotoUrl;
      img.alt = "";
      // Фото не загрузилось — без значка битой картинки, карточка просто без фото.
      img.addEventListener("error", () => img.remove());
      card.appendChild(img);
    }
    const body = document.createElement("div");
    body.className = "map-hover-body";
    const price = document.createElement("b");
    price.textContent = facts.price;
    body.appendChild(price);
    const title = document.createElement("span");
    title.className = "map-hover-title";
    title.textContent = prop.title;
    body.appendChild(title);
    for (const line of [facts.details, facts.place]) {
      if (!line) continue;
      const el = document.createElement("span");
      el.className = "map-hover-sub";
      el.textContent = line;
      body.appendChild(el);
    }
    card.appendChild(body);
    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: "map-hover-popup",
      offset: 14,
      maxWidth: "260px",
    })
      .setLngLat([prop.lng, prop.lat])
      .setDOMContent(card)
      .addTo(map);
    popup.getElement().dataset.propId = prop.id;
    hoverPopupRef.current = popup;
    handlersRef.current.onHoverProperty?.(prop.id);
  }

  function hideHoverCard(notify = true) {
    if (!hoverPopupRef.current) return;
    hoverPopupRef.current.remove();
    hoverPopupRef.current = null;
    if (notify) handlersRef.current.onHoverProperty?.(null);
  }

  function setVis(map: maplibregl.Map, layer: string, visible: boolean) {
    if (!map.getLayer(layer)) return;
    map.setLayoutProperty(layer, "visibility", visible ? "visible" : "none");
  }

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
