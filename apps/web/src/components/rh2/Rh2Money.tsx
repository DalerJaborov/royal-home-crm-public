import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { isMotionDisabled } from "../../lib/motionPolicy";

/**
 * Деньги темы «Royal Home 2026» — дословный перенос `.money[data-money]`
 * прототипа (`screens/_screens.js`, функция countUp):
 *   · моноширинные цифры и разряды ru-RU (класс `.money` в theme-2026-proto.css);
 *   · счёт вверх ОДИН раз, при первом показе значения, easeOutCubic, 620 мс;
 *   · при `prefers-reduced-motion: reduce` число появляется сразу.
 *
 * Ноль в счёт не идёт: пока запрос не ответил, экран рисует ноль, и, засчитав
 * его за «первый показ», настоящая сумма приехала бы уже без счётчика.
 *
 * Округление до целых сомони — тоже из прототипа: `Math.round(target * e)`.
 * Считается сумма по-прежнему сервером, здесь только её вид.
 */
export function Rh2Money({
  value,
  cur,
  className,
  style,
}: {
  value: number;
  /** Подпись валюты рядом с суммой (`<span class="cur">`), как в шапке «Финансов». */
  cur?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [display, setDisplay] = useState(value);
  const counted = useRef(false);
  const raf = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (counted.current || !Number.isFinite(value) || value === 0) {
      setDisplay(value);
      return;
    }
    counted.current = true;
    if (isMotionDisabled()) {
      setDisplay(value);
      return;
    }
    const target = value;
    const dur = 620;
    let t0: number | null = null;
    const step = (t: number) => {
      if (t0 === null) t0 = t;
      const k = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      setDisplay(target * eased);
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value]);

  return (
    <span className={className ? `money ${className}` : "money"} style={style}>
      {Math.round(Number.isFinite(display) ? display : 0).toLocaleString("ru-RU")}
      {cur ? <span className="cur">{cur}</span> : null}
    </span>
  );
}
