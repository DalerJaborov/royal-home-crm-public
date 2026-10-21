import { ChevronRight, FileText } from "lucide-react";
import type { JobApplication } from "../hooks/useVacancies";
import { initials } from "../lib/theme2026Person";
import { CANDIDATE_STAGE_LABELS, candidateMissingFacts, candidateTitle } from "../lib/vacanciesResume";
import { vacancyReceivedLabel } from "../lib/vacanciesView";

/** Queue selection never changes a candidate's stage or sends a message. */
export function VacancyRow({ item, selected, onSelect, disabled = false }: {
  item: JobApplication; selected: boolean; onSelect(): void; disabled?: boolean;
}) {
  const title = candidateTitle(item);
  const missing = candidateMissingFacts(item);
  return <li className="vacancy-queue-item">
    <button type="button" className="vacancy-queue-card" aria-current={selected ? "true" : undefined}
      onClick={onSelect} disabled={disabled} aria-label={`Открыть анкету: ${title}`}>
      <span className="vacancy-avatar" aria-hidden="true">{initials(title)}</span>
      <span className="vacancy-queue-copy"><strong>{title}</strong>
        <span>{item.positionTitle || "Должность не указана"}</span>
        <span className="vacancy-queue-meta">{CANDIDATE_STAGE_LABELS[item.status]}</span>
        <span className="vacancy-queue-meta">{vacancyReceivedLabel(item.createdAt)}</span>
        {missing.length > 0 && <span className="vacancy-queue-missing">Нужно уточнить: {missing.length}</span>}
        {item.cvFile && <span className="vacancy-queue-file"><FileText size={12} aria-hidden="true" /> Есть резюме</span>}
      </span><ChevronRight size={16} aria-hidden="true" />
    </button>
  </li>;
}
