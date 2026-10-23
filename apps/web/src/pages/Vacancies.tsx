import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, SlidersHorizontal, Users } from "lucide-react";
import type { RecruitmentPosition } from "@royal-home/shared";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { useBulkVacancies, useVacancies, useVacancyQueue, type JobApplication, type VacancyPriorityFilter } from "../hooks/useVacancies";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useMarkSectionSeen } from "../hooks/useCounters";
import { useCleanShell } from "../hooks/useCleanShell";
import { useMobileUx } from "../hooks/useMobileUx";
import { Button, Card, Filters, List, PageHeader, Rh2EmptyState, Rh2Screen, Rh2Sheet, Segment, Skeleton, Tabs, type TabOption } from "../components/rh2";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";
import { CButton, CHead, cn } from "../components/clean/ui";
import { CleanCandidateRow, cleanCandidateColumns } from "../components/clean/CleanCandidateRow";
import { Pagination } from "../components/Pagination";
import { RecruitmentPositions } from "../components/RecruitmentPositions";
import { VacancyBulkBar } from "../components/VacancyBulkBar";
import { VacancyDeleteDialog } from "../components/VacancyDeleteDialog";
import { VacancyCreateSheet } from "../components/VacancyCreateSheet";
import { VacancyPrint } from "../components/VacancyPrint";
import { VACANCY_SEARCH_MAX, vacancyTodayInterviews, vacanciesLoadErrorText } from "../lib/vacanciesView";
import { CANDIDATE_QUEUE_STAGES, candidateQueueCount, candidateStageFilters, candidateTitle, type CandidateQueueStage } from "../lib/vacanciesResume";
import { canDeleteCandidates, mergeQueuePages, positionChips, selectedItems, toggleAllLoaded, toggleSelected, VACANCY_PRIORITY_CHIPS, VACANCY_QUEUE_PAGE } from "../lib/vacancyQueue";
import { dushanbeTime } from "../lib/date";
import "../theme-2026-vacancies.css";

const STAGE_IDS = new Set<string>(CANDIDATE_QUEUE_STAGES.map(option => option.value));
const PRIORITY_IDS = new Set<string>(VACANCY_PRIORITY_CHIPS.map(chip => chip.value));
const ruCount = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
};

/**
 * «Подбор сотрудников» (23.10.2026): тот же набор, что у эталонного экрана
 * «Клиенты» в оболочке Clean — шапка, `Card tight` с поиском и «Фильтры · N»
 * (шторка), этапы вкладками `Tabs`, строки `CleanCandidateRow` в `List`,
 * «Показать ещё» общей `Pagination`. Анкета открывается отдельной карточкой
 * `/vacancies/:id`. Фильтры живут в адресе: «← Кандидаты» возвращает тот же срез.
 */
