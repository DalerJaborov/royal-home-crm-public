import { Link } from "react-router-dom";
import type { JobApplication } from "../../types/vacancies";
import { Chip, Row } from "../rh2";
import { ClientAvatar } from "../ClientAvatar";
import { cn } from "./ui";
import { CANDIDATE_STAGE_CHIP, candidateMissingFacts, candidateTitle } from "../../lib/vacanciesResume";
import { VACANCY_PRIORITY_DOT_CLASS, VACANCY_PRIORITY_HINT, VACANCY_PRIORITY_LABEL, VACANCY_PRIORITY_UNKNOWN, vacancyReceivedLabel } from "../../lib/vacanciesView";

/** Колонки строки кандидата — та же сетка у шапки списка и у каждой строки. */
export const cleanCandidateColumns = "lg:grid-cols-[44px_minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,.9fr)_minmax(0,.8fr)]";

/** Тон чипа оценки: тот же светофор, что у точки (VACANCY_PRIORITY_DOT_CLASS). */
export const CANDIDATE_PRIORITY_TONE = { GREEN: "ok", YELLOW: "warn", RED: "crit" } as const;

/** «Вакансия · 24 года · Душанбе» — вторая строка кандидата в списке. */
export function candidateIdentityLine(item: JobApplication): string {
  return [item.positionTitle || "Без вакансии", item.age != null ? `${item.age} лет` : null, item.city].filter(Boolean).join(" · ");
}

/** Точка оценки с подписью: цвет не единственный носитель смысла. */
export function VacancyPriority({ item }: { item: Pick<JobApplication, "priority" | "priorityReason"> }) {
  const known = item.priority;
  return <span className="inline-flex items-center gap-2 text-[14px] text-ink" title={known ? item.priorityReason || VACANCY_PRIORITY_HINT[known] : VACANCY_PRIORITY_UNKNOWN.hint}>
    <span className={known ? VACANCY_PRIORITY_DOT_CLASS[known] : VACANCY_PRIORITY_UNKNOWN.dotClass} aria-hidden="true" />
    {known ? VACANCY_PRIORITY_LABEL[known] : VACANCY_PRIORITY_UNKNOWN.label}
  </span>;
}

interface Props {
  item: JobApplication;
  href: string;
  /** Состояние ссылки: путь назад к списку с теми же фильтрами. */
  linkState?: unknown;
  clean: boolean;
  checked: boolean;
  /** Без onCheck строка без галочки (только просмотр). */
  onCheck?(): void;
}

/**
 * Строка кандидата по образцу CleanClientRow: только отображение. Выбор строки
 * ведёт на карточку `/vacancies/:id` и никогда не меняет этап и ничего не
 * отправляет; галочка — для массовых действий экрана.
 */
export function CleanCandidateRow({ item, href, linkState, clean, checked, onCheck }: Props) {
  const title = candidateTitle(item);
  const stage = CANDIDATE_STAGE_CHIP[item.status];
  const missing = candidateMissingFacts(item).length;
  const check = onCheck ? <label className="chk" style={{ minWidth: 44, justifyContent: "center" }}>
    <input type="checkbox" checked={checked} onChange={onCheck} /><span className="sr-only">Выбрать: {title}</span>
  </label> : <span aria-hidden="true" />;
  if (!clean) return <Row data-candidate-row={item.id} title={title} href={href} linkLabel={`Открыть анкету: ${title}`}
    avatar={{ label: title.slice(0, 1).toLocaleUpperCase("ru") }}
    line={<>{candidateIdentityLine(item)}{missing > 0 && <> · Нужно уточнить: {missing}</>}</>}
    chip={<Chip tone={stage.tone}>{stage.label}</Chip>} meta={vacancyReceivedLabel(item.createdAt)}
    actions={onCheck ? check : undefined} />;
  return (
    <div data-candidate-row={item.id} className={cn("clean-candidate-row grid grid-cols-[44px_minmax(0,1fr)] items-start lg:items-center gap-x-3 gap-y-2 rounded-[14px] px-4 py-3 hover:bg-row-alt", cleanCandidateColumns, checked && "bg-row-alt")}>
      {check}
      <Link to={href} state={linkState} aria-label={`Открыть анкету: ${title}`} className="flex min-w-0 items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-blue">
        <span className="shrink-0"><ClientAvatar fullName={title} avatarUrl={null} size={40} /></span>
        <span className="min-w-0">
          <span className="block break-words text-[16px] font-semibold text-ink">{title}</span>
          <span className="mt-1 block break-words text-[14px] text-gray-500">{candidateIdentityLine(item)}</span>
          {missing > 0 && <span className="mt-1 block text-[13px] text-gray-500">Нужно уточнить: {missing}</span>}
          {/* Телефон: оценка, этап и дата одной строкой под именем, без колонок. */}
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 lg:hidden"><VacancyPriority item={item} /><Chip tone={stage.tone}>{stage.label}</Chip><span className="text-[13px] text-gray-500">{vacancyReceivedLabel(item.createdAt)}</span></span>
        </span>
      </Link>
      <div className="hidden min-w-0 lg:block"><VacancyPriority item={item} /></div>
      <div className="hidden min-w-0 lg:block"><Chip tone={stage.tone}>{stage.label}</Chip></div>
      <div className="hidden min-w-0 lg:block"><p className="text-[14px] text-gray-500">{vacancyReceivedLabel(item.createdAt)}</p></div>
    </div>
  );
}
