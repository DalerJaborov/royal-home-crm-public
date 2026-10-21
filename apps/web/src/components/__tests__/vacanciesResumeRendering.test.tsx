import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobApplication } from "../../hooks/useVacancies";
import type { RecruitmentContactOptions, RecruitmentPosition } from "@royal-home/shared";

const state = vi.hoisted(() => ({ readOnly: false, contact: undefined as RecruitmentContactOptions | undefined,
  conversation: { data: { files: [], messages: [] }, isLoading: false, isError: false, refetch: vi.fn() } }));
vi.mock("../../hooks/useVacancies", () => ({
  useVacancyConversation: () => state.conversation,
  useSetVacancyStatus: () => ({ isPending: false, isError: false, reset: vi.fn(), mutate: vi.fn() }),
  useInviteCallRecordingUrl: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("../../hooks/useVacancyContact", () => ({ useVacancyContactOptions: () => ({ data: state.contact, isPending: !state.contact, isError: false, refetch: vi.fn() }) }));
vi.mock("../../lib/permissions", () => ({ useIsReadOnly: () => state.readOnly }));
vi.mock("../CallClientButton", () => ({ CallClientButton: ({ phone, label }: { phone: string | null; label: string }) => <button disabled={!phone}>{label}</button> }));
vi.mock("../MessageAttachments", () => ({ MessageAttachments: () => null }));
vi.mock("../VoiceNotePlayer", () => ({ VoiceNotePlayer: () => null }));
vi.mock("../VoiceNoteButton", () => ({ VoiceNoteButton: () => null }));
vi.mock("../ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../VacancyContactForm", async importOriginal => {
  const actual = await importOriginal<typeof import("../VacancyContactForm")>();
  return { ...actual, VacancyContactForm: () => null };
});
vi.mock("../rh2/Rh2Sheet", () => ({ Rh2Sheet: () => null }));
import { VacancyDetails } from "../VacancyDetails";
import { VacancyRow } from "../VacancyRow";
import { VacancyStageActions } from "../VacancyStageActions";

const candidate = (patch: Partial<JobApplication> = {}) => ({
  id: "candidate-test", status: "NEW", name: "Тестовая кандидатка", contactName: null,
  phone: null, age: null, city: null, education: null, experience: null, rawText: null,
  languages: null, startWhen: null, employedNow: null, studyingNow: null, studyingUniversity: null,
  priority: null, eligible: null, cvFile: null, channel: "INSTAGRAM", createdAt: "2026-10-21T10:00:00Z",
  interviewAt: null, interviewNote: null, rejectionReason: null, talentPool: false,
  positionTitle: "SMM-специалист / видеограф", ...patch,
} as JobApplication);
const options = (): RecruitmentContactOptions => ({ sms: { available: true }, assistantCall: { available: true },
  clarification: { available: true }, office: { address: "Тестовый адрес", mapUrl: null, preparation: null }, language: "ru", recentDeliveries: [] });

beforeEach(() => { state.readOnly = false; state.contact = undefined; });

describe("résumé content and action safety", () => {
  it("sparse candidate résumé explicitly leaves skills/tools/experience unknown", () => {
    const html = renderToStaticMarkup(<VacancyDetails item={candidate()} />);
    expect(html).toContain("Навыки"); expect(html).toContain("Инструменты");
    expect(html.match(/Не указано/g)?.length).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain("Premiere Pro"); expect(html).not.toContain("2024 — сейчас");
    expect(html).toContain("Неуказанные сведения не означают отказ");
    expect(html).not.toContain("/messages?open=");
  });
  it("sourced skills render their original quote and do not derive extra skills", () => {
    const html = renderToStaticMarkup(<VacancyDetails item={candidate({ recruitmentResume: { version: 1, facts: {
      skills: { value: "Монтаж видео", sourceEventKey: "a".repeat(64), quote: "Я монтирую короткие видео" },
    } } })} />);
    expect(html).toContain("Монтаж видео"); expect(html).toContain("Я монтирую короткие видео");
    expect(html).not.toContain("Цветокоррекция");
  });
  it("unrelated unknown study/employment fields do not clutter an SMM résumé", () => {
    const html = renderToStaticMarkup(<VacancyDetails item={candidate({ recruitmentAssessment: { missing: ["startWhen"], warnings: [], readyForReview: false } })} />);
    expect(html).not.toContain("Сейчас работает"); expect(html).not.toContain("Сейчас учится");
  });
  it("required missing readiness fields are explicit, known false answers remain visible", () => {
    const required = renderToStaticMarkup(<VacancyDetails item={candidate({ recruitmentAssessment: { missing: ["employedNow", "studyingNow"], warnings: [], readyForReview: false } })} />);
    expect(required).toContain("Сейчас работает"); expect(required).toContain("Сейчас учится");
    expect(required.match(/Нужно уточнить/g)?.length).toBeGreaterThanOrEqual(3);
    const known = renderToStaticMarkup(<VacancyDetails item={candidate({ employedNow: false, studyingNow: false })} />);
    expect(known).toContain("Сейчас работает"); expect(known).toContain("Сейчас учится");
  });
  it("queue selection is one named button with a visible HR stage", () => {
    const html = renderToStaticMarkup(<VacancyRow item={candidate({ status: "REJECTED" })} selected onSelect={() => undefined} />);
    expect(html).toContain('aria-current="true"'); expect(html).toContain("Открыть анкету:");
    expect(html).toContain("Отказ"); expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("Пригласить");
  });
  it("contact action stays disabled until capabilities have loaded", () => {
    const html = renderToStaticMarkup(<VacancyStageActions item={candidate()} />);
    expect(html).toContain("Проверяем способы связи");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Пригласить на собеседование/);
  });
  it("read-only viewers get no stage/contact mutation controls or phone editor", () => {
    state.readOnly = true;
    const actions = renderToStaticMarkup(<VacancyStageActions item={candidate()} />);
    const résumé = renderToStaticMarkup(<VacancyDetails item={candidate()} />);
    expect(actions).toContain("Доступ только для просмотра");
    expect(actions).not.toContain("<button");
    expect(résumé).not.toContain(">Добавить</button>");
  });
  it("UNKNOWN delivery blocks a new invitation instead of promising a resend", () => {
    state.contact = { ...options(), recentDeliveries: [{ id: "outcome", channel: "SMS", status: "UNKNOWN" }] };
    const html = renderToStaticMarkup(<VacancyStageActions item={candidate()} />);
    expect(html).toContain("результат не подтверждён");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Пригласить на собеседование/);
  });
  it("completed HR decisions offer an undo without another invite button", () => {
    state.contact = options();
    const html = renderToStaticMarkup(<VacancyStageActions item={candidate({ status: "REJECTED" })} />);
    expect(html).toContain("Отменить отказ"); expect(html).not.toContain(">Пригласить на собеседование</button>");
  });
  it("assistant findings show the conversation result for human verification", () => {
    state.contact = { ...options(), recentDeliveries: [{ id: "call", channel: "ASSISTANT_CALL", status: "COMPLETED", result: {
      purpose: "CLARIFY", summary: "Готов начать со следующей недели", transcript: ["Кандидат: могу выйти в понедельник"], candidateSpoke: true,
    } }] };
    const html = renderToStaticMarkup(<VacancyStageActions item={candidate()} />);
    expect(html).toContain("Что собрал ассистент"); expect(html).toContain("Готов начать со следующей недели");
    expect(html).toContain("не подтверждённые руководителем факты");
    expect(html).toContain("Кандидат: могу выйти в понедельник");
    expect(html).not.toContain("Кандидат подтвердил участие");
  });
  it("a call without candidate speech is not presented as collected answers", () => {
    state.contact = { ...options(), recentDeliveries: [{ id: "call", channel: "ASSISTANT_CALL", status: "COMPLETED", result: {
      purpose: "CLARIFY", summary: "Абонент не ответил", transcript: [], candidateSpoke: false,
    } }] };
    const html = renderToStaticMarkup(<VacancyStageActions item={candidate()} />);
    expect(html).toContain("Ответов кандидата нет."); expect(html).toContain("Абонент не ответил");
  });
  it("legacy applications show an unselected explicit vacancy picker; core applications cannot reassign", () => {
    state.contact = options();
    const positions = [{ key: "smm", titleRu: "SMM-специалист", isOpen: true }] as RecruitmentPosition[];
    const legacy = renderToStaticMarkup(<VacancyStageActions item={candidate({ customerInquiryId: null, positionKey: null })} positions={positions} />);
    expect(legacy).toContain("Укажите вакансию"); expect(legacy).toContain("Сохранить вакансию");
    expect(legacy).toMatch(/<option value="" selected="">Выберите вакансию/);
    expect(legacy).toMatch(/<button[^>]*disabled=""[^>]*>Сохранить вакансию/);
    expect(legacy).toContain("SMM-специалист");
    const core = renderToStaticMarkup(<VacancyStageActions item={candidate({ customerInquiryId: "core-inquiry", positionKey: "smm" })} positions={positions} />);
    expect(core).not.toContain("Сохранить вакансию"); expect(core).not.toContain("Изменить вакансию");
  });
  it("an assigned legacy vacancy stays a summary with editing under additional actions", () => {
    const positions = [{ key: "smm", titleRu: "SMM-специалист", isOpen: true }] as RecruitmentPosition[];
    const html = renderToStaticMarkup(<VacancyStageActions item={candidate({ customerInquiryId: null, positionKey: "smm" })} positions={positions} />);
    expect(html).not.toContain("Укажите вакансию");
    expect(html.indexOf("Изменить вакансию")).toBeGreaterThan(html.indexOf("Другие действия"));
  });
});
