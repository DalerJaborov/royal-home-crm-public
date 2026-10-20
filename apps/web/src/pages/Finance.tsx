import { CleanLoadError } from "../components/clean/CleanLoadError";
import { ShellOwnHeader } from "../components/rh2/ShellOwnHeader";
import { useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CLIENT_SOURCE_LABELS, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@royal-home/shared";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { useMobileUx } from "../hooks/useMobileUx";
import {
  downloadFinanceCsv,
  useCommissionForecast,
  useExpenseForecast,
  useFinanceSummary,
  type AgentPayoutDeal,
  type FinanceMonth,
} from "../hooks/useFinance";
import { FALLBACK_USD_TO_TJS } from "../lib/format";
import { dushanbeFirstDayOfMonthKey } from "../lib/date";
import { effectiveMonth } from "../lib/financeMonth";
import { RecurringSection } from "../components/finance/RecurringSection";
import { PulseTiles } from "../components/finance/PulseTiles";
import { StatTile } from "../components/ui/StatTile";
import { CommissionForecastCard } from "../components/finance/CommissionForecastBlock";
import { Rh2DeltaChip } from "../components/rh2/Rh2DeltaChip";
import { ExpensesWorkspace } from "../components/finance/ExpensesWorkspace";
import { Rh2Money } from "../components/rh2/Rh2Money";
import { Rh2Bars } from "../components/rh2/Rh2Bars";
import { Rh2BarChart } from "../components/rh2/Rh2BarChart";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import { scrollableRegion } from "../lib/a11y";
import { MhMoney, MhSection } from "../components/home/mh/MhScreen";
import { MoneyTabs } from "../components/SectionTabs";
import { useCleanShell } from "../hooks/useCleanShell";
import { financeWorkspace, financeWorkspaceSearch, type FinanceWorkspace } from "../lib/financeWorkspace";
import { ClaudeMoneyPage } from "../components/finance/ClaudeMoneyPage";

/**
 * ФИНАНСЫ — экран /finance темы «Royal Home 2026», перенесённый из прототипа
 * (`docs/pult/theme-2026/screens/finance.html`) дословно: разметка, имена
 * классов, порядок блоков и подписи взяты из макета, а не придуманы заново.
 *
 * Один экран на компьютер и телефон. Отдельного `MobileFinance.tsx` больше нет:
 * прототип сам содержит раскладку ≤820 px (`.tiles`, `.row`, `.chart.wide`,
 * `.only-narrow`), и вторая копия экрана только разъезжалась бы с первой —
 * ровно то, чем болели Finance.tsx и MobileFinance.tsx до переноса.
 *
 * Блоки в порядке прототипа:
 *   1) шапка: заголовок, пояснение, «Скачать CSV», «Архив», лента срока;
 *   2) главная цифра месяца: прибыль, полоса «осталось / ушло», выбор месяца;
 *   3) четыре плитки: комиссия, агентам, доход компании, расходы;
 *   4) «Расходы» (ExpensesWorkspace);
 *   5) «Прибыль по месяцам» (свой SVG);
 *   6) «Повторяющиеся платежи»;
 *   7) «Выплаты агентам»;
 *   8) «Стоимость лида».
 * Сверх прототипа сохранены функции CRM, которых макет не рисует: «Пульс денег»,
 * лента срока (6 месяцев / год / 2 года / 3 года), «Комиссия по месяцам» и
 * «Сомони за сделку». Все они одеты прототипными классами.
 */

const MONTHS_NOM = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];
const MONTHS_ACC = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];
const MONTHS_PREP = [
  "январе", "феврале", "марте", "апреле", "мае", "июне",
  "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

const RANGE_OPTIONS = [
  { months: 6, label: "6 месяцев" },
  { months: 12, label: "Год" },
  { months: 24, label: "2 года" },
  { months: 36, label: "3 года" },
] as const;

/** Текущий месяц ПО ДУШАНБЕ, а не по часам браузера. С 00:00 до 05:00 первого
 *  числа устройство в UTC (или западнее) ещё показывает прошлый месяц, а сервер
 *  уже считает новый через dushanbeStartOfMonth — Финансы открывались бы на
 *  прошлом месяце и не сходились с Главной. Та же ловушка, которую уже чинили
 *  в Отчётах, см. dushanbeFirstDayOfMonthKey в lib/date.ts. */
function currentMonth(): string {
  return dushanbeFirstDayOfMonthKey().slice(0, 7);
}

/** Индекс месяца 0..11 из ключа «2026-09». */
function monthIndex(key: string): number {
  return Number(key.slice(5, 7)) - 1;
}

function monthYear(key: string): string {
  return `${MONTHS_NOM[monthIndex(key)]} ${key.slice(0, 4)}`;
}

function nums(value: number): string {
  return Math.round(value).toLocaleString("ru-RU");
}

/** Плитка ведёт не по маршруту, а к разделу этого же экрана (владелец, 15.09.2026). */
function scrollToSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  const focusable = section.hasAttribute("tabindex");
  if (!focusable) section.tabIndex = -1;
  section.focus({ preventScroll: true });
  section.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  if (!focusable) section.addEventListener("blur", () => section.removeAttribute("tabindex"), { once: true });
}

