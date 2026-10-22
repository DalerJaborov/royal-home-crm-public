import { FileText } from "lucide-react";
import type { JobApplication } from "../hooks/useVacancies";
import { CANDIDATE_STAGE_LABELS, candidateMissingFacts, candidateTitle } from "../lib/vacanciesResume";
import { VACANCY_PRIORITY_DOT_CLASS, VACANCY_PRIORITY_HINT, VACANCY_PRIORITY_LABEL, VACANCY_PRIORITY_UNKNOWN, vacancyReceivedLabel } from "../lib/vacanciesView";

/** Точка оценки с подписью: цвет не единственный носитель смысла. */
export function VacancyPriority({ item }: { item: Pick<JobApplication, "priority" | "priorityReason"> }) {
  const known = item.priority;
  return <span className="vacancy-priority" title={known ? item.priorityReason || VACANCY_PRIORITY_HINT[known] : VACANCY_PRIORITY_UNKNOWN.hint}>
    <span className={known ? VACANCY_PRIORITY_DOT_CLASS[known] : VACANCY_PRIORITY_UNKNOWN.dotClass} aria-hidden="true" />
    {known ? VACANCY_PRIORITY_LABEL[known] : VACANCY_PRIORITY_UNKNOWN.label}
  </span>;
}

/** Queue selection never changes a candidate's stage or sends a message. */
export function VacancyRow({ item, selected, onSelect, disabled = false, checked, onCheck }: {
  item: JobApplication; selected: boolean; onSelect(): void; disabled?: boolean;
  /** Галочка массового выбора; без onCheck строка без галочки (только просмотр). */
  checked?: boolean; onCheck?(): void;
}) {
  const title = candidateTitle(item);
  const missing = candidateMissingFacts(item);
  const person = [item.age != null ? `${item.age} лет` : null, item.city].filter(Boolean).join(" · ");
  return <li className="vacancy-queue-item" data-checked={checked ? "true" : undefined}>
    {onCheck && <label className="vacancy-queue-check"><input type="checkbox" checked={!!checked} onChange={onCheck} />
      <span className="sr-only">Выбрать: {title}</span></label>}
    <button type="button" className="vacancy-queue-card" aria-current={selected ? "true" : undefined} data-candidate-id={item.id}
      onClick={onSelect} disabled={disabled} aria-label={`Открыть анкету: ${title}`}>
      <span className="vacancy-queue-copy">
        <span className="vacancy-queue-top"><strong>{title}</strong><span className="vacancy-queue-date">{vacancyReceivedLabel(item.createdAt)}</span></span>
        <span className={item.positionTitle ? "vacancy-queue-position" : "vacancy-queue-position none"}>{item.positionTitle || "Без вакансии"}</span>
        <span className="vacancy-queue-meta"><VacancyPriority item={item} />{person && <span>{person}</span>}</span>
        <span className="vacancy-queue-meta"><span className="vacancy-queue-stage">{CANDIDATE_STAGE_LABELS[item.status]}</span>
          {missing.length > 0 && <span className="vacancy-queue-missing">Нужно уточнить: {missing.length}</span>}
          {item.cvFile && <span className="vacancy-queue-file"><FileText size={13} aria-hidden="true" /> Резюме</span>}</span>
      </span>
    </button>
  </li>;
}
