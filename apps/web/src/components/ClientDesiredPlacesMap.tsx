import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { ClientDesiredPlace } from "../types";
import { attachYandexFallback, primaryTileConfig } from "../lib/leafletYandexTiles";

/**
 * Карта «Где ищет» в карточке клиента (12.09.2026, docs/geo-match-plan-12-09.md) —
 * read-only, показывает ВСЕ желаемые места покупателя сразу: метка и круг
 * радиуса на каждое, масштаб карты подбирается так, чтобы влезли все места
 * (fitBounds), тот же приём, что и в PropertyMapView.
 *
 * Не переиспользует LocationPicker: там ОДНА перетаскиваемая метка для правки,
 * здесь — НЕСКОЛЬКО меток без взаимодействия для просмотра. Круг рисуется тем
 * же способом, что в property-wizard/MapPointPicker.tsx (accuracyCircle):
 * цвет литералом, не токеном темы — Leaflet кладёт его в презентационный
 * атрибут SVG, `var()` там не работает.
 */
function placeIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="transform:translate(-50%,-100%);width:22px;height:22px;border-radius:50% 50% 50% 0;
      background:#2563eb;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);rotate:45deg;"></div>`,
    iconSize: [22, 22],
    iconAnchor: [0, 0],
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function ClientDesiredPlacesMap({ places }: { places: ClientDesiredPlace[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true, scrollWheelZoom: false });
    const tileConfig = primaryTileConfig();
    const tileLayer = L.tileLayer(tileConfig.url, {
      attribution: tileConfig.attribution,
      maxZoom: 19,
    }).addTo(map);
    // Отказ Яндекса откатывает на OSM молча (см. leafletYandexTiles.ts); эта
    // read-only карта не показывает отдельный статус офлайна — если упадёт и
    // OSM, карта останется серой, как и раньше.
    attachYandexFallback(tileLayer, tileConfig, () =>
      console.error("Карта желаемых мест: подложка недоступна (Яндекс и OSM)")
    );
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.forEach((l) => l.remove());
    layersRef.current = [];

    const bounds: L.LatLngTuple[] = [];
    places.forEach((p) => {
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      bounds.push([lat, lng]);
      const circle = L.circle([lat, lng], {
        radius: p.radiusM,
        color: "#2563eb",
        weight: 1,
        fillColor: "#2563eb",
        fillOpacity: 0.1,
        opacity: 0.4,
        interactive: false,
      }).addTo(map);
      const marker = L.marker([lat, lng], { icon: placeIcon() }).addTo(map);
      if (p.label) {
        marker.bindTooltip(escapeHtml(p.label), { direction: "top", offset: [0, -18] });
      }
      layersRef.current.push(circle, marker);
    });

    if (bounds.length > 0) {
      if (bounds.length === 1) {
        // Одна точка: fitBounds на одну координату зумит до предела — вместо
        // этого центрируем и подбираем зум так, чтобы влез круг радиуса.
        const only = places[0];
        const r = only?.radiusM ?? 1000;
        const metersToDegrees = r / 111_320; // грубая оценка, достаточная для зума обзора
        map.fitBounds(
          [
            [bounds[0][0] - metersToDegrees, bounds[0][1] - metersToDegrees],
            [bounds[0][0] + metersToDegrees, bounds[0][1] + metersToDegrees],
          ],
          { padding: [24, 24], maxZoom: 15 }
        );
      } else {
        map.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 });
      }
    }
  }, [places]);

  return <div ref={containerRef} style={{ height: 220, width: "100%", overflow: "hidden" }} />;
}
