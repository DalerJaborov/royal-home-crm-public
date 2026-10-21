import { describe, expect, it } from "vitest";
import type { JobApplication } from "../../hooks/useVacancies";
import { candidateMissingFacts, candidateMissingText, candidateQueueCount, candidateResumeFacts, candidateStageFilters, candidateStudyState, candidateTitle, selectedCandidate, legacyCandidatePositionPatch, candidateQueueOffset, candidateQueuePage, CANDIDATE_QUEUE_PAGE_SIZE } from "../vacanciesResume";
import { RECRUITMENT_DELIVERY_LABEL, recruitmentSendLabel } from "../vacanciesContact";
import { vacancyFiltersQuery } from "../vacancyFilters";

function application(patch: Partial<JobApplication> = {}): JobApplication {
  return { id: "candidate-a", name: null, contactName: null, phone: null, rawText: null, experience: null, cvFile: null, status: "NEW", ...patch } as JobApplication;
}
const source = { sourceEventKey: "a".repeat(64), quote: "Снимаю и монтирую ролики" };

describe("candidate résumé truth and queue selection", () => {
  it("keeps unknown facts missing, never manufactures skills or a timeline", () => {
    const item = application({ rawText: "Я заинтересован в работе" });
    expect(candidateResumeFacts(item)).toEqual({});
    expect(candidateMissingFacts(item)).toEqual(["name", "phone"]);
    expect(candidateTitle(item)).toBe("Кандидат без имени");
  });
  it("uses only structurally valid sourced facts", () => {
    const item = application({ recruitmentResume: { version: 1, facts: { skills: { value: "Монтаж", ...source } } } });
    expect(candidateResumeFacts(item).skills?.value).toBe("Монтаж");
    const invalid = { version: 1, facts: { skills: { value: "Неподтверждённый навык" } } };
    expect(candidateResumeFacts(application({ recruitmentResume: invalid as JobApplication["recruitmentResume"] }))).toEqual({});
  });
  it("respects the server's per-position assessment instead of legacy eligibility", () => {
    const item = application({ eligible: false, recruitmentAssessment: { missing: ["startWhen"], warnings: [], readyForReview: false } });
    expect(candidateMissingFacts(item)).toEqual(["startWhen"]);
    expect(candidateMissingText(item)).toBe("когда готов начать");
  });
  it("does not resurrect a cleared phone from an old résumé snapshot", () => {
    const item = application({ recruitmentResume: { version: 1, facts: { phone: { value: "test-contact", ...source } } } });
    expect(candidateMissingFacts(item)).toContain("phone");
  });
  it("legacy university attendance cannot be hidden by a false general-study flag", () => {
    expect(candidateStudyState(application({ studyingNow: false, studyingUniversity: true }))).toBe(true);
    expect(candidateStudyState(application({ studyingNow: null, studyingUniversity: null }))).toBeNull();
  });
  it("drops the previous selection when its candidate is absent from the new result", () => {
    expect(selectedCandidate([], "candidate-a")).toBeNull();
    const next = application({ id: "candidate-b" });
    expect(selectedCandidate([next], "candidate-a")).toBe(next);
  });
  it("sends active/stage filters to the server instead of filtering a truncated page", () => {
    expect(candidateStageFilters("ACTIVE")).toEqual({ activeOnly: true, status: undefined });
    expect(candidateStageFilters("ALL")).toEqual({ activeOnly: false, status: undefined });
    expect(candidateStageFilters("REJECTED")).toEqual({ activeOnly: false, status: "REJECTED" });
  });
  it("counts HR stages separately from legacy eligibility buckets", () => {
    const counts = { NEW: 5, REVIEWED: 3, INTERVIEW: 2, INTERVIEWED: 1, HIRED: 4, REJECTED: 7 };
    expect(candidateQueueCount(counts, "ACTIVE")).toBe(11);
    expect(candidateQueueCount(counts, "ALL")).toBe(22);
    expect(candidateQueueCount(undefined, "ACTIVE")).toBeUndefined();
  });
  it("legacy position assignment requires an explicit existing key and never changes core inquiry ownership", () => {
    const legacy = application();
    expect(legacyCandidatePositionPatch(legacy, "", [{ key: "smm" }])).toBeNull();
    expect(legacyCandidatePositionPatch(legacy, "unknown", [{ key: "smm" }])).toBeNull();
    expect(legacyCandidatePositionPatch(legacy, "smm", [{ key: "smm" }])).toEqual({ id: legacy.id, positionKey: "smm" });
    expect(legacyCandidatePositionPatch(application({ customerInquiryId: "core-inquiry" }), "smm", [{ key: "smm" }])).toBeNull();
    expect(legacyCandidatePositionPatch(application({ positionKey: "smm" }), "smm", [{ key: "smm" }])).toBeNull();
  });
});

