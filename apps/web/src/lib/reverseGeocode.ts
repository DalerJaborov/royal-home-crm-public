/**
 * ОБРАТНОЕ ГЕОКОДИРОВАНИЕ ТОЧКИ (Nominatim / OpenStreetMap) — общая часть.
 *
 * Один провайдер на оба места, где карте нужен настоящий адрес по точке, а не
 * наш собственный справочник домов: мастер объекта (`property-wizard/
 * useReverseGeocode.ts`, обёрнут хуком с дебаунсом под перетаскивание пина) и
 * клик по пустому месту карты объектов (`PropertyMapExplorer.tsx`, разовый
 * вызов без хука). Раньше клик по карте отвечал по своему справочнику домов
 * (`GET /geo/lookup`) — владелец поймал вживую, что у соседних точек одного
 * дома справочник иногда называет РАЗНУЮ улицу (контуры соседних домов на
 * плане смыкаются впритык, и наша логика «ближайший дом в 30 м» иногда берёт
 * не тот): «хочу как в Гугле и Яндексе — нажимаешь и видишь всё правильно».
 * Nominatim не знает о наших домах вовсе и отвечает тем же самым OSM-адресом,
 * что показали бы настоящие карты — здесь честнее его переспросить, чем
 * улучшать собственную эвристику.
 *
 * Правила использования Nominatim соблюдаем как и в хуке мастера: идентификация
 * параметром `email` (свой `User-Agent` из вкладки браузера не выставить —
 * его подменяет сам браузер), не долбим сервис — на карте это разовый клик,
 * не поток, но всё равно отменяем предыдущий запрос, если человек кликнул в
 * другое место раньше ответа.
 */

import { api } from "./api";
import { mergePointAddress, type OsmPointAddress, type OwnPointAddress, type PointAddress } from "./pointAddress";

const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const CONTACT_EMAIL = "info@royalhome.tj";

export type ReverseGeocodeResult = PointAddress;

/** Сервис ответил, но не адресом — отдельный класс ошибки, чтобы отличить
 *  «ответил с ошибкой» от «вообще не достучались» (см. CLAUDE.md, п.4г). */
export class NominatimHttpError extends Error {}

interface NominatimReverse {
  address?: Record<string, string | undefined>;
  display_name?: string;
}

/** Улица + дом; если улицы нет — первые две части display_name (без страны). */
export function parseNominatimReverse(data: NominatimReverse): OsmPointAddress {
  const a = data.address ?? {};
  const street = a.road ?? a.pedestrian ?? a.residential ?? a.neighbourhood ?? "";
  const house = a.house_number ?? "";
  // Номер без улицы — не адрес («12» в попапе ничего не говорит): тогда запасной
  // display_name, где номер стоит рядом с тем, к чему относится.
  const fromParts = street ? [street, house].filter(Boolean).join(", ") : "";
  const fallback = (data.display_name ?? "").split(",").slice(0, 2).map((s) => s.trim()).filter(Boolean).join(", ");
  return {
    address: fromParts || fallback,
    street: street || null,
    houseNumber: house || null,
    districtName: a.city_district ?? a.suburb ?? a.borough ?? a.county ?? null,
  };
}

async function fetchNominatim(lat: number, lng: number, signal?: AbortSignal): Promise<OsmPointAddress> {
  const url =
    `${NOMINATIM_REVERSE_URL}?format=jsonv2&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}` +
    `&zoom=18&addressdetails=1&accept-language=ru&email=${encodeURIComponent(CONTACT_EMAIL)}`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new NominatimHttpError(`Nominatim ${res.status}`);
  const data = (await res.json()) as NominatimReverse;
  return parseNominatimReverse(data);
}

/** Nominatim иногда висит без ответа. Меньше таймаута хука мастера (8 с), чтобы
 *  справочник успел ответить за него, а не весь запрос упал по чужому таймеру. */
const NOMINATIM_TIMEOUT_MS = 6_000;

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/**
 * Адрес точки: OpenStreetMap и наш справочник домов разом, итог — по правилам
 * `lib/pointAddress.ts` (там же, почему одного OSM мало: номера дома у него в
 * Душанбе почти нет). Один источник отказал — отвечает второй; упали оба —
 * ошибка OSM, как раньше (по её классу хук мастера пишет, что случилось).
 */
export async function fetchReverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<ReverseGeocodeResult> {
  if (signal?.aborted) throw abortError();
  const osmController = new AbortController();
  const onAbort = () => osmController.abort();
  signal?.addEventListener("abort", onAbort);
  const osmTimer = setTimeout(() => osmController.abort(), NOMINATIM_TIMEOUT_MS);
  try {
    const both = Promise.allSettled([
      fetchNominatim(lat, lng, osmController.signal),
      api<OwnPointAddress & { outsideCoverage?: boolean }>(`/geo/lookup?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`),
    ]);
    // У api() своей отмены нет — чужую отмену ловим сами, не дожидаясь справочника.
    const aborted = new Promise<never>((_, reject) => {
      if (signal) signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    const [osm, own] = await Promise.race([both, aborted]);
    if (osm.status === "rejected" && own.status === "rejected") {
      // Наш же таймер Nominatim — это «сервис не ответил», а не отмена
      // вызывающим: AbortError наверху молча гасится и оставил бы «Ищу адрес…».
      const reason: unknown = osm.reason;
      if (reason instanceof DOMException && reason.name === "AbortError" && !signal?.aborted) {
        throw new NominatimHttpError("Nominatim не ответил вовремя");
      }
      throw reason;
    }
    return mergePointAddress(
      osm.status === "fulfilled" ? osm.value : null,
      own.status === "fulfilled" && !own.value.outsideCoverage ? own.value : null,
    );
  } finally {
    clearTimeout(osmTimer);
    signal?.removeEventListener("abort", onAbort);
  }
}
