import { useState } from "react";
import { showingCancelSchema, showingRescheduleSchema } from "@royal-home/shared";
import { useCancelShowing, useCompleteTask, useRescheduleShowing } from "../hooks/useCalendar";
import { dushanbeInputToIso, dushanbeTodayKey } from "../lib/date";
import { ConfirmDialog } from "./ConfirmDialog";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

/** Uses the calendar's mutation paths: one showing, one history and one set of guards. */
export function ClientShowingActions({ id, scheduledAt }: { id: string; scheduledAt: string | null }) {
  const cancel = useCancelShowing();
  const move = useRescheduleShowing();
  const complete = useCompleteTask();
  const [mode, setMode] = useState<"cancel" | "move" | "complete" | null>(null);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const busy = cancel.isPending || move.isPending || complete.isPending;
  const error = validation ?? cancel.error?.message ?? move.error?.message ?? complete.error?.message;
  const close = () => { if (!busy) { setMode(null); setReason(""); setValidation(null); cancel.reset(); move.reset(); complete.reset(); } };
  async function save() {
    if (busy) return;
    setValidation(null);
    if (mode === "move" && (!date || !time)) { setValidation("Укажите дату и время"); return; }
    const at = mode === "move" ? dushanbeInputToIso(date, time) : null;
    const parsed = mode === "move" ? showingRescheduleSchema.safeParse({ reason, at }) : showingCancelSchema.safeParse({ reason });
    if (!parsed.success) { setValidation(parsed.error.issues[0]?.message ?? "Укажите причину"); return; }
    if (at && new Date(at).getTime() <= Date.now()) { setValidation("Выберите будущее время"); return; }
    try {
      if (mode === "move" && at) await move.mutateAsync({ interactionId: id, reason: reason.trim(), at });
      else await cancel.mutateAsync({ interactionId: id, reason: reason.trim() });
      setMode(null); setReason("");
    } catch { /* Mutation retains the structured API error beside the form. */ }
  }
  return <>
    <div className="client-workspace-nav">
      {(!scheduledAt || new Date(scheduledAt).getTime() <= Date.now()) && <button className="pill ghost sm" type="button" disabled={busy} onClick={() => setMode("complete")}>Показ проведён</button>}
      {scheduledAt && <><button className="pill ghost sm" type="button" disabled={busy} onClick={() => setMode("move")}>Перенести</button><button className="pill ghost sm" type="button" disabled={busy} onClick={() => setMode("cancel")}>Отменить показ</button></>}
    </div>
    {error && !mode && <p role="alert">{error}</p>}
    {mode === "complete" && <ConfirmDialog title="Подтвердить проведённый показ?" description="Отметка сохранится в истории и закроет задачу по этому показу." confirmLabel="Показ проведён" danger={false}
      confirmDisabled={busy} dismissible={!busy} onCancel={close} onConfirm={() => { if (!busy) complete.mutate(id, { onSuccess: () => setMode(null) }); }}>
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
    {(mode === "move" || mode === "cancel") && <Rh2Sheet title={mode === "move" ? "Перенести показ" : "Отменить показ"} onClose={close} onSubmit={() => void save()}
      footer={<><button type="button" className="pill ghost" disabled={busy} onClick={close}>Назад</button><button type="submit" className="pill" disabled={busy}>{busy ? "Сохранение…" : "Сохранить"}</button></>}>
      {mode === "move" && <div className="fgrid"><label className="fld"><span className="lab">Дата</span><input type="date" required min={dushanbeTodayKey()} value={date} onChange={e => setDate(e.target.value)} /></label><label className="fld"><span className="lab">Время</span><input type="time" required value={time} onChange={e => setTime(e.target.value)} /></label></div>}
      <label className="fld"><span className="lab">Причина</span><textarea required value={reason} onChange={e => setReason(e.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
    </Rh2Sheet>}
  </>;
}
