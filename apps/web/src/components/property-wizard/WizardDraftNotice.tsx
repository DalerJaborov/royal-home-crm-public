import type { WizardDraftStatus } from "./draftAutosave";

/** Storage location and acknowledgements come from the writer, never from a timer. */
export function WizardDraftNotice({ status, onRetry, disabled }: {
  status?: WizardDraftStatus;
  onRetry?: () => void;
  disabled?: boolean;
}) {
  if (!status) return null;
  const retry = status.state === "error" || status.state === "local" && !!status.message;
  const savedAt = status.state === "server" && status.savedAt && Number.isFinite(Date.parse(status.savedAt)) ? status.savedAt : null;
  return <div className="wizard-draft-notice" data-state={status.state} data-testid="wizard-draft-status"
    role={status.state === "error" ? "alert" : "status"} aria-live={status.state === "error" ? "assertive" : "polite"}>
    <span className="wizard-draft-dot" aria-hidden="true" />
    <div className="wizard-draft-copy">
      <span>{status.state === "saving" ? "Сохраняю черновик…" : status.state === "server" ? "Сохранено на сервере" : status.state === "local" ? "Сохранено на этом устройстве" : "Не удалось сохранить на сервере"}
        {savedAt && <> · <time dateTime={savedAt}>{new Date(savedAt).toLocaleTimeString("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" })}</time></>}
      </span>
      {(status.state === "local" || status.state === "error") && status.message && <p>{status.message}</p>}
    </div>
    {onRetry && retry && <button type="button" data-testid="wizard-draft-retry" className="wizard-text-action" onClick={onRetry} disabled={disabled}>Повторить сохранение</button>}
  </div>;
}
