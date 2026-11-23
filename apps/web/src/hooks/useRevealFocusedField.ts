import { useEffect } from "react";
import type { RefObject } from "react";

/** Поле, в котором печатают: на нём клавиатура открывается, и его нельзя оставлять под ней. */
export function isTypingField(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image"].includes(el.type);
}

/**
 * Поле в фокусе внутри окна прокручивается в видимую часть, когда открывается клавиатура
 * (21.11.2026, аудит К07.3–7.4: «поле при клавиатуре вне окна, печатаешь вслепую»).
 *
 * Браузер сам прокручивает страницу к полю, но не тело шторки: шторка — `position: fixed` со своей
 * прокруткой, и после подъёма над клавиатурой (Rh2Sheet) её тело остаётся там, где стояло. Задержка
 * 320 мс — анимация клавиатуры: раньше неё высота видимой области ещё старая и прокручивать некуда.
 */
export function useRevealFocusedField(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;
    let timer = 0;
    const reveal = () => {
      const active = document.activeElement;
      if (!isTypingField(active) || !node.contains(active)) return;
      active.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const later = () => { window.clearTimeout(timer); timer = window.setTimeout(reveal, 320); };
    node.addEventListener("focusin", later);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", later);
    return () => {
      window.clearTimeout(timer);
      node.removeEventListener("focusin", later);
      vv?.removeEventListener("resize", later);
    };
  }, [ref, enabled]);
}
