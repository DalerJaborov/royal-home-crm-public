import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useCan } from "../../lib/permissions";

type Agent = { id: string; fullName: string; telegramLinked: boolean; deliveryBlocked: boolean };
type Data = { agents: Agent[]; selected: string[] };
type Status = { enabled: boolean; sourceStopped: boolean; identityReady: boolean; baselineDone: boolean; baselineNextPage: number; baselineLastPage: number | null; pending: number; sellerUnknown?: number; uncertain: number; sellerReviewCount: number; sellerReview: Array<{ advertId: string; sourceUrl: string }>; review: Array<{ advertId: string; agentName: string; status: string; updatedAt: string; sourceUrl: string | null }> };

export function SomonRecipientsSection() {
  const can = useCan();
  const canManage = can("settings.manage");
  const query = useQuery({ queryKey: ["somon-recipients"], queryFn: () => api<Data>("/settings/somon/recipients"), enabled: canManage });
  if (!canManage) return null;
  if (query.isLoading) return <p role="status">Загрузка очереди Somon…</p>;
  if (query.isError || !query.data) return <p role="alert">Не удалось загрузить очередь Somon.</p>;
  return <SomonRecipientsEditor data={query.data} />;
}

function SomonRecipientsEditor({ data }: { data: Data }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(() => data.selected.filter(id => data.agents.some(a => a.id === id)));
  const save = useMutation({ mutationFn: () => api<{ ok: boolean }>("/settings/somon/recipients", { method: "PUT", body: { agentIds: selected } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["somon-recipients"] }); } });
  const unblock = useMutation({ mutationFn: (id: string) => api<{ ok: boolean }>(`/settings/somon/recipients/${id}/unblock`, { method: "POST", body: { checked: true } }), onSuccess: (_data, id) => { setSelected(ids => ids.includes(id) ? ids : [...ids, id]); void qc.invalidateQueries({ queryKey: ["somon-recipients"] }); } });
  function toggle(id: string, checked: boolean) { setSelected(ids => checked ? [...ids, id] : ids.filter(x => x !== id)); }
  function move(id: string, direction: -1 | 1) {
    setSelected(ids => { const i = ids.indexOf(id), j = i + direction; if (i < 0 || j < 0 || j >= ids.length) return ids; const next = [...ids]; [next[i], next[j]] = [next[j], next[i]]; return next; });
  }
  return <section className="card" aria-labelledby="somon-recipients-title">
    <div className="sec-h stack"><h2 id="somon-recipients-title">Очередь Somon.tj</h2><span className="note">Выберите агентов и задайте порядок. Без привязки Telegram сотрудник временно пропускается.</span></div>
    {data.agents.length === 0 ? <p>Нет действующих агентов.</p> : <div className="stack">{data.agents.map(a => {
      const index = selected.indexOf(a.id);
      return <div className="mod" key={a.id}><div className="t"><label><input type="checkbox" checked={index >= 0 && !a.deliveryBlocked} disabled={a.deliveryBlocked} onChange={e => toggle(a.id, e.target.checked)} /> {a.fullName}</label><span>{a.deliveryBlocked ? "Отправка отклонена Telegram — проверьте чат перед повторным включением" : a.telegramLinked ? "Telegram привязан" : "Telegram не привязан"}{index >= 0 && !a.deliveryBlocked ? ` · очередь ${index + 1}` : ""}</span></div>{a.deliveryBlocked && <button className="pill ghost sm" type="button" disabled={!a.telegramLinked || unblock.isPending} onClick={() => unblock.mutate(a.id)}>Чат проверен — включить</button>}{index >= 0 && !a.deliveryBlocked && <div className="acts"><button className="pill ghost sm" type="button" aria-label={`Поднять ${a.fullName}`} disabled={index === 0} onClick={() => move(a.id, -1)}>↑</button><button className="pill ghost sm" type="button" aria-label={`Опустить ${a.fullName}`} disabled={index === selected.length - 1} onClick={() => move(a.id, 1)}>↓</button></div>}</div>;
    })}</div>}
    <button className="pill primary" type="button" disabled={save.isPending} onClick={() => save.mutate()}>Сохранить очередь</button>
    {save.isSuccess && <p role="status">Очередь сохранена.</p>}
    {save.isError && <p role="alert">Не удалось сохранить очередь. Проверьте доступ и повторите попытку.</p>}
    {unblock.isError && <p role="alert">Не удалось включить получателя. Проверьте привязку Telegram и доступ.</p>}
    <SomonMonitorControls />
  </section>;
}

