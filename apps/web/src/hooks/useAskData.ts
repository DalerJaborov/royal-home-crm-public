import { useState, type FormEvent } from "react";
import { useMissionControlAsk } from "./useMissionControl";

/**
 * Общая логика «Вопрос к данным» (`POST /dashboard/mission-control/ask`). Заводилась
 * как общая для двух панелей (задача L2-T5, docs/pult/theme-2026/layer-2-plan.md §1
 * п.5); с 10.09.2026 потребитель один — `AskPanel.tsx`, вторая панель удалена вместе
 * с переносом главной на макет владельца. Хук оставлен: он держит правила вызова
 * (один вопрос, один ответ, без истории диалога) отдельно от разметки.
 *
 * Сам вызов и права (`dashboard.analytics`, `seesMoney`/`ownScope` на сервере) не
 * меняются — хук лишь оборачивает `useMissionControlAsk` состоянием поля ввода.
 */
export function useAskData() {
  const [question, setQuestion] = useState("");
  const { mutate, data, error, isPending, reset } = useMissionControlAsk();

  const onQuestionChange = (value: string) => {
    setQuestion(value);
    if (data || error) reset();
  };

  const ask = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || isPending) return;
    mutate(trimmed);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(question);
  };

  const clear = () => {
    setQuestion("");
    reset();
  };

  return {
    question,
    setQuestion: onQuestionChange,
    submit,
    ask,
    clear,
    answer: data?.answer ?? null,
    error,
    isPending,
    reset,
  };
}
