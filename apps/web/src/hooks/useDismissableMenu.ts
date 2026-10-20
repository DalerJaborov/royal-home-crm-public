import { useEffect, useRef, useState } from "react";

/**
 * Открытие/закрытие всплывающего меню: клик мимо и Escape закрывают, фокус
 * после Escape возвращается на кнопку-триггер — иначе с клавиатуры из меню
 * было не выйти. Вынесено из ActionMenu.tsx (22.08.2026): PropertyRow.tsx
 * держал точную копию этой логики для своего меню «⋮» в строке каталога, но
 * без Escape и без aria — второй набор одинаковых на вид кнопок вёл себя
 * по-разному с клавиатуры. Один источник поведения, разные триггеры сверху.
 */
export function useDismissableMenu<TTrigger extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<TTrigger>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("click", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, boxRef, buttonRef };
}
