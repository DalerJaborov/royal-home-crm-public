import { cx } from "./cx";

export type FilterOption<Id extends string = string> = {
  id: Id;
  label: string;
  count?: number;
  /** Цвет тревоги на подписи (пульт: раздел в жёлтом или красном). Нейтральный по умолчанию. */
  tone?: "warn" | "crit";
};

/**
 * ФИЛЬТРЫ: чипы-переключатели (контракт 06.10). Выбор ОДИН, поэтому состояние
 * несёт `aria-pressed` на каждой кнопке. Видимая высота 40, зона нажатия 44
 * (правило 6): псевдоэлемент в `.rh-filters button::after`.
 *
 * `scroll` — одна прокручиваемая строка вместо переноса на несколько (пульт,
 * лента разделов): кнопки 44 px, полоса прокрутки скрыта. `tone` у варианта
 * красит подпись в цвет тревоги, не меняя заливку выбранного.
 */
export function Filters<Id extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className,
  scroll = false,
  ...rest
}: {
  options: ReadonlyArray<FilterOption<Id>>;
  value: Id;
  onChange: (id: Id) => void;
  "aria-label"?: string;
  className?: string;
  scroll?: boolean;
  "data-testid"?: string;
}) {
  return (
    <div {...rest} role="group" aria-label={ariaLabel ?? "Фильтры"} className={cx("rh-filters", scroll && "rh-filters-scroll", className)}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={o.id === value} data-tone={o.tone} onClick={() => onChange(o.id)}>
          {o.label}
          {o.count != null ? <span className="n">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
