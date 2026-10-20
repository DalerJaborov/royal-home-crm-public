import { useMemo } from "react";
import type { PultArea } from "@royal-home/shared";
import { useAskData } from "../../hooks/useAskData";
import { ApiError } from "../../lib/api";
import { Button, LinkButton } from "../rh2/Button";
import { Filters } from "../rh2/Filters";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { answerLines, mentionedAreas } from "./AskPanel";

/**
 * «Спросить» под значком ИИ в шапке пульта (контракт 06.10: поле вопроса и
 * готовые вопросы уходят с экрана в шторку). Вызов и права те же, что у
 * прежней строки пульта: `POST /dashboard/mission-control/ask` через
 * `useAskData` — один вопрос, один ответ, без истории.
 *
 * Шторка Rh2Sheet сама `<form>`, поэтому поле ввода живёт в ней без
 * собственной формы (вложенные формы недопустимы), а отправка идёт через
 * `onSubmit` шторки.
 */
export function DirectorAskSheet({ areas, onClose }: { areas: PultArea[]; onClose: () => void }) {
  const { question, setQuestion, submit, ask, answer, error, isPending, clear } = useAskData();
  const suggestions = useMemo(
    () =>
      areas
        .filter((a) => a.tone !== "ok")
        .slice(0, 3)
        .map((a) => ({ id: a.label, label: `Что там с разделом «${a.label}»?` })),
    [areas],
  );
  const chips = useMemo(() => (answer ? mentionedAreas(answer, areas) : []), [answer, areas]);
  // 502 (ИИ не ответил) / 409 (модуль выключен) читаются как тихая строка, не как поломка.
  const quietError =
    error instanceof ApiError && (error.status === 502 || error.status === 409)
      ? error.message
      : error
        ? "Не удалось получить ответ"
        : null;
  const status = isPending ? "Думаю…" : quietError;
  const blank = !question.trim();

  return (
    <Rh2Sheet
      title="Спросить ИИ"
      onClose={onClose}
      onSubmit={submit}
      footer={
        blank || isPending ? (
          <Button type="submit" disabled disabledReason={isPending ? "Ответ ещё готовится" : "Введите вопрос"}>
            Спросить
          </Button>
        ) : (
          <Button type="submit">Спросить</Button>
        )
      }
    >
      <label className="fld">
        <span className="lab">Вопрос к данным компании</span>
        <input
          type="text"
          name="q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Сколько заработаем до пятницы?"
          maxLength={300}
          disabled={isPending}
          autoComplete="off"
        />
      </label>

      {!answer && suggestions.length > 0 && (
        <Filters
          aria-label="Примеры вопросов"
          options={suggestions}
          value=""
          onChange={(id) => {
            const picked = suggestions.find((s) => s.id === id);
            if (!picked) return;
            setQuestion(picked.label);
            ask(picked.label);
          }}
        />
      )}

      {status ? (
        <p className="quiet" role="status">
          {status}
        </p>
      ) : null}

      {answer ? (
        <div aria-live="polite">
          {answerLines(answer).map((line, i) => (
            <p key={i}>{line}</p>
          ))}
          <div className="acts">
            {chips.map((a) => (
              <LinkButton key={a.id} to={a.href} size="sm" variant="soft">
                {a.label}
              </LinkButton>
            ))}
            <Button size="sm" variant="ghost" onClick={clear}>
              Спросить ещё
            </Button>
          </div>
        </div>
      ) : null}
    </Rh2Sheet>
  );
}
