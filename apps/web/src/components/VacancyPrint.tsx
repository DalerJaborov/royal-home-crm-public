import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { JobApplication } from "../types/vacancies";
import { candidateTitle } from "../lib/vacanciesResume";
import { candidatePrintFacts } from "../lib/vacancyQueue";
import { dushanbeDate } from "../lib/date";

/**
 * Лист печати анкет. Рисуется отдельно от экрана, прямо в body: при печати
 * всё остальное скрыто (theme-2026-vacancies.css, @media print), на экране
 * скрыт сам лист. Каждая анкета — своя страница А4.
 */
export function VacancyPrint({ items, onDone }: { items: JobApplication[]; onDone(): void }) {
  useEffect(() => {
    if (!items.length) return;
    const done = () => onDone();
    window.addEventListener("afterprint", done);
    // Кадр на отрисовку листа до вызова печати.
    const frame = requestAnimationFrame(() => window.print());
    return () => { cancelAnimationFrame(frame); window.removeEventListener("afterprint", done); };
  }, [items, onDone]);
  if (!items.length) return null;
  const printed = dushanbeDate(new Date());
  return createPortal(<div className="vacancy-print-root" aria-hidden="true">
    {items.map(item => <article className="vacancy-print-page" key={item.id}>
      <header><p className="vacancy-print-brand">Royal Home · Анкета кандидата</p><h1>{candidateTitle(item)}</h1>
        <p className="vacancy-print-position">{item.positionTitle || "Без вакансии"}</p></header>
      <dl className="vacancy-print-facts">{candidatePrintFacts(item).map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
      {item.rawText && <section><h2>Что написал сам</h2><p className="vacancy-print-text">{item.rawText}</p></section>}
      {(item.interviewNote || item.rejectionReason) && <section><h2>Заметки</h2>
        {item.interviewNote && <p className="vacancy-print-text">{item.interviewNote}</p>}
        {item.rejectionReason && <p className="vacancy-print-text">Причина отказа: {item.rejectionReason}</p>}</section>}
      <footer>Распечатано {printed}</footer>
    </article>)}
  </div>, document.body);
}