describe("contact outcome language", () => {
  it("does not label provider acceptance, unknown delivery or dry run as delivery", () => {
    expect(RECRUITMENT_DELIVERY_LABEL.ACCEPTED).toBe("Принято оператором");
    expect(RECRUITMENT_DELIVERY_LABEL.UNKNOWN).toBe("Результат не подтверждён");
    expect(RECRUITMENT_DELIVERY_LABEL.DRY_RUN).toContain("не отправлено");
    expect(RECRUITMENT_DELIVERY_LABEL.DELIVERED).toBe("Доставлено");
  });
  it("the final CTA names every selected external action", () => {
    expect(recruitmentSendLabel(["SMS"])).toBe("Отправить SMS");
    expect(recruitmentSendLabel(["ASSISTANT_CALL"])).toBe("Поручить звонок ассистенту");
    expect(recruitmentSendLabel(["SMS", "ASSISTANT_CALL"])).toContain("SMS и поручить звонок");
  });
});

describe("candidate queue pagination beyond 200", () => {
  it("serializes offset with filters so later pages get their own query identity", () => {
    const query = vacancyFiltersQuery({ offset: 200, limit: 50, activeOnly: true, includeFiltered: true, includeNoPhone: true, positionKey: "smm", q: "  тест  " });
    const params = new URLSearchParams(query);
    expect(params.get("offset")).toBe("200"); expect(params.get("limit")).toBe("50");
    expect(params.get("q")).toBe("тест"); expect(params.get("positionKey")).toBe("smm");
    expect(params.get("includeNoPhone")).toBe("true"); expect(params.get("includeFiltered")).toBe("true");
    expect(vacancyFiltersQuery({ offset: 0, limit: 50 })).not.toBe(query);
  });
  it("starts new stage, vacancy or search filters at the first page", () => {
    const state = { key: "ACTIVE|smm|", offset: 200 };
    expect(candidateQueueOffset(state, "ACTIVE|smm|")).toBe(200);
    expect(candidateQueueOffset(state, "NEW|smm|")).toBe(0);
    expect(candidateQueueOffset(state, "ACTIVE|agent|")).toBe(0);
    expect(candidateQueueOffset(state, "ACTIVE|smm|test")).toBe(0);
  });
  it("keeps the 201st through 250th candidate reachable without increasing limit", () => {
    expect(CANDIDATE_QUEUE_PAGE_SIZE).toBe(50);
    expect(candidateQueuePage(0, 50, 250)).toEqual({ text: "Показаны 1–50 из 250", hasPrevious: false, hasNext: true });
    expect(candidateQueuePage(50, 50, 250)).toEqual({ text: "Показаны 51–100 из 250", hasPrevious: true, hasNext: true });
    expect(candidateQueuePage(150, 50, 250).hasNext).toBe(true);
    expect(candidateQueuePage(200, 50, 250)).toEqual({ text: "Показаны 201–250 из 250", hasPrevious: true, hasNext: false });
  });
  it("handles a partial last page, missing old-server totals, and a shrinking queue", () => {
    expect(candidateQueuePage(250, 13, 263)).toEqual({ text: "Показаны 251–263 из 263", hasPrevious: true, hasNext: false });
    expect(candidateQueuePage(50, 50)).toEqual({ text: "Показаны 51–100", hasPrevious: true, hasNext: true });
    expect(candidateQueuePage(200, 0, 180)).toEqual({ text: "Показано 0 из 180", hasPrevious: true, hasNext: false });
  });
});
