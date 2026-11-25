import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { REGISTRY_COLOR_LABEL, registryUpdatedDate, type RegistryColor, type RegistryProjectOption } from "@royal-home/shared";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useRegistryProjectSearch } from "../../hooks/useConstructionRegistry";
import { Chip, type ChipTone } from "../rh2/Chip";

/**
 * ПОЛЕ «ЗАСТРОЙЩИК И РАЗРЕШЕНИЕ» (25.11.2026, просьба владельца): объект сам определяет, к какому проекту реестра
 * memor.pro он относится. Уверены — подставлено; не уверены — догадка с пометкой «проверьте»; нет — пустое поле.
 * Само поле — поиск по ВСЕМУ реестру (combobox: стрелки, Enter, Escape) и пункт «Нет в реестре / не новостройка».
 * Одно поле на мастер, форму правки и карточку объекта: вопроса «Это ваш дом? Это он / Не он» больше нет.
 *
 * Только разметка и поиск; что делать с выбором, решает тот, кто поле показывает (мастер копит до сохранения,
 * карточка сохраняет сразу). Подпись цвета — словами из packages/shared, не только цветом.
 */

export type RegistryFieldState =
  /** Связь уже сохранена у объекта (карточка, форма правки). */
  | { kind: "linked"; option: RegistryProjectOption; method: "AUTO" | "MANUAL" }
  /** Уверенное совпадение до сохранения: подставлено, при сохранении свяжется само. */
  | { kind: "auto"; option: RegistryProjectOption }
  /** Неуверенная догадка: показана с «проверьте», сама не сохраняется. */
  | { kind: "guess"; option: RegistryProjectOption }
  /** Сотрудник выбрал сам: сохранится ручной связью. */
  | { kind: "picked"; option: RegistryProjectOption }
  /** «Нет в реестре / не новостройка». */
  | { kind: "none" }
  | { kind: "empty" };

const COLOR_TONE: Record<RegistryColor, ChipTone> = { green: "ok", yellow: "warn", red: "crit" };

/** Своя разметка поля: классы списков темы живут внутри карты мастера и здесь не действуют. Только токены темы. */
const INPUT_STYLE = {
  width: "100%",
  minHeight: 44,
  padding: "10px 12px",
  borderRadius: "var(--r-md)",
  border: "1px solid var(--line)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--fs-15)",
} as const;
const LIST_STYLE = {
  position: "absolute",
  zIndex: 30,
  left: 0,
  right: 0,
  top: "calc(100% + 4px)",
  maxHeight: 320,
  overflowY: "auto",
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.18)",
  padding: 4,
} as const;
const OPTION_STYLE = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  width: "100%",
  minHeight: 44,
  padding: "8px 12px",
  border: 0,
  borderRadius: "var(--r-sm)",
  background: "transparent",
  color: "var(--ink)",
  textAlign: "left",
  fontSize: "var(--fs-14)",
  cursor: "pointer",
} as const;
const NOTE_STYLE = { padding: "8px 12px", color: "var(--muted)", fontSize: "var(--fs-14)" } as const;

type Item = { type: "project"; option: RegistryProjectOption; hint?: string } | { type: "none" };

export interface RegistryPickerProps {
  state: RegistryFieldState;
  updatedAt: string | null;
  /** Точка объекта: ближние проекты выше в списке. */
  point: { lat: number; lng: number } | null;
  /** Варианты рядом (догадка и запасные): первыми в списке при пустом поиске. */
  nearby?: RegistryProjectOption[];
  busy?: boolean;
  onPick: (option: RegistryProjectOption) => void;
  onNone: () => void;
  /** Подпись над полем; в карточке объекта у блока свой заголовок. */
  label?: string | null;
  /**
   * Показывать ли «Нет в реестре / не новостройка». Только когда есть что отвергать (точка и проекты рядом или связь):
   * иначе сервер честно откажет, а решение сотрудника потерялось бы, когда геокодер позже поставит точку (ревью PR #441).
   */
  canMarkNone?: boolean;
}

function distanceText(option: RegistryProjectOption): string {
  if (option.distanceM == null) return "";
  // Ближе 30 м — это та же точка (погрешность карты): «0 м от точки» читается странно.
  return option.distanceM < 30 ? ", у точки объекта" : `, ${Math.round(option.distanceM)} м от точки`;
}

function StatusChip({ color }: { color: RegistryColor }) {
  return (
    <Chip tone={COLOR_TONE[color]} data-testid="registry-pick-status">
      {REGISTRY_COLOR_LABEL[color].title}
    </Chip>
  );
}

