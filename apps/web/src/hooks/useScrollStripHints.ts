import { useEffect } from "react";
import { STRIP_SELECTOR, stripMore } from "../lib/scrollStrip";

/** Браузер умеет затухание по прокрутке сам (CSS `animation-timeline`) — атрибут не нужен. */
function nativeFade(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timeline: scroll()");
}

/**
 * Ставит `data-strip-more` (`end` / `start` / `both`) на ряды, которые листаются вбок и ещё не докручены, —
 * по нему CSS рисует затухание края там, где `animation-timeline` не работает (аудит К20, 21.11.2026).
 * Один наблюдатель на всё приложение: ряды приходят и уходят с экранами, а их ширина меняется от шрифта и фото.
 */
export function useScrollStripHints(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || nativeFade()) return;
    let frame = 0;
    const apply = (el: HTMLElement) => {
      const next = stripMore(el);
      if (next === "none") { if (el.dataset.stripMore) delete el.dataset.stripMore; }
      else if (el.dataset.stripMore !== next) el.dataset.stripMore = next;
    };
    // Полный перебор — на resize, шрифты и загрузку. На изменение DOM пересчитываем только ряды, которых коснулись:
    // сам добавленный узел, ряды внутри него и ряд-предок (в ряд добавили плитку).
    const touched = new Set<HTMLElement>();
    let full = false;
    const sweep = () => {
      frame = 0;
      if (full) { full = false; touched.clear(); document.querySelectorAll<HTMLElement>(STRIP_SELECTOR).forEach(apply); return; }
      touched.forEach((el) => { if (el.isConnected) apply(el); });
      touched.clear();
    };
    const run = () => { if (!frame) frame = window.requestAnimationFrame(sweep); };
    const schedule = () => { full = true; run(); };
    const onMutations = (records: MutationRecord[]) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches(STRIP_SELECTOR)) touched.add(n);
          n.querySelectorAll<HTMLElement>(STRIP_SELECTOR).forEach((el) => touched.add(el));
        });
        const host = r.target instanceof HTMLElement ? r.target.closest<HTMLElement>(STRIP_SELECTOR) : null;
        if (host) touched.add(host);
      }
      if (touched.size) run();
    };
    const onScroll = (e: Event) => {
      const el = e.target;
      if (el instanceof HTMLElement && el.matches(STRIP_SELECTOR)) apply(el);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("load", schedule);
    const observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", schedule);
      window.removeEventListener("load", schedule);
      observer.disconnect();
      document.querySelectorAll<HTMLElement>("[data-strip-more]").forEach((el) => delete el.dataset.stripMore);
    };
  }, [enabled]);
}
