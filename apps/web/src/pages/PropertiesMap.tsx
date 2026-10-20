import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseShortCode } from "@royal-home/shared";
import { LocateFixed, Home as HomeIcon, Navigation, X } from "lucide-react";
import { lazyWithReload } from "../lib/lazyWithReload";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import { useAuthStore } from "../store/auth";
import { useCan } from "../lib/permissions";
import { useSiteNotifications } from "../hooks/useSiteNotifications";
import { useMobileUx } from "../hooks/useMobileUx";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import {
  usePropertiesMap,
  resolveGeoPlace,
  resolvePropertyPoint,
  suggestGeoAddress,
  type GeoResolveResult,
  type GeoSuggestItem,
  type MapProperty,
} from "../hooks/usePropertiesMap";
import { openRouteNative } from "../lib/openRoute";
import { distanceMeters } from "../lib/geoDistance";
import { toast } from "../store/toast";
import { formatMoney } from "../lib/format";
import type { PropertyMapExplorerHandle } from "../components/PropertyMapExplorer";
import { savePendingMapPin } from "../lib/pendingMapPin";
import { ObjectsTabs } from "../components/SectionTabs";
import { createLatestRequest } from "../lib/latestRequest";
import { mapCardFacts } from "../lib/mapCardFacts";

// Самая тяжёлая зависимость экрана (MapLibre GL) — грузим только когда карта
// реально открыта, тем же приёмом, что раньше был у Leaflet в Properties.tsx.
const PropertyMapExplorer = lazyWithReload(() =>
  import("../components/PropertyMapExplorer").then((m) => ({ default: m.PropertyMapExplorer }))
);

type Sheet = { kind: "property"; id: string } | { kind: "building"; id: string } | null;

/** Насколько близко перелетать по подсказке — дом/ориентир требуют «на месте»
 *  (16), улица чуть шире (15), район/микрорайон/жилой массив — 15.
 *
 *  БЫЛО 13, и это читалось как «карта не работает» (владелец 21.09.2026:
 *  «нажимаю адрес из подсказки, он просто показывает адрес, но сама карта
 *  никуда не перемещается»). Стартовый кадр показывает весь город примерно на
 *  том же 12-13, поэтому перелёт сдвигал камеру на несколько пикселей — глазу
 *  неотличимо от бездействия. Хуже того, ниже 14 карта держит обзорный ярус:
 *  видны только чёрные плашки районов, ни одного объекта. 15 гарантированно
 *  выводит из обзорного яруса, и человек видит то, что искал: дома с ценами. */
function suggestZoom(item: GeoSuggestItem): number {
  if (item.kind === "building") return 16;
  if (item.targetType === "landmark" || item.targetType === "street") return item.targetType === "landmark" ? 16 : 15;
  return 15;
}

/** ОДНА кнопка вместо трёх (владелец 15.09.2026: «просто одна кнопка
 *  "проложить маршрут" и иконка, пусть телефон сам решает, в какую карту
 *  отдавать»). Раньше здесь стояли Яндекс, 2ГИС и Google подряд: ряд названий
 *  чужих приложений в нашей карточке, и агент каждый раз выбирал заново то, что
 *  у него и так стоит одно. Как именно система выбирает карту — разобрано в
 *  lib/openRoute.ts у openRouteNative(). */
function RouteButtons({ lat, lng }: { lat: number; lng: number }) {
  const mobile = useMobileUx();
  return (
    <button
      type="button"
      className="pill ghost sm"
      onClick={() => openRouteNative(lat, lng, mobile)}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 11l19-9-9 19-2-8-8-2z" />
      </svg>
      Проложить маршрут
    </button>
  );
}

/** Карточка списка слева от карты — фото сверху (или честная заглушка, если
 *  объект без фото), цена бейджем поверх, название/комнаты/адрес снизу.
 *  Выбор варианта A из макета 14.09.2026 (владелец: «как в топовых сайтах»,
 *  фото-карточки, по 2 в ряд, кириллица в адресах). Клик — та же логика
 *  выбора, что раньше была у строк горизонтальной ленты (перелёт камеры +
 *  подсветка на карте через selectedMapId). */
