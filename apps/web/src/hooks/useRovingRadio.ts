import { useRef } from "react";
import type { KeyboardEvent } from "react";

/**
 * Клавиатура в группе `role="radiogroup"` — без библиотек (задание
 * send-back-web-24-09.md, п.7). Стрелки ↑/↓/←/→ переводят выбор по кругу,
 * Home/End прыгают к первому/последнему доступному варианту, Tab заходит в
 * группу один раз (roving tabindex: `tabIndex 0` только у выбранного или,
 * если выбора ещё нет, у первого доступного варианта; у остальных `-1`) —
 * ровно то поведение, что описывает WAI-ARIA Practices для radiogroup.
 * Выключенные варианты (`isDisabled`) пропускаются и как якорь tabIndex, и
 * при переборе стрелками.
 *
 * Хук не рисует ничего сам — отдаёт `register`/`tabIndex`/`onKeyDown` для
 * кнопок группы (роли `role="radio"` в разметке уже есть, см.
 * PropertyVideoFixCard.tsx), поэтому годится для любой группы `<button
 * role="radio">`, а не только двух конкретных в этом файле.
 */
export function useRovingRadio<T>(values: readonly T[], selected: T | null, isDisabled?: (value: T) => boolean) {
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());

  const enabled = (v: T) => !isDisabled?.(v);
  const enabledValues = values.filter(enabled);
  // Якорь: выбранный вариант, если он сам не выключен, иначе первый доступный —
  // группа без единого доступного варианта (все выключены) не встречается в
  // разметке этого файла, но на всякий случай не роняет клавиатуру.
  const anchor = selected != null && enabled(selected) ? selected : enabledValues[0];

  function register(value: T) {
    return (el: HTMLButtonElement | null) => {
      if (el) itemRefs.current.set(value, el);
      else itemRefs.current.delete(value);
    };
  }

  function tabIndex(value: T): 0 | -1 {
    return enabledValues.length > 0 && value === anchor ? 0 : -1;
  }

  function onKeyDown(e: KeyboardEvent, value: T, onSelect: (value: T) => void) {
    if (enabledValues.length === 0) return;
    const idx = values.indexOf(value);
    let target: T | undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") target = step(values, idx, 1, enabled);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") target = step(values, idx, -1, enabled);
    else if (e.key === "Home") target = enabledValues[0];
    else if (e.key === "End") target = enabledValues[enabledValues.length - 1];
    else return;
    if (target == null) return;
    e.preventDefault();
    onSelect(target);
    itemRefs.current.get(target)?.focus();
  }

  return { register, tabIndex, onKeyDown };
}

/** Следующий доступный вариант по кругу, начиная сразу за `from` в направлении `dir`. */
function step<T>(values: readonly T[], from: number, dir: 1 | -1, enabled: (v: T) => boolean): T | undefined {
  const n = values.length;
  for (let i = 1; i <= n; i++) {
    const idx = (((from + dir * i) % n) + n) % n;
    if (enabled(values[idx])) return values[idx];
  }
  return undefined;
}
