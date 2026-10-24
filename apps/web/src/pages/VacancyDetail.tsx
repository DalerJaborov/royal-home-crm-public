import { useCallback, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { usableRouteId } from "../lib/routeId";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileText, MessageCircle, Paperclip, Phone, Printer, UserRound } from "lucide-react";
import type { RecruitmentPosition } from "@royal-home/shared";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { api } from "../lib/api";
import { ApiError } from "../lib/apiError";
import { useAuthStore } from "../store/auth";
import { useVacancy, type JobApplication } from "../hooks/useVacancies";
import { useCleanShell } from "../hooks/useCleanShell";
import { useMobileUx } from "../hooks/useMobileUx";
import { Chip, PageHeader, Rh2EmptyState, Rh2Screen, Tabs } from "../components/rh2";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";
import { ClientAvatar } from "../components/ClientAvatar";
import { CleanClientDetailHeader, CleanClientDetailSkeleton, CleanRecordTabs, cleanClientDetailScale, type CleanRecordTab } from "../components/clean/CleanClientDetailLayout";
import { CANDIDATE_PRIORITY_TONE } from "../components/clean/CleanCandidateRow";
import { VacancyContactHistory, VacancyConversation, VacancyDetails, VacancyOriginals } from "../components/VacancyDetails";
import { VacancyStageActions } from "../components/VacancyStageActions";
import { VacancyDeleteDialog } from "../components/VacancyDeleteDialog";
import { VacancyPrint } from "../components/VacancyPrint";
import { CANDIDATE_STAGE_CHIP, candidateTitle } from "../lib/vacanciesResume";
import { VACANCY_PRIORITY_LABEL, VACANCY_PRIORITY_UNKNOWN, vacancyReceivedLabel } from "../lib/vacanciesView";
import { canDeleteCandidates } from "../lib/vacancyQueue";
// Карточка кандидата собрана из деталей карточки клиента — те же правила вкладок и шапки.
import "../theme-client-workspace.css";
import "../theme-2026-vacancies.css";

type Panel = "resume" | "chat" | "contact" | "files";
const PANELS: ReadonlyArray<CleanRecordTab<Panel>> = [
  { id: "resume", label: "Анкета", icon: UserRound },
  { id: "chat", label: "Переписка", short: "Чат", icon: MessageCircle },
  { id: "contact", label: "Связь", icon: Phone },
  { id: "files", label: "Материалы", icon: Paperclip },
];

/** Путь назад к списку: тот же срез фильтров, с которого открыли анкету. */
function backPath(state: unknown): string {
  const back = state && typeof state === "object" && "back" in state ? (state as { back?: unknown }).back : null;
  return typeof back === "string" && back.startsWith("/vacancies") ? back : "/vacancies";
}

/**
 * Карточка кандидата `/vacancies/:id` (23.10.2026) — та же разметка, что у
 * карточки клиента в оболочке Clean: шапка CleanClientDetailHeader (аватар 64,
 * имя 26, чипы этапа/вакансии/оценки, строка с телефоном), ряд `.acts`, ниже
 * `.card.clean-client-sections` с вкладками `.clean-record-tabs`.
 */
