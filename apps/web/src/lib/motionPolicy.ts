/** Clean has no timed motion; legacy continues respecting the device preference. */
export function isMotionDisabled(): boolean {
  return (typeof document !== "undefined" && document.documentElement.dataset.shell === "clean") ||
    (typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}