export function RegistryPicker({ state, updatedAt, point, nearby = [], busy = false, onPick, onNone, label = "Застройщик и разрешение", canMarkNone = true }: RegistryPickerProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const showInput = editing || state.kind === "empty";
  const debounced = useDebouncedValue(query.trim(), 250);
  const search = useRegistryProjectSearch(debounced, point, showInput && open);
  const date = registryUpdatedDate(updatedAt);
  const inputRef = useRef<HTMLInputElement>(null);
  // Поле открыто кнопкой «Изменить» — фокус сразу в нём (клавиатура и экранный диктор продолжают с поля).
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const items: Item[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Item[] = [];
    const push = (option: RegistryProjectOption, hint?: string) => {
      if (seen.has(option.id)) return;
      seen.add(option.id);
      out.push({ type: "project", option, hint });
    };
    if (!debounced) nearby.forEach((o, i) => push(o, i === 0 && state.kind === "guess" ? "похоже" : undefined));
    for (const o of search.data?.items ?? []) push(o);
    if (canMarkNone) out.push({ type: "none" });
    return out;
  }, [debounced, nearby, search.data, state.kind, canMarkNone]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const finish = () => {
    close();
    setEditing(false);
    setQuery("");
  };
  const choose = (item: Item) => {
    if (item.type === "none") onNone();
    else onPick(item.option);
    finish();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (open) close();
      else if (state.kind !== "empty") finish();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Enter") {
      // Поле живёт внутри формы правки: Enter здесь никогда не сохраняет всю форму (ревью PR #441).
      event.preventDefault();
      if (!open) return;
      if (active >= 0 && active < items.length) {
        choose(items[active]!);
        return;
      }
      // Ничего не подсвечено — берём первый проект списка (если он есть), «Нет в реестре» так не выбирается.
      const first = items.find((item) => item.type === "project");
      if (first) choose(first);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || (open && (event.key === "Home" || event.key === "End"))) {
      event.preventDefault();
      setOpen(true);
      const last = items.length - 1;
      const next =
        event.key === "Home" ? 0 : event.key === "End" ? last : event.key === "ArrowDown" ? (active + 1 > last ? 0 : active + 1) : active <= 0 ? last : active - 1;
      setActive(next);
    }
  };

  const activeId = open && active >= 0 && active < items.length ? `${listId}-${active}` : undefined;

  return (
    <div className="f" data-testid="registry-pick">
      {label && (
        <label className="lab" htmlFor={showInput ? inputId : undefined} id={`${id}-label`}>
          {label}
        </label>
      )}

      {!showInput && (
        <div className="row rh-row" data-testid={`registry-pick-${state.kind}`} style={{ flexWrap: "wrap", rowGap: 8 }}>
          <div className="t" style={{ flex: "1 1 220px", minWidth: 0 }}>
            {state.kind === "none" ? (
              <>
                <b>Нет в реестре</b>
                <span>Отмечено: не новостройка или проекта нет в реестре строек.</span>
              </>
            ) : (
              <>
                <b>
                  {state.kind === "guess" ? "Похоже: " : "Застройщик: "}
                  {state.option.developer}
                </b>
                <span>
                  {state.option.title}
                  {distanceText(state.option)}
                </span>
                <span data-testid="registry-pick-source">
                  {state.kind === "guess"
                    ? "Проверьте: не уверены, тот ли это проект. Не тот — нажмите «Изменить»."
                    : `${state.kind === "picked" || (state.kind === "linked" && state.method === "MANUAL") ? "Выбрано вручную" : "Определено автоматически"} по реестру memor.pro${date ? ` на ${date}` : ""}`}
                </span>
              </>
            )}
          </div>
          {state.kind !== "none" && <StatusChip color={state.option.color} />}
          <button
            type="button"
            className="pill sm ghost"
            disabled={busy}
            onClick={() => {
              setEditing(true);
              setOpen(true);
            }}
            data-testid="registry-pick-change"
            aria-label={`Изменить: ${label ?? "застройщик и разрешение"}`}
          >
            Изменить
          </button>
        </div>
      )}

      {showInput && (
        <div style={{ position: "relative" }}>
          <input
            id={inputId}
            value={query}
            autoComplete="off"
            ref={inputRef}
            disabled={busy}
            placeholder="Название комплекса, застройщик или адрес"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={activeId}
            aria-label={label ? undefined : "Застройщик и разрешение"}
            data-testid="registry-pick-input"
            style={INPUT_STYLE}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              close();
              if (editing && !query) setEditing(false);
            }}
            onKeyDown={onKeyDown}
          />
          {open && (
            <div
              id={listId}
              role="listbox"
              aria-label="Проекты реестра строек"
              data-testid="registry-pick-list"
              style={LIST_STYLE}
              // Тянут полосу прокрутки списка — фокус остаётся в поле, иначе список закрылся бы на blur (ревью PR #441).
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
            >
              {items.map((item, index) => (
                <button
                  key={item.type === "none" ? "none" : item.option.id}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={active === index}
                  style={{ ...OPTION_STYLE, ...(active === index ? { background: "var(--hover)" } : {}) }}
                  data-testid={item.type === "none" ? "registry-pick-none" : "registry-pick-option"}
                  onPointerDown={(e) => e.preventDefault()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item)}
                >
                  {item.type === "none" ? (
                    <b>Нет в реестре / не новостройка</b>
                  ) : (
                    <>
                      <b>{item.option.title}</b>
                      <span style={{ color: "var(--muted)" }}>
                        {item.option.developer} · {REGISTRY_COLOR_LABEL[item.option.color].title.toLowerCase()}
                        {distanceText(item.option)}
                        {item.hint ? ` (${item.hint})` : ""}
                      </span>
                    </>
                  )}
                </button>
              ))}
              {search.isFetching && <div style={NOTE_STYLE}>Ищу в реестре…</div>}
              {search.isError && <div style={NOTE_STYLE}>Реестр не ответил. Попробуйте ещё раз.</div>}
            </div>
          )}
        </div>
      )}    </div>
  );
}
