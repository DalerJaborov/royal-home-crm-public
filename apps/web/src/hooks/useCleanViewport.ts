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
    document.addEventListener("focusout", schedule);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      if (frame) window.cancelAnimationFrame(frame);
      contentObserver.disconnect();
      sizeObserver.disconnect();
      root.style.removeProperty("--clean-viewport-height");
      root.style.removeProperty("--clean-notice-space");
      delete root.dataset.cleanKeyboard;
    };
  }, [enabled]);
}
