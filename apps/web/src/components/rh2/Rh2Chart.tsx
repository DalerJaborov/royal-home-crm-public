import { useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Область графика темы «Royal Home 2026» — `.chart` + `.tipbox` прототипа.
 *
 * Подсказка работает тремя способами, как в `screens/_screens.js`: по наведению,
 * по касанию и с клавиатуры (элемент с `data-tip` держит `tabIndex`), поэтому
 * график читается и на телефоне, и без мыши. Формат `data-tip` тот же:
 * «заголовок|пояснение».
 */
type Tip = { title: string; body: string; left: number; top: number };

export function Rh2Chart({
  className,
  children,
}: {
  /** Модификаторы прототипа: `wide` для широких графиков с прокруткой. */
  className?: string;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  /** true — подсказка показана; false — под курсором нет элемента с data-tip. */
  function show(target: EventTarget | null): boolean {
    const box = boxRef.current;
    if (!box || !(target instanceof Element)) return false;
    const el = target.closest("[data-tip]");
    if (!el) return false;
    const parts = (el.getAttribute("data-tip") ?? "").split("|");
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setTip({
      title: parts[0] ?? "",
      body: parts[1] ?? "",
      left: Math.round(r.left - b.left + r.width / 2),
      top: Math.round(r.top - b.top + 12),
    });
    return true;
  }

  return (
    <div
      ref={boxRef}
      className={className ? `chart ${className}` : "chart"}
      onPointerMove={(e) => show(e.target)}
      onPointerDown={(e) => {
        if (!show(e.target)) setTip(null);
      }}
      onPointerLeave={() => setTip(null)}
      onFocus={(e) => show(e.target)}
      onBlur={() => setTip(null)}
    >
      {children}
      {/* [hidden] внутри .rh2 объявлен с !important — на absolute-блоке он работает. */}
      <div className="tipbox" hidden={!tip} style={tip ? { left: tip.left, top: tip.top } : undefined}>
        {tip ? (
          <>
            <b>{tip.title}</b>
            {tip.body}
          </>
        ) : null}
      </div>
    </div>
  );
}
