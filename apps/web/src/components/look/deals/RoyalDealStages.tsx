import { useEffect, useRef, useState } from "react";

/**
 * Этапы доски таблетками в ряд (телефон, новый вид). Ряд листается сам, страница —
 * нет. Чтобы обрезанная справа таблетка не выглядела концом списка, у ряда
 * затухает правый край — только когда справа ещё есть что листать
 * (`data-more="true"`), и таблетки встают по краю (scroll-snap).
 */
export type DealStageTab = { key: string; label: string; count: number };

export function RoyalDealStages({ tabs, current, onPick }: { tabs: DealStageTab[]; current: string; onPick: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", update); ro?.disconnect(); };
  }, [tabs.length]);
  return (
    <div ref={ref} className="ry-deals-stages" role="group" aria-label="Стадии сделок" data-more={more ? "true" : undefined}>
      {tabs.map((tab) => (
        <button type="button" key={tab.key} className="ry-deals-stage" aria-pressed={current === tab.key} onClick={() => onPick(tab.key)}>
          {tab.label}<span className="ry-deals-stage-n ry-num">{tab.count}</span>
        </button>
      ))}
    </div>
  );
}
