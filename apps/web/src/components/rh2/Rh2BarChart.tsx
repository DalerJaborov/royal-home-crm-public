import { useEffect, useRef, useState } from "react";
import { Rh2Chart } from "./Rh2Chart";

/**
 * Столбчатый график прототипа (`screens/finance.html`, блок «Прибыль по месяцам»):
 * свой SVG без библиотек, три линии сетки, ось, подписи оси и месяцев, значение
 * над последним столбцом и прозрачные `.hit`-прямоугольники под подсказку —
 * по касанию, по наведению и с клавиатуры.
 *
 * Геометрия прототипа: viewBox 640×210, поле графика от x=52 до x=628,
 * ноль на y=170, верх шкалы на y=20. Число столбцов не фиксировано: шаг и
 * ширина считаются от количества месяцев, поэтому график одинаково честен
 * и на шести месяцах, и на тридцати шести.
 */
const LEFT = 52;
const TOP = 20;
const ZERO = 170;

export interface Rh2BarChartItem {
  key: string;
  /** Короткая подпись под столбцом: «сен». */
  label: string;
  value: number;
  /** Подсказка «заголовок|пояснение». */
  tip: string;
}

/** «184 300» → «184к», «900» → «900». Подписи оси прототипа. */
export function axisLabel(v: number): string {
  return Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}к` : String(Math.round(v));
}

/** Верх шкалы — round-число не ниже максимума, чтобы подписи оси были читаемыми. */
export function niceTop(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (step * pow >= max) return step * pow;
  }
  return 10 * pow;
}

export function Rh2BarChart({
  items,
  ariaLabel,
  lastValueLabel,
  responsive = false,
}: {
  items: Rh2BarChartItem[];
  ariaLabel: string;
  /** Подпись над последним столбцом (`.val`). */
  lastValueLabel?: string;
  /** A short series fits the real card width; longer histories retain scrolling. */
  responsive?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(640);
  const compact = responsive && items.length > 0 && items.length <= 8;
  useEffect(() => {
    if (!compact || !container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewWidth(Math.max(280, Math.min(640, Math.round(entry.contentRect.width))));
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [compact]);
  if (items.length === 0) return null;
  const maximum = Math.max(...items.map((i) => i.value), 0);
  const minimum = Math.min(...items.map((i) => i.value), 0);
  const top = maximum > 0 || minimum === 0 ? niceTop(maximum) : 0;
  const bottom = minimum < 0 ? -niceTop(-minimum) : 0;
  const range = top - bottom;
  const position = (value: number) => ZERO - ((value - bottom) / range) * (ZERO - TOP);
  const zero = position(0);
  const width = compact ? viewWidth : 640;
  const right = width - 12;
  const step = (right - LEFT) / items.length;
  const barW = Math.max(6, Math.min(58, step * 0.62));
  const centre = (i: number) => LEFT + step * (i + 0.5);

  return (
    <div ref={container} className="rh2-bar-chart">
    <Rh2Chart className={compact ? "compact" : "wide"}>
      <svg viewBox={`0 0 ${width} 210`} role="img" aria-label={ariaLabel}>
        <line className="gl" x1={LEFT} y1={TOP} x2={right} y2={TOP} />
        <line className="gl" x1={LEFT} y1={70} x2={right} y2={70} />
        <line className="gl" x1={LEFT} y1={120} x2={right} y2={120} />
        <line className="ax" x1={LEFT} y1={zero} x2={right} y2={zero} />
        <text className="axl" x="46" y="24" textAnchor="end">
          {axisLabel(top)}
        </text>
        <text className="axl" x="46" y="74" textAnchor="end">
          {axisLabel(top - range / 3)}
        </text>
        <text className="axl" x="46" y="124" textAnchor="end">
          {axisLabel(top - (range * 2) / 3)}
        </text>
        <text className="axl" x="46" y="174" textAnchor="end">
          {axisLabel(bottom)}
        </text>

        {items.map((item, i) => {
          const valueY = position(item.value);
          const h = Math.abs(valueY - zero);
          return (
            <rect
              key={item.key}
              className={i === items.length - 1 ? "br" : "br alt"}
              data-negative={item.value < 0 || undefined}
              x={centre(i) - barW / 2}
              y={Math.min(valueY, zero)}
              width={barW}
              height={h}
              rx="4"
            />
          );
        })}

        {items.map((item, i) => (
          <text className="axl" key={item.key} x={centre(i)} y="188" textAnchor="middle">
            {item.label}
          </text>
        ))}
        {lastValueLabel ? (
          <text className="val" x={centre(items.length - 1)} y="14" textAnchor="middle">
            {lastValueLabel}
          </text>
        ) : null}

        {items.map((item, i) => (
          <rect
            key={item.key}
            className="hit"
            x={centre(i) - step / 2}
            y="0"
            width={step}
            height={ZERO}
            tabIndex={0}
            data-tip={item.tip}
          />
        ))}
      </svg>
    </Rh2Chart>
    </div>
  );
}
