import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarDays, Plus, Search, Users } from "lucide-react";
import type { RecruitmentPosition } from "@royal-home/shared";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { useBulkVacancies, useVacancies, useVacancyQueue, type JobApplication, type VacancyPriorityFilter } from "../hooks/useVacancies";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useMarkSectionSeen } from "../hooks/useCounters";
import { VacancyRow } from "../components/VacancyRow";
import { VacancyDetails, VacancyOriginals } from "../components/VacancyDetails";
import { VacancyStageActions } from "../components/VacancyStageActions";
import { RecruitmentPositions } from "../components/RecruitmentPositions";
import { VacancyFacetChips, VacancyStageChips } from "../components/VacancyFilterChips";
import { VacancyBulkBar } from "../components/VacancyBulkBar";
import { VacancyDeleteDialog } from "../components/VacancyDeleteDialog";
import { VacancyCreateSheet } from "../components/VacancyCreateSheet";
import { VacancyPrint } from "../components/VacancyPrint";
import { VACANCY_SEARCH_MAX, vacancyTodayInterviews, vacanciesLoadErrorText } from "../lib/vacanciesView";
import { candidateStageFilters, candidateTitle, type CandidateQueueStage } from "../lib/vacanciesResume";
import { adjacentCandidateId, canDeleteCandidates, mergeQueuePages, queueLoadedNote, selectedItems, toggleAllLoaded, toggleSelected } from "../lib/vacancyQueue";
import { dushanbeTime } from "../lib/date";
import "../theme-2026-vacancies.css";

const focusCandidate = (id: string) => requestAnimationFrame(() =>
  document.querySelector<HTMLButtonElement>(`.vacancy-queue-card[data-candidate-id="${CSS.escape(id)}"]`)?.focus());

