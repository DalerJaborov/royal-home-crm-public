import { useEffect, useRef, useState } from "react";
import { isMotionDisabled } from "../../lib/motionPolicy";

/** Ease-out кубическая — то же семейство кривых, что `--rh-ease-out`. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Примитив слоя 2: число, которое "прокручивается" к новому значению.
 *
 * По договору дизайна (§money) count-up — только у сумм при ПЕРВОМ показе, не на
 * каждое обновление (иначе счётчики бы дёргались на каждый polling-тик — так и
 * решено в спецификации v8: "без count-up, кроме 4 сумм «Денег» при первом
 * открытии"). Поведение здесь именно такое: анимация проигрывается на маунте и на
 * смену `value` относительно предыдущего рендера, вызывающий код сам решает,
 * менять ли `value` только один раз (см. проп `animateOnMount`).
 *
 * `prefers-reduced-motion: reduce` — значение подставляется сразу, без анимации.
 */
export function CountingNumber({
  value,
  duration = 600,
  format,
  className = "",
  animateOnMount = true,
}: {
  value: number;
  /** мс, по умолчанию 600 — как в договоре дизайна. */
  duration?: number;
  /** Форматирование итогового числа (money, проценты и т.п.). */
  format?: (n: number) => string;
  className?: string;
  /** Если false — первый рендер сразу показывает конечное значение без анимации. */
  animateOnMount?: boolean;
}) {
  const animate = animateOnMount && !isMotionDisabled();
  const [display, setDisplay] = useState(animate ? 0 : value);
  const prevValue = useRef(animate ? 0 : value);
  const rafId = useRef<number | null>(null);

  useEffect(() => {
    const from = prevValue.current;
    const to = value;
    if (from === to) return;

    if (isMotionDisabled()) {
      setDisplay(to);
      prevValue.current = to;
      return;
    }

    const start = performance.now();
    if (rafId.current !== null) cancelAnimationFrame(rafId.current);

    function tick(now: number) {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      const eased = easeOutCubic(t);
      setDisplay(from + (to - from) * eased);
      if (t < 1) {
        rafId.current = requestAnimationFrame(tick);
      } else {
        prevValue.current = to;
        rafId.current = null;
      }
    }
    rafId.current = requestAnimationFrame(tick);

    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);

  const rounded = Math.round(display);
  return <span className={`tabular-nums ${className}`}>{format ? format(rounded) : rounded}</span>;
}
