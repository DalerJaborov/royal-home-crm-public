import { api } from "./api";

/**
 * ТОЧКА — НА ДОМ (28.09.2026, владелец: «по EXIF на пару метров в дорогу ввёл, и
 * не выходит номер дома, потому что метка не на доме»).
 *
 * Точка, которую поставил не человек (снимок объекта, «Определить мою
 * позицию»), в доме почти никогда не лежит: GPS в помещении уходит на 10–30 м,
 * чаще всего на улицу. Справочник (`GET /geo/lookup`) отвечает «рядом дом» и
 * отдаёт точку внутри него — туда метку и переносим, и номер дома встаёт сам.
 * Правило «рядом» (до стены не дальше 30 м) — на сервере, `lib/geoLookup.ts`
 * (`snapToBuilding`), тем же правилом сервер ставит на дом фото с iPhone.
 *
 * `null` — переносить некуда: точка уже в доме, рядом дома нет или сеть
 * отказала. Точку, поставленную рукой, сюда не передают вовсе.
 */
export interface SnappedPoint {
  lat: number;
  lng: number;
  /** «проспект Рудаки, 181» — для строки под картой. */
  label: string;
  /** Сколько метров было от точки до стены дома. */
  movedM: number;
}

interface LookupAnswer {
  confidence: "contour" | "nearby" | "district_only";
  street: string | null;
  houseNumber: string | null;
  building: { lat: number; lng: number; distanceM: number } | null;
}

export async function fetchHouseSnap(lat: number, lng: number): Promise<SnappedPoint | null> {
  try {
    const res = await api<LookupAnswer>(`/geo/lookup?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`);
    return snappedFromLookup(res);
  } catch {
    return null;
  }
}

export function snappedFromLookup(res: LookupAnswer): SnappedPoint | null {
  if (res.confidence !== "nearby" || !res.building) return null;
  const label = [res.street, res.houseNumber].filter(Boolean).join(", ") || "ближайший дом";
  return { lat: res.building.lat, lng: res.building.lng, label, movedM: res.building.distanceM };
}

/** Строка под картой — что сделали и что делать, если дом не тот. */
export function snapNote(snapped: SnappedPoint, source: "photo" | "phone"): string {
  const from = source === "photo" ? "Точка по фото стояла" : "Ваша позиция была";
  return `${from} в ${Math.max(1, snapped.movedM)} м от дома — поставили на дом: ${snapped.label}. Если дом не тот, передвиньте карту.`;
}
