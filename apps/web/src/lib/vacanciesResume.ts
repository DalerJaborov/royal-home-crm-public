import { recruitmentResumeSchema, RECRUITMENT_FACT_LABELS, type RecruitmentFactKey, type RecruitmentPosition } from "@royal-home/shared";
import type { JobApplication, VacancyStage } from "../types/vacancies";

export const CANDIDATE_STAGE_LABELS: Record<JobApplication["status"], string> = {
  NEW: "Новый отклик", REVIEWED: "В работе", INTERVIEW: "Назначено собеседование",
  INTERVIEWED: "Ожидает решения", HIRED: "Принят на работу", REJECTED: "Отказ", NOT_CANDIDATE: "Не кандидат",
};
/** Короткий чип этапа для строки и шапки карточки: слово + тон словаря `Chip`
 *  (components/rh2/Chip.tsx). Полное название этапа — CANDIDATE_STAGE_LABELS. */
export const CANDIDATE_STAGE_CHIP: Record<JobApplication["status"], { label: string; tone: "neutral" | "ok" | "warn" | "crit" | "aqua" | "lav" }> = {
  NEW: { label: "Новый отклик", tone: "warn" }, REVIEWED: { label: "В работе", tone: "neutral" },
  INTERVIEW: { label: "Собеседование", tone: "lav" }, INTERVIEWED: { label: "Ждёт решения", tone: "aqua" },
  HIRED: { label: "Принят", tone: "ok" }, REJECTED: { label: "Отказ", tone: "crit" }, NOT_CANDIDATE: { label: "Не кандидат", tone: "neutral" },
};
export type CandidateQueueStage = "ACTIVE" | "ALL" | VacancyStage;
export const CANDIDATE_QUEUE_PAGE_SIZE = 50;
export const CANDIDATE_QUEUE_STAGES: Array<{ value: CandidateQueueStage; label: string }> = [
  { value: "ACTIVE", label: "Активные" }, { value: "NEW", label: "Новые" },
  { value: "REVIEWED", label: "В работе" }, { value: "INTERVIEW", label: "Собеседования" },
  { value: "INTERVIEWED", label: "Ждут решения" }, { value: "HIRED", label: "Приняты" },
  { value: "REJECTED", label: "Отказ" }, { value: "ALL", label: "Все" },
];
export function candidateStageFilters(stage: CandidateQueueStage) {
  return { activeOnly: stage === "ACTIVE", status: stage === "ACTIVE" || stage === "ALL" ? undefined : stage };
}
export function candidateTitle(item: JobApplication): string {
  return item.name?.trim() || item.contactName?.trim() || "Кандидат без имени";
}
/** No inferred skills or invented employment periods: only sourced facts. */
export function candidateResumeFacts(item: JobApplication) {
  const parsed = recruitmentResumeSchema.safeParse(item.recruitmentResume);
  return parsed.success ? parsed.data.facts : {};
}
export function candidateMissingFacts(item: JobApplication): RecruitmentFactKey[] {
  if (item.recruitmentAssessment) return item.recruitmentAssessment.missing;
  const facts = candidateResumeFacts(item);
  const missing: RecruitmentFactKey[] = [];
  if (!item.name && !item.contactName && !facts.name) missing.push("name");
  if (!item.phone) missing.push("phone");
  if (!facts.about && !item.experience && !item.rawText && !item.cvFile && !item.customerPortfolio?.length) missing.push("about");
  return missing;
}
export function candidateMissingText(item: JobApplication): string {
  return candidateMissingFacts(item).map(key => RECRUITMENT_FACT_LABELS[key].toLocaleLowerCase("ru")).join(", ");
}
export function candidateStudyState(item: JobApplication): boolean | null {
  const facts = candidateResumeFacts(item);
  if (facts.studyingNow) return facts.studyingNow.value;
  if (item.studyingNow === true || item.studyingUniversity === true) return true;
  return item.studyingNow == null && item.studyingUniversity == null ? null : false;
}
export function selectedCandidate(items: JobApplication[], selectedId: string | null) {
  return items.find(item => item.id === selectedId) ?? items[0] ?? null;
}
export function legacyCandidatePositionPatch(item: JobApplication, positionKey: string, positions: Pick<RecruitmentPosition, "key">[]) {
  if (item.customerInquiryId || !positionKey || positionKey === item.positionKey || !positions.some(position => position.key === positionKey)) return null;
  return { id: item.id, positionKey };
}
export function candidateQueueCount(counts: Partial<Record<VacancyStage, number>> | undefined, stage: CandidateQueueStage) {
  if (!counts) return undefined;
  if (stage !== "ACTIVE" && stage !== "ALL") return counts[stage] ?? 0;
  return Object.entries(counts).reduce((sum, [key, count]) =>
    stage === "ACTIVE" && (key === "HIRED" || key === "REJECTED") ? sum : sum + (count ?? 0), 0);
}
