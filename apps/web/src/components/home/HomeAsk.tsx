import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api";

/**
 * Вопрос помощнику на ролевой Главной (макет `.aib-ask`): тот же
 * POST /ai/assistant, что и у панели помощника, сервер режет ответ по роли —
 * агенту закрыты чужие карточки и разговоры, менеджеру деньги и номера.
 * Подсказки и подпись поля — свои у каждой роли (макет `tpl-home-*`).
 */
export function HomeAsk({
  placeholder,
  ariaLabel,
  suggestions,
  nested = false,
}: {
  placeholder: string;
  ariaLabel: string;
  suggestions: string[];
  /** Поле стоит внутри чужой `<form>` (шторка `Rh2Sheet` сама форма): вложенных форм не бывает, поэтому
   *  вместо своей формы — `div`, отправка по Enter и по кнопке. Логика вопроса одна и та же. */
  nested?: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || pending) return;
    setPending(true);
    setStatus("Думаю…");
    setAnswer(null);
    try {
      const res = await api<{ reply: string }>("/ai/assistant", {
        method: "POST",
        body: { messages: [{ role: "user", content: text }] },
      });
      setAnswer(res.reply);
      setStatus(null);
    } catch (err) {
      // 502 (ИИ не ответил) / 409 (модуль выключен) — тихая строка, не alert.
      setStatus(err instanceof ApiError ? err.message : "Не удалось получить ответ");
    } finally {
      setPending(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(question);
  }

  const Wrap = nested ? "div" : "form";
  return (
    <div className="aib-ask">
      <Wrap onSubmit={nested ? undefined : submit}>
        <input
          className="inp"
          type="text"
          name="q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={
            nested
              ? (e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  void ask(question);
                }
              : undefined
          }
          aria-label={ariaLabel}
          placeholder={placeholder}
          maxLength={300}
          disabled={pending}
          autoComplete="off"
        />
        <button
          className="pill"
          type={nested ? "button" : "submit"}
          onClick={nested ? () => void ask(question) : undefined}
          disabled={pending || !question.trim()}
        >
          Спросить
        </button>
      </Wrap>
      {!answer && (
        <div className="aib-sugg" role="group" aria-label="Готовые вопросы">
          {suggestions.map((q) => (
            <button
              key={q}
              type="button"
              data-q={q}
              disabled={pending}
              onClick={() => {
                setQuestion(q);
                void ask(q);
              }}
            >
              {q}
            </button>
          ))}
        </div>
      )}
      {(status || answer) && (
        <div className="aib-ans" role="status" aria-live="polite">
          {answer ?? status}
          {answer && (
            <>
              {" "}
              <button
                className="lk"
                type="button"
                onClick={() => {
                  setAnswer(null);
                  setQuestion("");
                }}
              >
                Спросить ещё
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
