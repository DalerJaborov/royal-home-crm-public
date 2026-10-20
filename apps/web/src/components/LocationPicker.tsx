import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { districtCenter } from "../lib/districtCoords";
import { attachYandexFallback, primaryTileConfig } from "../lib/leafletYandexTiles";

interface LocationPickerProps {
  /** Текущая выбранная точка; null — точка ещё не выбрана. */
  value: { lat: number; lng: number } | null;
  onChange: (coords: { lat: number; lng: number }) => void;
  /** Имя района — старт карты, когда точка ещё не выбрана. */
  districtName?: string;
  /**
   * Радиус вокруг точки, метры — и «насколько широко люди понимают название»
   * у ориентира (справочник ориентиров, docs/geo-match-plan-12-09.md, блок J),
   * и радиус поиска у желаемого места покупателя (там же). Необязательный —
   * форма объекта его не передаёт, пусто/null/undefined — круг не рисуется
   * (обычный выбор точки, как раньше).
   */
  radiusM?: number | null;
}

/** Каплевидная метка (divIcon вместо PNG — так Leaflet не спотыкается о пути к
 * ассетам в сборке, тот же приём, что в PropertyMapView). */
function pinIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="transform:translate(-50%,-100%);width:26px;height:26px;border-radius:50% 50% 50% 0;
      background:#2563eb;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);rotate:45deg;"></div>`,
    iconSize: [26, 26],
    iconAnchor: [0, 0],
  });
}

export function LocationPicker({ value, onChange, districtName, radiusM }: LocationPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  // onChange держим в ref, чтобы не пересоздавать карту на каждый рендер родителя.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const radiusRef = useRef(radiusM);
  radiusRef.current = radiusM;

  // Круг радиуса — тот же приём, что и в property-wizard/MapPointPicker.tsx
  // (accuracyCircle): цвет литералом, не токеном темы — Leaflet кладёт его в
  // презентационный атрибут SVG, `var()` там не работает.
  function syncCircle(map: L.Map, latlng: L.LatLng) {
    const r = radiusRef.current;
    if (!r) {
      circleRef.current?.remove();
      circleRef.current = null;
      return;
    }
    if (circleRef.current) {
      circleRef.current.setLatLng(latlng);
      circleRef.current.setRadius(r);
    } else {
      circleRef.current = L.circle(latlng, {
        radius: r,
        color: "#2563eb",
        weight: 1,
        fillColor: "#2563eb",
        fillOpacity: 0.12,
        opacity: 0.45,
        interactive: false,
      }).addTo(map);
    }
  }

  // Инициализация карты — один раз за монтирование.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const start = value ?? { lat: districtCenter(districtName)[0], lng: districtCenter(districtName)[1] };
    const map = L.map(containerRef.current, { zoomControl: true }).setView([start.lat, start.lng], value ? 16 : 14);
    const tileConfig = primaryTileConfig();
    const tileLayer = L.tileLayer(tileConfig.url, {
      attribution: tileConfig.attribution,
      maxZoom: 19,
    }).addTo(map);
    // Отказ Яндекса откатывает на OSM молча (см. leafletYandexTiles.ts); этот
    // компонент не показывает отдельный статус офлайна (как MapPointPicker) —
    // если упадёт и OSM, карта просто останется серой, как и раньше.
    attachYandexFallback(tileLayer, tileConfig, () =>
      console.error("Карта точки: подложка недоступна (Яндекс и OSM)")
    );

    const marker = L.marker([start.lat, start.lng], { icon: pinIcon(), draggable: true }).addTo(map);
    marker.on("dragend", () => {
      const { lat, lng } = marker.getLatLng();
      syncCircle(map, marker.getLatLng());
      onChangeRef.current({ lat, lng });
    });
    // Клик по карте переносит метку — быстрее, чем тащить издалека.
    map.on("click", (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng);
      syncCircle(map, e.latlng);
      onChangeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });

    mapRef.current = map;
    markerRef.current = marker;
    syncCircle(map, marker.getLatLng());
    // Первый рендер в скрытом/раскрывающемся контейнере может дать нулевой размер —
    // пересчитываем, когда контейнер получил высоту.
    setTimeout(() => map.invalidateSize(), 0);

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Родитель сменил район (и точка ещё не выбрана вручную) — переехать к новому центру.
  useEffect(() => {
    if (!mapRef.current || !markerRef.current || value) return;
    const [lat, lng] = districtCenter(districtName);
    mapRef.current.setView([lat, lng], 14);
    markerRef.current.setLatLng([lat, lng]);
    syncCircle(mapRef.current, markerRef.current.getLatLng());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [districtName, value]);

  // Родитель подставил другую точку в уже смонтированную карту (в форме клиента
  // удалили первое «место», и второе заняло его индекс-ключ): метка и круг
  // переезжают. Свои же клики и перетаскивание сюда не попадают: метка уже там.
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker || !value) return;
    const cur = marker.getLatLng();
    if (cur.lat === value.lat && cur.lng === value.lng) return;
    marker.setLatLng([value.lat, value.lng]);
    map.panTo([value.lat, value.lng]);
    syncCircle(map, marker.getLatLng());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.lat, value?.lng]);

  // Радиус поменяли из формы (не перетаскиванием) — круг обновляется отдельно,
  // без лишнего re-init карты.
  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return;
    syncCircle(mapRef.current, markerRef.current.getLatLng());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radiusM]);

  return (
    <div className="rounded-lg overflow-hidden border border-line">
      <div ref={containerRef} className="h-[240px] w-full" />
    </div>
  );
}
