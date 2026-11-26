import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationSendContext, ConversationSendPropertiesResult } from "@royal-home/shared";
import { api } from "../lib/api";
import { sendToClient } from "../lib/clientSend";
import { useSendIntent } from "./useSendIntent";

/**
 * Объект из переписки без карточки клиента (26.11.2026, сервер: lib/conversationPropertySend.ts).
 * Шторка «Объект» берёт отсюда один лёгкий запрос (куда уйдёт, что уже отправляли, что бот собрал
 * о запросе) вместо тяжёлой карточки клиента, которой у диалога может не быть вовсе.
 */
export function useConversationSendContext(conversationId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["conversation-send-context", conversationId],
    queryFn: () => api<ConversationSendContext>(`/conversations/${conversationId}/send-context`),
    enabled: !!conversationId && enabled,
    staleTime: 15_000,
    retry: false,
  });
}

export interface SendPropertiesFromChatInput {
  propertyIds: string[];
  /** Срок паузы бота (ISO); пусто — умолчание сервера. Округляется до минуты снаружи, чтобы повтор шёл с тем же ключом. */
  pausedUntil?: string;
}

/** Отправка идёт через sendToClient: повтор после обрыва связи отдаёт ответ первого раза, клиенту не уйдёт дубль. */
export function useSendPropertiesFromChat(conversationId: string | undefined) {
  const queryClient = useQueryClient();
  const intent = useSendIntent();
  return useMutation({
    mutationFn: (body: SendPropertiesFromChatInput) =>
      sendToClient<ConversationSendPropertiesResult>(intent, `/conversations/${conversationId}/send-properties`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation-send-context", conversationId] });
    },
  });
}
