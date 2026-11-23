import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ShowingQuestionAnswer, ShowingQuestionView } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Вопросы агенту о показе (владелец 22.11.2026): «Договорились о показе?» и
 * «У вас был показ?». Главный путь — кнопки в Шабнам; здесь тот же вопрос в CRM.
 * Ответ здесь снимает кнопки в Шабнам (сервер: lib/showingQuestions.ts).
 */
export function useShowingQuestions(clientId?: string) {
  return useQuery({
    queryKey: ["showing-questions", clientId ?? "all"],
    queryFn: () =>
      api<{ items: ShowingQuestionView[] }>(`/showing-questions${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`),
    // Вопрос появляется через минуту после разговора или через час после показа.
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
}

export function useAnswerShowingQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, answer }: { id: string; answer: ShowingQuestionAnswer }) =>
      api<{ ok: boolean; message: string }>(`/showing-questions/${id}/answer`, { method: "POST", body: answer }),
    // Отвеченная карточка ещё несколько секунд показывает итог («Записала показ…») и только потом
    // уходит из списка; при ошибке список перечитывается сразу (вопрос могли закрыть в Шабнам).
    onSuccess: () => {
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["showing-questions"] }), 4000);
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: ["showing-questions"] });
    },
    onSettled: () => {
      // Ответ ставит или отмечает показ и задачу — календарь и карточка клиента должны это увидеть.
      void qc.invalidateQueries({ queryKey: ["calendar-tasks"] });
      void qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
      void qc.invalidateQueries({ queryKey: ["client"] });
    },
  });
}
