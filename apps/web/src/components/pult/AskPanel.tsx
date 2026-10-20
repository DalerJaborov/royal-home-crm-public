import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { PultArea } from "@royal-home/shared";
import { useAskData } from "../../hooks/useAskData";
import { ApiError } from "../../lib/api";

/**
 * Строка «Спросить» пульта — `.ask-row` артефакта «Единый пульт директора»,
 * разметка дословно:
 *
 *   <div class="ask-row">
 *     <form><input placeholder="Спросить: сколько заработаем до пятницы?"><button class="pill">Спросить</button></form>
 *     <div class="sugg">…кнопки-подсказки…</div>
 *     <div class="ask-status" role="status"></div>
 *     <div class="ask-ans" hidden aria-live="polite"></div>
 *   </div>
 *
 * Вызов и права не менялись — `hooks/useAskData.ts` (тот же
 * `POST /mission-control/ask`). Ответ печатается построчно 40 мс/строку
 * (`.ask-ans p.ln`), под ним чипы-ссылки `.chips` по разделам, упомянутым в
 * ответе; ошибка 502/409 — тихая строка `.ask-status`, без alert и тоста.
 * Один компонент на десктоп и телефон: узкий экран раскладывает строку сам
 * (медиазапросы артефакта ≤640).
 */

const LINE_MS = 40;

/** Режет ответ на строки для построчной печати: по явным переносам, иначе по
 * предложениям — короткий ответ на 1 предложение печатается одной строкой. */
export function answerLines(text: string): string[] {
  const byNewline = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (byNewline.length > 1) return byNewline;
  // Без взгляда назад (?<=…): Safari до 16.4 его не знает. Знак конца
  // предложения забирается в само предложение, пробелы после — разделитель.
  const bySentence = (text.match(/[^.!?]*[.!?]+|[^.!?]+$/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  return bySentence.length > 0 ? bySentence : [text];
}

/** Разделы, упомянутые в тексте ответа — по названию плитки (case-insensitive)
 * либо по ключевым словам-синонимам (тот же приём, что `reportSentences` в
 * `PultHero2026.tsx`, не меняя контракт `PultArea`). */
export function mentionedAreas(text: string, areas: PultArea[]): PultArea[] {
  const low = text.toLowerCase();
  const KEYWORDS: Partial<Record<PultArea["id"], RegExp>> = {
    clients: /клиент/,
    team: /команд|агент/,
    money: /деньги|комисси|план[а-я]* месяца|выручк/,
    properties: /объект|в продаже/,
    calls: /звонк|пропущен/,
    ads: /реклам|инстаграм|instagram/,
    bot: /бот|переписк|диалог/,
    deals: /сделк/,
    system: /систем|ошибк|крон/,
  };
  return areas.filter((a) => low.includes(a.label.toLowerCase()) || (KEYWORDS[a.id]?.test(low) ?? false));
}

/** До трёх подсказок «из контекста дня» — по разделам с тоном ≠ ok (в
 * артефакте в `.sugg` ровно три примера вопросов). */
function contextSuggestions(areas: PultArea[]): { label: string; question: string }[] {
  const worrying = areas.filter((a) => a.tone !== "ok").slice(0, 3);
  return worrying.map((a) => ({ label: a.label, question: `Что там с разделом «${a.label}»?` }));
}

function TypedAnswer({ text }: { text: string }) {
  const lines = useMemo(() => answerLines(text), [text]);
  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  const [shown, setShown] = useState(reducedMotion ? lines.length : 0);

  useEffect(() => {
    setShown(reducedMotion ? lines.length : 0);
    if (reducedMotion) return;
    let cancelled = false;
    let i = 0;
    const tick = () => {
      if (cancelled) return;
      i += 1;
      setShown(i);
      if (i < lines.length) window.setTimeout(tick, LINE_MS);
    };
    const t = window.setTimeout(tick, LINE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, reducedMotion]);

  return (
    <>
      {lines.slice(0, shown).map((line, i) => (
        <p key={i} className="ln">
          {line}
        </p>
      ))}
    </>
  );
}

export function AskPanel({ areas, className }: { areas: PultArea[]; className?: string }) {
  const { question, setQuestion, submit, ask, answer, error, isPending, clear } = useAskData();
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestions = useMemo(() => contextSuggestions(areas), [areas]);
  const chips = useMemo(() => (answer ? mentionedAreas(answer, areas) : []), [answer, areas]);

  // 502 (ИИ не ответил) / 409 (модуль выключен) — тихая строка, не alert.
  const quietError =
    error instanceof ApiError && (error.status === 502 || error.status === 409)
      ? error.message
      : error
        ? "Не удалось получить ответ"
        : null;

  const status = isPending ? "Думаю…" : quietError;

  return (
    <div className={`ask-row ${className ?? ""}`.trim()} data-ai-ask-panel>
      <form onSubmit={submit}>
        <input
          ref={inputRef}
          type="text"
          name="q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Спросить: сколько заработаем до пятницы?"
          maxLength={300}
          disabled={isPending}
          aria-label="Вопрос к данным компании"
          autoComplete="off"
        />
        <button className="pill" type="submit" disabled={isPending || !question.trim()}>
          Спросить
        </button>
      </form>

      {!answer && suggestions.length > 0 && (
        <div className="sugg" role="group" aria-label="Примеры вопросов">
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              data-q={s.question}
              onClick={() => {
                setQuestion(s.question);
                ask(s.question);
              }}
            >
              {s.question}
            </button>
          ))}
        </div>
      )}

      <div className={`ask-status${status ? " on" : ""}`} role="status" style={{ flexBasis: "100%" }}>
        {status ?? ""}
      </div>

      {answer && (
        <div className="ask-ans" aria-live="polite">
          <TypedAnswer text={answer} />
          <div className="chips">
            {chips.map((a) => (
              <Link key={a.id} to={a.href}>
                Открыть {a.label} →
              </Link>
            ))}
            <button type="button" onClick={clear}>
              Спросить ещё
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