export function Finance() {
  const can = useCan();

  if (!can("finance.view")) {
    return (
      <Rh2Screen>
          <div className="pg-h">
            <div>
              <h1>Финансы</h1>
              <p className="sub">Раздел доступен только директору и администратору.</p>
            </div>
          </div>
      </Rh2Screen>
    );
  }

  return <FinanceScreen />;
}

/** Область во всю ширину — те же значения, что MH_HOST в MhScreen.tsx/MhList.tsx. */
const MH_HOST: import("react").CSSProperties = {
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  display: "flex",
  flexDirection: "column",
};

/** One operational surface for authorized Clean desktop and phone; legacy keeps its own DOM. */
function FinanceFrame({ clean, children }: { clean: boolean; children: React.ReactNode }) {
  return clean ? <div className="finance-clean">{children}</div> : <>{children}</>;
}

function FinanceScreen() {
  const can = useCan();
  const canManage = !useIsReadOnly() && can("finance.manage");
  // 14.09.2026: на телефоне сверху — дословная сводка макета c99db05f
  // (`renderFinance`): крупная прибыль с полосой плана и «Расходы месяца»
  // списком, в обёртке `.rh2 .mh`. Хуки и права общие для обеих ширин —
  // ветвится только разметка.
  const mobile = useMobileUx();
  const clean = useCleanShell();
  const [searchParams, setSearchParams] = useSearchParams();
  const workspace = financeWorkspace(searchParams.get("workspace"));
  function setWorkspace(next: FinanceWorkspace) {
    setSearchParams((previous) => financeWorkspaceSearch(previous, next));
  }
  const pendingSection = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (pendingSection.current) {
      scrollToSection(pendingSection.current);
      pendingSection.current = null;
    }
  }, [workspace]);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth());
  const [rangeMonths, setRangeMonths] = useState<number>(6);
  // error берём обязательно: без него упавший запрос выглядел как «за месяц ничего
  // не заработали» — все карточки показывали прочерк, а списки писали «пока нет
  // данных». Директору невозможно отличить отказ сервера от пустого месяца.
  const { data, isLoading, error, refetch } = useFinanceSummary(rangeMonths, true, clean ? selectedMonth : undefined);
  // Выбранный месяц мог выпасть из нового диапазона — показываем ближайший (WEB-PAGES12).
  const months = data?.months ?? [];
  const month = clean ? selectedMonth : effectiveMonth(selectedMonth, months);
  // Исторического снимка воронки нет: прогноз сервера использует сегодняшние
  // открытые сделки и не описывает состояние выбранного прошлого месяца.
  const canForecast = can("finance.view") && month === currentMonth();
  const { data: forecast } = useExpenseForecast();
  // Тот же прогноз, что уже показывает CommissionForecastCard ниже (общий
  // queryKey — второго запроса по сети не будет): план и процент к нему
  // для полосы под крупной цифрой на телефоне — реальные числа, не выдуманные.
  const { data: commissionForecast } = useCommissionForecast(canForecast, month);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const index = months.findIndex((m) => m.month === month);
  const current: FinanceMonth | undefined = index >= 0 ? months[index] : undefined;
  const previous: FinanceMonth | undefined = index > 0 ? months[index - 1] : undefined;
  const emptyOngoingMonth = clean && current?.month === currentMonth() && current.revenue === 0 && current.totalExpenses === 0;

  function openSection(id: string, next: typeof workspace) {
    if (!clean) { scrollToSection(id); return; }
    if (workspace === next) { scrollToSection(id); return; }
    pendingSection.current = id;
    setWorkspace(next);
  }

  function exportCsv() {
    // Выгрузка — не мутация, и общий тост об ошибках сюда не приходит.
    // Проглоченный отказ выглядел так: жмёшь, файла нет, объяснения нет.
    setExportError(null);
    if (exporting) return;
    setExporting(true);
    downloadFinanceCsv(rangeMonths).catch((err) =>
      setExportError(err instanceof Error ? err.message : "Не удалось выгрузить файл")
    ).finally(() => setExporting(false));
  }

  // Шапка макета и прежняя шапка экрана стояли друг над другом: на телефоне
  // заголовок «Финансы» с подписью печатался ДВАЖДЫ (владелец, 15.09.2026).
  // Убираем прежнюю ровно тогда, когда отрисована макетная, — и только её
  // текстовую часть: кнопки «Скачать CSV» и «Архив» живут в том же `.pg-h`
  // и нужны на обеих ширинах.
  const mhHeaderShown = mobile && !clean && current !== undefined;

  if (clean) return <FinanceFrame clean><ClaudeMoneyPage month={month} onMonthChange={setSelectedMonth} workspace={workspace} onWorkspaceChange={setWorkspace} canManage={canManage} archiveAllowed={can("archive.view")} onExport={exportCsv} exporting={exporting} exportError={exportError} overview={<>
    {error ? <CleanLoadError title="Финансовая сводка" retry={refetch} /> : isLoading ? <p className="cef-muted" role="status">Загружаем финансовую сводку…</p> : <>
      <div className="cef-overview-period"><label>Графики за<select value={rangeMonths} onChange={(event) => setRangeMonths(Number(event.target.value))}>{RANGE_OPTIONS.map((option) => <option key={option.months} value={option.months}>{option.label}</option>)}</select></label></div>
      {current ? <div className="cef-summary-grid">
        <div className="cef-card"><span className="cef-muted">Валовая комиссия</span><strong className="cef-kpi">{nums(current.revenue)} с.</strong></div>
        <div className="cef-card"><span className="cef-muted">Доход компании</span><strong className="cef-kpi">{nums(current.companyRevenue)} с.</strong></div>
        <div className="cef-card"><span className="cef-muted">Операционные расходы</span><strong className="cef-kpi">{nums(current.operatingExpenses)} с.</strong></div>
        <div className="cef-card"><span className="cef-muted">Прибыль</span><strong className="cef-kpi">{nums(current.profit)} с.</strong></div>
      </div> : <div className="cef-card"><h2>Нет сводки за выбранный месяц</h2><p className="cef-muted">Это отсутствие данных, а не подтверждённый нулевой результат.</p></div>}
      <PulseTiles onOpen={(section) => section === "expenses"
        ? openSection("finance-panel-expenses", "expenses")
        : scrollToSection("profit-chart-section")} />
      <CommissionForecastCard enabled={canForecast} month={month} />
      <div className="cef-chart-grid"><ProfitChart months={months} responsive /><CommissionChartSection months={months} responsive /></div>
      <div className="cef-chart-grid"><CostPerLeadSection current={current} /><CostPerDealSection current={current} /></div>
    </>}
  </>} payouts={<>
    {error ? <CleanLoadError title="Выплаты агентам" retry={refetch} /> : isLoading ? <p role="status">Загружаем выплаты…</p> : <><PayoutsSection current={current} />{(!current || current.payouts.length === 0) && <div className="cef-card"><h2>Выплаты агентам</h2><p className="cef-muted">За выбранный месяц нет начисленных долей в закрытых сделках.</p></div>}</>}
  </>} /></FinanceFrame>;

  return (
    <FinanceFrame clean={clean}>
      {mobile && !clean && current && (
        <div className="rh2" style={MH_HOST}>
          <div className="mh">
            <ShellOwnHeader />
            <div className="top">
              <div className="grow">
                <h1 className="s">Финансы</h1>
              </div>
            </div>
            <div className="body">
              <div className="sec" style={{ marginTop: 6 }}>
                <MhMoney
                  amount={`${nums(current.profit)} с.`}
                  sub={
                    canForecast && commissionForecast
                      ? `прибыль за ${MONTHS_ACC[monthIndex(current.month)]} · прогноз валовой комиссии: ${commissionForecast.percentOfPlan} % плана ${nums(commissionForecast.planTjs)} с.`
                      : `прибыль за ${MONTHS_ACC[monthIndex(current.month)]}`
                  }
                  percent={null}
                />
              </div>
              <MhSection title="Расходы месяца">
                <div className="card-s">
                  {(Object.entries(current.expenses) as [ExpenseCategory, number | undefined][])
                    .filter(([, v]) => (v ?? 0) > 0)
                    .map(([cat, v]) => (
                      <div className="row" key={cat}>
                        <span className="t">
                          <span className="n">{EXPENSE_CATEGORY_LABELS[cat]}</span>
                        </span>
                        <span className="s">{nums(v ?? 0)} с.</span>
                      </div>
                    ))}
                  {current.totalExpenses === 0 && <p className="state">Расходов за этот месяц ещё нет.</p>}
                </div>
              </MhSection>
            </div>
          </div>
        </div>
      )}
      <Rh2Screen>
        <div className="pg-h">
          {!mhHeaderShown && (
            <div>
              <h1>Финансы</h1>
              <p className="sub">{clean
                ? `${monthYear(month)} · итоги в сомони${data ? ` · 1 USD = ${data.usdToTjsRate.toLocaleString("ru-RU")} TJS` : ""}`
                : <>Доходы, расходы, прибыль и окупаемость рекламы. Итоги в сомони; долларовые суммы пересчитаны по курсу CRM{data ? `: 1 USD = ${data.usdToTjsRate.toLocaleString("ru-RU")} TJS` : "."}</>}</p>
            </div>
          )}
          <div className="acts">
            <button
              className="pill ghost"
              type="button"
              onClick={exportCsv}
              disabled={exporting}
              aria-busy={exporting}
              title="Полная выгрузка: каждая закрытая сделка с разбивкой комиссии и все расходы. Открывается в Excel."
            >
              {exporting ? "Готовим файл…" : "Скачать CSV"}
            </button>
            {can("archive.view") && (
              <Link className="pill ghost" to="/archive">
                Архив
              </Link>
            )}
          </div>
        </div>

        <MoneyTabs right={clean ? <div className="finance-workspace-nav !m-0 !shrink-0" role="tablist" aria-label="Разделы финансов" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
          const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          tabs[next]?.focus(); tabs[next]?.click();
        }}>
          {([
            ["expenses", "Расходы"], ["overview", "Обзор и прогноз"],
            ["payouts", "Выплаты агентам"], ["recurring", "Регулярные расходы"],
          ] as const).map(([key, label]) => <button type="button" role="tab" id={`finance-tab-${key}`} key={key} aria-selected={workspace === key} tabIndex={workspace === key ? 0 : -1} aria-controls={`finance-panel-${key}`} onClick={() => setWorkspace(key)}>{label}</button>)}
        </div> : undefined} />

        {/* Прогноз к концу месяца — сверху раздела, до сводки: на вопрос «сколько
            выйдет» отвечает он, а всё ниже отвечает «сколько уже вышло».
            Месяц берётся тот же, что выбран на экране. */}
        {!clean && <CommissionForecastCard enabled={canForecast} month={month} />}

        {/* Срок сводки — функция CRM, которой нет в макете: одета лентой сегментов. */}
        <div className="hscroll">
          <div className="seg" role="tablist" aria-label="Срок сводки">
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.months}
                type="button"
                role="tab"
                aria-selected={rangeMonths === r.months}
                onClick={() => setRangeMonths(r.months)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {data?.truncated && (
          <div className="state err" role="alert">
            Сводка достигла предела выборки: суммы могут быть неполными. Сократите период сводки.
          </div>
        )}
        {error && (
          <div className="state err" role="alert">
            <span className="dot crit" /> Финансовая сводка не загрузилась. Это сбой связи, а не нулевой месяц.
            <button
              className="lk"
              type="button"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={() => refetch()}
            >
              Повторить
            </button>
          </div>
        )}
        {exportError && (
          <div className="state err" role="alert">
            <span className="dot crit" /> {exportError}
          </div>
        )}
        {isLoading && !data && (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w22" /> Считаем деньги
          </div>
        )}
        {clean && data && months.length === 0 && !error && <p className="state">За выбранный период финансовых итогов пока нет.</p>}

        {/* Главная цифра месяца */}
        {current && (
          <div className="card" id="profit-hero-section">
            <div className="fhero">
              <div className="lead">
                <span className="k">Прибыль за {MONTHS_ACC[monthIndex(current.month)]}</span>
                <Rh2Money value={current.profit} cur="сомони" />
                <p className={clean ? "sub finance-definition" : "sub"}>
                  Доход компании {nums(current.companyRevenue)} минус расходы {nums(current.operatingExpenses)}.
                  {!clean && current.dealSalaryExpenses > 0
                    ? ` Доли агентов из сделок (${nums(current.dealSalaryExpenses)}) второй раз не вычитаем — они уже не входят в доход компании.`
                    : ""}
                  {!clean && previous ? ` В ${MONTHS_PREP[monthIndex(previous.month)]} было ${nums(previous.profit)}.` : ""}
                </p>
                {clean && (emptyOngoingMonth ? <span className="note">В текущем месяце пока нет учтённых операций. Месяц не завершён.</span> : <Rh2DeltaChip value={current.profit} previous={previous?.profit} periodLabel="в прошлом месяце" />)}
              </div>
              <div className="mons">
                <button
                  className="pill ghost sm icon"
                  type="button"
                  aria-label="Предыдущий месяц"
                  disabled={index <= 0}
                  onClick={() => months[index - 1] && setSelectedMonth(months[index - 1].month)}
                >
                  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m14 6-6 6 6 6" />
                  </svg>
                </button>
                <span className="chip">{monthYear(current.month)}</span>
                <button
                  className="pill ghost sm icon"
                  type="button"
                  aria-label="Следующий месяц"
                  disabled={index < 0 || index >= months.length - 1}
                  onClick={() => months[index + 1] && setSelectedMonth(months[index + 1].month)}
                >
                  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m10 6 6 6-6 6" />
                  </svg>
                </button>
              </div>
            </div>
            {!clean && <><div className="prog split" style={{ marginTop: 20 }} aria-hidden="true">
              <i style={{ "--v": Math.max(0, Math.round(current.profit)), background: "var(--ok)" } as React.CSSProperties} />
              <i style={{ "--v": Math.max(0, Math.round(current.operatingExpenses)), background: "var(--track)" } as React.CSSProperties} />
            </div>
            <div className="prog-legend">
              <span>
                <b>{nums(current.profit)}</b>осталось компании
              </span>
              <span>
                <b>{nums(current.operatingExpenses)}</b>ушло на расходы
              </span>
            </div></>}
          </div>
        )}

        {current && (
          <div className="tiles">
            <StatTile
              label="Комиссия за месяц"
              title={clean ? "Открыть обзор комиссии по месяцам" : "Комиссия по месяцам — график ниже"}
              onClick={() => openSection("commission-chart-section", "overview")}
              value={
                <>
                  <Rh2Money value={current.revenue} />
                  {/* Чип прироста только когда прошлый месяц ЕСТЬ в ответе
                      (`months[index - 1]`): в первом месяце работы и при выборе
                      самого раннего месяца диапазона сравнивать не с чем. */}
                  <Rh2DeltaChip value={current.revenue} previous={emptyOngoingMonth ? undefined : previous?.revenue} periodLabel="в прошлом месяце" />
                </>
              }
              line="всё, что заплатили клиенты"
            />
            <StatTile
              label={clean ? "Доли агентов" : "Агентам"}
              title={clean ? "Открыть выплаты агентам" : "Выплаты агентам — таблица ниже"}
              onClick={() => openSection(clean ? "finance-payouts-workspace" : "payouts-section", "payouts")}
              value={<Rh2Money value={current.realtorPayouts} />}
              line={clean ? "из комиссии закрытых сделок" : "риелторам, продавшим объекты"}
            />
            <StatTile
              label="Доход компании"
              title={clean ? "Открыть обзор прибыли по месяцам" : "Прибыль по месяцам — график ниже"}
              onClick={() => openSection("profit-chart-section", "overview")}
              value={
                <>
                  <Rh2Money value={current.companyRevenue} />
                  <Rh2DeltaChip
                    value={current.companyRevenue}
                    previous={emptyOngoingMonth ? undefined : previous?.companyRevenue}
                    periodLabel="в прошлом месяце"
                  />
                </>
              }
              line="комиссия минус доли агентов"
            />
            <StatTile
              label="Расходы за месяц"
              title={clean ? "Открыть расходы месяца" : "Расходы месяца — список ниже"}
              onClick={() => openSection("expenses-workspace", "expenses")}
              value={
                <>
                  <Rh2Money value={current.totalExpenses} />
                  {/* У расходов рост — плохо, поэтому цвет чипа перевёрнут. */}
                  <Rh2DeltaChip
                    value={current.totalExpenses}
                    previous={emptyOngoingMonth ? undefined : previous?.totalExpenses}
                    positiveIsGood={false}
                    periodLabel="в прошлом месяце"
                  />
                  {forecast?.month === current.month && forecast.overrun && (
                    <span className="dot warn" style={{ marginLeft: 6 }} title="Перерасход по прогнозу" />
                  )}
                </>
              }
              line="реклама, зарплаты, офис"
            />
          </div>
        )}

        {clean ? <div className="cols2 [&_.trio]:!grid-cols-3 [&_.trio_.money]:!text-[24px] [&_.sec-h]:!flex-wrap [&_.note]:!text-sm">
          <ProfitChart months={months} />
          <PulseTiles compact onOpen={(section) => section === "expenses"
            ? openSection("expenses-workspace", "expenses")
            : scrollToSection(section === "profit" ? "profit-chart-section" : "profit-hero-section")} />
        </div> : <PulseTiles />}

        <div id="expenses-workspace" hidden={clean && workspace !== "expenses"}>
          <div id="finance-panel-expenses" role={clean ? "tabpanel" : undefined} aria-labelledby={clean ? "finance-tab-expenses" : undefined}>
          <ExpensesWorkspace
            month={month}
            canManage={canManage}
            usdToTjs={data?.usdToTjsRate ?? FALLBACK_USD_TO_TJS}
          />
          </div>
        </div>

        {/* Шесть нижних разделов — попарно в ряд на широком экране (`.cols2`,
            theme-royal-home-2026.css): два графика, два денежных списка, две
            полосы стоимости. Пары выбраны по соседству и совместимости, а не
            сеткой на весь экран: выше идут шапка, лента сроков, «Прибыль за
            месяц» и плитки — им нужна вся ширина, и общая сетка оставила бы
            полупустые ряды. «Пульс» и «Расходы» тоже остаются однорядными:
            первый — лента плиток, второй — рабочий стол расходов со своей
            лентой месяцев. Ниже 1280 px порядок прежний. */}
        {clean ? <>
          <div hidden={workspace !== "overview"} id="finance-panel-overview" role="tabpanel" aria-labelledby="finance-tab-overview" className="finance-overview-workspace">{workspace === "overview" && <>
            {error ? <CleanLoadError title="Финансовая сводка" retry={refetch} /> : <>
            <CommissionForecastCard enabled={canForecast} month={month} />
            <CommissionChartSection months={months} />
            <div className="cols2"><CostPerLeadSection current={current} /><CostPerDealSection current={current} /></div>
            </>}
          </>}</div>
          <div hidden={workspace !== "recurring"} id="finance-panel-recurring" role="tabpanel" aria-labelledby="finance-tab-recurring">{workspace === "recurring" && <>
            <p className="finance-workspace-note">Шаблоны регулярных расходов. Созданные по ним расходы учитываются в списке месяца; сам шаблон не является оплатой.</p>
            {canManage && <button className="pill ghost" type="button" onClick={() => openSection("expenses-workspace", "expenses")}>Перейти к добавлению расхода</button>}
            <RecurringSection canManage={canManage} />
          </>}</div>
          <div hidden={workspace !== "payouts"} id="finance-payouts-workspace">
            <div id="finance-panel-payouts" role="tabpanel" aria-labelledby="finance-tab-payouts">{workspace === "payouts" && <>
            {error && <CleanLoadError title="Выплаты агентам" retry={refetch} />}
            <PayoutsSection current={current} />
            {current && current.payouts.length === 0 && <div className="card"><h2>Выплаты агентам</h2><p className="sub">За {MONTHS_ACC[monthIndex(current.month)]} в закрытых сделках нет начисленных долей агентов.</p></div>}
            </>}</div>
          </div>
        </> : <>
        <div className="cols2">
          <ProfitChart months={months} />
          <CommissionChartSection months={months} />
        </div>
        <div className="cols2">
          <RecurringSection canManage={canManage} />
          <PayoutsSection current={current} />
        </div>
        <div className="cols2">
          <CostPerLeadSection current={current} />
          <CostPerDealSection current={current} />
        </div>
        </>}
      </Rh2Screen>
    </FinanceFrame>
  );
}

