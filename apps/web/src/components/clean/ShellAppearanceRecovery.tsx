import { CButton } from "./ui";

/** Fail closed to the permitted legacy UI, but explain the fallback instead of silently changing the design. */
export function ShellAppearanceRecovery() {
  function reload() {
    window.dispatchEvent(new CustomEvent("rh:before-app-update"));
    window.location.reload();
  }
  return <section role="status" aria-label="Интерфейс временно недоступен" className="flex flex-wrap items-center gap-3 bg-card px-4 py-3 text-[15px] text-ink">
    <p className="min-w-0 flex-1">Новое оформление не загрузилось. Сейчас показана резервная версия приложения.</p>
    <CButton variant="soft" onClick={reload}>Повторить загрузку</CButton>
  </section>;
}
