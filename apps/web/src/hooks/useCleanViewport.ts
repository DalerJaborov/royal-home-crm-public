import { useLayoutEffect } from "react";
import { layoutViewportHeight, readKeyboard, visibleFrame } from "../lib/keyboardInset";

/** Keep the composer inside the visible viewport, without changing legacy phone behavior. */
export function useCleanViewport(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = 0;
    let notice: HTMLElement | null = null;
    const sizeObserver = new ResizeObserver(() => schedule());
    let written = "";
    const apply = () => {
      frame = 0;
      // Каркас переписки = видимая область (lib/keyboardInset.ts → visibleFrame): верх — offsetTop, высота —
      // visualViewport.height, ВСЕГДА, а не только когда «клавиатура признана открытой». До 21.11 верх
      // ставился лишь при открытой клавиатуре, а признак на iPhone врал (innerHeight падал вместе с
      // клавиатурой): переписка стояла на 0 при сдвинутой вниз видимой области и уезжала вверх за экран.
      const layoutHeight = layoutViewportHeight();
      const box = visibleFrame(viewport, layoutHeight);
      const kbOpen = viewport ? readKeyboard(layoutHeight, viewport).open : false;
      const key = `${box.top}|${box.height}`;
      if (key !== written) {
        written = key;
        root.style.setProperty("--clean-viewport-height", `${box.height}px`);
        root.style.setProperty("--clean-viewport-top", `${box.top}px`);
      }
      const nextNotice = document.querySelector<HTMLElement>(".clean-critical-notice");
      if (notice !== nextNotice) {
        if (notice) sizeObserver.unobserve(notice);
        notice = nextNotice;
        if (notice) sizeObserver.observe(notice);
      }
      const noticeStyle = notice ? getComputedStyle(notice) : null;
      const noticeSpace = notice ? notice.getBoundingClientRect().height + (parseFloat(noticeStyle?.marginTop ?? "0") || 0) + (parseFloat(noticeStyle?.marginBottom ?? "0") || 0) : 0;
      root.style.setProperty("--clean-notice-space", `${Math.ceil(noticeSpace)}px`);
      const focused = document.activeElement;
      const editing = focused instanceof HTMLElement && (focused.matches("input,textarea") || focused.isContentEditable);
      if (editing && kbOpen) root.dataset.cleanKeyboard = "1";
      else delete root.dataset.cleanKeyboard;
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(apply); };
    apply();
    const contentObserver = new MutationObserver(schedule);
    contentObserver.observe(document.body, { childList: true, subtree: true });
    // Видимая область двигается каждый кадр анимации клавиатуры: пересчёт сразу, без ожидания следующего кадра,
    // иначе переписка отстаёт от экрана на кадр и «дрожит».
    const now = () => { if (frame) { window.cancelAnimationFrame(frame); frame = 0; } apply(); };
    viewport?.addEventListener("resize", now);
    viewport?.addEventListener("scroll", now);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    // iOS присылает resize видимой области уже ПОСЛЕ закрытия клавиатуры: через 350 мс после focusout — последний пересчёт (он же сброс в 0).
    let lateTimer = 0;
    const onFocusOut = () => { schedule(); window.clearTimeout(lateTimer); lateTimer = window.setTimeout(schedule, 350); };
    document.addEventListener("focusout", onFocusOut);
    return () => {
      window.clearTimeout(lateTimer);
      viewport?.removeEventListener("resize", now);
      viewport?.removeEventListener("scroll", now);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", onFocusOut);
      if (frame) window.cancelAnimationFrame(frame);
      contentObserver.disconnect();
      sizeObserver.disconnect();
      root.style.removeProperty("--clean-viewport-height");
      root.style.removeProperty("--clean-viewport-top");
      root.style.removeProperty("--clean-notice-space");
      delete root.dataset.cleanKeyboard;
    };
  }, [enabled]);
}