function MapPropertyCard({
  p,
  selected,
  mine,
  onSelect,
  hovered = false,
  onHover,
}: {
  p: MapProperty & { lat: number; lng: number };
  selected: boolean;
  mine: boolean;
  onSelect: () => void;
  hovered?: boolean;
  onHover?: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`map-card${selected ? " is-sel" : ""}${hovered ? " is-hover" : ""}`}
      role="listitem"
      onClick={onSelect}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
    >
      <div className="map-card-photo">
        {p.coverPhotoUrl ? (
          <img src={p.coverPhotoUrl} alt="" loading="lazy" />
        ) : (
          <div className="map-card-nophoto">
            <HomeIcon size={22} color="rgb(var(--rgb-ink) / 0.28)" />
          </div>
        )}
        <span className="map-card-price">{formatMoney(p.price, p.currency)}</span>
      </div>
      <div className="map-card-title">
        {p.title}
        {mine ? " · моё" : ""}
      </div>
      {p.placeDescription && <div className="map-card-addr">{p.placeDescription}</div>}
    </button>
  );
}

/**
 * КАРТОЧКА ОБЪЕКТА ПОВЕРХ КАРТЫ (25.09.2026). Владелец: «объекты не
 * нажимаются, как будто картинка… не как премиальный сайт». Раньше нажатие на
 * объект открывало шторку на весь экран с размытым фоном — карта пропадала, и
 * в шторке было одно название. Теперь, как в Яндекс и Google Картах, карточка
 * встаёт поверх карты внизу, карта остаётся живой: можно двигать, нажимать
 * соседний объект (карточка сменится), нажатие мимо — закрывает.
 */
