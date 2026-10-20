import { cx } from "./cx";

export type SegmentOption<Id extends string = string> = { id: Id; label: string };

/**
 * КРУПНЫЙ ПЕРЕКЛЮЧАТЕЛЬ на два-три значения (Продавцы · Покупатели), контракт
 * 06.10: высота 44, выбранный залит `--ink`. Это выбор «кто», а не вкладка
 * раздела, поэтому роль `group` + `aria-pressed`, а не `tablist`.
 */
export function Segment<Id extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className,
  ...rest
}: {
  options:
    | readonly [SegmentOption<Id>, SegmentOption<Id>]
    | readonly [SegmentOption<Id>, SegmentOption<Id>, SegmentOption<Id>];
  value: Id;
  onChange: (id: Id) => void;
  "aria-label": string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div {...rest} role="group" aria-label={ariaLabel} className={cx("seg", "big", className)}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
