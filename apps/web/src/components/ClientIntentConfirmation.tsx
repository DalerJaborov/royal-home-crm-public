import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { confirmClientIntentSchema } from "@royal-home/shared";
import type { Client } from "../types";
import { api } from "../lib/api";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

/** Explicit current intent; an old role change is never shown as two simultaneous jobs. */
export function ClientIntentConfirmation({ client, locked }: { client: Client; locked: boolean }) {
  const [open, setOpen] = useState(false);
  const [both, setBoth] = useState(!!client.dualIntent);
  const query = useQueryClient();
  const save = useMutation({
    mutationFn: () => api(`/clients/${client.id}/intents`, { method: "POST", body: confirmClientIntentSchema.parse({ dualIntent: both }) }),
    onSuccess: async () => {
      await Promise.all([query.invalidateQueries({ queryKey: ["client"] }), query.invalidateQueries({ queryKey: ["clients"] }), query.invalidateQueries({ queryKey: ["client-match", client.id] })]);
      setOpen(false);
    },
  });
  if (client.kind === "OTHER" || client.pendingAcceptance && locked) return null;
  const start = () => { setBoth(!!client.dualIntent); save.reset(); setOpen(true); };
  return <div className="client-intent-confirmation">
    {client.dualIntentNeedsConfirmation && <p className="sub">В истории есть другая роль. Уточните, продаёт и покупает ли клиент одновременно — прежний запрос этого не подтверждает.</p>}
    {!locked && <button type="button" className="pill ghost sm" onClick={start}>{client.dualIntentNeedsConfirmation ? "Уточнить роли клиента" : client.dualIntent ? "Изменить роли клиента" : client.kind === "SELLER" ? "Клиент также покупает?" : "Клиент также продаёт?"}</button>}
    {open && !locked && <Rh2Sheet title="Актуальные роли клиента" onClose={() => { if (!save.isPending) setOpen(false); }} onSubmit={() => { if (!save.isPending) save.mutate(); }}
      footer={<><button type="button" className="pill ghost" disabled={save.isPending} onClick={() => setOpen(false)}>Отмена</button><button type="submit" className="pill" disabled={save.isPending}>{save.isPending ? "Сохранение…" : "Подтвердить роли"}</button></>}>
      <p>Основная роль: <b>{client.kind === "SELLER" ? "продавец" : "покупатель"}</b>.</p>
      <label className="check"><input type="checkbox" checked={both} onChange={event => setBoth(event.target.checked)} /> Клиент одновременно продаёт и покупает недвижимость</label>
      <p className="sub">Подтвердите это по словам клиента. Смена типа или старый запрос не означают, что обе задачи актуальны сейчас. Решение сохранится в истории.</p>
      {save.error && <p role="alert">{save.error.message}</p>}
    </Rh2Sheet>}
  </div>;
}
