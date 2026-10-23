import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { callbackRequestViewSchema } from "@royal-home/shared";
import { api } from "../../lib/api";
import { useCan, useIsReadOnly } from "../../lib/permissions";
import { useAuthStore } from "../../store/auth";

/** Conversation-local controls, not a company-wide callback banner. A local
 * claim is never shown as a completed call or a delivered customer message. */
export function CustomerRequestsPanel({ conversationId }: { conversationId: string }) {
  const can = useCan(), agentId = useAuthStore(state => state.agent?.id), qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const enabled = !!agentId && (can("messages.view") || can("messages.viewOwn"));
  const queryKey = ["customer-requests", conversationId, agentId];
  const requests = useQuery({ queryKey, enabled, staleTime: 10_000, refetchInterval: 30_000,
    queryFn: async () => {
      const result = await api<{ items: unknown[] }>(`/me/callback-requests?conversationId=${encodeURIComponent(conversationId)}`);
      return callbackRequestViewSchema.array().parse(result.items).filter(item => item.conversationId === conversationId &&
        item.lifecycleRevision !== null && (item.requestKind === "HUMAN" || item.requestKind === "CALLBACK") &&
        (item.lifecycleStatus === "QUEUED" || item.lifecycleStatus === "ACCEPTED"));
    },
  });
  const transition = useMutation({ retry: false,
    mutationFn: ({ id, expectedRevision, action }: { id: string; expectedRevision: string; action: "accept" | "return" | "close" }) => {
      if (readOnly) throw new Error("Режим просмотра: изменение запросов недоступно.");
      return api<{ ok: true }>(`/me/callback-requests/${id}/transition`, { method: "POST", body: { expectedRevision, action } });
    },
    onSettled: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["customer-requests", conversationId] }),
        qc.invalidateQueries({ queryKey: ["conversations"] })]);
    },
  });
  if (!enabled) return null;
  if (requests.isError) return <p className="px-3 py-2 text-sm" role="status">Не удалось обновить запросы клиента.</p>;
  if (!requests.data?.length) return null;
  return <section aria-label="Запросы клиента в этом диалоге" className="px-3 py-2 space-y-2 max-h-52 overflow-auto shrink-0 bg-blue/5">
    {requests.data.map(request => {
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
