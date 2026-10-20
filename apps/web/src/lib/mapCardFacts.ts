/**
 * ЧТО ПИСАТЬ В КАРТОЧКЕ ОБЪЕКТА НА КАРТЕ (25.09.2026).
 *
 * Владелец: «объекты на карте не нажимаются, как будто картинка… можешь
 * сделать, чтобы нажимались реально и когда мышкой по ним водишь, как Google
 * Maps или Яндекс?». Наведение на плашку цены теперь показывает маленькую
 * карточку, нажатие — карточку поверх карты с кнопкой «Открыть объект».
 * Обе берут строки отсюда, чтобы одно и то же не считалось в двух местах по-разному.
 *
 * Чистая функция без DOM — её проверяет `__tests__/mapCardFacts.test.ts`.
 */
import { formatMoney } from "./format";
import { distanceMeters } from "./geoDistance";
import { priceLabel } from "./mapGeoJson";

export interface MapCardInput {
  price: number;
  currency: string;
  rooms: number | null;
  pricePerSqmTjs: number | null;
  placeDescription: string;
}

export interface MapCardFacts {
  /** Полная цена: «1 452 000 с.», «$85 000». */
  price: string;
  /** «3-комн. · 8 500 с. за м²» — то, чего нет на плашке. Пусто, если нечего. */
  details: string;
  /** «Сино, 400 м от ЦУМа» или пусто. */
  place: string;
}

export function mapCardFacts(p: MapCardInput): MapCardFacts {
  const parts: string[] = [];
  if (p.rooms) parts.push(`${p.rooms}-комн.`);
  if (p.pricePerSqmTjs != null && p.pricePerSqmTjs > 0) {
    parts.push(`${formatMoney(Math.round(p.pricePerSqmTjs), "TJS")} за м²`);
  }
  return {
    price: formatMoney(p.price, p.currency),
    details: parts.join(" · "),
    place: p.placeDescription.trim(),
  };
}

/**
 * Нажатие на пустое место карты. Открыта карточка объекта — первое нажатие
 * мимо её закрывает, как в Яндекс и Google Картах; адрес точки показывается
 * только следующим нажатием, иначе поверх закрывающейся карточки выскакивал
 * бы ещё и попап адреса.
 */
export function emptyMapClickAction(cardOpen: boolean): "close-card" | "show-address" {
  return cardOpen ? "close-card" : "show-address";
}

/** Сколько объектов стоит рядом с нажатой точкой — строка для карточки места. */
export const NEARBY_RADIUS_M = 300;

/**
 * «Рядом в продаже: 3 объекта, от 420 т. с.» для карточки места (нажатие на
 * пустое место карты). Владелец 25.09.2026 про прежнее окно: «дешёвое окно…
 * тупо с адресом… нет ничего». Считается по тем объектам, что уже нарисованы
 * на карте, — без нового запроса к серверу. null — рядом ничего нет.
 */
export function nearbySummary(
  lat: number,
  lng: number,
  properties: { lat: number | null; lng: number | null; price: number; currency: string }[],
  radiusM = NEARBY_RADIUS_M
): string | null {
  const near = properties.filter(
    (p) => p.lat != null && p.lng != null && distanceMeters(lat, lng, p.lat, p.lng) <= radiusM
  );
  if (near.length === 0) return null;
  const n = near.length;
  const word = n % 10 === 1 && n % 100 !== 11 ? "объект" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "объекта" : "объектов";
  // «от …» — только если все в одной валюте: сравнивать доллары с сомони
  // без курса значило бы соврать.
  const currencies = new Set(near.map((p) => p.currency));
  if (currencies.size !== 1) return `Рядом в продаже: ${n} ${word}`;
  const min = Math.min(...near.map((p) => p.price));
  return `Рядом в продаже: ${n} ${word}, от ${priceLabel(min, near[0].currency)}`;
}
