/**
 * АДРЕС ТОЧКИ ИЗ ДВУХ ИСТОЧНИКОВ — OpenStreetMap и наш справочник домов.
 *
 * 23.09.2026, владелец: «карта только улицу пишет, а дальше не пишет номер
 * дома». С 14.09 (#391) клик по карте и мастер объекта брали адрес только у
 * Nominatim (OpenStreetMap). В Душанбе у большинства зданий OSM номера нет, и
 * Nominatim честно отвечает одной улицей. А в нашем справочнике (`GET
 * /geo/lookup`, `apps/api/src/lib/geoLookup.ts`) у 22 630 из 24 325 домов есть
 * и улица, и номер — только в ответ на точку его никто больше не спрашивал.
 *
 * Почему справочник тогда отключили: «ближайший дом в 30 м» иногда называл
 * соседний дом с другой улицей. Поэтому доверяем ему не вслепую:
 *   1. OSM сам знает номер — берём OSM, как было;
 *   2. точка ВНУТРИ контура дома из справочника — берём справочник: это тот
 *      самый дом, на который нажали, как в Яндексе;
 *   3. дом только «рядом» — номер берём, лишь если улица справочника совпала с
 *      улицей OSM (или OSM улицы не знает вовсе): соседний дом с чужой улицы
 *      так больше не подставится;
 *   4. иначе — то, что есть (улица OSM без номера).
 *
 * Чистая функция без сети — её проверяет `__tests__/pointAddress.test.ts`.
 */

/** Разобранный ответ Nominatim (см. `lib/reverseGeocode.ts`). */
export interface OsmPointAddress {
  address: string;
  street: string | null;
  houseNumber: string | null;
  districtName: string | null;
}

/** То, что нужно из ответа `GET /geo/lookup`. */
export interface OwnPointAddress {
  street: string | null;
  houseNumber: string | null;
  microdistrict: string | null;
  confidence: "contour" | "nearby" | "district_only";
  district: { id: string; name: string } | null;
}

export interface PointAddress {
  /** «Улица, дом»; пустая строка — адреса у точки нет ни там, ни там. */
  address: string;
  /** Район: наш (по границе) важнее, OSM — запасной. */
  districtName: string | null;
}

const STREET_KIND_WORDS = new Set([
  "улица",
  "ул",
  "проспект",
  "пр",
  "пр-т",
  "переулок",
  "пер",
  "проезд",
  "тупик",
  "бульвар",
  "шоссе",
  "кӯчаи",
  "кучаи",
  "хиёбони",
  "гузаргоҳи",
  "гузаргохи",
  "street",
  "st",
  "avenue",
  "ave",
  "kuchai",
  "khiyoboni",
  "prospekt",
  "ulitsa",
]);

/**
 * ОДНО НАЗВАНИЕ В ТРЁХ НАПИСАНИЯХ (28.09.2026, владелец: «вообще нигде нет номеров
 * дома»). Nominatim отвечает тем, что лежит в OpenStreetMap, а в Душанбе улицы там
 * чаще записаны по-таджикски («хиёбони Рӯдакӣ») или латиницей («Rudaki Avenue»).
 * Справочник пишет по-русски («проспект Рудаки»). Прямое сравнение слов видело в
 * этом РАЗНЫЕ улицы, и правило 3 ниже выбрасывало номер из справочника почти везде.
 *
 * Поэтому слово сводится к латинскому «скелету»: таджикские буквы — к русским
 * (ӯ→у, ӣ→и, ҳ→х, қ→к, ғ→г, ҷ→дж), кириллица — в латиницу, и буквы, которые
 * разные системы передают по-разному (х/kh/h, ж/zh/j, дж/j, й/y/i), — к одной.
 */
const TAJIK_TO_RUSSIAN: Record<string, string> = { ӯ: "у", ӣ: "и", ҳ: "х", қ: "к", ғ: "г", ҷ: "дж", ё: "е", ъ: "", ь: "" };
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "j", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sh", ы: "i", э: "e", ю: "yu", я: "ya",
};

function wordSkeleton(word: string): string {
  const ru = [...word].map((c) => TAJIK_TO_RUSSIAN[c] ?? c).join("");
  const lat = [...ru].map((c) => CYRILLIC_TO_LATIN[c] ?? c).join("");
  return lat
    .replace(/['’`ʼ-]/g, "")
    .replace(/kh/g, "h")
    .replace(/dzh|dj|zh/g, "j")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
}

/** Слова названия без «улица/проспект/…» (или другого набора слов-видов),
 *  регистра, ё и знаков — скелетами. */
function streetWords(name: string, kindWords: ReadonlySet<string> = STREET_KIND_WORDS): string[] {
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,«»"()]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !kindWords.has(w))
    .map(wordSkeleton)
    .filter(Boolean);
}

const DISTRICT_KIND_WORDS = new Set(["район", "р-н", "ноҳияи", "нохияи", "district", "nohiyai", "rayon", "raion"]);

/**
 * Тот ли это район: «Sino», «ноҳияи Шоҳмансур», «район Фирдавсӣ» против наших
 * «Сино», «Шохмансур», «Фирдавси» (28.09.2026). Прежнее сравнение без регистра
 * по вхождению видело совпадение только у русского написания, и мастер объекта
 * молча брал район по грубой подсказке.
 */
export function isSameDistrictName(a: string, b: string): boolean {
  const wa = streetWords(a, DISTRICT_KIND_WORDS);
  const wb = streetWords(b, DISTRICT_KIND_WORDS);
  if (wa.length === 0 || wb.length === 0) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

/**
 * Одна ли это улица: «улица Айни» и «улица Садриддина Айни» — да, «Айни» и
 * «Рудаки» — нет. Все слова короткого названия должны встретиться в длинном.
 */
export function isSameStreet(a: string, b: string): boolean {
  const wa = streetWords(a);
  const wb = streetWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

export function mergePointAddress(osm: OsmPointAddress | null, own: OwnPointAddress | null): PointAddress {
  const districtName = own?.district?.name ?? osm?.districtName ?? null;
  const osmAddress = osm?.address ?? "";

  if (osm?.houseNumber && osm.street) return { address: osmAddress, districtName };

  if (own?.houseNumber) {
    // Дом без улицы в справочнике — номер внутри микрорайона («82 мкр, 14»).
    const ownPlace = own.street ?? own.microdistrict;
    if (ownPlace) {
      const ownAddress = `${ownPlace}, ${own.houseNumber}`;
      if (own.confidence === "contour") return { address: ownAddress, districtName };
      if (own.confidence === "nearby") {
        const osmStreet = osm?.street ?? null;
        if (!osmStreet || (own.street && isSameStreet(osmStreet, own.street))) {
          return { address: ownAddress, districtName };
        }
      }
    }
  }

  if (osmAddress) return { address: osmAddress, districtName };
  return { address: own?.street ?? own?.microdistrict ?? "", districtName };
}
