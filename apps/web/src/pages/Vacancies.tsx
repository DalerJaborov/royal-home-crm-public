import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Search, Users } from "lucide-react";
import type { RecruitmentPosition } from "@royal-home/shared";
import { useCan } from "../lib/permissions";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { useVacancies } from "../hooks/useVacancies";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useMarkSectionSeen } from "../hooks/useCounters";
import { VacancyRow } from "../components/VacancyRow";
import { VacancyDetails, VacancyOriginals } from "../components/VacancyDetails";
import { VacancyStageActions } from "../components/VacancyStageActions";
import { RecruitmentPositions } from "../components/RecruitmentPositions";
import { VACANCY_SEARCH_MAX, vacancyTodayInterviews, vacanciesLoadErrorText } from "../lib/vacanciesView";
import { CANDIDATE_QUEUE_STAGES, CANDIDATE_QUEUE_PAGE_SIZE, candidateQueueCount, candidateQueueOffset, candidateQueuePage, candidateStageFilters, selectedCandidate, type CandidateQueueStage } from "../lib/vacanciesResume";
import "../theme-2026-vacancies.css";

export function Vacancies() {
  useMarkSectionSeen("vacancies");
  const can = useCan(), canView = can("vacancies.view");
  const actor = useAuthStore(s => s.agent?.id);
  const [view, setView] = useState<"applications" | "positions">("applications");
  const [stage, setStage] = useState<CandidateQueueStage>("ACTIVE");
  const [positionKey, setPositionKey] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);
  const filterKey = `${stage}|${positionKey}|${q}`;
  const [paging, setPaging] = useState({ key: filterKey, offset: 0 });
  const offset = candidateQueueOffset(paging, filterKey);
  const query = useVacancies(canView && view === "applications", {
    ...candidateStageFilters(stage), positionKey: positionKey || undefined,
    includeFiltered: true, includeNoPhone: true, q, limit: CANDIDATE_QUEUE_PAGE_SIZE, offset,
  });
  const positions = useQuery({ queryKey: ["recruitment-positions", actor], enabled: canView,
    queryFn: () => api<{ items: RecruitmentPosition[] }>("/vacancies/positions", { expectAgentId: actor }) });
  const data = query.data, items = data?.items ?? [];
  const pending = query.isLoading || search.trim() !== q;
  const current = pending || query.isError ? null : selectedCandidate(items, selectedId);
  const page = candidateQueuePage(offset, items.length, data?.total);
  const todayInterviews = vacancyTodayInterviews(data);
  const hasFilters = !!search || !!positionKey || stage !== "ACTIVE";
  function resetPageSelection() {
    setPaging({ key: "", offset: 0 }); setSelectedId(null); setMobileDetail(false);
  }
  function resetFilters() {
    setSearch(""); setPositionKey(""); setStage("ACTIVE"); resetPageSelection();
  }
  function changePage(nextOffset: number) {
    setPaging({ key: filterKey, offset: Math.max(0, nextOffset) }); setSelectedId(null); setMobileDetail(false);
    requestAnimationFrame(() => document.getElementById("vacancy-queue-title")?.focus());
  }
  if (!canView) return <div className="rh2 screens vacancies-root"><div className="scr vacancies-screen">
    <h1>Подбор сотрудников</h1><p>Кандидатов разбирает руководство. У вас нет доступа к этому разделу.</p>
  </div></div>;
  return <div className="rh2 screens vacancies-root"><div className="scr vacancies-screen">
    <header className="vacancies-page-header">
      <div><p className="vacancies-eyebrow">Royal Home · Команда</p><h1>Подбор сотрудников</h1></div>
      <nav className="vacancies-view-switch" aria-label="Раздел подбора">
        <button type="button" aria-pressed={view === "applications"} onClick={() => setView("applications")}>Кандидаты</button>
        <button type="button" aria-pressed={view === "positions"} onClick={() => setView("positions")}>Вакансии</button>
      </nav>
    </header>
    {view === "positions" ? <RecruitmentPositions /> : <div className="vacancies-layout" data-mobile-detail={mobileDetail && !!current}>
      <aside className="vacancy-queue" aria-label="Очередь кандидатов">
        <div className="vacancy-queue-heading"><h2 id="vacancy-queue-title" tabIndex={-1}>Кандидаты</h2><span>{pending ? "…" : data?.total ?? ""}</span></div>
        <label className="vacancy-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Поиск по анкетам</span>
          <input type="search" value={search} maxLength={VACANCY_SEARCH_MAX} onChange={event => { setSearch(event.target.value); resetPageSelection(); }} placeholder="Имя, телефон, опыт" />
        </label>
        <label className="vacancy-field"><span>Этап подбора</span>
          <select value={stage} onChange={event => { setStage(event.target.value as CandidateQueueStage); resetPageSelection(); }}>
            {CANDIDATE_QUEUE_STAGES.map(option => {
              const count = candidateQueueCount(data?.counts, option.value);
              return <option value={option.value} key={option.value}>{option.label}{count == null ? "" : ` · ${count}`}</option>;
            })}
          </select>
        </label>
        <label className="vacancy-field"><span>Вакансия</span>
          <select value={positionKey} onChange={event => { setPositionKey(event.target.value); resetPageSelection(); }}>
            <option value="">Все вакансии</option>
            {positions.data?.items.map(position => <option value={position.key} key={position.key}>{position.titleRu}{position.isOpen ? "" : " · набор закрыт"}</option>)}
          </select>
        </label>
        {positions.isError && <p className="vacancy-muted">Список вакансий не загрузился. <button type="button" className="vacancy-text-button" onClick={() => void positions.refetch()}>Повторить</button></p>}
        {hasFilters && <button type="button" className="vacancy-text-button" onClick={resetFilters}>Сбросить фильтры</button>}
        <div className="vacancy-queue-results" aria-busy={pending}>
          {pending ? <p className="vacancy-queue-state" role="status">Загружаем кандидатов…</p>
            : query.isError ? <div className="vacancy-queue-state" role="alert"><p>{vacanciesLoadErrorText(query.error)}</p><button type="button" className="vacancy-button secondary" onClick={() => void query.refetch()}>Повторить</button></div>
            : items.length === 0 ? <div className="vacancy-queue-state"><Users aria-hidden="true" /><h3>{offset > 0 ? "На этой странице нет анкет" : hasFilters ? "Ничего не найдено" : "Активных кандидатов пока нет"}</h3>
              <p>{offset > 0 ? "Очередь могла измениться. Вернитесь к началу списка." : hasFilters ? "Измените поиск или сбросьте фильтры." : "Новые отклики появятся здесь. Завершённые анкеты доступны в выборе этапа."}</p>
              <button type="button" className="vacancy-button secondary" onClick={offset > 0 ? () => changePage(0) : hasFilters ? resetFilters : () => setStage("ALL")}>{offset > 0 ? "В начало очереди" : hasFilters ? "Сбросить фильтры" : "Все кандидаты"}</button></div>
            : <ul className="vacancy-queue-list" key={`${filterKey}|${offset}`}>{items.map(item => <VacancyRow key={item.id} item={item} selected={current?.id === item.id} onSelect={() => {
              setSelectedId(item.id); setMobileDetail(true); requestAnimationFrame(() => document.getElementById("candidate-resume-title")?.focus());
            }} />)}</ul>}
        </div>
        {!pending && !query.isError && (items.length > 0 || offset > 0) && <nav className="vacancy-paging" aria-label="Страницы очереди"><p role="status">{page.text}</p><div className="vacancy-pagination-buttons">
          <button type="button" className="vacancy-button secondary" disabled={query.isFetching || !page.hasPrevious} onClick={() => changePage(offset - CANDIDATE_QUEUE_PAGE_SIZE)}>Предыдущие</button>
          <button type="button" className="vacancy-button secondary" disabled={query.isFetching || !page.hasNext} onClick={() => changePage(offset + CANDIDATE_QUEUE_PAGE_SIZE)}>Следующие</button>
        </div></nav>}
        {todayInterviews.length > 0 && <p className="vacancy-muted vacancy-today">Сегодня собеседований: {todayInterviews.length}. <button type="button" className="vacancy-text-button" onClick={() => { setSearch(""); setPositionKey(""); setStage("INTERVIEW"); resetPageSelection(); }}>Открыть</button></p>}
        {data?.collecting === false && <p className="vacancy-notice">Сбор новых анкет выключен. Сохранённые отклики доступны для работы.</p>}
      </aside>
      {current ? <div className="vacancy-detail" key={current.id}>
        <div className="vacancy-mobile-navigation"><button type="button" className="vacancy-text-button" onClick={() => { setMobileDetail(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.vacancy-queue-card[aria-current="true"]')?.focus()); }}><ArrowLeft size={18} aria-hidden="true" /> К кандидатам</button><a className="vacancy-text-button" href="#candidate-next-actions">К действиям</a></div>
        <VacancyDetails item={current} />
        <aside id="candidate-next-actions" className="vacancy-next" tabIndex={-1} aria-label="Следующий шаг"><h2>Следующий шаг</h2><VacancyStageActions item={current} positions={positions.data?.items} positionsLoading={positions.isPending} positionsError={positions.isError} onPositionsRetry={() => void positions.refetch()} /><VacancyOriginals item={current} /></aside>
      </div> : <div className="vacancy-no-selection" role="status"><Users size={36} aria-hidden="true" /><h2>{pending ? "Загружаем анкеты" : "Анкета кандидата"}</h2><p>{pending ? "Проверяем актуальный список. Действия появятся после загрузки." : "Выберите кандидата в списке слева."}</p></div>}
    </div>}
  </div></div>;
}
