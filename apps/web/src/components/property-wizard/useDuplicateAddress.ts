import { useEffect, useRef, useState } from "react";
import type { PropertyDuplicateMatch } from "@royal-home/shared";
import { api } from "../../lib/api";
import type { WizardValues } from "./types";

/**
 * «Этот адрес уже заведён» — шаг «Где» мастера объекта (владелец 15.09.2026:
 * «Один объект от двух агентов — самая частая грязь в базе»; артефакт
 * `.dup`/`dupNear()`, docs/pult/theme-2026/artifact-wizard-property-15-09.html).
 *
 * Сервер (routes/properties/duplicateCheck.ts) ищет ТОЧНОЕ совпадение — по
 * канонному адресу в районе ИЛИ по точке (радиус 40 м, 02.10.2026), и в обоих
 * случаях сверяет площадь ±1 м² и все остальные параметры (комнаты, этаж,
 * этажность, тип, новостройка/вторичка), заданные у обеих сторон. Точка и
 * параметры шага «Параметры» уходят в запрос по мере появления. Здесь только запрос с задержкой после ввода и молчание при
 * отказе — предупреждение не должно мешать заполнению мастера, если сервис
 * недоступен или адрес/район ещё не готовы для сравнения.
 */
export function useDuplicateAddress(values: WizardValues): PropertyDuplicateMatch[] {
  const [matches, setMatches] = useState<PropertyDuplicateMatch[]>([]);
  const requestRef = useRef(0);

  const address = values.address.trim();
  const areaSqm = Number(values.areaSqm);

  useEffect(() => {
    if (!values.districtId || address.length < 3 || !areaSqm) {
      setMatches([]);
      return;
    }
    const myRequest = ++requestRef.current;
    // Задержка после ввода (не на каждую букву) — тот же приём, что и подсказка
    // адреса чуть выше на этом же шаге (StepPlace.tsx, resolveGeoPlace).
    const timer = setTimeout(() => {
      const query = new URLSearchParams({
        districtId: values.districtId,
        address,
        areaSqm: String(areaSqm),
      });
      if (values.floor) query.set("floor", values.floor);
      if (values.totalFloors) query.set("totalFloors", values.totalFloors);
      if (values.rooms) query.set("rooms", values.rooms);
      if (values.type) query.set("type", values.type);
      if (values.marketType) query.set("marketType", values.marketType);
      if (values.windowCount) query.set("windowCount", values.windowCount);
      if (values.landAreaSotka) query.set("landAreaSotka", values.landAreaSotka);
      if (values.lat !== null && values.lng !== null) {
        query.set("lat", String(values.lat));
        query.set("lng", String(values.lng));
      }
      api<{ matches: PropertyDuplicateMatch[] }>(`/properties/duplicate-check?${query.toString()}`)
        .then((res) => {
          if (requestRef.current !== myRequest) return; // адрес уже сменился
          setMatches(res.matches);
        })
        .catch(() => {
          // Отказ запроса не должен мешать заполнению мастера — просто молчим.
          if (requestRef.current === myRequest) setMatches([]);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [
    values.districtId,
    address,
    areaSqm,
    values.floor,
    values.totalFloors,
    values.rooms,
    values.type,
    values.marketType,
    values.windowCount,
    values.landAreaSotka,
    values.lat,
    values.lng,
  ]);

  return matches;
}