export function Vacancies() {
  useMarkSectionSeen("vacancies");
  const can = useCan(), canView = can("vacancies.view");
  const readOnly = useIsReadOnly();
  const clean = useCleanShell();
  const mobile = useMobileUx();
  const navigate = useNavigate();
  const actor = useAuthStore(s => s.agent?.id);
  const role = useAuthStore(s => s.agent?.role);
  const canDelete = canDeleteCandidates(role) && !readOnly;
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "positions" ? "positions" : "applications";
  const stageParam = params.get("stage") ?? "";
  const stage = (STAGE_IDS.has(stageParam) ? stageParam : "ACTIVE") as CandidateQueueStage;
  const positionKey = params.get("position") ?? "";
  const priorityParam = params.get("priority") ?? "";
  const priority = (PRIORITY_IDS.has(priorityParam) ? priorityParam : "") as VacancyPriorityFilter | "";
  const [search, setSearch] = useState(() => (params.get("q") ?? "").slice(0, VACANCY_SEARCH_MAX));
  const [showFilters, setShowFilters] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [printItems, setPrintItems] = useState<JobApplication[]>([]);
  const [deleteItems, setDeleteItems] = useState<JobApplication[]>([]);
  const [creating, setCreating] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);

  const patchParams = useCallback((patch: Record<string, string | undefined>) => {
    setParams(current => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
    setChecked(new Set());
  }, [setParams]);
  // Поиск в адрес — уже успокоившийся, чтобы история не росла на каждую букву.
  useEffect(() => { if ((params.get("q") ?? "") !== q) patchParams({ q: q || undefined }); }, [q, params, patchParams]);

  const queue = useVacancyQueue(canView && view === "applications", {
    ...candidateStageFilters(stage), positionKey: positionKey || undefined, priority: priority || undefined,
    includeFiltered: true, includeNoPhone: true, q,
  });
  const positionTotals = useVacancies(canView && view === "positions", { includeFiltered: true, includeNoPhone: true, limit: 1 });
  const positions = useQuery({ queryKey: ["recruitment-positions", actor], enabled: canView,
    queryFn: () => api<{ items: RecruitmentPosition[] }>("/vacancies/positions", { expectAgentId: actor }) });
  const bulk = useBulkVacancies();
  const data = queue.data?.pages[0];
  const items = useMemo(() => mergeQueuePages(queue.data?.pages), [queue.data?.pages]);
  const pending = queue.isLoading || search.trim() !== q;
  const todayInterviews = vacancyTodayInterviews(data);
  const chosen = selectedItems(items, checked);
  const activeFilterCount = (positionKey ? 1 : 0) + (priority ? 1 : 0);
  const hasFilters = !!search || activeFilterCount > 0 || stage !== "ACTIVE";
  const allChecked = items.length > 0 && items.every(item => checked.has(item.id));
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = queue;
  const pageCount = queue.data?.pages.length ?? 1;
  const finishPrint = useCallback(() => setPrintItems([]), []);
  const backState = { back: `/vacancies${params.toString() ? `?${params.toString()}` : ""}` };

  function resetFilters() { setSearch(""); patchParams({ q: undefined, position: undefined, priority: undefined, stage: undefined }); }
  function openCandidate(id: string) { navigate(`/vacancies/${encodeURIComponent(id)}`, { state: backState }); }

  if (!canView) return <Rh2Screen title="Подбор сотрудников" className={clean ? "clean-clients-page" : undefined}>
    <PageHeader title="Подбор сотрудников" sub="Кандидатов разбирает руководство. У вас нет доступа к этому разделу." />
  </Rh2Screen>;

  const title = "Подбор сотрудников";
  const sub = view === "positions" ? "Вакансии и условия, которые бот рассказывает кандидатам"
    : data ? `${ruCount(data.total ?? items.length, "кандидат", "кандидата", "кандидатов")} · ${ruCount(data.counts?.NEW ?? 0, "новый", "новых", "новых")}` : "Загружаем кандидатов…";
  const segment = <Segment aria-label="Раздел подбора" value={view} onChange={id => patchParams({ view: id === "positions" ? "positions" : undefined })}
    options={[{ id: "applications", label: "Кандидаты" }, { id: "positions", label: "Вакансии" }]} />;
  const addLabel = <><Plus size={18} aria-hidden />Кандидат</>;
  const add = !readOnly && view === "applications" ? (clean ? <CButton onClick={() => setCreating(true)}>{addLabel}</CButton>
    : <Button icon={<Plus size={18} aria-hidden />} onClick={() => setCreating(true)}>Кандидат</Button>) : null;
  const stageTabs: TabOption<CandidateQueueStage>[] = CANDIDATE_QUEUE_STAGES.map(option => ({ id: option.value, label: option.label, count: candidateQueueCount(data?.counts, option.value) }));
  const positionOptions = positionChips(positions.data?.items, data?.positionCounts)
    .map(chip => ({ id: chip.key || "all", label: chip.closed ? `${chip.label} · закрыт` : chip.label, count: chip.count }));
  const priorityOptions = [{ id: "all", label: "Все", count: undefined as number | undefined },
    ...VACANCY_PRIORITY_CHIPS.map(chip => ({ id: chip.value as string, label: chip.label, count: data?.priorityCounts?.[chip.value] }))];

  return <Rh2Screen title={title} className={clean ? "clean-clients-page" : undefined}>
    {mobile ? <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="sr-only">{title}</h1>{segment}{add}</div>
      : clean ? <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="text-[28px] font-semibold tracking-tight text-ink">{title}</h1><p className="mt-2 text-[16px] text-gray-500">{sub}</p></div>
        <div className="flex flex-wrap items-center gap-3">{segment}{add}</div>
      </div> : <PageHeader title={title} sub={sub} actions={<>{segment}{add}</>} />}

    {view === "positions" ? <RecruitmentPositions clean={clean} candidateCounts={positionTotals.data?.positionCounts}
      onOpenCandidates={key => { setSearch(""); patchParams({ view: undefined, stage: "ALL", position: key, priority: undefined, q: undefined }); }} />
      : <>
      <Tabs aria-label="Этап подбора" options={stageTabs} value={stage} onChange={id => patchParams({ stage: id === "ACTIVE" ? undefined : id })} />

      {todayInterviews.length > 0 && <Card tight aria-label="Собеседования сегодня">
        <CHead title="Собеседования сегодня" count={todayInterviews.length} className="mb-2" />
        <ul className="grid gap-1">{todayInterviews.map(item => <li key={item.id}>
          <Link to={`/vacancies/${encodeURIComponent(item.id)}`} state={backState} className="flex min-h-11 items-center gap-3 rounded-[14px] px-3 hover:bg-row-alt focus-visible:outline-2 focus-visible:outline-blue">
            <span className="w-14 shrink-0 text-[15px] font-semibold tabular-nums text-ink">{item.interviewAt ? dushanbeTime(item.interviewAt) : "—"}</span>
            <span className="min-w-0 break-words text-[15px] text-ink">{candidateTitle(item)}</span>
            <span className="ml-auto hidden text-[14px] text-gray-500 sm:inline">{item.positionTitle || "Без вакансии"}</span>
          </Link></li>)}</ul>
      </Card>}

      <Card tight id="vacancies-list">
        <div className={clean ? "mb-4 flex items-center gap-3" : "filters"}>
          <input className="inp" type="search" aria-label="Поиск по анкетам" placeholder="Имя, телефон, опыт" value={search} maxLength={VACANCY_SEARCH_MAX}
            onChange={event => setSearch(event.target.value)} />
          {clean ? <CButton variant="outline" aria-haspopup="dialog" onClick={() => setShowFilters(true)}><SlidersHorizontal size={18} aria-hidden />Фильтры{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</CButton>
            : <Button variant="ghost" icon={<SlidersHorizontal size={18} aria-hidden />} aria-haspopup="dialog" onClick={() => setShowFilters(true)}>Фильтры{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</Button>}
        </div>

        {hasFilters && <div className="quiet"><span className="dot" /><span className="txt">{activeFilterCount > 0 ? `Включено фильтров: ${activeFilterCount}` : "Список сужен поиском или этапом"}</span>
          <Button variant="ghost" size="sm" onClick={resetFilters}>Сбросить</Button></div>}
        {positions.isError && <div className="quiet warn"><span className="dot warn" /><span className="txt">Список вакансий не загрузился.</span>
          <Button variant="ghost" size="sm" onClick={() => void positions.refetch()}>Повторить</Button></div>}
        {data?.collecting === false && <div className="quiet"><span className="dot" /><span className="txt">Сбор новых анкет выключен. Сохранённые отклики доступны для работы.</span></div>}

        <VacancyBulkBar selected={chosen} positions={positions.data?.items} mutation={bulk} canDelete={canDelete} readOnly={readOnly}
          onClear={() => setChecked(new Set())} onPrint={() => setPrintItems(chosen)} onDelete={() => setDeleteItems(chosen)} />

        <div aria-busy={pending}>
          {pending && <div role="status" aria-label="Загружаем кандидатов">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} kind="row" />)}</div>}
          {!pending && queue.isError && <Rh2ErrorState message={vacanciesLoadErrorText(queue.error)} onRetry={() => void queue.refetch()} />}
          {!pending && !queue.isError && items.length > 0 && <List aria-label="Кандидаты">
            {clean ? <div className={cn("hidden items-center gap-3 px-4 pb-2 pt-3 text-[14px] text-gray-500 lg:grid", cleanCandidateColumns)}>
              <label className="chk" style={{ minWidth: 44, justifyContent: "center" }}><input type="checkbox" checked={allChecked} onChange={() => setChecked(value => toggleAllLoaded(value, items))} /><span className="sr-only">Выбрать все загруженные</span></label>
              <span aria-hidden>Кандидат</span><span aria-hidden>Оценка</span><span aria-hidden>Этап</span><span aria-hidden>Получено</span>
            </div> : <label className="chk"><input type="checkbox" checked={allChecked} onChange={() => setChecked(value => toggleAllLoaded(value, items))} />Выбрать все загруженные</label>}
            {items.map(item => <CleanCandidateRow key={item.id} item={item} clean={clean} href={`/vacancies/${encodeURIComponent(item.id)}`} linkState={backState}
              checked={checked.has(item.id)} onCheck={() => setChecked(value => toggleSelected(value, item.id))} />)}
          </List>}
          {!pending && !queue.isError && items.length === 0 && <Rh2EmptyState icon={Users}
            title={hasFilters ? "Ничего не найдено." : "Активных кандидатов пока нет."}
            hint={hasFilters ? "Измените поиск или сбросьте фильтры." : "Новые отклики появятся здесь. Завершённые анкеты — на этапе «Все»."}
            action={<Button variant="ghost" onClick={hasFilters ? resetFilters : () => patchParams({ stage: "ALL" })}>{hasFilters ? "Сбросить фильтры" : "Все кандидаты"}</Button>} />}
        </div>

        {/* «Показать ещё» общей Pagination: каждая страница — следующий offset сервера,
            строки копит mergeQueuePages. Когда догружать нечего, кнопка прячется сама. */}
        {data && !queue.isError && <Pagination variant="loadMore" page={pageCount} pageSize={VACANCY_QUEUE_PAGE} total={hasNextPage ? data.total ?? 0 : 0}
          onPageChange={next => { if (next > pageCount && hasNextPage && !isFetchingNextPage) void fetchNextPage(); }} />}
        {isFetchingNextPage && <p className="quiet" role="status"><span className="dot" /><span className="txt">Загружаем следующие анкеты…</span></p>}
        {queue.isFetchNextPageError && <div className="quiet crit" role="alert"><span className="dot crit" /><span className="txt">Следующие анкеты не загрузились.</span>
          <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()}>Повторить</Button></div>}
      </Card>

      {showFilters && <Rh2Sheet title="Фильтры" ariaLabel="Фильтры кандидатов" onClose={() => setShowFilters(false)}
        footer={<><Button variant="ghost" onClick={() => patchParams({ position: undefined, priority: undefined })}>Сбросить</Button>
          <Button onClick={() => setShowFilters(false)}>Показать{data ? ` ${data.total}` : ""}</Button></>}>
        <div className="sec-t" style={{ marginTop: 0 }}>Вакансия</div>
        <Filters aria-label="Вакансия" value={positionKey || "all"} options={positionOptions} onChange={id => patchParams({ position: id === "all" ? undefined : id })} />
        <div className="sec-t">Оценка</div>
        <Filters aria-label="Оценка кандидата" value={priority || "all"} options={priorityOptions} onChange={id => patchParams({ priority: id === "all" ? undefined : id })} />
      </Rh2Sheet>}
    </>}

    {creating && <VacancyCreateSheet positions={positions.data?.items} defaultPositionKey={positionKey} onClose={() => setCreating(false)}
      onCreated={id => { setCreating(false); openCandidate(id); }}
      onOpenExisting={id => { setCreating(false); openCandidate(id); }} />}
    {deleteItems.length > 0 && <VacancyDeleteDialog items={deleteItems} onClose={() => setDeleteItems([])} onDeleted={ids => {
      setDeleteItems([]);
      setChecked(value => new Set([...value].filter(id => !ids.includes(id))));
    }} />}
    <VacancyPrint items={printItems} onDone={finishPrint} />
  </Rh2Screen>;
}
