import { useState } from "react";
import { PROPERTY_DELETE_REQUEST_REASONS, PROPERTY_DELETE_REQUEST_REASON_LABELS, propertyDeleteRequestSchema, type PropertyRemovalInput } from "@royal-home/shared";
import { ConfirmDialog } from "./ConfirmDialog";

export function parseRemovalChoice(reason: string, comment: string): PropertyRemovalInput | null {
  const parsed = propertyDeleteRequestSchema.safeParse({ reason, comment });
  return parsed.success ? { removalReason: parsed.data.reason, removalComment: parsed.data.comment } : null;
}

export function PropertyRemovalDialog({ title, description, confirmLabel, onConfirm, onClose }: {
  title: string; description: string; confirmLabel: string;
  onConfirm: (body: PropertyRemovalInput) => Promise<unknown>; onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = parseRemovalChoice(reason, comment);
  const hint = !reason ? "Выберите причину" : reason === "SOLD_ELSEWHERE" ? "Опишите обстоятельства продажи: не менее 20 символов" : "Добавьте комментарий к причине";
  return <ConfirmDialog title={title} description={description} confirmLabel={busy ? "Сохранение…" : confirmLabel}
    confirmDisabled={!body || busy} confirmHint={!body ? hint : undefined} dismissible={!busy} onCancel={onClose}
    onConfirm={async () => {
      if (!body || busy) return;
      setBusy(true); setError(null);
      try { await onConfirm(body); onClose(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось сохранить. Повторите попытку."); }
      finally { setBusy(false); }
    }}>
    <label className="fld"><span className="lab">Причина</span><select className="inp" value={reason} disabled={busy} onChange={event => setReason(event.target.value)}><option value="">Выберите причину</option>{PROPERTY_DELETE_REQUEST_REASONS.map(value => <option key={value} value={value}>{PROPERTY_DELETE_REQUEST_REASON_LABELS[value]}</option>)}</select></label>
    <label className="fld"><span className="lab">Комментарий{reason === "OTHER" || reason === "SOLD_ELSEWHERE" ? " · обязательно" : ""}</span><textarea className="inp" rows={3} maxLength={1000} value={comment} disabled={busy} onChange={event => setComment(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
  </ConfirmDialog>;
}
