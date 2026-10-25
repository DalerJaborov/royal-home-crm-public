import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { callbackRequestViewSchema } from "@royal-home/shared";
import { api } from "../../lib/api";
import { useCan, useIsReadOnly } from "../../lib/permissions";
import { useAuthStore } from "../../store/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The existing endpoint accepts one native UUID conversation id per request. */
export function callbackRequestConversationIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => !!id && UUID.test(id)))];
}

/** Conversation-local controls, not a company-wide callback banner. A local
 * claim is never shown as a completed call or a delivered customer message. */
export function CustomerRequestsPanel({ conversationId, conversationIds }: { conversationId?: string; conversationIds?: string[] }) {
  const can = useCan(), agentId = useAuthStore(state => state.agent?.id), qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const enabled = !!agentId && (can("messages.view") || can("messages.viewOwn"));
  const ids = callbackRequestConversationIds(conversationIds ?? (conversationId ? [conversationId] : []));
  const requestQueries = useQueries({ queries: ids.map(sourceId => ({
    queryKey: ["customer-requests", sourceId, agentId], enabled, staleTime: 10_000, refetchInterval: 30_000,
    queryFn: async () => {
      const result = await api<{ items: unknown[] }>(`/me/callback-requests?conversationId=${encodeURIComponent(sourceId)}`);
      return callbackRequestViewSchema.array().parse(result.items).filter(item => item.conversationId === sourceId &&
        item.lifecycleRevision !== null && (item.requestKind === "HUMAN" || item.requestKind === "CALLBACK") &&
        (item.lifecycleStatus === "QUEUED" || item.lifecycleStatus === "ACCEPTED"));
    },
  })) });
  const requestItems = [...new Map(requestQueries.flatMap(query => query.data ?? []).map(item => [item.id, item])).values()]
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const queryFailed = requestQueries.some(query => query.isError);
  const transition = useMutation({ retry: false,
    mutationFn: ({ id, expectedRevision, action }: { id: string; expectedRevision: string; action: "accept" | "return" | "close" }) => {
      if (readOnly) throw new Error("Режим просмотра: изменение запросов недоступно.");
      return api<{ ok: true }>(`/me/callback-requests/${id}/transition`, { method: "POST", body: { expectedRevision, action } });
    },
    onSettled: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["customer-requests"] }),
        qc.invalidateQueries({ queryKey: ["conversations"] })]);
    },
  });
  if (!enabled || ids.length === 0) return null;
  if (queryFailed && requestItems.length === 0) return <p className="px-3 py-2 text-sm" role="status">Не удалось обновить запросы клиента.</p>;
  if (!requestItems.length && !queryFailed) return null;
  return <section aria-label="Запросы клиента в этом диалоге" className="px-3 py-2 space-y-2 max-h-52 overflow-auto shrink-0 bg-blue/5">
    {queryFailed && <p className="text-sm" role="status">Не удалось обновить часть запросов клиента.</p>}
    {requestItems.map(request => {
      const queued = request.lifecycleStatus === "QUEUED", mine = request.assignedAgentId === agentId;
      const human = request.requestKind === "HUMAN";
      return <div key={request.id} className="space-y-1">
        <p className="text-sm font-semibold">{human ? "Клиент ждёт сотрудника" : "Запрос на звонок"}</p>
        <p className="text-sm break-words">{request.topic}</p>
        <p className="text-[13px] text-gray-500">{queued ? "Ожидает принятия" : mine ? "Вы приняли запрос" : "Принят другим сотрудником"}
          {human ? ". Принятие — передача этого диалога сотруднику." : ". Принятие запроса ещё не означает, что звонок состоялся."}</p>
        {!readOnly && <div className="flex flex-wrap gap-2">
          {queued && <button type="button" className="pill min-h-11" disabled={transition.isPending} onClick={() => transition.mutate({
            id: request.id, expectedRevision: request.lifecycleRevision!, action: "accept",
          })}>Принять в работу</button>}
          {!queued && mine && <button type="button" className="pill ghost min-h-11" disabled={transition.isPending} onClick={() => transition.mutate({
            id: request.id, expectedRevision: request.lifecycleRevision!, action: "return",
          })}>Вернуть в очередь</button>}
          {(queued || mine) && <button type="button" className="pill ghost min-h-11" disabled={transition.isPending} onClick={() => transition.mutate({
            id: request.id, expectedRevision: request.lifecycleRevision!, action: "close",
          })}>Закрыть запрос</button>}
        </div>}
      </div>;
    })}
    {transition.isError && <p className="text-sm text-amber" role="alert">Не удалось подтвердить изменение. Данные обновлены; проверьте запрос перед повтором.</p>}
  </section>;
}
