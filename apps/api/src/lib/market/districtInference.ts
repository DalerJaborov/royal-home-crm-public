/**
 * РАЙОН ОБЪЯВЛЕНИЯ ИЗ ВСЕГО, ЧТО О НЁМ ИЗВЕСТНО (14.11.2026).
 *
 * ЗАЧЕМ. У Paydo район в заголовке карточки («Душанбе | Сино») стоит у каждого пятого
 * объявления, остальные выпадали из сегментов «район × комнаты» и из подбора покупателю.
 * При этом в самом списке API лежит куда больше: текст описания (`description_fields`:
 * «Район: Шохмансур», «Ноҳия: И Сомони»), адрес с координатами, название ориентира в
 * заголовке («Саховат», «Кароболо»). Раньше ничего из этого не читалось.
 *
 * ЛЕСТНИЦА (первая ступень, давшая ответ, побеждает; нет ответа ни у одной — null):
 *   1. район из самого источника — не перебиваем никогда;
 *   2. координаты внутри границы района из справочника (только полигон, без «ближайшего
 *      центра»: это была догадка, а не факт);
 *   3. подписанное поле в тексте: «Район: Сино», «Ноҳия И.Сомони», «Фирдавси район»;
 *   4. улица из адреса, найденная в справочнике улиц, если район улицы однозначен;
 *   5. целый фрагмент адреса/заголовка, равный названию района («Душанбе, Шохмансур»);
 *   6. народное название места из словаря владельца (`FOLK_PLACES`: «Саховат», «91 мкр»)
 *      в заголовке или адресе.
 * Два разных района на одной ступени — это спор данных, молчим (null), а не выбираем.
 *
 * ЧЕГО НЕТ НАМЕРЕННО. Голого «Сино» посреди свободного текста: «Проспект Сино», «Ибни
 * Сино» — улицы, а не район. Слова района без подписи берём только целым фрагментом
 * адреса. Угадывания «по вероятности» тоже нет: не знаем — null.
 */

import { BW, EW } from "../../ai/wordBoundary.js";
import { FOLK_PLACES } from "../../ai/folkPlaces.js";
import { geoMatchKey } from "../geoNormalize.js";
import { districtByAddress, districtByPoint } from "../propertyDistrict.js";
import { canonicalDistrict, normalizeDistrictName, type CanonicalDistrict } from "./districtName.js";

export type DistrictVia = "source" | "point" | "label" | "street" | "segment" | "place";

export interface DistrictEvidence {
  /** Район, как его назвал источник («Исмоили Сомони», «И. Сомони»). */
  sourceDistrict?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Адрес/ориентир из объявления. */
  address?: string | null;
  title?: string | null;
  /** Текст описания (если источник отдал). */
  description?: string | null;
}

export interface DistrictAnswer {
  name: string | null;
  via: DistrictVia | null;
}

/** Написания районов после `geoMatchKey` (регистр, ё, таджикские буквы, латиница, знаки убраны). */
const ALIASES: Array<{ district: CanonicalDistrict; forms: string[]; labelOnlyForms?: string[] }> = [
  { district: "Сино", forms: ["сино"] },
  { district: "Исмоили Сомони", forms: ["исмоили сомони", "исмоил сомони", "и сомони"], labelOnlyForms: ["сомони"] },
  { district: "Шохмансур", forms: ["шохмансур", "шомансур", "шахмансур", "шох мансур"] },
  { district: "Фирдавси", forms: ["фирдавси", "фирдоуси"] },
];

/** Подпись поля: «район», «ноҳия», «р-н», «н.» — после geoMatchKey. */
const LABEL = "(?:район\\p{L}{0,2}|раион\\p{L}{0,2}|р н|р он|нохия\\p{L}{0,2}|н)";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function labelledRegexes(): Array<{ district: CanonicalDistrict; re: RegExp }> {
  const out: Array<{ district: CanonicalDistrict; re: RegExp }> = [];
  for (const a of ALIASES) {
    for (const form of [...a.forms, ...(a.labelOnlyForms ?? [])]) {
      const f = escapeRe(form);
      out.push({ district: a.district, re: new RegExp(`${BW}${LABEL} ${f}${EW}`, "u") });
      // «Фирдавси район» — подпись после названия; голое «сомони» с подписью сзади не берём.
      if (a.forms.includes(form)) out.push({ district: a.district, re: new RegExp(`${BW}${f} ${LABEL}${EW}`, "u") });
    }
  }
  return out;
}
const LABELLED = labelledRegexes();

function uniqueDistrict(found: Set<CanonicalDistrict>): CanonicalDistrict | null | "conflict" {
  if (found.size === 0) return null;
  return found.size === 1 ? [...found][0] : "conflict";
}

/** Ступень 3: подписанный район в произвольном тексте. null — не нашли, "conflict" — два разных. */
export function districtByLabel(text: string | null | undefined): CanonicalDistrict | null | "conflict" {
  if (!text) return null;
  const key = geoMatchKey(text);
  const found = new Set<CanonicalDistrict>();
  for (const { district, re } of LABELLED) if (re.test(key)) found.add(district);
  return uniqueDistrict(found);
}

