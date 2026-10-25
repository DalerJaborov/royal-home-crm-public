import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WeeklyOperationalPreviewKind, WeeklyOperationalPreviewPage, AgencyLabelPreview } from '@royal-home/shared';
import { canViewInvestigations } from '@royal-home/shared';
import { api } from '../../lib/api';
import { dushanbeDateTime } from '../../lib/date';
import { useAuthStore } from '../../store/auth';
import { useCan } from '../../lib/permissions';
const labels: Record<WeeklyOperationalPreviewKind, string> = {
  DEFERRED_AFTER_SHOWING: 'Отложены после показа за неделю',
  PROPERTY_NO_RECORDED_ACTIVITY: 'Объекты без записанной активности 14 дней',
  IDLE_RESERVATION_DEAL: 'Брони и сделки без записанных действий 14 дней',
};
export function WeeklyOperationalPreviewPanel() {
  const role = useAuthStore(state => state.agent?.role); const can = useCan();
  const allowed = canViewInvestigations(role) && can('clients.securityReview');
  const [open, setOpen] = useState(false); const [kind, setKind] = useState<WeeklyOperationalPreviewKind>('DEFERRED_AFTER_SHOWING'); const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['weekly-operational-preview', kind, page], enabled: allowed && open,
    queryFn: () => api<WeeklyOperationalPreviewPage>(`/security/cases/weekly-operational-preview?kind=${kind}&page=${page}`) });
  const agencies = useQuery({ queryKey: ['agency-label-preview'], enabled: allowed && open,
    queryFn: () => api<AgencyLabelPreview>('/security/cases/agency-label-preview') });
  if (!allowed) return null;
  return <details className="card my-3" onToggle={event => setOpen(event.currentTarget.open)}><summary>Недельный обзор работы — предпросмотр</summary>
    <p className="sub">Текущий снимок записей CRM. Полнота звонков и переписки неизвестна: отсутствие записи не доказывает бездействие. Обзор не меняет уровни проверки и не отправляет уведомления.</p>
    <label className="block my-3">Раздел <select className="input w-full mt-1" value={kind} onChange={event => { setKind(event.target.value as WeeklyOperationalPreviewKind); setPage(1); }}>
      {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    {kind === 'DEFERRED_AFTER_SHOWING' && <p className="sub">Сейчас отложенные карточки за последние 7 дней. Показ должен иметь объект, прошедшую дату и отметку выполнения до откладывания. Исторические показы без этих данных сюда не входят.</p>}
    {kind === 'PROPERTY_NO_RECORDED_ACTIVITY' && <p className="sub">Активные объекты старше 14 дней без записанных отправок, показов и звонков продавцу за этот период. Это вопрос работы с объектом, а не признак нарушения.</p>}
    {kind === 'IDLE_RESERVATION_DEAL' && <p className="sub">Срок проверяется по началу сделки или брони, изменениям в журнале, документам и записанным контактам. Отдельного достоверного признака «движение вне CRM» нет.</p>}
    {query.isError ? <p role="alert">Сводка недоступна. <button onClick={() => void query.refetch()}>Повторить</button></p>
      : query.isFetching ? <p>Загрузка…</p> : !query.data?.items.length ? <p>По выбранному условию записей нет.</p>
      : <div className="grid gap-2">{query.data.items.map(row => <article className="rounded-xl border p-3" key={`${row.sourceType}:${row.id}`}>
        <p>Текущий ответственный: {row.agentName ?? 'не указан'} · {dushanbeDateTime(row.observedAt)}</p>
        <div className="flex flex-wrap gap-3">{row.clientId && <Link to={`/clients/${row.clientId}`}>Карточка клиента</Link>}{row.propertyId && <Link to={`/properties/${row.propertyId}`}>Объект и история</Link>}</div>
      </article>)}</div>}
    {query.data && <div className="flex flex-wrap items-center gap-3 mt-3"><span>{query.data.total} записей · страница {page}</span><button disabled={page === 1 || query.isFetching} onClick={() => setPage(value => value - 1)}>Назад</button><button disabled={page * query.data.pageSize >= query.data.total || query.isFetching} onClick={() => setPage(value => value + 1)}>Далее</button></div>}
    <h3 className="mt-4">Совпадения введённых названий агентств за 90 дней</h3>
    <p className="sub">Сравниваются только одинаковые названия из поля отказа у одного сотрудника, без учёта регистра и крайних пробелов. Нет подтверждённого справочника организаций: совпадение текста не доказывает, что это одна компания, и не меняет уровень проверки.</p>
    {agencies.isError ? <p role="alert">Названия недоступны. <button onClick={() => void agencies.refetch()}>Повторить</button></p>
      : agencies.isFetching ? <p>Загрузка названий…</p> : !agencies.data?.groups.length ? <p>В доступных записях совпадений для двух разных клиентов нет.</p>
      : agencies.data.groups.map(group => <article className="rounded-xl border p-3 my-2" key={`${group.agentId}:${group.originalLabels[0]}`}>
        <p>{group.originalLabels.join(' / ')} · {group.distinctClients} разных клиентов · один ответственный сотрудник</p>
        <div className="flex flex-wrap gap-3">{group.clientIds.map((id, index) => <Link key={id} to={`/clients/${id}`}>Карточка {index + 1}</Link>)}</div>
        <p className="sub">Совпадение организации не подтверждено. Проверьте исходные отказы и обстоятельства.</p>
      </article>)}
    {agencies.data?.truncated && <p className="sub">Показан неполный срез: последние 1 000 отказов. Это не общий итог за 90 дней.</p>}
  </details>;
}
