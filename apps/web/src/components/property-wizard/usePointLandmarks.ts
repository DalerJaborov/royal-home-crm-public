import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";

/**
 * ОРИЕНТИР ПО ТОЧКЕ (владелец 25.09.2026: «когда добавляешь объект, они сами
 * должны ставиться автоматически, один ориентир или два, как обычно ставят»).
 *
 * `GET /geo/landmarks` отдаёт один-два узнаваемых места рядом готовой строкой
 * («рядом ТЦ Садбарг, 400 м от ЦУМа») — тем же отбором, что строка места на
 * карте объектов (`apps/api/src/lib/landmarkPick.ts`). Пустая строка — рядом
 * ничего годного. `null` — ответа ещё нет или сеть отказала: поле тогда просто
 * остаётся как есть, это не ошибка шага.
 */
export function usePointLandmarks(point: { lat: number; lng: number } | null): string | null {
  const [text, setText] = useState<string | null>(null);
  // Перетаскивание пина шлёт десятки обновлений — спрашиваем по точке с
  // точностью ~1 м и не повторяем уже заданный вопрос.
  const askedRef = useRef<string | null>(null);

  const lat = point?.lat ?? null;
  const lng = point?.lng ?? null;

  useEffect(() => {
    if (lat == null || lng == null) {
      askedRef.current = null;
      return;
    }
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (askedRef.current === key) return;
    let alive = true;
    const timer = setTimeout(() => {
      api<{ text: string }>(`/geo/landmarks?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`)
        .then((res) => {
          if (!alive) return;
          askedRef.current = key;
          setText(res.text);
        })
        .catch(() => {
          // Без подсказки агент впишет ориентир сам — молча, как и район по карте.
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [lat, lng]);

  return text;
}

/**
 * Что делать с полем «Ориентир», когда пришла подсказка по точке.
 *
 * Поле заполняется само, только пока его не трогал агент: оно пустое или в нём
 * ровно то, что сайт подставил сам в прошлый раз (`lastAuto`). Всё, что агент
 * вписал или поправил руками, остаётся как есть — точку можно двигать сколько
 * угодно. Возвращает новый текст поля или `null`, если менять не нужно.
 *
 * Возврат на шаг: StepPlace размонтируется, и `lastAuto` теряется. Первый ответ
 * после возврата приходит на ту же точку и совпадает с полем — такое поле
 * признаётся автоматическим (вызывающий запоминает `suggestion` как `lastAuto`),
 * и следующий сдвиг точки снова его обновит.
 */
export function nextLandmarkValue(current: string, lastAuto: string | null, suggestion: string): string | null {
  const cur = current.trim();
  const isAuto = cur === "" || cur === (lastAuto ?? "").trim() || cur === suggestion.trim();
  if (!isAuto) return null;
  return suggestion === current ? null : suggestion;
}