export function VacancyDetail() {
  const id = usableRouteId(useParams().id);
  const location = useLocation();
  const navigate = useNavigate();
  const back = backPath(location.state);
  const can = useCan(), canView = can("vacancies.view");
  const readOnly = useIsReadOnly();
  const clean = useCleanShell();
  const mobile = useMobileUx();
  const actor = useAuthStore(s => s.agent?.id);
  const role = useAuthStore(s => s.agent?.role);
  const canDelete = canDeleteCandidates(role) && !readOnly;
  const query = useVacancy(canView ? id : undefined);
  const positions = useQuery({ queryKey: ["recruitment-positions", actor], enabled: canView,
    queryFn: () => api<{ items: RecruitmentPosition[] }>("/vacancies/positions", { expectAgentId: actor }) });
  const [panel, setPanel] = useState<Panel>("resume");
  const [printItems, setPrintItems] = useState<JobApplication[]>([]);
  const [deleting, setDeleting] = useState(false);
  const finishPrint = useCallback(() => setPrintItems([]), []);
  const backLink = <div className="wrap" style={{ marginBottom: 4 }}>
    <Link className="lk mut" to={back} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><ArrowLeft className="i" />Кандидаты</Link>
  </div>;

  if (!canView) return <Rh2Screen title="Кандидат" back={back}><PageHeader title="Кандидат" sub="Кандидатов разбирает руководство. У вас нет доступа к этому разделу." /></Rh2Screen>;
  if (query.isPending) return clean ? <CleanClientDetailSkeleton /> : <Rh2Screen title="Кандидат" back={back}><p className="quiet" role="status"><span className="dot" /><span className="txt">Загружаем анкету…</span></p></Rh2Screen>;
  if (query.isError || !query.data) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return <Rh2Screen title="Кандидат" back={back}>{backLink}
      {missing ? <Rh2EmptyState icon={FileText} title="Анкета не найдена." hint="Её удалили или скрыли из подбора." />
        : <Rh2ErrorState message="Анкета не загрузилась." onRetry={() => void query.refetch()} />}
    </Rh2Screen>;
  }

  const item = query.data;
  const title = candidateTitle(item);
  const stage = CANDIDATE_STAGE_CHIP[item.status];
  const sub = [item.phone || "Телефон не указан", item.city, `получено ${vacancyReceivedLabel(item.createdAt)}`].filter(Boolean).join(" · ");
  const panelProps = (id: Panel) => ({ role: "tabpanel", id: `vacancy-panel-${id}`, "aria-labelledby": `vacancy-tab-${id}`, tabIndex: 0, hidden: panel !== id }) as const;

  return <Rh2Screen title={title} back={back} className={clean ? "clean-client-detail" : undefined}>
    <div style={clean ? cleanClientDetailScale : undefined} className="grid gap-4">
      {backLink}
      <CleanClientDetailHeader enabled={clean}>
        <div className={mobile ? "cd-h cd-h-m" : "cd-h"} style={clean ? { display: "grid", gridTemplateColumns: "64px minmax(0, 1fr)", gap: 16, alignItems: "start", textAlign: "left" } : undefined}>
          <span className={mobile ? "av lg" : "av xl"} style={clean ? { width: 64, height: 64 } : undefined}>
            <ClientAvatar fullName={title} avatarUrl={null} size={mobile ? 56 : clean ? 64 : 96} />
          </span>
          <div className="who">
            <h1 style={clean ? { fontSize: 26, lineHeight: 1.25, overflowWrap: "anywhere", marginBottom: 8 } : undefined}>{title}</h1>
            <div className="wrap" style={{ marginBottom: 8 }}>
              <Chip tone={stage.tone}>{stage.label}</Chip>
              <span className="chip mute">{item.positionTitle || "Без вакансии"}</span>
              <Chip tone={item.priority ? CANDIDATE_PRIORITY_TONE[item.priority] : "neutral"} title={item.priorityReason || undefined}>
                {item.priority ? VACANCY_PRIORITY_LABEL[item.priority] : VACANCY_PRIORITY_UNKNOWN.label}
              </Chip>
            </div>
            <p className="sub" style={clean ? { fontSize: 14, lineHeight: 1.6, margin: 0 } : undefined}>{sub}</p>
          </div>
          <VacancyStageActions item={item} positions={positions.data?.items} positionsLoading={positions.isPending} positionsError={positions.isError}
            onPositionsRetry={() => void positions.refetch()} onDelete={canDelete ? () => setDeleting(true) : undefined}>
            <button type="button" className="pill ghost" onClick={() => setPrintItems([item])}><Printer className="i" aria-hidden="true" />Распечатать</button>
          </VacancyStageActions>
        </div>
      </CleanClientDetailHeader>

      <div className={clean ? "card clean-client-sections" : "card"} style={clean ? { border: 0, padding: 24 } : undefined}>
        {clean ? <CleanRecordTabs tabs={PANELS} value={panel} onChange={setPanel} ariaLabel="Разделы анкеты кандидата" idPrefix="vacancy" />
          : <Tabs aria-label="Разделы анкеты кандидата" idPrefix="vacancy" options={PANELS} value={panel} onChange={setPanel} />}
        <div className="mt-6">
          <div {...panelProps("resume")}>{panel === "resume" && <VacancyDetails item={item} />}</div>
          <div {...panelProps("chat")}>{panel === "chat" && <VacancyConversation item={item} />}</div>
          <div {...panelProps("contact")}>{panel === "contact" && <VacancyContactHistory item={item} />}</div>
          <div {...panelProps("files")}>{panel === "files" && <VacancyOriginals item={item} />}</div>
        </div>
      </div>
    </div>
    {deleting && <VacancyDeleteDialog items={[item]} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); navigate(back, { replace: true }); }} />}
    <VacancyPrint items={printItems} onDone={finishPrint} />
  </Rh2Screen>;
}
