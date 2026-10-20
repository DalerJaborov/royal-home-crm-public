import { useCallback, useSyncExternalStore } from "react";
import { isTabHidden } from "../lib/tabHidden";

/**
 * Общее «сейчас» для секундных таймеров (обратный отсчёт, «ждёт 3:12»,
 * «повторим через 20 с»). 06.10.2026 («CRM зависает»): пять мест держали по
 * своему `setInterval(…, 1000)` и перерисовывали весь компонент каждую секунду,
 * в том числе на свёрнутой вкладке. Теперь на вкладку ОДИН интервал, подписчики
 * через useSyncExternalStore, а на скрытой вкладке тик не идёт вовсе
 * (признак тот же, что у lib/tabHidden.ts). При возврате на вкладку «сейчас»
 * обновляется сразу, не дожидаясь следующей секунды.
 *
 * `enabled = false` — не подписываться: интервал живёт, только пока есть хоть
 * один включённый подписчик. Возвращаемое значение при выключенной подписке
 * может быть устаревшим, использовать его в этом случае не нужно.
 */
const TICK_MS = 1_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick() {
  if (isTabHidden()) return;
  now = Date.now();
  listeners.forEach((l) => l());
}

function onVisibility() {
  if (!isTabHidden()) tick();
}

function start() {
  if (timer !== null) return;
  now = Date.now();
  timer = setInterval(tick, TICK_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

function stop() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisibility);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

function getSnapshot(): number {
  // Без подписчиков тик не идёт, и закешированное значение стареет: освежаем его
  // лениво, но не чаще раза в 250 мс, чтобы снимок оставался стабильным в
  // пределах одной отрисовки (требование useSyncExternalStore).
  if (listeners.size === 0) {
    const t = Date.now();
    if (t - now > 250) now = t;
  }
  return now;
}

const noopSubscribe = () => () => {};

export function useNow(enabled = true): number {
  const sub = useCallback((l: () => void) => (enabled ? subscribe(l) : noopSubscribe()), [enabled]);
  return useSyncExternalStore(sub, getSnapshot, getSnapshot);
}