function SomonMonitorControls() {
  const qc = useQueryClient();
  const [sourceChecked, setSourceChecked] = useState(false);
  const status = useQuery({ queryKey: ["somon-monitor"], queryFn: () => api<Status>("/settings/somon/status"), refetchInterval: 30_000 });
  const change = useMutation({ mutationFn: (enabled: boolean) => api<{ ok: boolean }>("/settings/somon/state", { method: "PUT", body: { enabled } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["somon-monitor"] }); } });
  const resolve = useMutation({ mutationFn: (id: string) => api<{ ok: boolean }>(`/settings/somon/review/${id}/resolve`, { method: "POST" }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["somon-monitor"] }); } });
  const recover = useMutation({ mutationFn: () => api<{ ok: boolean }>("/settings/somon/source/recover", { method: "POST", body: { checked: true } }), onSuccess: () => { setSourceChecked(false); void qc.invalidateQueries({ queryKey: ["somon-monitor"] }); } });
  const resolveSeller = useMutation({ mutationFn: (id: string) => api<{ ok: boolean }>(`/settings/somon/seller-review/${id}/resolve`, { method: "POST" }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["somon-monitor"] }); } });
  if (status.isLoading) return <p role="status">Загрузка состояния Somon…</p>;
  if (!status.data || status.isError) return <p role="alert">Не удалось получить состояние Somon.</p>;
  const s = status.data;
  const sellerReview = (s.sellerReview ?? []).length > 0 && <div><p>На ручной проверке: {s.sellerReviewCount}. Не удалось подтвердить данные продавца; автоматически эти карточки не отправляются. Сначала показаны самые ранние записи.</p>{s.sellerReview.map(x => <div className="mod" key={x.advertId}><a href={x.sourceUrl} target="_blank" rel="noreferrer">Открыть объявление №{x.advertId}</a><button className="pill ghost sm" type="button" disabled={resolveSeller.isPending} onClick={() => resolveSeller.mutate(x.advertId)}>Проверено</button></div>)}{resolveSeller.isError && <p role="alert">Не удалось отметить проверку продавца.</p>}</div>;
  return <>{sellerReview}<div className="mod"><div className="t"><b>Наблюдение за объявлениями</b><span>{s.sourceStopped ? "Остановлено после ошибок или отказа площадки." : !s.enabled ? "Выключено" : !s.identityReady ? "Остановлено: требуется проверка защиты от повторных контактов." : !s.baselineDone ? `Подготовка: страница ${s.baselineNextPage}${s.baselineLastPage ? ` из ${s.baselineLastPage}` : ""}. Старые объявления не рассылаются.` : `Включено · ожидают проверки: ${s.pending}${s.sellerUnknown ? ` · ждут дозаписи автора: ${s.sellerUnknown}` : ""}.`}</span>{s.uncertain > 0 && <span role="alert">Отправок для проверки: {s.uncertain}. Автоматического повтора нет.</span>}</div><div className="acts"><button className="pill ghost sm" type="button" disabled={change.isPending || (!s.enabled && s.sourceStopped)} onClick={() => change.mutate(!s.enabled)}>{s.enabled ? "Остановить" : "Запустить"}</button></div>{change.isError && <p role="alert">Не удалось изменить состояние. Сохраните очередь и проверьте привязку Telegram и доступ к настройкам.</p>}</div>{s.sourceStopped && <div><p>Проверьте причину остановки и согласуйте доступ с Somon. После восстановления запросы возобновятся не раньше чем через две минуты.</p><label><input type="checkbox" checked={sourceChecked} onChange={e => setSourceChecked(e.target.checked)} /> Причина проверена и устранена</label><button className="pill ghost sm" type="button" disabled={!sourceChecked || recover.isPending} onClick={() => recover.mutate()}>Возобновить доступ к Somon</button>{recover.isError && <p role="alert">Не удалось возобновить доступ.</p>}</div>}{s.review.length > 0 && <div><p>Проверьте у сотрудника результат отправки, затем отметьте запись проверенной. Повторной отправки не будет.</p>{s.review.map(x => <div className="mod" key={x.advertId}><div className="t"><b>№{x.advertId} · {x.agentName}</b><span>{new Date(x.updatedAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe" })} · {x.status === "FAILED" ? "Telegram отклонил" : x.status === "CANCELLED" ? "Отменено при остановке" : "Результат неизвестен"}</span>{x.sourceUrl && <a href={x.sourceUrl} target="_blank" rel="noreferrer">Открыть объявление</a>}</div><button className="pill ghost sm" type="button" disabled={resolve.isPending} onClick={() => resolve.mutate(x.advertId)}>Проверено</button></div>)}{resolve.isError && <p role="alert">Не удалось отметить проверку.</p>}</div>}</>;
}