function MapObjectCard({ p, onOpen, onClose }: { p: MapProperty; onOpen: () => void; onClose: () => void }) {
  const facts = mapCardFacts(p);
  const mobile = useMobileUx();
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => setPhotoFailed(false), [p.id]);
  return (
    <div className="map-obj-card" role="region" aria-label={p.title}>
      <button type="button" className="map-obj-close" aria-label="Закрыть" onClick={onClose}>
        <X size={18} />
      </button>
      <button type="button" className="map-obj-photo" onClick={onOpen} aria-label="Открыть объект">
        {p.coverPhotoUrl && !photoFailed ? (
          <img src={p.coverPhotoUrl} alt="" onError={() => setPhotoFailed(true)} />
        ) : (
          <span className="map-card-nophoto">
            <HomeIcon size={24} color="rgb(var(--rgb-ink) / 0.28)" />
          </span>
        )}
      </button>
      <div className="map-obj-body">
        <b className="map-obj-price">{facts.price}</b>
        <button type="button" className="map-obj-title" onClick={onOpen}>
          {p.title}
        </button>
        {facts.details && <span className="map-obj-sub">{facts.details}</span>}
        {facts.place && <span className="map-obj-sub is-place">{facts.place}</span>}
        <div className="map-obj-acts">
          <button type="button" className="pill sm" onClick={onOpen}>
            Открыть объект
          </button>
          {p.lat != null && p.lng != null && (
            <button
              type="button"
              className="pill ghost sm"
              onClick={() => openRouteNative(p.lat!, p.lng!, mobile)}
              aria-label="Маршрут"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <Navigation size={15} aria-hidden="true" />
              <span className="map-obj-route-label">Маршрут</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Дом с несколькими объектами — та же плавающая карточка, внутри список. */
function MapBuildingCard({
  items,
  onPick,
  onClose,
}: {
  items: MapProperty[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="map-obj-card is-list" role="region" aria-label="Дом">
      <button type="button" className="map-obj-close" aria-label="Закрыть" onClick={onClose}>
        <X size={18} />
      </button>
      <b className="map-obj-head">{items.length > 0 ? `В этом доме: ${items.length}` : "Дом"}</b>
      <div className="map-obj-rows">
        {items.map((p) => (
          <button key={p.id} type="button" className="map-obj-row" onClick={() => onPick(p.id)}>
            <b>{formatMoney(p.price, p.currency)}</b>
            <span>{p.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function PropertiesMap() {
  const can = useCan();
  // Вкладка «Изменения на сайте» (перенос меню 15.09.2026) — тот же счётчик и
  // право, что в lib/navigation.ts / pages/Properties.tsx.
  const { data: siteNotifications } = useSiteNotifications({ enabled: can("siteChanges.view") });
  const navigate = useNavigate();
  const mobile = useMobileUx();
  const agent = useAuthStore((s) => s.agent);
  const [scope, setScope] = useState<"mine" | "all">("all");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [ribbonId, setRibbonId] = useState<string | null>(null);
  /** Объект под мышкой — на карте (плашка) или в списке (карточка): вторая
   *  сторона подсвечивается (25.09.2026). */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [nearMe, setNearMe] = useState<{ lat: number; lng: number } | null>(null);
  /** Подложка Яндекса отказала на холсте и заменена на OSM (PropertyMapExplorer)
   *  — копирайт-плашку «© Яндекс» ниже нужно погасить вместе с ней. */
  const [yandexBasemapFailed, setYandexBasemapFailed] = useState(false);
  /** Ни Яндекс, ни OSM не отдали тайлы (PropertyMapExplorer, порог отказов) —
   *  честная строка вместо тихо пустого серого холста, см. п.4
   *  docs/breakage-audit-night-20-09.md. */
  const [basemapUnavailable, setBasemapUnavailable] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<GeoResolveResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** Метка на карте, куда именно привёл поиск — владелец 14.09.2026 вживую:
   *  «ввожу адрес, показывается просто картинка, никакой отметки нет, где
   *  дом — ищу сам». `flyTo` двигал камеру, но раньше НИЧЕГО не отмечал на
   *  месте — как в реальных картах, теперь ставит обычный маркер-«каплю». */
  const [searchPin, setSearchPin] = useState<{ lat: number; lng: number } | null>(null);
  /** Живые подсказки под полем поиска — «как в топовых картах» (владелец
   *  14.09.2026): раньше поиск ждал полного слова и «Найти», выпадающего
   *  списка не было вовсе, хотя подсказка (GET /geo/suggest) уже существовала
   *  для другого экрана. */
  const [suggestions, setSuggestions] = useState<GeoSuggestItem[]>([]);
  const [inputFocused, setInputFocused] = useState(false);
  /** Подсказку выбрали (или отправили поиск) — поле заполнилось её же текстом,
   *  следующий дебаунс не должен переспрашивать список по точному совпадению. */
  const justPickedRef = useRef(false);
  /** Действует только последний запрос поиска и последний запрос подсказок
   *  (24.09.2026, lib/latestRequest.ts). Без этого поздний ответ «Найти» по
   *  старому слову переставлял метку поверх уже выбранной подсказки, а
   *  подсказки, запрошенные до отправки, приходили после неё и снова
   *  раскрывали только что закрытый список. */
  const [searchSeq] = useState(createLatestRequest);
  const [suggestSeq] = useState(createLatestRequest);
  const debouncedQuery = useDebouncedValue(query, 250);
  const mapHandle = useRef<PropertyMapExplorerHandle | null>(null);
  const ribbonRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (justPickedRef.current) {
      justPickedRef.current = false;
      return;
    }
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const id = suggestSeq.next();
    suggestGeoAddress(q)
      .then((items) => {
        if (suggestSeq.isLatest(id)) setSuggestions(items);
      })
      .catch(() => {
        if (suggestSeq.isLatest(id)) setSuggestions([]);
      });
    return () => suggestSeq.invalidate();
  }, [debouncedQuery, suggestSeq]);

  const { data, isLoading, error } = usePropertiesMap(scope === "mine" && agent ? { agentId: agent.id } : {});

  const ribbonItems = useMemo(() => {
    const items = (data?.properties ?? []).filter(
      (p): p is MapProperty & { lat: number; lng: number } => p.lat != null && p.lng != null
    );
    // «Рядом со мной» сортирует ленту по расстоянию по прямой (та же
    // haversine-формула, что и на сервере, — geoDistance.ts). Время в пути
    // не показываем: у CRM нет службы маршрутизации, а придумывать минуты
    // «на машине», как в мокапе, значило бы врать честным «нет данных».
    if (!nearMe) return items;
    return [...items].sort(
      (a, b) =>
        distanceMeters(nearMe.lat, nearMe.lng, a.lat, a.lng) - distanceMeters(nearMe.lat, nearMe.lng, b.lat, b.lng)
    );
  }, [data, nearMe]);

  // Клик по дому (не только по объекту/кластеру) тоже подсвечивает его на
  // карте — владелец 14.09.2026: «нельзя кликать по дому чтобы он светился,
  // как в Яндексе/Google?». Слой buildings-extrusion уже красит выбранный id
  // отдельным цветом (правило 3, исключение) — не хватало только передать
  // сюда id ИМЕННО дома, а не оставлять его на прежнем ribbonId. У обоих
  // видов sheet есть .id — простое условие достаточно.
  const selectedMapId = sheet ? sheet.id : ribbonId;

  function selectRibbon(id: string) {
    setRibbonId(id);
    ribbonRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const item = ribbonItems.find((p) => p.id === id);
    if (item) mapHandle.current?.flyTo(item.lat, item.lng);
  }

  function handleSelectProperty(id: string) {
    setSheet({ kind: "property", id });
    selectRibbon(id);
  }

  // Esc закрывает карточку поверх карты — как шторка, которая была здесь раньше.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheet(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);

  function handleSelectBuilding(id: string) {
    setSheet({ kind: "building", id });
  }

  function handleSelectCluster(id: string) {
    const cluster = data?.clusters.find((c) => c.id === id);
    if (cluster) mapHandle.current?.flyTo(cluster.lat, cluster.lng, 15);
  }

  function handleLongPress(lat: number, lng: number) {
    savePendingMapPin(lat, lng);
    toast.success("Точка поставлена. Откройте «Новый объект» — координата уже на руках у мастера.");
    navigate("/properties/new");
  }

  async function handleSearch(q: string) {
    if (!q.trim()) return;
    const id = searchSeq.next();
    justPickedRef.current = true;
    // Подсказки, уже летящие к нам, после отправки не нужны — не дать им
    // раскрыть список заново.
    suggestSeq.invalidate();
    setSuggestions([]);
    setSearching(true);
    setSearchError(null);
    try {
      // Номер объекта («ОБ-000088», «№88», «88») — летим к самому объекту (05.10.2026).
      // Нет такого объекта — продолжаем обычным геопоиском (вдруг «88» — название места).
      const shortId = parseShortCode(q);
      if (shortId !== null) {
        const point = await resolvePropertyPoint(shortId);
        if (!searchSeq.isLatest(id)) return;
        if (point.kind === "point") {
          setSearchResult(null);
          setSearchPin({ lat: point.lat, lng: point.lng });
          mapHandle.current?.flyTo(point.lat, point.lng, 16);
          return;
        }
        if (point.kind === "noPoint") {
          setSearchResult(null);
          setSearchPin(null);
          setSearchError("У объекта нет точки на карте.");
          return;
        }
      }
      const result = await resolveGeoPlace(q.trim());
      if (!searchSeq.isLatest(id)) return; // уже искали другое или выбрали подсказку
      setSearchResult(result);
      if (result) {
        setSearchPin({ lat: result.lat, lng: result.lng });
        mapHandle.current?.flyTo(result.lat, result.lng, result.radiusM > 2000 ? 13 : 15);
      } else {
        setSearchPin(null);
        setSearchError("Ничего не нашлось — попробуйте другое название.");
      }
    } catch {
      if (searchSeq.isLatest(id)) setSearchError("Не удалось найти место, попробуйте ещё раз.");
    } finally {
      if (searchSeq.isLatest(id)) setSearching(false);
    }
  }

  function pickSuggestion(item: GeoSuggestItem) {
    justPickedRef.current = true;
    // Выбор подсказки главнее «Найти», отправленного раньше: его поздний ответ
    // метку уже не переставит.
    searchSeq.invalidate();
    suggestSeq.invalidate();
    setSearching(false);
    setQuery(item.label);
    setSuggestions([]);
    setSearchError(null);
    setSearchResult(null);
    setSearchPin({ lat: item.lat, lng: item.lng });
    mapHandle.current?.flyTo(item.lat, item.lng, suggestZoom(item));
  }

  function handleNearMe() {
    if (!navigator.geolocation) {
      toast.error("Геолокация недоступна в этом браузере.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setNearMe({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => toast.error("Не удалось определить местоположение."),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  const buildingItems = sheet?.kind === "building" ? (data?.properties ?? []).filter((p) => p.buildingId === sheet.id) : [];
  const propertyItem = sheet?.kind === "property" ? data?.properties.find((p) => p.id === sheet.id) : undefined;

  const searchBlock = (
    <div style={{ position: "relative" }}>
      <form
        className="row"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSearch(query);
        }}
      >
        <input
          id="map-search"
          aria-label="Поиск места на карте"
          className="inp"
          style={{ flex: 1 }}
          placeholder="ЦУМ, 82 мкр, Рудаки…"
          value={query}
          autoComplete="off"
          role="combobox"
          aria-expanded={inputFocused && suggestions.length > 0}
          aria-controls="map-search-suggestions"
          onChange={(e) => {
            justPickedRef.current = false;
            setQuery(e.target.value);
            if (!e.target.value.trim()) {
              searchSeq.invalidate();
              setSearching(false);
              setSearchPin(null);
              setSearchResult(null);
            }
          }}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
        />
        {/* Пустое поле — кнопка честно неактивна (22.09.2026). Раньше она
            выглядела рабочей, а handleSearch первой же строкой выходил на
            `!q.trim()`: нажатие не делало РОВНО ничего и ничего не объясняло.
            Поймано сторожем мёртвых кнопок на телефоне. */}
        <button type="submit" className="pill" disabled={searching || !query.trim()}>
          {searching ? "Ищу…" : "Найти"}
        </button>
      </form>
      {/* Живые подсказки при вводе — «как в топовых картах» (владелец
          14.09.2026), вместо «ввести слово целиком и нажать Найти».
          `onMouseDown` вместо `onClick`: срабатывает раньше `onBlur` поля,
          иначе список схлопывался бы до того, как долетал клик. */}
      {inputFocused && suggestions.length > 0 && (
        <ul
          id="map-search-suggestions"
          role="listbox"
          className="card"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 5,
            marginTop: 4,
            padding: 4,
            listStyle: "none",
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {suggestions.map((item) => (
            <li key={item.kind === "building" ? `building:${item.buildingId}` : `${item.targetType}:${item.targetId}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="lk"
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 6px" }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSuggestion(item);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {searchError && (
        <p className="quiet" style={{ marginTop: 6 }}>
          {searchError}
        </p>
      )}
      {searchResult && (searchResult.alternatives.length > 0 || searchResult.confidence !== "exact") && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          <span className="quiet">Похоже на: {searchResult.name}.</span>
          {searchResult.alternatives.map((alt) => (
            <button
              key={`${alt.targetType}:${alt.targetId}`}
              type="button"
              className="chip"
              onClick={() => {
                setSearchPin({ lat: alt.lat, lng: alt.lng });
                mapHandle.current?.flyTo(alt.lat, alt.lng, alt.radiusM > 2000 ? 13 : 15);
              }}
            >
              {alt.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // Список объектов — карточки с фото, по 2 в ряд (владелец 14.09.2026,
  // выбран вариант A из макета: «как в топовых сайтах»). Раньше была лента
  // горизонтального скролла ПОД картой (решение 12.09.2026) — прямое новое
  // решение владельца его отменяет; сама карта (PropertyMapExplorer) не
  // тронута, только то, что вокруг нее.
  const cardsBlock = ribbonItems.length > 0 && (
    <div className="map-grid" role="list" aria-label="Объекты на карте">
      {ribbonItems.map((p) => (
        <div
          key={p.id}
          ref={(el) => {
            if (el) ribbonRefs.current.set(p.id, el);
            else ribbonRefs.current.delete(p.id);
          }}
        >
          <MapPropertyCard
            p={p}
            selected={ribbonId === p.id}
            mine={p.intakeAgentId === agent?.id}
            // Только handleSelectProperty — он сам зовёт selectRibbon. Раньше
            // здесь стояли оба подряд: два перелёта камеры и две прокрутки
            // списка на один клик (24.09.2026).
            onSelect={() => handleSelectProperty(p.id)}
            hovered={hoveredId === p.id}
            onHover={(on) => setHoveredId(on ? p.id : null)}
          />
        </div>
      ))}
    </div>
  );

  // Объекты без точки на карте не рисуются и в кружки не входят (сервер
  // считает их отдельно, 24.09.2026) — одна строка, чтобы число на карте не
  // расходилось с каталогом молча.
  const withoutPoint = data?.withoutPoint ?? 0;
  const withoutPointLine = withoutPoint > 0 && (
    <p className="quiet" style={{ margin: "0 14px 8px" }}>
      Ещё {withoutPoint} без точки на карте
    </p>
  );

  // Карта убирается только когда показывать НЕЧЕГО (24.09.2026). Раньше
  // условием было `!error`: данные карты перезапрашиваются раз в минуту
  // (lib/queryClient.ts), и один неудачный фоновый перезапрос — при том что
  // прошлый набор объектов у TanStack Query на руках — размонтировал холст со
  // всем состоянием (кадр, выбор, метка поиска) и ставил на его место «Не
  // удалось загрузить карту». Со старыми данными карта остаётся, над ней —
  // тихая строка (под вкладками, `error && data`).
  const loadFailed = !!error && !data;
  // На компьютере высоту/ширину холста задаёт CSS (.map-layout в
  // theme-2026-map.css): в узком окне с мышью он встаёт под поиск, над
  // карточками, а не сжимается сбоку от списка до полоски.
  const mapBlock = !loadFailed && (
    <div
      className={mobile ? undefined : "map-canvas"}
      style={{
        position: "relative",
        ...(mobile ? { flex: 1, minWidth: 0, height: "50dvh" } : {}),
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <Suspense fallback={null}>
        {data && (
          <PropertyMapExplorer
            data={data}
            currentAgentId={agent?.id ?? null}
            selectedId={selectedMapId}
            onSelectProperty={handleSelectProperty}
            onSelectBuilding={handleSelectBuilding}
            onSelectCluster={handleSelectCluster}
            onLongPressMap={handleLongPress}
            onBasemapFallback={() => setYandexBasemapFailed(true)}
            onBasemapUnavailable={() => setBasemapUnavailable(true)}
            nearMe={nearMe}
            searchPin={searchPin}
            handleRef={mapHandle}
            hoveredId={hoveredId}
            onHoverProperty={setHoveredId}
            onEmptyClick={() => setSheet(null)}
            cardOpen={sheet != null}
          />
        )}
      </Suspense>
      {propertyItem && (
        <MapObjectCard
          p={propertyItem}
          onOpen={() => navigate(`/properties/${propertyItem.shortId}`)}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "building" && (
        <MapBuildingCard items={buildingItems} onPick={handleSelectProperty} onClose={() => setSheet(null)} />
      )}
      {isLoading && (
        <div className="state" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <p>Загружаю карту…</p>
        </div>
      )}
      {/* Ни один источник подложки не отдал тайлы (PropertyMapExplorer, порог
          отказов в обработчике "error") — строка сверху, а НЕ на весь холст:
          точки объектов и кластеры рисуются своими GeoJSON-источниками поверх
          подложки и остаются рабочими без неё, прятать их за оверлеем незачем. */}
      {basemapUnavailable && (
        <div
          className="row"
          style={{
            position: "absolute",
            top: 8,
            // Слева — кнопка «Рядом со мной», справа — зум: строка между ними.
            left: 54,
            right: 54,
            justifyContent: "center",
            gap: 6,
            background: "rgba(255,255,255,0.9)",
            color: "#111",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 13,
            textAlign: "center",
          }}
        >
          Подложка карты недоступна — точки объектов показаны без карты
        </div>
      )}
      {/* «Рядом со мной» — элемент самой карты, а не шапки экрана (как у любого
          карточного приложения). В ЛЕВОМ верхнем углу (24.09.2026): справа
          сверху стоит кнопка зума MapLibre (NavigationControl, тот же отступ
          10 px), и эта кнопка лежала ровно под ней — нажать было нельзя, а
          видно только краешек. */}
      <button
        type="button"
        aria-label="Рядом со мной"
        title="Рядом со мной"
        onClick={handleNearMe}
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          width: 36,
          height: 36,
          display: "grid",
          placeItems: "center",
          borderRadius: "50%",
          border: 0,
          background: "var(--c-card-solid)",
          color: "rgb(var(--rgb-ink))",
          boxShadow: "var(--shadow-pop, 0 4px 12px rgba(0,0,0,.15))",
          cursor: "pointer",
        }}
      >
        <LocateFixed size={18} />
      </button>
      {/* Требование условий Яндекса при использовании их тайлов (план,
          раздел «Что осталось выяснить», п. 4.1.3/6.5.1): лого, копирайт,
          ссылка на условия, кнопка «открыть в Картах». Рисуется поверх
          холста React-ом — MapLibre не даёт кликабельным ссылкам ничего,
          кроме своего обязательного атрибуционного контрола.
          Слева снизу (24.09.2026): справа снизу стоит тот самый контрол
          MapLibre (кнопка «i»), и плашка закрывала его целиком. */}
      {import.meta.env.VITE_YANDEX_TILES_KEY && !yandexBasemapFailed && (
        <div
          className="row"
          style={{
            position: "absolute",
            left: 8,
            bottom: 8,
            // Не дотягиваться до кнопки атрибуции справа на узком телефоне.
            maxWidth: "calc(100% - 56px)",
            flexWrap: "wrap",
            gap: 8,
            background: "rgba(255,255,255,0.85)",
            borderRadius: 8,
            padding: "4px 8px",
            fontSize: 13,
          }}
        >
          <span>© Яндекс</span>
          <a href="https://yandex.ru/legal/maps_termsofuse/" target="_blank" rel="noopener noreferrer">
            Условия
          </a>
          <a href="https://yandex.ru/maps/" target="_blank" rel="noopener noreferrer">
            Открыть в Картах
          </a>
        </div>
      )}
    </div>
  );

  return (
    <Rh2Screen>
      <div className="pg-h">
        <div>
          <h1>Карта объектов</h1>
          <p className="sub">Где что стоит и почём — без переключателей, само собой.</p>
        </div>
        <div className="acts">
          <div className="seg" role="tablist" aria-label="Чьи объекты">
            {(["all", "mine"] as const).map((s) => (
              <button key={s} type="button" role="tab" aria-selected={scope === s} onClick={() => setScope(s)}>
                {s === "all" ? "Все" : "Мои"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ObjectsTabs />

      {loadFailed && (
        <div className="state">
          <p>Не удалось загрузить карту.</p>
        </div>
      )}
      {error && data && (
        <p className="quiet" role="status" style={{ margin: "0 0 8px" }}>
          Не удалось обновить карту — показаны последние загруженные объекты. Попробую ещё раз сам.
        </p>
      )}

      {mobile ? (
        <>
          {searchBlock}
          {mapBlock}
          {withoutPointLine}
          {cardsBlock}
        </>
      ) : (
        <div className="map-layout">
          <div className="map-sidebar">
            <div style={{ padding: 14 }}>{searchBlock}</div>
            {withoutPointLine}
            {cardsBlock}
          </div>
          {mapBlock}
        </div>
      )}

    </Rh2Screen>
  );
}
