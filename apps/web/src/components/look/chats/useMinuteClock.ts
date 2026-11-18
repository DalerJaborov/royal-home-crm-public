import { useEffect, useState } from "react";

/**
 * Часы с шагом в минуту для списка разговоров нового вида (18.11.2026).
 *
 * Строки списка в `memo`, поэтому «ждёт 5 мин», часы паузы бота и «вчера» после
 * полуночи пересчитываются, только если сменился проп. Этот счётчик и есть
 * такой проп: раз в 60 с — новое значение, пока вкладка на виду; скрытая
 * вкладка не тикает, а при возврате время сразу догоняет. Запросов не делает.
 */
export function useMinuteClock(enabled = true, stepMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Выключено (прежний вид) — ни таймера, ни лишних перерисовок.
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => setNow(Date.now()), stepMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else { setNow(Date.now()); start(); }
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, stepMs]);
  return now;
}
