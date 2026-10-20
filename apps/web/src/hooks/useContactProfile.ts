/**
 * Досье собеседника приезжает вместе с диалогом (`ConversationDetail.contact`),
 * поэтому отдельного запроса на чтение здесь нет — только правка категории.
 *
 * После правки обновляем весь кэш диалогов, а не одну запись: то же досье висит
 * на всех переписках этого человека, и оставить в соседней вкладке прежнюю роль
 * значило бы показать два ответа на один вопрос «кто это».
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ContactCategory, ContactProfileView } from "@royal-home/shared";
import { api } from "../lib/api";

export function useSetContactCategory(contactId: string | null) {
  const qc = useQueryClient();
  return useMutation<{ contact: ContactProfileView }, Error, ContactCategory>({
    mutationFn: (category) =>
      api<{ contact: ContactProfileView }>(`/contacts/${contactId}`, { method: "PATCH", body: { category } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"], exact: false });
    },
  });
}