export function Vacancies() {
  useMarkSectionSeen("vacancies");
  const can = useCan(), canView = can("vacancies.view");
  const readOnly = useIsReadOnly();
  const actor = useAuthStore(s => s.agent?.id);
  const role = useAuthStore(s => s.agent?.role);
  const canDelete = canDeleteCandidates(role) && !readOnly;
  const [view, setView] = useState<"applications" | "positions">("applications");
  const [stage, setStage] = useState<CandidateQueueStage>("ACTIVE");
  const [positionKey, setPositionKey] = useState("");
  const [priority, setPriority] = useState<VacancyPriorityFilter | "">("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<JobApplication | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [printItems, setPrintItems] = useState<JobApplication[]>([]);
  const [deleteItems, setDeleteItems] = useState<JobApplication[]>([]);
  const [creating, setCreating] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);
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
  const current = pending || queue.isError ? null
    : items.find(item => item.id === selectedId) ?? (pinned && pinned.id === selectedId ? pinned : null) ?? items[0] ?? null;
  const todayInterviews = vacancyTodayInterviews(data);
  const chosen = selectedItems(items, checked);
  const hasFilters = !!search || !!positionKey || !!priority || stage !== "ACTIVE";
  const allChecked = items.length > 0 && items.every(item => checked.has(item.id));

  function resetSelection() { setSelectedId(null); setPinned(null); setMobileDetail(false); setChecked(new Set()); }
  function resetFilters() { setSearch(""); setPositionKey(""); setPriority(""); setStage("ACTIVE"); resetSelection(); }
  function openCandidate(item: JobApplication | string, focusTitle = true) {
    const id = typeof item === "string" ? item : item.id;
    setSelectedId(id); setPinned(typeof item === "string" ? null : item); setMobileDetail(true);
    requestAnimationFrame(() => {
      // Телефон: анкета занимает экран целиком — начинаем с её верха, а не с места в ленте.
      if (window.matchMedia("(max-width: 820px)").matches) window.scrollTo({ top: 0 });
      if (focusTitle) document.getElementById("candidate-resume-title")?.focus({ preventScroll: true });
    });
  }
  function onQueueKey(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!(event.target instanceof HTMLElement) || !event.target.classList.contains("vacancy-queue-card")) return;
    event.preventDefault();
    const next = adjacentCandidateId(items, current?.id, event.key === "ArrowDown" ? 1 : -1);
    if (next) { setSelectedId(next); setPinned(null); focusCandidate(next); }
  }
  const finishPrint = useCallback(() => setPrintItems([]), []);

  // Бесконечная лента: догружаем, когда низ списка показался на экране.
  const sentinel = useRef<HTMLLIElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = queue;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: "240px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length]);

  if (!canView) return <div className="rh2 screens vacancies-root"><div className="scr vacancies-screen">
    <h1>Подбор сотрудников</h1><p>Кандидатов разбирает руководство. У вас нет доступа к этому разделу.</p>
  </div></div>;
  return <div className="rh2 screens vacancies-root"><div className="scr vacancies-screen">
    <header className="vacancies-page-header">
      <div><p className="vacancies-eyebrow">Royal Home · Команда</p><h1>Подбор сотрудников</h1></div>
      <div className="vacancies-header-actions">
        {!readOnly && view === "applications" && <button type="button" className="vacancy-button" onClick={() => setCreating(true)}><Plus size={18} aria-hidden="true" />Кандидат</button>}
        <nav className="vacancies-view-switch" aria-label="Раздел подбора">
          <button type="button" aria-pressed={view === "applications"} onClick={() => setView("applications")}>Кандидаты</button>
          <button type="button" aria-pressed={view === "positions"} onClick={() => setView("positions")}>Вакансии</button>
        </nav>
      </div>
    </header>
    {view === "positions" ? <RecruitmentPositions candidateCounts={positionTotals.data?.positionCounts}
      onOpenCandidates={key => { setView("applications"); setStage("ALL"); setPositionKey(key); setPriority(""); setSearch(""); resetSelection(); }} />
      : <>
      <VacancyStageChips stage={stage} counts={data?.counts} onChange={value => { setStage(value); resetSelection(); }} />
      <div className="vacancies-toolbar">
        <label className="vacancy-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Поиск по анкетам</span>
          <input type="search" value={search} maxLength={VACANCY_SEARCH_MAX} onChange={event => { setSearch(event.target.value); resetSelection(); }} placeholder="Имя, телефон, опыт" />
        </label>
        <VacancyFacetChips positions={positions.data?.items} positionCounts={data?.positionCounts} positionKey={positionKey}
          onPosition={key => { setPositionKey(key); resetSelection(); }} priority={priority} priorityCounts={data?.priorityCounts}
          onPriority={value => { setPriority(value); resetSelection(); }} />
        {hasFilters && <button type="button" className="vacancy-text-button" onClick={resetFilters}>Сбросить фильтры</button>}
      </div>
      {positions.isError && <p className="vacancy-muted">Список вакансий не загрузился. <button type="button" className="vacancy-text-button" onClick={() => void positions.refetch()}>Повторить</button></p>}
      {todayInterviews.length > 0 && <details className="vacancy-today"><summary><CalendarDays size={16} aria-hidden="true" />Собеседования сегодня · {todayInterviews.length}</summary>
        <ul>{todayInterviews.map(item => <li key={item.id}><button type="button" className="vacancy-text-button" onClick={() => openCandidate(item)}>
          <span className="vacancy-today-time">{item.interviewAt ? dushanbeTime(item.interviewAt) : "—"}</span>{candidateTitle(item)}</button></li>)}</ul></details>}
      <div className="vacancies-layout" data-mobile-detail={mobileDetail && !!current}>
      <aside className="vacancy-queue" aria-label="Лента кандидатов">
        <div className="vacancy-queue-heading"><h2 id="vacancy-queue-title" tabIndex={-1}>Кандидаты</h2><span>{pending ? "…" : data?.total ?? ""}</span></div>
        {items.length > 0 && <div className="vacancy-queue-tools">
          <label className="vacancy-checkbox"><input type="checkbox" checked={allChecked} onChange={() => setChecked(value => toggleAllLoaded(value, items))} />Выбрать все загруженные</label>
        </div>}
        <div className="vacancy-queue-results" aria-busy={pending}>
          {pending ? <p className="vacancy-queue-state" role="status">Загружаем кандидатов…</p>
            : queue.isError ? <div className="vacancy-queue-state" role="alert"><p>{vacanciesLoadErrorText(queue.error)}</p><button type="button" className="vacancy-button secondary" onClick={() => void queue.refetch()}>Повторить</button></div>
            : items.length === 0 ? <div className="vacancy-queue-state"><Users aria-hidden="true" /><h3>{hasFilters ? "Ничего не найдено" : "Активных кандидатов пока нет"}</h3>
              <p>{hasFilters ? "Измените поиск или сбросьте фильтры." : "Новые отклики появятся здесь. Завершённые анкеты — на этапе «Все»."}</p>
              <button type="button" className="vacancy-button secondary" onClick={hasFilters ? resetFilters : () => setStage("ALL")}>{hasFilters ? "Сбросить фильтры" : "Все кандидаты"}</button></div>
            : <ul className="vacancy-queue-list" onKeyDown={onQueueKey}>{items.map(item => <VacancyRow key={item.id} item={item} selected={current?.id === item.id}
              checked={checked.has(item.id)} onCheck={() => setChecked(value => toggleSelected(value, item.id))}
              onSelect={() => openCandidate(item)} />)}
              <li ref={sentinel} className="vacancy-queue-end" aria-hidden={!hasNextPage}>
                {hasNextPage ? <button type="button" className="vacancy-button secondary" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>{isFetchingNextPage ? "Загружаем…" : "Загрузить ещё"}</button> : null}
              </li></ul>}
        </div>
        {!pending && !queue.isError && items.length > 0 && <p className="vacancy-muted vacancy-loaded" role="status">{queueLoadedNote(items.length, data?.total)}</p>}
        {queue.isFetchNextPageError && <p className="vacancy-notice" role="alert">Следующие анкеты не загрузились. <button type="button" className="vacancy-text-button" onClick={() => void fetchNextPage()}>Повторить</button></p>}
        {data?.collecting === false && <p className="vacancy-notice">Сбор новых анкет выключен. Сохранённые отклики доступны для работы.</p>}
      </aside>
      {current ? <div className="vacancy-detail" key={current.id} onKeyDown={event => {
        // Esc из окна (портал) всплывает сюда через React — окно закрывается само, анкету не трогаем.
        if (event.key === "Escape" && mobileDetail && event.currentTarget.contains(event.target as Node)) { setMobileDetail(false); focusCandidate(current.id); }
      }}>
        <div className="vacancy-mobile-navigation"><button type="button" className="vacancy-text-button" onClick={() => { setMobileDetail(false); focusCandidate(current.id); }}><ArrowLeft size={18} aria-hidden="true" /> К кандидатам</button><a className="vacancy-text-button" href="#candidate-next-actions">К действиям</a></div>
        <VacancyDetails item={current} onPrint={() => setPrintItems([current])} onDelete={canDelete ? () => setDeleteItems([current]) : undefined} />
        <aside id="candidate-next-actions" className="vacancy-next" tabIndex={-1} aria-label="Следующий шаг"><h2>Следующий шаг</h2><VacancyStageActions item={current} positions={positions.data?.items} positionsLoading={positions.isPending} positionsError={positions.isError} onPositionsRetry={() => void positions.refetch()} onDelete={canDelete ? () => setDeleteItems([current]) : undefined} /><VacancyOriginals item={current} /></aside>
      </div> : <div className="vacancy-no-selection" role="status"><Users size={36} aria-hidden="true" /><h2>{pending ? "Загружаем анкеты" : "Анкета кандидата"}</h2><p>{pending ? "Проверяем актуальный список. Действия появятся после загрузки." : "Выберите кандидата в списке слева."}</p></div>}
    </div>
    <VacancyBulkBar selected={chosen} positions={positions.data?.items} mutation={bulk} canDelete={canDelete} readOnly={readOnly}
      onClear={() => setChecked(new Set())} onPrint={() => setPrintItems(chosen)} onDelete={() => setDeleteItems(chosen)} />
    </>}
    {creating && <VacancyCreateSheet positions={positions.data?.items} defaultPositionKey={positionKey} onClose={() => setCreating(false)}
      onCreated={id => { setCreating(false); setStage("ALL"); setPositionKey(""); setPriority(""); setSearch(""); setChecked(new Set()); openCandidate(id); }}
      onOpenExisting={(id, phone) => { setCreating(false); setStage("ALL"); setPositionKey(""); setPriority(""); setSearch(phone.slice(0, VACANCY_SEARCH_MAX)); setChecked(new Set()); openCandidate(id, false); }} />}
    {deleteItems.length > 0 && <VacancyDeleteDialog items={deleteItems} onClose={() => setDeleteItems([])} onDeleted={ids => {
      setDeleteItems([]);
      setChecked(value => new Set([...value].filter(id => !ids.includes(id))));
      if (current && ids.includes(current.id)) { setSelectedId(null); setPinned(null); setMobileDetail(false); }
    }} />}
    <VacancyPrint items={printItems} onDone={finishPrint} />
  </div></div>;
}