/** «Прибыль по месяцам» — свой SVG прототипа: столбцы, оси, подписи, подсказка. */
function ProfitChart({ months, responsive = false }: { months: FinanceMonth[]; responsive?: boolean }) {
  if (months.length === 0) return null;
  const last = months[months.length - 1];
  return (
    <div className="sec" id="profit-chart-section">
      <div className="sec-h">
        <h2>Прибыль по месяцам</h2>
        <span className="note">доход компании минус расходы, {months.length} мес.</span>
      </div>
      <div className="card tight">
        <Rh2BarChart
          responsive={responsive}
          ariaLabel={`Прибыль по месяцам: ${months
            .map((m) => `${MONTHS_ACC[monthIndex(m.month)]} ${nums(m.profit)}`)
            .join(", ")} сомони`}
          lastValueLabel={nums(last.profit)}
          items={months.map((m) => ({
            key: m.month,
            label: MONTHS_SHORT[monthIndex(m.month)],
            value: m.profit,
            tip: `${monthYear(m.month)}|${nums(m.profit)} сомони прибыли`,
          }))}
        />
        <div className="lgd">
          <span>
            <i />
            текущий месяц
          </span>
          <span>
            <i className="alt" />
            прошлые месяцы
          </span>
        </div>
        <p className="state">Коснитесь столбца, чтобы увидеть месяц и сумму.</p>
      </div>
    </div>
  );
}

