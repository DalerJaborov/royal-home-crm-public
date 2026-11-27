import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Rh2Portal } from "../../rh2/Rh2Scope";
import { hapticTap } from "../../../lib/haptics";

/**
 * ВЫБОР ИЗ СПИСКА В «НОВОМ ВИДЕ» — вместо серого списка браузера (<select>), 27.11.2026, пачка shell2.
 *
 * Макет не знает родного списка выбора: на телефоне он открывается системным окном, на ПК — серой
 * плашкой браузера, и выглядит чужим (REPORT 27.11, п. 7: «Бот молчит», разделы настроек). Здесь
 * одна деталь на все такие места оболочки: таблетка с текущим значением и стрелкой, по нажатию —
 * шторка снизу со списком вариантов (та же `.sheet.bottom`, что у быстрых действий). Выбор и запрос
 * те же: `onChange` получает то же значение, что получал бы `<select>`.
 *
 * Доступность: кнопка говорит, что выбирается и что выбрано; в шторке варианты — радиокнопки,
 * Escape и нажатие мимо закрывают, фокус возвращается на кнопку.
 */
export interface RoyalPickerOption {
  value: string;
  label: string;
  /** Тихая строка под вариантом (счётчик, пояснение). */
  hint?: string;
}

export function RoyalPicker({ value, options, onChange, label, title, className, id, placeholder = "Выберите", testId }: {
  value: string;
  options: RoyalPickerOption[];
  onChange: (value: string) => void;
  /** Что выбирается — для экранного чтеца и заголовка шторки. */
  label: string;
  /** Заголовок шторки, если отличается от `label`. */
  title?: string;
  className?: string;
  id?: string;
  placeholder?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    sheet.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], [role="radio"]')?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => { setOpen(false); button.current?.focus(); };
  const pick = (next: string) => {
    hapticTap();
    setOpen(false);
    button.current?.focus();
    if (next !== value) onChange(next);
  };

  return (
    <>
      <button ref={button} type="button" id={id} data-testid={testId} className={`ry-picker${className ? ` ${className}` : ""}`}
        aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${current?.label ?? placeholder}`} onClick={() => setOpen(true)}>
        <span className="ry-picker-value">{current?.label ?? placeholder}</span>
        <ChevronDown aria-hidden="true" className="ry-picker-chev" />
      </button>
      {open && (
        <Rh2Portal>
          <div className="sheet-back" onClick={close} />
          <div ref={sheet} className="sheet bottom ry-picker-sheet" role="dialog" aria-modal="true" aria-labelledby={headingId} data-no-sheet>
            <div className="grab" aria-hidden />
            <div className="sheet-b">
              <h2 id={headingId} className="ry-picker-title">{title ?? label}</h2>
              <div className="ry-picker-list" role="radiogroup" aria-labelledby={headingId}>
                {options.map((option) => {
                  const selected = option.value === value;
                  return (
                    <button key={option.value} type="button" role="radio" aria-checked={selected} className="ry-picker-option" onClick={() => pick(option.value)}>
                      <span className="ry-picker-option-text">
                        <span className="ry-picker-option-label">{option.label}</span>
                        {option.hint && <span className="ry-picker-option-hint">{option.hint}</span>}
                      </span>
                      {selected && <Check aria-hidden="true" className="ry-picker-check" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Rh2Portal>
      )}
    </>
  );
}
