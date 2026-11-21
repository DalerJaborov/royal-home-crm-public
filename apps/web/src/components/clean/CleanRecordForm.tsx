import type { ReactNode } from "react";

/** Presentation only: legacy forms keep their historical DOM and behaviours. */
export function CleanRecordForm({ enabled, children, id }: { enabled: boolean; children: ReactNode; id?: string }) {
  return enabled ? <div id={id} className="clean-record-form">{children}</div> : <>{children}</>;
}

/** Keep old selector contracts on excluded legacy phones. */
export function cleanRecordChoiceProps(clean: boolean, selected: boolean) {
  return clean ? { "aria-pressed": selected } : { "aria-selected": selected };
}

export function focusCleanRecordError(id: string) {
  document.getElementById(id)?.querySelector<HTMLInputElement>(".fld.bad input:not(:disabled), .fld.bad select, .fld.bad textarea")?.focus();
}

export function CleanInteractionContext({ name, scheduling }: { name: string; scheduling: boolean }) {
  return <section className="clean-interaction-context" aria-label="Выбранный клиент">
    <span className="lab">{scheduling ? "Показ для клиента" : "Взаимодействие с клиентом"}</span>
    <p className="clean-interaction-client">{name}</p>
  </section>;
}

/** Preserve the draft after access changes, while the form becomes view-only. */
export function ReadOnlyRecordFields({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  return readOnly ? <><p role="status">Доступ только для просмотра. Черновик остаётся в форме.</p><fieldset disabled style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>{children}</fieldset></> : <>{children}</>;
}
