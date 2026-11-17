import { useEffect, useRef, useState, type FormEvent } from "react";
import { renderAssistantContent } from "../assistantContent";
import { AssistantStreamError, streamAssistant } from "../../lib/assistantStream";

/**
 * Вопрос помощнику на ролевой Главной (макет `.aib-ask`): тот же
 * POST /ai/assistant, что и у панели помощника, и тем же клиентом потока
 * (`streamAssistant`): маршрут отдаёт SSE, а не JSON, и прежний `api()` читал
 * поток как JSON — вопрос всегда заканчивался «Не удалось получить ответ»
 * (аудит 31.10.2026, п. 4). Сервер режет ответ по роли —
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
  const abortRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);

  // Ушли с Главной посреди вопроса — запрос обрываем, ответ некому показывать.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || pending) return;
    setPending(true);
    setStatus("Думаю…");
    setAnswer(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const reply = await streamAssistant([{ role: "user", content: text }], setStatus, { signal: controller.signal });
      if (unmountedRef.current) return;
      setAnswer(reply);
      setStatus(null);
    } catch (err) {
      if (unmountedRef.current) return;
      // Выключен (403), лимит (429), ИИ не ответил, таймаут — тихая строка, не alert.
      setStatus(err instanceof AssistantStreamError ? err.message : "Не удалось получить ответ");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!unmountedRef.current) setPending(false);
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
          {answer ? renderAssistantContent(answer, () => undefined) : status}
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
