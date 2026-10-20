/** Runs after React has committed the inline errors. No-op outside the browser. */
export function focusWizardError() {
  if (typeof document === "undefined" || typeof requestAnimationFrame === "undefined") return;
  requestAnimationFrame(() => {
    const invalid = document.querySelector<HTMLElement>('.wizard-workspace [aria-invalid="true"]');
    const field = invalid?.matches("input,select,textarea,button,[tabindex]") ? invalid
      : invalid?.querySelector<HTMLElement>("input,select,textarea,button,[tabindex]");
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: "center", behavior: "auto" });
  });
}
