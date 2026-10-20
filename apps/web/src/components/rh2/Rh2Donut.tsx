import { useState } from "react";
import type { CSSProperties } from "react";

/**
 * Кольцо долей прототипа (`.donut > .ring svg + .keys`). Радиус 43 при
 * viewBox 100×100 — как в `screens/sources.html`; длина окружности отсюда же,
 * поэтому `stroke-dasharray` считается, а не подбирается.
 *
 * Цвета сегментов — пастельные «ink»-токены темы по порядку прототипа. Цветом
 * ничего не кодируется: тот же порядок повторяется в легенде подписью, поэтому
 * кольцо читается в обеих темах и без различения цветов.
 */
const R = 43;
const C = 2 * Math.PI * R;

export const RH2_DONUT_COLORS = [
  "var(--ink)",
  "var(--aqua-ink)",
  "var(--lav-ink)",
  "var(--sky-ink)",
  "var(--lime-ink)",
  "var(--faint)",
] as const;

export interface Rh2DonutSlice {
  key: string;
  label: string;
  value: number;
  /** Подпись справа в легенде: «243 лида, 38 %». */
  quantity: string;
}

export function Rh2Donut({
  slices,
  total,
  middleLabel,
  ariaLabel,
  selected,
  onSelect,
}: {
  slices: Rh2DonutSlice[];
  total: number;
  /** Подпись под числом в центре кольца. */
  middleLabel: string;
  ariaLabel: string;
  /** Выделенный ключ легенды (подсветка строки канала ниже по экрану).
   *  Не передан — кольцо помнит выделение само, чтобы нажатие в легенде всегда
   *  давало видимый отклик, а не тишину. */
  selected?: string | null;
  onSelect?: (key: string) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const active = selected !== undefined ? selected : own;
  let offset = 0;
  const arcs = slices.map((s, i) => {
    const len = total > 0 ? (s.value / total) * C : 0;
    const arc = { key: s.key, len, offset, color: RH2_DONUT_COLORS[i % RH2_DONUT_COLORS.length] };
    offset += len;
    return arc;
  });

  return (
    <div className="donut">
      {/* boxShadow:none — столкновение имён: у Tailwind есть утилита `.ring`
          (голубая обводка 3 px), и она красит любой элемент с этим классом.
          Прототипное имя менять нельзя, эталонный CSS правится только скриптом,
          поэтому обводка гасится здесь. */}
      <div className="ring" style={{ boxShadow: "none" }}>
        <svg viewBox="0 0 100 100" role="img" aria-label={ariaLabel}>
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx="50"
              cy="50"
              r={R}
              stroke={a.color}
              strokeDasharray={`${a.len.toFixed(2)} ${(C - a.len).toFixed(2)}`}
              strokeDashoffset={`-${a.offset.toFixed(2)}`}
            />
          ))}
        </svg>
        <span className="mid">
          {total.toLocaleString("ru-RU")}
          <small>{middleLabel}</small>
        </span>
      </div>
      <div className="keys">
        {slices.map((s, i) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={active === s.key}
            onClick={() => {
              setOwn((k) => (k === s.key ? null : s.key));
              onSelect?.(s.key);
            }}
          >
            <span
              className="sw"
              style={{ background: RH2_DONUT_COLORS[i % RH2_DONUT_COLORS.length] } as CSSProperties}
            />
            <span className="nm2">{s.label}</span>
            <span className="qt">{s.quantity}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
