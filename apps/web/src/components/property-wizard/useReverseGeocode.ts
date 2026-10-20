import { useEffect, useRef, useState } from "react";
import { fetchReverseGeocode, NominatimHttpError, type ReverseGeocodeResult } from "../../lib/reverseGeocode";

/**
 * ОБРАТНОЕ ГЕОКОДИРОВАНИЕ ТОЧКИ НА КАРТЕ (Nominatim / OpenStreetMap) — хук
 * под перетаскивание пина в мастере объекта: дебаунс, отмена устаревшего
 * запроса, статус для UI. Сам запрос и разбор ответа — в `lib/reverseGeocode.ts`,
 * общие с картой объектов (клик по пустому месту, `PropertyMapExplorer.tsx`),
 * которой этот дебаунс не нужен (там один клик — один запрос).
 *
 * Правила Nominatim соблюдаем честно: не чаще запроса в секунду (пауза 600 мс
 * плюс запрос уходит только когда карту отпустили) и идентификация вызывающего
 * параметром `email` (см. `lib/reverseGeocode.ts` — свой `User-Agent` из
 * вкладки браузера не выставить, его подменяет сам браузер).
 *
 * Отказ сервиса — не поломка шага: адрес остаётся полем ввода, агент пишет его
 * руками. Обратное поведение (пустое поле «ждём адрес») стоило бы объекта.
 */

const DEBOUNCE_MS = 600;
/** Nominatim иногда висит без ответа — не ждём его вечно. */
const REQUEST_TIMEOUT_MS = 8_000;

export type { ReverseGeocodeResult } from "../../lib/reverseGeocode";
export type ReverseGeocodeStatus = "idle" | "loading" | "ok" | "empty" | "failed" | "offline";

export function useReverseGeocode(point: { lat: number; lng: number } | null): {
  result: ReverseGeocodeResult | null;
  status: ReverseGeocodeStatus;
} {
  const [result, setResult] = useState<ReverseGeocodeResult | null>(null);
  const [status, setStatus] = useState<ReverseGeocodeStatus>("idle");
  const abortRef = useRef<AbortController | null>(null);
  // Онлайн/офлайн — состояние, а не просто чтение navigator.onLine, чтобы его
  // возврат сам стал зависимостью эффекта и запустил повторный запрос.
  const [netOnline, setNetOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const netOnlineRef = useRef(netOnline);
  netOnlineRef.current = netOnline;
  // Координаты (округлённые до ~1 м), на которые уже получен ОТВЕТ сервиса —
  // повторный сдвиг на ту же точку не долбит Nominatim заново. Отмечаем
  // только успех: если запрос упал, тот же сдвиг назад должен иметь шанс
  // на повтор, а не молча повторять старую ошибку.
  const queriedRef = useRef<string | null>(null);

  const lat = point?.lat ?? null;
  const lng = point?.lng ?? null;

  useEffect(() => {
    const handleOnline = () => setNetOnline(true);
    const handleOffline = () => setNetOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (lat === null || lng === null) {
      setStatus("idle");
      return;
    }

    // Округление до 5 знаков — это ~1 м, точнее сравнивать смысла нет, а
    // дальше просто разные подряд идущие сдвиги мышью считались бы новой точкой.
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (key === queriedRef.current) return; // уже спрашивали именно эту точку

    if (!netOnline) {
      // Не дёргаем геокодер вовсе без сети — запрос заведомо не дойдёт, а
      // событие online выше перезапустит этот эффект и попробует снова.
      setStatus("offline");
      return;
    }

    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("loading");

      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      fetchReverseGeocode(lat, lng, controller.signal)
        .then((parsed) => {
          if (abortRef.current !== controller) return; // этот запрос уже не последний
          clearTimeout(timeoutId);
          setResult(parsed);
          setStatus(parsed.address ? "ok" : "empty");
          queriedRef.current = key;
        })
        .catch((err: unknown) => {
          if (abortRef.current !== controller) return;
          clearTimeout(timeoutId);
          if (err instanceof DOMException && err.name === "AbortError") {
            // Отмена — это либо мы сами (смена координат/размонтирование,
            // молчим — новый цикл сам обновит статус), либо таймаут (говорим
            // прямо, это тоже «не получилось», а не тихая отмена).
            if (timedOut) setStatus("failed");
            return;
          }
          if (err instanceof NominatimHttpError) {
            // Сервис ДОСТУПЕН и ОТВЕТИЛ, просто не адресом — не путать с обрывом сети.
            setStatus("failed");
            return;
          }
          // fetch не достучался до сети вовсе (DNS/обрыв/CORS) — отличаем от
          // «сервис ответил ошибкой» текстом статуса выше по стеку (StepPlace).
          setStatus(netOnlineRef.current ? "failed" : "offline");
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Отменяем и отложенный запрос, и уже улетевший — при размонтировании,
      // и заодно при каждой смене координат, чтобы старый ответ не перетёр
      // состояние новой точки, пока не прошёл собственный дебаунс.
      abortRef.current?.abort();
    };
  }, [lat, lng, netOnline]);

  return { result, status };
}
