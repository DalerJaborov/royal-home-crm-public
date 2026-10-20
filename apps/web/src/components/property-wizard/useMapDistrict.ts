import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";

/**
 * РАЙОН ТОЧКИ ПО НАШЕЙ КАРТЕ (GET /geo/lookup) — вместо «ближайшего из четырёх».
 *
 * Подсказка района в мастере считалась сравнением точки с четырьмя вбитыми в код
 * «центрами» районов (lib/districtCoords.ts) и выбором ближайшего. Эти четыре
 * точки выставлены на глаз, границ не знают, и на улице Дехоти, 8 подсказка
 * уверенно показывала Шохмансур вместо Фирдавси — карточка ОБ-000109, разбор
 * 20.09.2026 (см. шапку apps/api/src/lib/propertyDistrict.ts). Настоящие границы
 * районов лежат в базе с 12.09.2026, и сервер умеет отвечать по ним точно.
 *
 * Отказ сети — не поломка шага: вернётся null, и вызывающий останется на прежней
 * грубой подсказке. Сервер при сохранении всё равно поставит район по карте.
 */
export function useMapDistrict(point: { lat: number; lng: number } | null): { id: string; name: string } | null {
  const [district, setDistrict] = useState<{ id: string; name: string } | null>(null);
  // Точка, на которую уже получен ответ: перетаскивание пина шлёт десятки
  // обновлений, а справочник отвечает на округлённую до ~1 м координату одинаково.
  const askedRef = useRef<string | null>(null);

  const lat = point?.lat ?? null;
  const lng = point?.lng ?? null;

  useEffect(() => {
    if (lat == null || lng == null) {
      setDistrict(null);
      askedRef.current = null;
      return;
    }
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (askedRef.current === key) return;
    let alive = true;
    const timer = setTimeout(() => {
      api<{ district: { id: string; name: string } | null }>(`/geo/lookup?lat=${lat}&lng=${lng}`)
        .then((res) => {
          if (!alive) return;
          askedRef.current = key;
          setDistrict(res.district);
        })
        .catch(() => {
          // Прежняя грубая подсказка остаётся за вызывающим — молча, это не ошибка шага.
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [lat, lng]);

  return district;
}
