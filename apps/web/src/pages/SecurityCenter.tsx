import { useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { useCan } from "../lib/permissions";
import {
  useLostClients,
  useLostProperties,
  useSecuritySummary,
  type AgentFaultFilter,
  type SecurityClientRow,
} from "../hooks/useSecurity";
import { Pagination } from "../components/Pagination";
import { SecurityList, SecurityRow } from "../components/security/SecurityList";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";
import { REFUSAL_REASON_LABELS, type SecurityReviewState } from "@royal-home/shared";
import { dushanbeDate, dushanbeTime } from "../lib/date";
import { StatTile } from "../components/ui/StatTile";
import { useCounters } from "../hooks/useCounters";
import { useOversightSummary } from "../hooks/useOversight";
import { TeamTabs } from "../components/SectionTabs";
import { Rh2EmptyState } from "../components/rh2/Rh2EmptyState";
import { InvestigationCasesPanel } from "../components/security/InvestigationCasesPanel";

type Tab = "clients" | "properties";
type VerdictFilter = SecurityReviewState | "";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Момент, с которого считается «в ожидании»/«разобрано» — та же дата, что видна
 *  в строке (`SecurityList`): факт проверки, а до неё — дата создания заявки. */
function waitingSince(r: SecurityClientRow): number {
  return new Date(r.securityReviewedAt ?? r.createdAt).getTime();
}

/** «сегодня в 12:40» / «3 сен в 09:12» — тот же формат, что и в остальной CRM
 *  (vacanciesView.ts), время всегда душанбинское. */
function shortWhen(value: string): string {
  const day = dushanbeDate(value);
  const today = dushanbeDate(new Date());
  if (day === today) return `сегодня в ${dushanbeTime(value)}`;
  return `${dushanbeDate(value, { day: "numeric", month: "short" })} в ${dushanbeTime(value)}`;
}

/**
 * «Служба безопасности» — тема «Royal Home 2026», разметка дословно по
 * `<template id="tpl-security">` артефакта владельца (одна и та же на ПК и
 * телефон, узкую раскладку делают медиазапросы прототипа).
 *
 * Плитки сводки (шаг 5 переноса, 10.09.2026) — суммы по вердиктам и «вина
 * агента» ПО ВСЕЙ выборке, а не по одной странице списка: GET /security/summary
 * (groupBy по securityReview + тот же батч-классификатор вины, что у фильтра
 * ниже). Деление «Ждут проверки / Уже разобрано» ниже плиток по-прежнему
 * считается из уже загруженной страницы — это просто группировка видимых строк,
 * не сумма. Диаграмма причин закрытия за месяц (`reasonBars`) сумму по ВСЕМ
 * страницам всё ещё не заявляет — эндпоинт под неё в эту правку не входил,
 * поэтому она остаётся честно пустой, пока `total > items.length`. Разбор
 * закрытого вердикта — готовая `SecurityReviewPanel` на карточке клиента
 * (`ClientDetail.tsx`, право `clients.securityReview`), поэтому «Открыть
 * проверку» ведёт туда, а не дублирует ту же форму вторым местом.
 */
/** Плитки сводки применяют реальный фильтр списка ниже (тот же verdict/
 *  agentFault, что и в шторке «Фильтры») и прокручивают к результату —
 *  список уже на этом экране, отдельного маршрута с фильтром для него нет. */
function scrollToResults() {
  document.getElementById("sc-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function SecurityCenter() {
  const can = useCan();
  const canView = can("clients.securityReview");
  // Вкладки раздела «Команда» (перенос меню 15.09.2026) — тот же набор и та же
  // логика подписи, что в pages/Team.tsx / lib/navigation.ts. Не путать с
  // внутренним `tab` ниже («Клиенты в СБ» / «Потерянные объекты») — это срез
  // данных ЭТОГО экрана, а не переход между экранами раздела.
  const { data: sectionCounters } = useCounters();
  const { data: oversightSummary } = useOversightSummary(can("dashboard.analytics"));
  const [tab, setTab] = useState<Tab>("clients");
  const [clientsPage, setClientsPage] = useState(1);
  const [propertiesPage, setPropertiesPage] = useState(1);
  const [verdict, setVerdictRaw] = useState<VerdictFilter>("");
  const [agentFaultFilter, setAgentFaultFilterRaw] = useState<AgentFaultFilter>(undefined);
  // Смена фильтра — новая выдача, и смотреть её надо с первой страницы: иначе
  // человек со второй страницы попадал на пустую под суженным фильтром. Сброс
  // здесь, а не у каждой кнопки: фильтр ставят и шторка, и плитки сводки.
  const setVerdict = (v: VerdictFilter) => {
    setVerdictRaw(v);
    setClientsPage(1);
    setPropertiesPage(1);
  };
  const setAgentFaultFilter = (v: AgentFaultFilter) => {
    setAgentFaultFilterRaw(v);
    setClientsPage(1);
    setPropertiesPage(1);
  };
  const [filtersOpen, setFiltersOpen] = useState(false);

  const clientsQuery = useLostClients(clientsPage, verdict || undefined, agentFaultFilter, canView && tab === "clients");
  const propertiesQuery = useLostProperties(
    propertiesPage,
    verdict || undefined,
    agentFaultFilter,
    canView && tab === "properties"
  );
  const summaryQuery = useSecuritySummary(tab, canView);

  const active = tab === "clients" ? clientsQuery : propertiesQuery;
  const rows = active.data?.items ?? [];
  // Все совпадающие карточки поместились на одной странице — только тогда
  // диаграмма причин ниже честна (суммы по вердикту в плитках сводки теперь
  // считает сервер, см. summaryQuery, и от этого не зависят).
  const allLoaded = active.data ? active.data.total <= rows.length : false;

  const pending = rows.filter((r) => (r.securityReview ?? "PENDING") === "PENDING");
  const cleared = rows.filter((r) => r.securityReview === "CLEARED");
  const confirmed = rows.filter((r) => r.securityReview === "CONFIRMED");
  const now = Date.now();

  const reasonBars = useMemo(() => {
    if (!allLoaded) return null;
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!r.refusalReason) continue;
      if (now - waitingSince(r) > MONTH_MS) continue;
      const label = REFUSAL_REASON_LABELS[r.refusalReason];
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const arr = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const max = arr.length > 0 ? arr[0][1] : 1;
    return arr.map(([label, n]) => ({ label, n, v: n / max }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, allLoaded]);

  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Раздел недоступен</h1>
            </div>
          </div>
          <TeamTabs />
          <div className="card tight">
            <Rh2EmptyState icon={Lock} title="Недостаточно прав для просмотра." />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Служба безопасности</h1>
            <p className="sub">
              Сюда попадают закрытые карточки, где сделка могла пройти мимо агентства: клиент купил или продал
              сам либо через другое агентство. Задача проверки: открыть карточку, посмотреть переписку и звонки,
              выставить вердикт.
            </p>
          </div>
          <div className="acts">
            <button className="pill ghost" type="button" onClick={() => setFiltersOpen(true)}>
              Фильтры{[verdict, agentFaultFilter].filter(Boolean).length > 0 ? ` ${[verdict, agentFaultFilter].filter(Boolean).length}` : ""}
            </button>
          </div>
        </div>

        <TeamTabs />

        <InvestigationCasesPanel />

        <div className="quiet">
          <span className="txt">
            Чужие карточки открываются только для чтения. Менять статус, писать клиенту и передавать агента
            служба безопасности не может: доступен один вердикт.
          </span>
        </div>

        <div className="hscroll">
          <div className="seg" role="tablist" aria-label="Что показывать">
            <button type="button" role="tab" aria-selected={tab === "clients"} onClick={() => setTab("clients")}>
              Клиенты в СБ {clientsQuery.data && <span className="n">{clientsQuery.data.total}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "properties"}
              onClick={() => setTab("properties")}
            >
              Потерянные объекты {propertiesQuery.data && <span className="n">{propertiesQuery.data.total}</span>}
            </button>
          </div>
        </div>

        {summaryQuery.data ? (
          <div className="tiles">
            <StatTile
              label="Ждут проверки"
              value={summaryQuery.data.pending}
              line={
                summaryQuery.data.pendingOldCount > 0
                  ? `из них ${summaryQuery.data.pendingOldCount} старше недели`
                  : "старше недели нет"
              }
              critical={summaryQuery.data.pendingOldCount > 0}
              onClick={() => {
                setVerdict("PENDING");
                scrollToResults();
              }}
              title="Отфильтровать список: ждут проверки"
            />
            <StatTile
              label="Закрыто после проверки"
              value={summaryQuery.data.cleared}
              line="вопросов не возникло"
              onClick={() => {
                setVerdict("CLEARED");
                scrollToResults();
              }}
              title="Отфильтровать список: закрыто после проверки"
            />
            <StatTile
              label="Нарушение подтверждено"
              value={summaryQuery.data.confirmed}
              line="сделка прошла мимо компании"
              critical
              onClick={() => {
                setVerdict("CONFIRMED");
                scrollToResults();
              }}
              title="Отфильтровать список: нарушение подтверждено"
            />
            <StatTile
              label="С просрочками агента"
              value={summaryQuery.data.agentFault}
              line="вина видна по задачам"
              onClick={() => {
                setAgentFaultFilter("1");
                scrollToResults();
              }}
              title="Отфильтровать список: есть вина агента"
            />
          </div>
        ) : summaryQuery.isError ? (
          <div className="quiet">
            <span className="txt">Сводку по вердиктам сейчас не удалось посчитать — список ниже работает как обычно.</span>
          </div>
        ) : null}

        {summaryQuery.data && (
          <section className="sec">
            <div className="card-s" style={{ marginTop: 4 }}>
              <div className="row">
                <span className="t">
                  <span className="n">Входов с новых устройств</span>
                  <span className={summaryQuery.data.alerts.newDeviceLogins > 0 ? "s warn" : "s ok"}>
                    {summaryQuery.data.alerts.newDeviceLogins > 0
                      ? `${summaryQuery.data.alerts.newDeviceLogins} за неделю`
                      : "0 · всё чисто"}
                  </span>
                </span>
              </div>
              <div className="row">
                <span className="t">
                  <span className="n">Изменений прав доступа</span>
                  <span className="s">
                    {summaryQuery.data.alerts.permissionChangeCount} за неделю
                    {summaryQuery.data.alerts.lastPermissionChangeAt
                      ? ` · последнее ${shortWhen(summaryQuery.data.alerts.lastPermissionChangeAt)}`
                      : ""}
                  </span>
                </span>
              </div>
            </div>

            <div className="sec-t">
              <h2>Красные флаги со звонков</h2>
              <span className="cnt">за неделю</span>
            </div>
            {summaryQuery.data.alerts.callRedFlags.length === 0 ? (
              <div className="card-s">
                <div className="quiet">
                  <div className="ln">За неделю красных флагов не найдено</div>
                </div>
              </div>
            ) : (
              <div className="card-s">
                {summaryQuery.data.alerts.callRedFlags.map((f) => (
                  <div className="row" key={f.id}>
                    <span className="t">
                      <span className="n">{f.clientName}</span>
                      <span className="s warn">{f.detail ?? "Флаг без описания"}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {active.isLoading || active.isError || rows.length === 0 ? (
          <div className="card tight" id="sc-results">
            <SecurityList rows={rows} isLoading={active.isLoading} isError={active.isError} onRetry={() => active.refetch()} />
          </div>
        ) : (
          <div id="sc-results">
            {pending.length > 0 && (
              <div className="sec">
                <div className="sec-h">
                  <h2>Ждут проверки</h2>
                  <span className="note">{pending.length} карточек</span>
                </div>
                <div className="card tight">
                  {pending.map((r, i) => (
                    <SecurityRow key={r.id} row={r} tone={i} />
                  ))}
                </div>
              </div>
            )}

            {(cleared.length > 0 || confirmed.length > 0) && (
              <div className="sec">
                <div className="sec-h">
                  <h2>Уже разобрано</h2>
                  <span className="note">{cleared.length + confirmed.length} карточек</span>
                </div>
                <div className="card tight">
                  {[...confirmed, ...cleared].map((r, i) => (
                    <SecurityRow key={r.id} row={r} tone={pending.length + i} />
                  ))}
                </div>
              </div>
            )}

            {active.data && (
              <div className="card tight">
                <Pagination
                  page={tab === "clients" ? clientsPage : propertiesPage}
                  pageSize={active.data.pageSize}
                  total={active.data.total}
                  onPageChange={tab === "clients" ? setClientsPage : setPropertiesPage}
                />
              </div>
            )}
          </div>
        )}

        {reasonBars && reasonBars.length > 0 && (
          <div className="sec">
            <div className="sec-h">
              <h2>Причины закрытия за месяц</h2>
              <span className="note">по каким основаниям карточки попадают в проверку</span>
            </div>
            <div className="card tight">
              <div className="bars">
                {reasonBars.map((b) => (
                  <div className="b" key={b.label}>
                    <span className="nm3">{b.label}</span>
                    <span className="tr">
                      <i style={{ ["--v" as string]: b.v }} />
                    </span>
                    <span className="vl">{b.n}</span>
                  </div>
                ))}
              </div>
              <p className="state">
                Остальные причины закрытия в проверку не идут: они не означают, что сделка прошла мимо агентства.
              </p>
            </div>
          </div>
        )}
      </div>

      <Rh2Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Фильтры" ariaLabel="Фильтры проверок">
        <div className="sec-t" style={{ marginTop: 0 }}>
          Вердикт
        </div>
        <div className="seg">
          <button type="button" aria-selected={verdict === ""} onClick={() => setVerdict("")}>
            Любой
          </button>
          <button type="button" aria-selected={verdict === "PENDING"} onClick={() => setVerdict("PENDING")}>
            Ждёт проверки
          </button>
          <button type="button" aria-selected={verdict === "CLEARED"} onClick={() => setVerdict("CLEARED")}>
            Закрыт после проверки
          </button>
          <button type="button" aria-selected={verdict === "CONFIRMED"} onClick={() => setVerdict("CONFIRMED")}>
            Нарушение подтверждено
          </button>
        </div>
        <div className="sec-t">Вина агента, агент на момент потери</div>
        <div className="seg">
          <button type="button" aria-selected={agentFaultFilter === undefined} onClick={() => setAgentFaultFilter(undefined)}>
            Любой
          </button>
          <button type="button" aria-selected={agentFaultFilter === "1"} onClick={() => setAgentFaultFilter("1")}>
            Есть вина агента
          </button>
          <button type="button" aria-selected={agentFaultFilter === "0"} onClick={() => setAgentFaultFilter("0")}>
            Без вины агента
          </button>
        </div>
      </Rh2Sheet>
    </div>
  );
}
