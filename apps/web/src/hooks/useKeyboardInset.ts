import { useEffect } from "react";

/**
 * Высота экранной клавиатуры в CSS-переменной `--rh-kb-inset` на <html>, пока хук активен.
 *
 * ЗАЧЕМ (15.11.2026, чат ассистента «криво стоит»). Шторка снизу — `position: fixed`
 * по layout viewport. Клавиатура iOS и Android поднимает только visualViewport и не
 * двигает layout viewport, поэтому поле ввода в подвале шторки уходило ПОД клавиатуру:
 * человек печатал вслепую. Тот же приём уже стоит в MobileChatView; здесь он вынесен
 * переменной, чтобы любая шторка подняла подвал одной строкой CSS:
 * `bottom: var(--rh-kb-inset, 0px)`.
 *
 * Порог 80 px отсекает дрожание адресной строки браузера (она тоже меняет visualViewport).
 */
export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      root.style.setProperty("--rh-kb-inset", inset < 80 ? "0px" : `${inset}px`);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--rh-kb-inset");
    };
  }, [active]);
}
