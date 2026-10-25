import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { confirmClientIntentSchema } from "@royal-home/shared";
import type { Client } from "../types";
import { api } from "../lib/api";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { useAuthStore } from "../store/auth";

/** Explicit current intent; an old role change is never shown as two simultaneous jobs. */
export function ClientIntentConfirmation({ client, locked, mode = "overview" }: { client: Client; locked: boolean; mode?: "overview" | "edit" }) {
  const [open, setOpen] = useState(false);
  const [both, setBoth] = useState(!!client.dualIntent);
  const [resolution, setResolution] = useState<"MANUAL" | "AUTO">("MANUAL");
  const isAdmin = useAuthStore(state => state.agent?.role === "ADMIN");
  const query = useQueryClient();
  const save = useMutation({
    mutationFn: () => api(`/clients/${client.id}/intents`, { method: "POST", body: confirmClientIntentSchema.parse({ dualIntent: both, resolution }) }),
    onSuccess: async () => {
      await Promise.all([query.invalidateQueries({ queryKey: ["client"] }), query.invalidateQueries({ queryKey: ["clients"] }), query.invalidateQueries({ queryKey: ["client-match", client.id] })]);
      setOpen(false);
    },
  });
  if (client.kind === "OTHER" || client.pendingAcceptance && locked) return null;
  const needsReview = client.dualIntentNeedsReview === true;
  const start = () => { setBoth(!!client.dualIntent); setResolution("MANUAL"); save.reset(); setOpen(true); };
  return <div className="client-intent-confirmation">
    {mode === "overview" && client.dualIntent && <span className="chip">Покупает и продаёт</span>}
    {mode === "overview" && client.dualIntent && client.dualIntentDecisionSource === "AUTO" && <span className="sub"> Определено автоматически</span>}
    {mode === "overview" && needsReview && <p className="sub">Неясно, актуальны ли покупка и продажа одновременно.</p>}
    {!locked && (mode === "edit" || needsReview) && <button type="button" className="pill ghost sm" onClick={start}>{mode === "edit" ? "Изменить роли клиента" : "Уточнить роли клиента"}</button>}
    {open && !locked && <Rh2Sheet title="Актуальные роли клиента" onClose={() => { if (!save.isPending) setOpen(false); }} onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (!save.isPending) save.mutate(); }}
      footer={<><button type="button" className="pill ghost" disabled={save.isPending} onClick={() => setOpen(false)}>Отмена</button><button type="submit" className="pill" disabled={save.isPending}>{save.isPending ? "Сохранение…" : "Подтвердить роли"}</button></>}>
      <p>Основная роль: <b>{client.kind === "SELLER" ? "продавец" : "покупатель"}</b>.</p>
      {isAdmin && <label className="fld"><span className="lab">Как определять роли</span><select className="inp" value={resolution} onChange={event => setResolution(event.target.value as "MANUAL" | "AUTO")}><option value="MANUAL">Моё решение</option><option value="AUTO">Автоматически по актуальным сведениям</option></select></label>}
      {resolution === "MANUAL" ? <><label className="check"><input type="checkbox" checked={both} onChange={event => setBoth(event.target.checked)} /> Клиент одновременно продаёт и покупает недвижимость</label>
      <p className="sub">Ручное решение сохранится в истории. Автоматика не будет менять его.</p></> : <p className="sub">CRM заново проверит актуальные сведения. При неоднозначных данных потребуется уточнение.</p>}
      {save.error && <p role="alert">{save.error.message}</p>}
    </Rh2Sheet>}
  </div>;
}
