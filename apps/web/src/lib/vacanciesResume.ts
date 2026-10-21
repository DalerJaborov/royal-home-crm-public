import { recruitmentResumeSchema, RECRUITMENT_FACT_LABELS, type RecruitmentFactKey, type RecruitmentPosition } from "@royal-home/shared";
import type { JobApplication, VacancyStage } from "../hooks/useVacancies";

export const CANDIDATE_STAGE_LABELS: Record<JobApplication["status"], string> = {
  NEW: "Новый отклик", REVIEWED: "В работе", INTERVIEW: "Назначено собеседование",
  INTERVIEWED: "Ожидает решения", HIRED: "Принят на работу", REJECTED: "Отказ", NOT_CANDIDATE: "Не кандидат",
};
export type CandidateQueueStage = "ACTIVE" | "ALL" | VacancyStage;
export const CANDIDATE_QUEUE_PAGE_SIZE = 50;
export function candidateQueueOffset(paging: { key: string; offset: number }, filterKey: string): number {
  return paging.key === filterKey ? paging.offset : 0;
}
export function candidateQueuePage(offset: number, shown: number, total?: number) {
  return {
    text: shown > 0 ? `Показаны ${offset + 1}–${offset + shown}${total == null ? "" : ` из ${total}`}` : total == null ? "На этой странице нет анкет" : `Показано 0 из ${total}`,
    hasPrevious: offset > 0,
    hasNext: shown === CANDIDATE_QUEUE_PAGE_SIZE && (total == null || offset + shown < total),
  };
}
export const CANDIDATE_QUEUE_STAGES: Array<{ value: CandidateQueueStage; label: string }> = [
  { value: "ACTIVE", label: "Все активные" }, { value: "NEW", label: "Новые отклики" },
  { value: "REVIEWED", label: "В работе" }, { value: "INTERVIEW", label: "Собеседования" },
  { value: "INTERVIEWED", label: "Ожидают решения" }, { value: "HIRED", label: "Приняты на работу" },
  { value: "REJECTED", label: "Отказ" }, { value: "ALL", label: "Все кандидаты" },
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