/**
 * «Комиссия по месяцам» — блок, который был только на телефоне (MobileFinance).
 * Перенесён на общий экран тем же графиком прототипа, чтобы не пропасть.
 */
function CommissionChartSection({ months, responsive = false }: { months: FinanceMonth[]; responsive?: boolean }) {
  if (months.length === 0) return null;
  const last = months[months.length - 1];
  return (
    <div className="sec" id="commission-chart-section">
      <div className="sec-h">
        <h2>Комиссия по месяцам</h2>
        <span className="note">всё, что заплатили клиенты, сомони</span>
      </div>
      <div className="card tight">
        <Rh2BarChart
          responsive={responsive}
          ariaLabel={`Комиссия по месяцам: ${months
            .map((m) => `${MONTHS_ACC[monthIndex(m.month)]} ${nums(m.revenue)}`)
            .join(", ")} сомони`}
          lastValueLabel={nums(last.revenue)}
          items={months.map((m) => ({
            key: m.month,
            label: MONTHS_SHORT[monthIndex(m.month)],
            value: m.revenue,
            tip: `${monthYear(m.month)}|${nums(m.revenue)} сомони комиссии`,
          }))}
        />
        <p className="state">Коснитесь столбца, чтобы увидеть месяц и сумму.</p>
      </div>
    </div>
  );
}

