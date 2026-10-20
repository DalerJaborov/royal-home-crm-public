import { useLayoutEffect, useRef, useState } from "react";
import type { ActionRowAction, ActionRowData } from "../pult/ActionRow";
import { useUndoToast } from "../../hooks/useUndoToast";
import { useCan } from "../../lib/permissions";
import { CAvatar, CButton, CLink } from "./ui";

/** Only successful members enter the undo ledger. Failed members stay actionable. */
export async function runDecisionBatch(rows: ActionRowData[], onFailure?: (error: unknown) => void) {
  const succeeded: { id: string; action: ActionRowAction }[] = [];
  for (const row of rows) {
    const action = row.actions[0];
    if (!action) continue;
    try { if (await action.onRun()) succeeded.push({ id: row.id, action }); }
    catch (error) { onFailure?.(error); }
  }
  return succeeded;
}

export function CleanDecisionRow({ row, photos, disabled = false, resolved = false, onResolved, onBusy }: {
  row: ActionRowData; photos: Map<string, string>; disabled?: boolean;
  resolved?: boolean;
  onResolved?: (id: string, done: boolean) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const can = useCan();
  const { showUndoToast } = useUndoToast();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [childBusy, setChildBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [batchOutcome, setBatchOutcome] = useState("");
  const complete = done || resolved;
  const completion = useRef<HTMLParagraphElement>(null);
  const focusCompletion = useRef(false);
  useLayoutEffect(() => {
    if ((complete || batchOutcome) && focusCompletion.current) { completion.current?.focus(); focusCompletion.current = false; }
  }, [complete, batchOutcome]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [badPhoto, setBadPhoto] = useState<string>();
  const allowed = row.id.startsWith("deal") ? can("deals.complete")
    : row.id.startsWith("property") ? can("properties.moderate")
    : row.id.startsWith("client") ? can("clients.assign")
    : row.id.startsWith("system") ? can("auditLog.view") : true;
  const members = row.members?.filter((m) => !completed.has(m.id));
  const group = !!row.members?.length;
  const photo = row.id.startsWith("property-") ? photos.get(row.id.slice(9)) : undefined;
  const resolve = (id: string, value: boolean) => setCompleted((previous) => {
    const next = new Set(previous); if (value) next.add(id); else next.delete(id); return next;
  });

  async function run(action?: ActionRowAction) {
    if (lock.current || disabled || childBusy || !allowed) return;
    // Disabling the focused submit button can blur it before the request resolves.
    focusCompletion.current = document.activeElement instanceof HTMLElement && !!document.activeElement.closest(".clean-decision-actions");
    lock.current = true; setBusy(true); onBusy?.(true); setError("");
    try {
      const targets = action ? [{ ...row, actions: [action] }] : members ?? [];
      const failures: string[] = [];
      const succeeded = await runDecisionBatch(targets, (cause) => {
        if (cause instanceof Error) failures.push(cause.message);
      });
      if (!succeeded.length) { setError(failures[0] || "Не удалось выполнить действие. Можно повторить."); return; }
      if (action) { setDone(true); onResolved?.(row.id, true); }
      else { succeeded.forEach(({ id }) => resolve(id, true)); setBatchOutcome(`Выполнено ${succeeded.length} из ${targets.length}`); setDone(succeeded.length === targets.length); setOpen(true); }
      if (succeeded.length < targets.length) setError(`Выполнено ${succeeded.length} из ${targets.length}. Остальные решения остались в очереди.${failures[0] ? ` ${failures[0]}` : ""}`);
      const message = action
        ? typeof action.doneMessage === "function" ? action.doneMessage() : action.doneMessage
        : `Выполнено ${succeeded.length} из ${targets.length}`;
      showUndoToast({ message, duration: 10_000,
        onUndo: succeeded.every(({ action: a }) => a.onUndo) ? () => {
          void (async () => {
            let failures = 0;
            let reason = "";
            for (const entry of succeeded) {
              try {
                await entry.action.onUndo!();
                if (action) { setDone(false); onResolved?.(row.id, false); }
                else { resolve(entry.id, false); setDone(false); setBatchOutcome(""); }
              } catch (cause) { failures++; if (cause instanceof Error) reason = cause.message; }
            }
            if (failures) showUndoToast({ message: `Не удалось отменить ${failures} действий. ${reason || "Проверьте состояние в разделе."}` });
          })();
        } : undefined,
      });
    } finally { lock.current = false; setBusy(false); onBusy?.(false); }
  }

  return <div>
    <div className={`clean-decision${complete ? " clean-decision-done" : ""}`}>
      {photo && badPhoto !== photo
        ? <img src={photo} alt="" width={40} height={40} className="size-10 rounded-xl object-cover" onError={() => setBadPhoto(photo)} />
        : <CAvatar name={row.avatar?.label ?? row.title} size={40} />}
      <div className="min-w-0">
        <p className="clean-decision-title">{row.title}</p>
        <p ref={completion} tabIndex={-1} role="status" className="clean-decision-description">{batchOutcome || (complete ? "Выполнено" : row.tone === "crit" ? "Срочно" : "Требует внимания")}{row.k ? ` · ${row.k}` : ""}{row.description ? ` · ${row.description}` : ""}</p>
      </div>
      <div className="clean-decision-actions">
        {!complete && allowed && (group
          ? !!members?.length && row.bulkLabel && <CButton variant="primary" size="sm" disabled={busy || disabled || childBusy} data-endpoint={row.bulkEndpoint} onClick={() => void run()}>{busy ? "Выполняем…" : row.bulkLabel}</CButton>
          : row.actions.map((action, i) => <CButton key={action.endpoint + action.label} variant={i ? "soft" : "primary"} size="sm" disabled={busy || disabled} data-endpoint={action.endpoint} onClick={() => void run(action)}>{busy ? "Выполняем…" : action.label}</CButton>))}
        {row.links?.map((link) => <CLink key={link.href} to={link.href} variant="soft" size="sm">{link.label}</CLink>)}
        {(group || row.description) && <CButton variant="soft" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Свернуть" : group ? "Разобрать" : "Подробнее"}</CButton>}
      </div>
    </div>
    {error && <p role="alert" className="clean-decision-error">{error}</p>}
    {open && row.description && <p className="clean-decision-details">{row.description}</p>}
    {open && group && <div className="mt-2 grid gap-2">
      {row.members!.map((member) => <CleanDecisionRow key={member.id} row={member} photos={photos} resolved={completed.has(member.id)} disabled={busy || disabled || childBusy} onResolved={resolve} onBusy={setChildBusy} />)}
      {!members?.length && <p className="clean-decision-details">Все решения этой группы выполнены.</p>}
    </div>}
  </div>;
}
