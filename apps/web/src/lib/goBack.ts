/**
 * «НАЗАД» — ОДНА ДВЕРЬ НА ВСЁ ПРИЛОЖЕНИЕ (21.11.2026; первое правило — 21.09.2026, hooks/useGoBack.ts).
 *
 * Владелец с iPhone: «кнопка „Назад“ выкидывает в другое место, например в Объекты». Причины были разные,
 * механизм один — каждая кнопка решала «куда назад» сама:
 *  - стрелка в шапке (Topbar) делала ПЕРЕХОД на раздел-родитель (`navigate("/properties")`), а не шаг
 *    назад: открыл объект из переписки, нажал «Назад» — оказался в «Объектах», а не в переписке;
 *  - жест от левого края в Safari срабатывал ВМЕСТЕ с системным жестом «назад» браузера — два шага за раз.
 *
 * Решение одно: если перед этим экраном в истории вкладки стоит экран ЭТОГО приложения — шаг назад по
 * истории (как системная кнопка), иначе — переход на логичного родителя с заменой записи (переписка →
 * список чатов, клиент → клиенты, объект → объекты). Голый `navigate(-1)`/`history.back()` в коде запрещён
 * сторожем (src/lib/__tests__/goBackGuard.test.ts) — только через `useGoBack`.
 */

/** Запись истории, как её пишет React Router: `{ usr, key, idx }`; `idx` — номер записи в этой вкладке. */
export interface RouterHistoryState {
  idx?: unknown;
  key?: unknown;
}

/**
 * Есть ли в истории вкладки предыдущий экран приложения.
 *
 * `idx` React Router ведёт сам и сохраняет в `history.state`: 0 — первая запись приложения в этой вкладке
 * (открыли по ссылке из Telegram, из пуша, с экрана «Домой»), больше нуля — до неё есть наши же экраны,
 * в том числе после перезагрузки страницы посреди работы. Без `idx` (старое состояние, чужой код записи)
 * судим по ключу: `"default"` — самая первая запись после загрузки.
 */
export function hasAppHistory(state: RouterHistoryState | null | undefined, locationKey: string): boolean {
  const idx = state?.idx;
  if (typeof idx === "number" && Number.isFinite(idx)) return idx > 0;
  return locationKey !== "default";
}

export type BackStep = { kind: "history" } | { kind: "parent"; to: string };

/**
 * Куда ведёт «Назад». `canPop: false` — экран сам знает, что шаг по истории увёл бы не туда (переписка,
 * открытая заменой адреса, а не переходом из списка): тогда только родитель.
 */
export function decideBack(state: RouterHistoryState | null | undefined, locationKey: string, fallback: string, canPop = true): BackStep {
  return canPop && hasAppHistory(state, locationKey) ? { kind: "history" } : { kind: "parent", to: fallback };
}

/**
 * Нужен ли СВОЙ жест «назад» от левого края (hooks/useEdgeSwipeBack.ts).
 *
 * Только в приложении на экране «Домой» на iPhone/iPad (`navigator.standalone === true`): там у системы
 * жеста «назад» нет. В Safari и в Chrome на Android свой жест у браузера/системы уже есть, и наш срабатывал
 * ВМЕСТЕ с ним — два шага назад за одно движение: из переписки человека выбрасывало на экран раньше
 * списка чатов (например, в «Объекты»). ОЦЕНКА механизма: на настоящем телефоне не воспроизведено.
 */
export function needsOwnEdgeSwipe(nav: { standalone?: unknown } | undefined): boolean {
  return nav?.standalone === true;
}
