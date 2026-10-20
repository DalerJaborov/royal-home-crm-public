import { useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useDismissableMenu } from "../hooks/useDismissableMenu";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

/** Выпадающий список с поиском по вводу — замена нативному <select> там, где
 * вариантов много (районы, сотрудники) и пролистывать длинный список неудобно.
 *
 * ДОСТУПНОСТЬ (добавлена 14.08.2026). Заменяя нативный <select>, компонент обязан
 * вернуть и то, что тот давал бесплатно: до этой правки здесь не было ни одной
 * роли и ни одного aria-атрибута — для скринридера поле выглядело кнопкой с
 * непонятной подписью, а список вариантов — россыпью соседних кнопок. Ни «это
 * список», ни «раскрыт», ни «выбрано вот это» не сообщалось. При том что через
 * этот компонент заполняются ОБЯЗАТЕЛЬНЫЕ поля (район объекта, кто принял объект).
 *
 * Разметка — стандартная схема ARIA для «select-only combobox»: кнопка-триггер
 * с role="combobox" + aria-expanded + aria-controls, всплывающий список с
 * role="listbox", варианты с role="option" + aria-selected.
 *
 * ВЫХОД ПО ESCAPE (22.08.2026). Открытый список сразу забирает фокус в поле поиска
 * (autoFocus ниже), а закрывался он только кликом мимо — с клавиатуры выйти из
 * него было нельзя вообще, оставалось только выбрать хоть какой-нибудь вариант.
 * Соседи по этой же роли (DistrictMultiSelect, GlassSelect в FormField) Escape
 * держали с самого начала. Теперь общее поведение — из useDismissableMenu. */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Выберите...",
  required,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const { open, setOpen, boxRef, buttonRef } = useDismissableMenu();
  const [query, setQuery] = useState("");
  const listboxId = useId();

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Введённый поиск живёт только пока список раскрыт: закрыли любым способом —
  // следующее открытие начинается с полного списка, а не с чужого запроса.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        ref={buttonRef}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-required={required || undefined}
        className={`w-full flex items-center justify-between gap-2 border rounded-lg px-3 py-2 text-[15px] outline-hidden text-left transition-colors cursor-pointer bg-card hover:border-blue/50 focus:border-blue disabled:opacity-50 disabled:cursor-not-allowed ${
          open ? "border-blue ring-2 ring-blue/15" : "border-line"
        }`}
      >
        <span className={selected ? "text-ink font-medium" : "text-gray-500"}>{selected?.label ?? placeholder}</span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 transition-transform ${open ? "rotate-180 text-blue" : "text-gray-500"}`}
          strokeWidth={2.2}
        />
      </button>
      {/* Скрытый required-инпут — чтобы форма стандартно валидировала обязательность без своей логики. */}
      {required && <input tabIndex={-1} value={value} required onChange={() => {}} className="sr-only" />}

      {open && (
        // bg-card-solid, а НЕ bg-card: обычный --c-card полупрозрачен (матовое стекло,
        // index.css) — список вариантов просвечивал сквозь содержимое под полем.
        <div className="absolute z-20 mt-1 w-full bg-card-solid border border-line rounded-lg shadow-lg overflow-hidden">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск..."
            aria-label="Поиск по списку"
            className="w-full border-b border-line-soft px-3 py-2 text-[15px] outline-hidden"
          />
          {/* «Ничего не найдено» — СНАРУЖИ списка, и роль списка снимается,
              пока вариантов нет: внутри `role="listbox"` разрешены только
              `option`, и абзац рядом с ними роняет axe `aria-required-children`
              (тот же класс, что на пульте — a11y, 10.09.2026). */}
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-[15px] text-gray-400">Ничего не найдено</div>
          )}
          <div
            className="max-h-52 overflow-y-auto"
            role={filtered.length > 0 ? "listbox" : undefined}
            id={listboxId}
          >
            {filtered.map((o) => (
              <button
                type="button"
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  setQuery("");
                }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-[15px] text-left hover:bg-hover-tint"
              >
                {o.label}
                {o.value === value && <Check className="w-3.5 h-3.5 text-blue shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