/**
 * Дата выплаты рядом со сделкой (ночная проверка 24.09.2026, находка №206):
 * до этого «Выплаты агентам» показывали только суммы — не было видно, выплачена
 * ли комиссия и когда, хотя окно документов сделки (DealDocumentsModal) это уже
 * знает. Пусто, пока в сделках агента вообще нечего выплачивать (сюда не
 * попадает — deals собраны только из сделок с realtor > 0, см. routes/expenses.ts).
 */
function agentPayoutStatus(deals: AgentPayoutDeal[]): string {
  const unpaid = deals.filter((d) => !d.payoutAt).length;
  if (unpaid === 0) {
    // Самая свежая дата выплаты — сравнение ISO-строк лексикографическое, для
    // "YYYY-MM-DD..." это то же, что сравнение дат.
    const latest = deals.reduce((max, d) => (d.payoutAt! > max ? d.payoutAt! : max), deals[0]?.payoutAt ?? "");
    return latest ? `выплачено ${new Date(latest).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe" })}` : "";
  }
  if (unpaid === deals.length) return "не выплачено";
  return `выплачено ${deals.length - unpaid} из ${deals.length}`;
}

/**
 * Прозрачность выплат: кому и за что причитается в выбранном месяце. Каждая
 * цифра выводится из зафиксированных долей закрытых сделок, скрытых начислений нет.
 */
