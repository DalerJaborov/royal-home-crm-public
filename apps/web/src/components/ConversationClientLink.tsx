import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { conversationClientLinkSchema } from "@royal-home/shared";
import { useClients } from "../hooks/useClients";
import { api } from "../lib/api";
import { useCan } from "../lib/permissions";
import { formatClientCode, formatClientName } from "../lib/clientFormat";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { toast } from "../store/toast";
import type { Client } from "../types";

/** Shared by both desktop shells and the phone conversation. */
export function ConversationClientLink({ conversationId, clientId, readOnly = false }: {
  conversationId: string; clientId: string | null; readOnly?: boolean;
}) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (readOnly || clientId || !can("messages.view") || !can("clients.merge") || !can("clients.viewAll")) return null;
  return <>
    <div className="quiet">
      <span className="txt">Уже общались с этим человеком по телефону?</span>
      <button type="button" className="lnk" onClick={() => setOpen(true)}>Связать с клиентом</button>
    </div>
    {open && <LinkClientSheet conversationId={conversationId} onClose={() => setOpen(false)} />}
  </>;
}

function LinkClientSheet({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<Client | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const found = useClients({ q: search.trim(), pageSize: 8 }, search.trim().length >= 2 && !target);
  const link = useMutation({
    mutationFn: async () => api(`/conversations/${conversationId}/link-client`, { method: "POST",
      body: conversationClientLinkSchema.parse({ clientId: target?.id, confirmSamePerson: confirmed }) }),
    meta: { silent: true },
    onSuccess: async () => {
      await Promise.all(["conversations", "clients", "client", "contacts", "contact-links", "calls", "incoming-calls", "counters"]
        .map((key) => qc.invalidateQueries({ queryKey: [key] })));
      toast.success("Переписка связана с клиентом");
      onClose();
    },
  });
  const close = () => { if (!link.isPending) onClose(); };
  return <Rh2Sheet title="Связать переписку с клиентом" onClose={close} layer="above-chat"
    onSubmit={() => { if (target && confirmed && !link.isPending) link.mutate(); }}
    footer={<>
      <button type="button" className="pill ghost" disabled={link.isPending} onClick={close}>Отмена</button>
      <button type="submit" className="pill" disabled={!target || !confirmed || link.isPending}>
        {link.isPending ? "Связываем…" : "Связать"}
      </button>
    </>}>
    <p className="state">Выберите существующую карточку этого человека. Переписка и досье будут связаны с ней.
      Основной телефон и ответственный агент сохранятся. Номер WhatsApp добавится отдельно.</p>
    {target ? <>
      <div className="list"><div className="row"><div className="t">
        <b>{formatClientName(target)}</b><span>{formatClientCode(target.shortId, target.kind)} · {target.phone}</span>
        {target.requirementsNotes && <span>{target.requirementsNotes}</span>}
      </div><button type="button" className="pill ghost sm" disabled={link.isPending}
        onClick={() => { setTarget(null); setConfirmed(false); link.reset(); }}>Изменить</button></div></div>
      <label className="fld"><span>
        <input type="checkbox" checked={confirmed} disabled={link.isPending}
          onChange={(e) => setConfirmed(e.target.checked)} /> Подтверждаю: это один и тот же человек, даже если номера разные
      </span></label>
    </> : <>
      <label className="fld"><span className="lab">Клиент</span>
        <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Имя или телефон клиента" />
      </label>
      {search.trim().length >= 2 && <div className="list" aria-live="polite">
        {found.isFetching ? <p className="state">Ищем…</p> : found.isError ? <p className="state err" role="alert">
          Не удалось найти карточки. <button type="button" className="lnk" onClick={() => void found.refetch()}>Повторить</button>
        </p> : found.data?.items.length ? found.data.items.map((c) => <button key={c.id} type="button" className="row"
          onClick={() => { setTarget(c); link.reset(); }}><div className="t"><b>{formatClientName(c)}</b>
          <span>{formatClientCode(c.shortId, c.kind)} · {c.phone}</span></div></button>) : <p className="state">Никого не нашли</p>}
      </div>}
    </>}
    {link.isError && <p className="quiet crit" role="alert">{link.error.message}</p>}
  </Rh2Sheet>;
}
