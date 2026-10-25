import { useQuery } from '@tanstack/react-query';
import { canViewInvestigations } from '@royal-home/shared';
import { useCan } from '../lib/permissions';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth';
type DossierResponse = { items: Array<{ propertyId: string; lines?: string[] }> };
export function PropertyRemovalDossier({ propertyIds }: { propertyIds: string[] }) {
  const role = useAuthStore(state => state.agent?.role);
  const can = useCan();
  const allowed = canViewInvestigations(role) && can('clients.securityReview');
  const ids = [...new Set(propertyIds)].sort();
  const query = useQuery({ queryKey: ['property-removal-dossiers', ids], enabled: allowed && ids.length > 0,
    retry: false, queryFn: async () => {
      const items: DossierResponse['items'] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const response = await api<DossierResponse>('/properties/removal-dossiers', { method: 'POST', body: { propertyIds: ids.slice(offset, offset + 100) } });
        items.push(...response.items);
      }
      return items;
    } });
  if (!allowed || !ids.length) return null;
  return <section className="rounded-xl border border-neutral-200 p-3 space-y-2" aria-label="Факты перед снятием">
    <p className="font-medium">Факты перед решением</p>
    <p className="text-xs text-neutral-500">Наблюдения CRM. Отсутствие ответа само по себе не доказывает нарушение.</p>
    {query.isFetching && <p role="status">Загружаем историю…</p>}
    {query.isError && <p role="alert">История сейчас недоступна. Не считайте отсутствие данных отсутствием событий.</p>}
    {query.data?.map((row, index) => <div key={row.propertyId} className="text-sm space-y-1">
      {ids.length > 1 && <p className="font-medium">Объект {index + 1}</p>}
      {row.lines?.map((line, i) => <p key={i}>{line}</p>)}
    </div>)}
  </section>;
}
