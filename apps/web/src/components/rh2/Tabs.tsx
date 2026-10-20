import type { KeyboardEvent } from "react";
import { cx } from "./cx";

export type TabOption<Id extends string = string> = { id: Id; label: string; count?: number };

/**
 * ВКЛАДКИ ВНУТРИ РАЗДЕЛА: `.seg` темы с `role="tablist"` (контракт 06.10).
 * Стрелки и Home/End переводят выбор и фокус (roving tabindex): таб-стоп в
 * списке один, как требует ARIA. Видимая высота 40, зона 44.
 *
 * Когда срез это МАРШРУТ (`/clients`, `/clients/deferred`), нужны ссылки, а не
 * кнопки: для этого есть `components/ScreenTabs.tsx`. Здесь переключается
 * состояние внутри одного экрана.
 */
export function Tabs<Id extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className,
  idPrefix,
  ...rest
}: {
  options: ReadonlyArray<TabOption<Id>>;
  value: Id;
  onChange: (id: Id) => void;
  "aria-label"?: string;
  className?: string;
  /** Optional relationship to panels: <prefix>-tab-<id> / <prefix>-panel-<id>. */
  idPrefix?: string;
  "data-testid"?: string;
}) {
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key) || options.length === 0) return;
    const i = options.findIndex((o) => o.id === value);
    const last = options.length - 1;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : e.key === "ArrowRight"
            ? (i + 1) % options.length
            : (i - 1 + options.length) % options.length;
    e.preventDefault();
    onChange(options[next].id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div {...rest} role="tablist" aria-label={ariaLabel} onKeyDown={move} className={cx("seg", "rh-tabs", className)}>
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${o.id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${o.id}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.id)}
          >
            {o.label}
            {o.count != null ? <span className="n"> · {o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
