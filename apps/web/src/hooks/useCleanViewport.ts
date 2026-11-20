import { useLayoutEffect } from "react";

/** Keep the composer inside the visible viewport, without changing legacy phone behavior. */
export function useCleanViewport(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = 0;
    let notice: HTMLElement | null = null;
    const sizeObserver = new ResizeObserver(() => schedule());
    const apply = () => {
      frame = 0;
      root.style.setProperty("--clean-viewport-height", `${Math.round(viewport?.height ?? window.innerHeight)}px`);
      // Safari при открытой клавиатуре двигает ВИДИМУЮ область вниз (offsetTop > 0), а слои
      // `position: fixed` остаются привязаны к layout viewport: полноэкранная переписка с top: 0
      // уезжала вверх за экран, поле ввода оказывалось под шапкой, под ним — пустота (кадр 12, 20.11).
      // Верх берём только пока клавиатура открыта: закрылась — строго 0, даже если iOS ещё не вернул offsetTop
      // (резиновая прокрутка и запоздалый resize оставляли переписку сдвинутой).
      const focusedNow = document.activeElement;
      const typing = focusedNow instanceof HTMLElement && (focusedNow.matches("input,textarea") || focusedNow.isContentEditable);
      const kbOpen = typing && window.innerHeight - (viewport?.height ?? window.innerHeight) > 140;
      root.style.setProperty("--clean-viewport-top", kbOpen ? `${Math.max(0, Math.round(viewport?.offsetTop ?? 0))}px` : "0px");
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
      if (editing && window.innerHeight - (viewport?.height ?? window.innerHeight) > 140) root.dataset.cleanKeyboard = "1";
      else delete root.dataset.cleanKeyboard;
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(apply); };
    apply();
    const contentObserver = new MutationObserver(schedule);
    contentObserver.observe(document.body, { childList: true, subtree: true });
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    // iOS присылает resize видимой области уже ПОСЛЕ закрытия клавиатуры — пересчитываем ещё раз с запасом.
    let lateTimer = 0;
    const onFocusOut = () => { schedule(); window.clearTimeout(lateTimer); lateTimer = window.setTimeout(schedule, 350); };
    document.addEventListener("focusout", onFocusOut);
    return () => {
      window.clearTimeout(lateTimer);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
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
