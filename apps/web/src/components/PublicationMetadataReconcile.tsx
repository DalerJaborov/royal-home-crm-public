import { useState } from "react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
export type MetadataAttemptSummary = { id?: string; channel: string; operation: string; status: string; startedAt?: string | null };
export function PublicationMetadataReconcile({propertyId,rows,onChanged}:{propertyId:string;rows:MetadataAttemptSummary[];onChanged:()=>void}) {
  const role=useAuthStore(s=>s.agent?.role);
  const [selected,setSelected]=useState<string|null>(null),[note,setNote]=useState(''),[checked,setChecked]=useState(false),[outcome,setOutcome]=useState<'APPLIED'|'FAILED'>('APPLIED'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  if(role!=='ADMIN'&&role!=='DIRECTOR') return null;
  const attempts=rows.filter(r=>r.id&&r.startedAt&&['UNKNOWN','EXECUTING'].includes(r.status));
  if(!attempts.length) return null;
  return <div className="space-y-3 mt-3">
    <p>Неопределённый результат нельзя повторять автоматически. Сначала проверьте публикацию и историю запросов на площадке.</p>
    {attempts.map(row=><div key={row.id}>
      <button className="pill sm" type="button" disabled={busy} onClick={()=>{setSelected(row.id!);setNote('');setChecked(false);setError('');}}>Зафиксировать проверку · {row.channel} · {row.operation==='CAPTION'?'описание':'обложка'}</button>
      {selected===row.id&&<form className="space-y-2 mt-2" onSubmit={async event=>{
        event.preventDefault();event.stopPropagation();if(!checked||note.trim().length<20)return;setBusy(true);setError('');
        try {await api(`/properties/${propertyId}/publication-metadata/${row.id}/reconcile`,{method:'POST',body:{expectedStartedAt:row.startedAt,providerChecked:true,outcome,note}});setSelected(null);onChanged();}
        catch(err){setError(err instanceof Error?err.message:'Проверка не сохранена');}finally{setBusy(false);}
      }}>
        <label className="block">Что подтвердилось на площадке<select className="input" value={outcome} disabled={busy} onChange={e=>setOutcome(e.target.value as 'APPLIED'|'FAILED')}><option value="APPLIED">Изменение применено</option><option value="FAILED">Изменение не применено</option></select></label>
        <label className="block">Как проверили и что увидели<textarea className="input" minLength={20} maxLength={2000} required value={note} disabled={busy} onChange={e=>setNote(e.target.value)}/></label>
        <label className="flex gap-2"><input type="checkbox" checked={checked} disabled={busy} onChange={e=>setChecked(e.target.checked)}/>Я проверил площадку и историю запросов, результат определён.</label>
        <p>Будет сохранено ваше подтверждение. CRM не выполняет независимую проверку и ничего не отправляет.</p>
        {error&&<p role="alert">{error}</p>}
        <button className="pill sm" disabled={busy||!checked||note.trim().length<20}>Сохранить результат проверки</button>
      </form>}
    </div>)}
  </div>;
}
