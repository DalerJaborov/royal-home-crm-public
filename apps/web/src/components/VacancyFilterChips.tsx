import type { RecruitmentPosition } from "@royal-home/shared";
import type { VacanciesResponse, VacancyPriorityFilter } from "../types/vacancies";
import { CANDIDATE_QUEUE_STAGES, candidateQueueCount, type CandidateQueueStage } from "../lib/vacanciesResume";
import { positionChips, VACANCY_PRIORITY_CHIPS } from "../lib/vacancyQueue";

function Chip({ pressed, onClick, label, count, dotClass, title }: {
  pressed: boolean; onClick(): void; label: string; count?: number; dotClass?: string; title?: string;
}) {
  return <button type="button" className="vacancy-chip" aria-pressed={pressed} onClick={onClick} title={title}>
    {dotClass && <span className={dotClass} aria-hidden="true" />}<span>{label}</span>{count != null && <span className="vacancy-chip-count">{count}</span>}
  </button>;
}

/** Полоса этапов — вместо выпадающего списка: числа видны до нажатия. */
export function VacancyStageChips({ stage, counts, onChange }: {
  stage: CandidateQueueStage; counts: VacanciesResponse["counts"] | undefined; onChange(stage: CandidateQueueStage): void;
}) {
  return <div className="vacancy-chip-row vacancy-stage-row" role="group" aria-label="Этап подбора">
    {CANDIDATE_QUEUE_STAGES.map(option => <Chip key={option.value} pressed={stage === option.value} onClick={() => onChange(option.value)}
      label={option.label} count={candidateQueueCount(counts, option.value)} />)}
  </div>;
}

/** Вакансия и оценка — чипами со счётчиками сервера. */
export function VacancyFacetChips({ positions, positionCounts, positionKey, onPosition, priority, priorityCounts, onPriority }: {
  positions: RecruitmentPosition[] | undefined; positionCounts: Record<string, number> | undefined;
  positionKey: string; onPosition(key: string): void;
  priority: VacancyPriorityFilter | ""; priorityCounts: VacanciesResponse["priorityCounts"]; onPriority(value: VacancyPriorityFilter | ""): void;
}) {
  return <>
    <div className="vacancy-chip-row" role="group" aria-label="Вакансия">
      {positionChips(positions, positionCounts).map(chip => <Chip key={chip.key || "all"} pressed={positionKey === chip.key} onClick={() => onPosition(chip.key)}
        label={chip.closed ? `${chip.label} · закрыт` : chip.label} count={chip.count} />)}
    </div>
    <div className="vacancy-chip-row" role="group" aria-label="Оценка кандидата">
      {VACANCY_PRIORITY_CHIPS.map(chip => <Chip key={chip.value} pressed={priority === chip.value} dotClass={chip.dotClass}
        onClick={() => onPriority(priority === chip.value ? "" : chip.value)} label={chip.label} count={priorityCounts?.[chip.value]} />)}
    </div>
  </>;
}