/** Ступень 5: фрагмент текста целиком равен названию района («Душанбе, Шохмансур»). */
export function districtBySegment(text: string | null | undefined): CanonicalDistrict | null | "conflict" {
  if (!text) return null;
  const found = new Set<CanonicalDistrict>();
  for (const part of text.split(/[,;|•\n]/)) {
    const key = geoMatchKey(part);
    if (!key) continue;
    const d = canonicalDistrict(key);
    if (d) found.add(d);
  }
  return uniqueDistrict(found);
}

/** Написания, которых нет в `FOLK_PLACES`, но которые пишут в объявлениях (район у них тот же). */
const PLACE_ALIASES: Array<{ name: string; district: CanonicalDistrict }> = [
  { name: "Кароболо", district: "Сино" }, // тот же «Караболо» из словаря владельца
  { name: "Дом печать", district: "Исмоили Сомони" }, // тот же «Дом Печати»
];

interface PlaceNeedle {
  re: RegExp;
  district: CanonicalDistrict;
}
let placeIndex: PlaceNeedle[] | null = null;

function places(): PlaceNeedle[] {
  if (placeIndex) return placeIndex;
  const list: Array<{ name: string; district: CanonicalDistrict }> = [...FOLK_PLACES, ...PLACE_ALIASES];
  placeIndex = [];
  for (const p of list) {
    const key = geoMatchKey(p.name);
    // Короче трёх знаков — слишком много случайных совпадений.
    if (key.length < 3) continue;
    // Допускаем до трёх букв окончания: «аэропорта», «цирке». Числовые («91 мкр») — как есть.
    const tail = /\d/.test(key) ? "" : "\\p{L}{0,3}";
    placeIndex.push({ re: new RegExp(`${BW}${escapeRe(key)}${tail}${EW}`, "u"), district: p.district });
  }
  return placeIndex;
}

/** Ступень 6: известное место в тексте (заголовок, адрес). */
export function districtByPlace(text: string | null | undefined): CanonicalDistrict | null | "conflict" {
  if (!text) return null;
  const key = geoMatchKey(text);
  const found = new Set<CanonicalDistrict>();
  for (const { re, district } of places()) if (re.test(key)) found.add(district);
  return uniqueDistrict(found);
}

/** Строки описания, где продавец пишет адрес: «Адрес: …», «Ҷойгиршавӣ: …», «Ориентир: …». */
export function addressLinesOf(description: string | null | undefined): string[] {
  if (!description) return [];
  const out: string[] = [];
  for (const line of description.split("\n")) {
    const m = line.match(/(?:адрес|ориентир|манзил|ҷойгиршавӣ|ҷойгиршави|joygirshavi|address)\s*[:\-–.]\s*(.+)$/iu);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

/** Ответ пробы по набору строк: один район — он; два разных — "conflict"; пусто — null. */
async function overAll(
  items: Array<string | null | undefined>,
  probe: (x: string) => Promise<string | null | "conflict"> | string | null | "conflict"
): Promise<string | null | "conflict"> {
  const found = new Set<string>();
  for (const it of items) {
    if (!it?.trim()) continue;
    const r = await probe(it);
    if (r === "conflict") return "conflict";
    if (r) found.add(r);
  }
  if (found.size === 0) return null;
  return found.size === 1 ? [...found][0] : "conflict";
}

const NONE: DistrictAnswer = { name: null, via: null };

export async function resolveDistrict(ev: DistrictEvidence): Promise<DistrictAnswer> {
  // 1. Источник.
  const fromSource = normalizeDistrictName(ev.sourceDistrict);
  if (fromSource) return { name: fromSource, via: "source" };

  // 2. Координаты в границе района.
  if (ev.latitude != null && ev.longitude != null && Number.isFinite(ev.latitude) && Number.isFinite(ev.longitude)) {
    const byPoint = await districtByPoint(ev.latitude, ev.longitude);
    if (byPoint) return { name: byPoint.name, via: "point" };
  }

  const addressLines = [ev.address, ...addressLinesOf(ev.description)].filter((x): x is string => !!x?.trim());

  // 3. Подписанное поле в тексте.
  const label = await overAll([ev.description, ev.address, ev.title], districtByLabel);
  if (label === "conflict") return NONE;
  if (label) return { name: label, via: "label" };

  // 4. Улица из адреса.
  const street = await overAll(addressLines, async (a) => (await districtByAddress(a))?.name ?? null);
  if (street === "conflict") return NONE;
  if (street) return { name: street, via: "street" };

  // 5. Целый фрагмент = название района.
  const seg = await overAll([ev.address, ev.title, ...addressLines], districtBySegment);
  if (seg === "conflict") return NONE;
  if (seg) return { name: seg, via: "segment" };

  // 6. Известное место в заголовке или адресе.
  const place = await overAll([ev.title, ...addressLines], districtByPlace);
  if (place && place !== "conflict") return { name: place, via: "place" };

  return NONE;
}
