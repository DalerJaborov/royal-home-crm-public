import type { CSSProperties, ReactNode } from "react";

/**
 * Полосы прототипа (`.bars > .b > .nm3 / .tr > i / .vl`). Заполнение задаётся
 * переменной `--v` (доля 0..1), как в `_components.css`: анимация роста полосы
 * живёт в CSS и сама гаснет при `prefers-reduced-motion`.
 */
export interface Rh2Bar {
  key: string;
  /** Подпись слева. Кнопка/ссылка допустима: в прототипе это `.lk`. */
  name: ReactNode;
  /** Доля заполнения от 0 до 1. */
  share: number;
  /** Число справа. */
  value: ReactNode;
}

export function Rh2Bars({ items }: { items: Rh2Bar[] }) {
  return (
    <div className="bars">
      {items.map((b) => (
        <div className="b" key={b.key}>
          <span className="nm3">{b.name}</span>
          <span className="tr">
            <i style={{ "--v": Math.max(0, Math.min(1, b.share)) } as CSSProperties} />
          </span>
          <span className="vl">{b.value}</span>
        </div>
      ))}
    </div>
  );
}
