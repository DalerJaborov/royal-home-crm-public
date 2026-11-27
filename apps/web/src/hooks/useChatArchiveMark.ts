import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { isConversationListKey } from "../lib/liveEvents";
import { toast } from "../store/toast";
import { currentSessionEpoch, rollbackInSameSession } from "../lib/sessionGuard";
import type { ConversationsPage } from "./useConversations";

/**
 * «В архив» / «Вернуть» из строки списка чатов (27.11.2026, POST /conversations/archive-mark). Строка уходит из
 * открытого списка сразу (оптимистично), число «Архив» и срезы подтягивает перезапрос; не вышло — список возвращается.
 */
const isList = (query: { queryKey: readonly unknown[] }) => isConversationListKey(query.queryKey);

export function useChatArchiveMark() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "archive" | "restore" }) =>
      api<{ ok: true; updated: number }>("/conversations/archive-mark", { method: "POST", body: { id, action } }),
    // silent: свой короткий тост ниже («Чат в архиве»), общее «Сохранено» тут не к месту.
    meta: { silent: true },
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["conversations"], predicate: isList });
      const snapshot = queryClient.getQueriesData<ConversationsPage>({ queryKey: ["conversations"], predicate: isList });
      queryClient.setQueriesData<ConversationsPage>({ queryKey: ["conversations"], predicate: isList }, (old) =>
        old && Array.isArray(old.items)
          ? { ...old, items: old.items.filter((c) => c.id !== id), total: old.total != null ? Math.max(0, old.total - 1) : old.total }
          : old,
      );
      return { snapshot, epoch: currentSessionEpoch() };
    },
    onSuccess: (_data, { action }) => {
      toast.success(action === "archive" ? "Чат в архиве. Новое сообщение вернёт его в список." : "Чат вернулся в список");
    },
    onError: (_err, _vars, context) => {
      toast.error("Не удалось. Попробуйте ещё раз.");
      rollbackInSameSession(context?.epoch, () => {
        for (const [key, value] of context?.snapshot ?? []) queryClient.setQueryData(key, value);
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"], predicate: isList });
    },
  });
}
