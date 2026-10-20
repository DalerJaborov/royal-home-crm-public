import type { LandmarkUpdateInput } from "@royal-home/shared";

/**
 * Правка ориентира из формы Настроек. Пустые «Адрес» и «Радиус» уходят как
 * `null` — так сервер понимает «очистить». `undefined` в JSON не попадает
 * вовсе, и стёртое поле молча оставалось прежним (аудит 23.09.2026, №30;
 * ловушка из CLAUDE.md).
 */
export function landmarkPatchFromForm(value: {
  name: string;
  category: string;
  address: string;
  radiusM: string;
  point: { lat: number; lng: number };
  weight: 0 | 50 | 100;
  isCityCenter: boolean;
}): LandmarkUpdateInput {
  return {
    name: value.name.trim(),
    category: value.category.trim(),
    address: value.address.trim() || null,
    radiusM: value.radiusM ? Number(value.radiusM) : null,
    lat: value.point.lat,
    lng: value.point.lng,
    weight: value.weight,
    isCityCenter: value.isCityCenter,
  };
}
