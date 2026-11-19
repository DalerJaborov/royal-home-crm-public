import { useEffect, useState } from "react";
import type { RhBrand } from "../ui";

/**
 * Время суток, «сейчас» и логотип канала для главной «Нового вида» (ядро, пачка home).
 *
 * ДОЛГ (20.11.2026): pages/TodayRoyal.tsx пока держит свои копии этих трёх функций —
 * его правит другая ветка. При переводе TodayRoyal на ядро он импортирует их отсюда,
 * а копии удаляются (журнал docs/journal/2026-11-20-new-look-home.md). Здесь — своим
 * модулем, чтобы кусок ядра не тянул весь TodayRoyal со всеми его запросами.
 */

/** Приветствие по часу в Душанбе. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Доброе утро";
  if (hour >= 12 && hour < 18) return "Добрый день";
  if (hour >= 18 && hour < 23) return "Добрый вечер";
  return "Доброй ночи";
}

/** «Сейчас», которое обновляется раз в минуту и при возврате на вкладку. */
export function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
    };
  }, []);
  return now;
}

/** Канал → логотип в родном цвете. Неизвестный канал — null (нейтральный круг у вызывающего). */
export function channelBrand(source: string): RhBrand | null {
  const s = source.toLowerCase();
  if (s.includes("whatsapp")) return "whatsapp";
  if (s.includes("telegram")) return "telegram";
  if (s.includes("instagram")) return "instagram";
  if (s.includes("site") || s.includes("web") || s.includes("сайт")) return "site";
  if (s.includes("call") || s.includes("phone") || s.includes("звон")) return "calls";
  return null;
}