function PayoutsSection({ current }: { current: FinanceMonth | undefined }) {
  if (!current || current.payouts.length === 0) return null;
  return (
    <div className="sec" id="payouts-section">
      <div className="sec-h">
        <h2>Выплаты агентам</h2>
        <span className="note">
          по зафиксированным долям закрытых сделок, {MONTHS_ACC[monthIndex(current.month)]}
        </span>
      </div>
      <div className="card tight">
        <div className="tbl-wrap" {...scrollableRegion("Финансы по агентам")}>
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Агент</th>
                <th scope="col" className="num">За продажу</th>
                <th scope="col" className="num">Итого</th>
                <th scope="col">Выплата</th>
              </tr>
            </thead>
            <tbody>
              {current.payouts.map((p) => (
                <tr key={p.agentId}>
                  <td>{p.name}</td>
                  <td className="num">{p.realtor ? nums(p.realtor) : "нет"}</td>
                  <td className="num">
                    <Rh2Money value={p.total} />
                  </td>
                  <td className="quiet">{agentPayoutStatus(p.deals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** «Стоимость лида» — полосы прототипа: чем короче полоса, тем дешевле лид. */
function CostPerLeadSection({ current }: { current: FinanceMonth | undefined }) {
  const rows = (current?.costPerLead ?? []).filter((c) => c.costPerLead !== null);
  return (
    <div className="sec">
      <div className="sec-h">
        <h2>Стоимость лида</h2>
        <span className="note">этот месяц, по расходам категории «Реклама»</span>
      </div>
      <div className="card tight">
        {rows.length === 0 ? (
          <p className="state">
            Добавьте расход категории «Реклама» с каналом: CRM посчитает стоимость лида по каждому каналу сама.
          </p>
        ) : (
          <>
            <Rh2Bars
              items={rows.map((c) => {
                const max = Math.max(...rows.map((r) => r.costPerLead ?? 0), 1);
                return {
                  key: c.source,
                  name: CLIENT_SOURCE_LABELS[c.source],
                  share: (c.costPerLead ?? 0) / max,
                  value: `${nums(c.costPerLead ?? 0)} с`,
                };
              })}
            />
            <p className="state">
              Чем короче полоса, тем дешевле лид. Каналы без лидов за месяц в список не попадают.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * «Сомони за сделку» — тот же расход канала, но на число ЗАКРЫТЫХ сделок, не на
 * все лиды: воронка короче, и без расхода или сделок канала строка не рисуется
 * вовсе (costPerDeal === null, решение владельца). Блока нет в макете, одет
 * теми же полосами, что и «Стоимость лида».
 */
function CostPerDealSection({ current }: { current: FinanceMonth | undefined }) {
  const rows = (current?.costPerLead ?? []).filter((c) => c.costPerDeal !== null);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.costPerDeal ?? 0), 1);
  return (
    <div className="sec">
      <div className="sec-h">
        <h2>Сомони за сделку</h2>
        <span className="note">расход канала, делённый на закрытые сделки месяца</span>
      </div>
      <div className="card tight">
        <Rh2Bars
          items={rows.map((c) => ({
            key: c.source,
            name: CLIENT_SOURCE_LABELS[c.source],
            share: (c.costPerDeal ?? 0) / max,
            value: `${nums(c.costPerDeal ?? 0)} с`,
          }))}
        />
        <p className="state">Чем короче полоса, тем дешевле обошлась сделка этого канала.</p>
      </div>
    </div>
  );
}
