import { useState } from "react";
import { useAnswerOwnerQuestion, useOwnerQuestions } from "../../hooks/useMe";
import { CButton } from "./ui";

/** Ответ клиенту обязан быть содержательным: тот же предел, что у сервера (ownerAnswerSchema). */
export const OWNER_ANSWER_MIN = 5;

/**
 * Ответ на вопрос бота прямо в строке решения (раньше кнопка уводила в карточку).
 * Вопрос ищем в той же очереди, что и баннер «Бот обещал уточнить» (`GET /me/owner-questions`):
 * нужна ревизия управляемого вопроса. Очередь ещё не пришла — ничего не рисуем, остаётся ссылка в строке.
 */
export function CleanOwnerQuestionReply({ questionId, onAnswered }: { questionId: string; onAnswered?: () => void }) {
  const { data } = useOwnerQuestions();
  const answer = useAnswerOwnerQuestion();
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const question = data?.items.find((item) => item.id === questionId);
  if (!question) return null;
  if (question.managedRevision != null && question.answeredAt != null) {
    return <p role="status" className="clean-decision-details">Ответ сохранён, клиенту он ещё не ушёл. Проверьте диалог.</p>;
  }
  const trimmed = text.trim();
  const tooShort = trimmed.length < OWNER_ANSWER_MIN;
  function send() {
    if (answer.isPending || tooShort) return;
    setNote("");
    answer.mutate(
      { id: questionId, answer: trimmed, ...(question?.managedRevision ? { expectedRevision: question.managedRevision } : {}) },
      {
        onSuccess: (result) => {
          setText("");
          // Честно различаем «ответил» и «клиент получил».
          if (!result.delivered) setNote(result.message);
          onAnswered?.();
        },
      },
    );
  }
  return (
    <div className="clean-decision-reply mt-2 grid gap-2">
      <label className="text-[13px] text-gray-600" htmlFor={`owner-answer-${questionId}`}>
        Ответ клиенту{question.clientName ? ` · ${question.clientName}` : ""}
      </label>
      <textarea
        id={`owner-answer-${questionId}`}
        rows={2}
        value={text}
        maxLength={2000}
        disabled={answer.isPending}
        onChange={(event) => setText(event.target.value)}
        placeholder="Ответьте так, чтобы клиент понял без вопроса"
        className="w-full rounded-[14px] border border-line-soft bg-card p-3 text-[14px] text-ink"
      />
      <div className="flex flex-wrap items-center gap-2">
        <CButton size="sm" disabled={answer.isPending || tooShort} data-endpoint="POST /api/v1/me/owner-questions/:id/answer" onClick={send}>
          {answer.isPending ? "Отправляем…" : question.managedRevision != null ? "Сохранить ответ" : "Ответить клиенту"}
        </CButton>
        {tooShort && trimmed.length > 0 && <span className="text-[13px] text-gray-600">Минимум {OWNER_ANSWER_MIN} символов</span>}
        {note && <span role="status" className="text-[13px] text-gray-600">{note}</span>}
      </div>
      {answer.isError && <p role="alert" className="clean-decision-error">{answer.error instanceof Error ? answer.error.message : "Не удалось отправить ответ. Можно повторить."}</p>}
    </div>
  );
}
