import { ShellOwnHeader } from "../components/rh2/ShellOwnHeader";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ClientSource } from "@royal-home/shared";
import { reportDateRangeError } from "@royal-home/shared";
import { useCan } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import { useMobileUx } from "../hooks/useMobileUx";
import {
  downloadPropertiesExport,
  useAgentsReport,
  useFunnelReport,
  useSourcesReport,
  useHotProperties,
  type AgentReportRow,
  type FunnelStage,
} from "../hooks/useReports";
import { CLIENT_SOURCE_LABELS } from "../lib/clientFormat";
import { pluralizeRu } from "../lib/format";
import { dushanbeDayKey, dushanbeFirstDayOfMonthKey, dushanbeTodayKey } from "../lib/date";
import { isFunnelEmpty, selectFunnelStages } from "../lib/reportFunnelView";
import { MonthlyReports } from "../components/MonthlyReports";
import { ProblemReports } from "../components/ProblemReports";
import { DemandSupplySection } from "../components/DemandSupplySection";
import { Rh2Money } from "../components/rh2/Rh2Money";
import { Rh2Bars } from "../components/rh2/Rh2Bars";
import { Rh2Donut } from "../components/rh2/Rh2Donut";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import { MoneyTabs } from "../components/SectionTabs";
import { scrollableRegion } from "../lib/a11y";
import { useCleanShell } from "../hooks/useCleanShell";
import { StatTile } from "../components/ui/StatTile";

/**
 * ОТЧЁТЫ — экран /reports темы «Royal Home 2026», перенесённый из прототипа
 * (`docs/pult/theme-2026/screens/reports.html`) дословно: разметка, имена
 * классов, порядок блоков и подписи из макета.
 *
 * Один экран на компьютер и телефон: раскладку ≤820 px даёт сам прототип
 * (`.only-wide` / `.only-narrow`, `.hscroll`, `.bars`), поэтому отдельного
 * `MobileReports.tsx` больше нет и расходиться нечему.
 *
 * Сверх прототипа сохранены функции, которые экран уже умел: пресеты периода с
 * телефона (Неделя / Месяц / Год) вместе с двумя полями дат десктопа, «Топ по
 * показам», кольцо «Откуда приходят», «Месячные отчёты», «Разбор проблемных
 * мест» и тихая строка для агента. Все они одеты прототипными классами.
 *
 * Раздела «Комиссия по месяцам» из макета здесь нет: /reports такой ряд не
 * отдаёт, а рисовать выдуманные цифры нельзя. Комиссия по месяцам живёт на
 * «Деньгах», где под неё есть настоящие данные.
 */

export const PRESETS = [
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
  { key: "year", label: "Год" },
] as const;
export type PresetKey = (typeof PRESETS)[number]["key"];

/** Границы периода — днями ПО ДУШАНБЕ (границы суток только через lib/date). */
export function presetRange(preset: PresetKey): { from: string; to: string } {
  const to = dushanbeTodayKey();
  if (preset === "week") return { from: dushanbeDayKey(Date.now() - 6 * 24 * 60 * 60 * 1000), to };
  if (preset === "month") return { from: dushanbeFirstDayOfMonthKey(), to };
  return { from: `${to.slice(0, 4)}-01-01`, to };
}

export function dot(dateKey: string): string {
  const [y, m, d] = dateKey.split("-");
  return `${d}.${m}.${y}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

export function nums(value: number): string {
  return Math.round(value).toLocaleString("ru-RU");
}

/** Плитка ведёт не по маршруту, а к разделу этого же экрана (владелец, 15.09.2026). */
function scrollToSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  section.tabIndex = -1;
  section.focus({ preventScroll: true });
  section.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

/** Сколько строк видно до нажатия «Показать ещё» (правило владельца 8). */
export const PAGE = 5;

export function Reports() {
  const can = useCan();

  if (!can("reports.view")) {
    return (
      <Rh2Screen>
          <div className="pg-h">
            <div>
              <h1>Отчёты</h1>
              <p className="sub">Нет доступа к отчётам. Уточните права у администратора.</p>
            </div>
          </div>
      </Rh2Screen>
    );
  }

  return <ReportsScreen />;
}

/** Область во всю ширину — те же значения, что MH_HOST в MhScreen.tsx/MhList.tsx. */
const MH_HOST: import("react").CSSProperties = {
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  display: "flex",
  flexDirection: "column",
};

function ReportsFrame({ clean, children }: { clean: boolean; children: ReactNode }) {
  return clean ? <div className="clean-reports [&_.pg-h_h1]:!text-[32px] [&_.sec-h_h2]:!text-xl [&_.note]:!text-sm [&_.sub]:!text-base [&_.tbl]:!text-sm [&_.bars]:!text-base [&_.tiles]:!gap-4 [&_.tiles]:!grid-cols-2 min-[1180px]:[&_.tiles]:!grid-cols-4 [&_.tiles_.money]:!text-[28px]">{children}</div> : <>{children}</>;
}

function ReportsScreen() {
  const can = useCan();
  // 14.09.2026: на телефоне сверху — дословная сводка макета c99db05f
  // (`renderReports`): плитки и «По агентам» списком в обёртке `.rh2 .mh`.
  // Хуки, запросы и права общие для обеих ширин — ветвится только разметка.
  const mobile = useMobileUx();
  const clean = useCleanShell();
  const isAgent = useAuthStore((s) => s.agent?.role) === "AGENT";
  const [preset, setPreset] = useState<PresetKey | "custom">("month");
  const [from, setFrom] = useState(dushanbeFirstDayOfMonthKey());
  const [to, setTo] = useState(dushanbeTodayKey());
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [agentsShown, setAgentsShown] = useState(PAGE);

  const range = { from, to };
  const rangeError = reportDateRangeError(from, to);
  const {
    data: funnelData,
    isLoading: funnelLoading,
    isError: funnelError,
    error: funnelErrObj,
    refetch: refetchFunnel,
  } = useFunnelReport(range, !rangeError);
  const {
    data: agentsData,
    isLoading: agentsLoading,
    isError: agentsError,
    error: agentsErrObj,
    refetch: refetchAgents,
  } = useAgentsReport(range, !rangeError);
  const { data: sourcesData, isLoading: sourcesLoading, isError: sourcesError, refetch: refetchSources } = useSourcesReport(range, !rangeError);

  function applyPreset(key: PresetKey) {
    const r = presetRange(key);
    setPreset(key);
    setFrom(r.from);
    setTo(r.to);
    setAgentsShown(PAGE);
  }

  async function exportProperties(format: "csv" | "json") {
    setExportError(null);
    setExporting(format);
    try {
      await downloadPropertiesExport(format);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Не удалось выгрузить объекты");
    } finally {
      setExporting(null);
    }
  }

  const funnel: FunnelStage[] = funnelData?.funnel ?? [];
  const funnelMax = Math.max(1, ...funnel.map((s) => s.count));
  const { leads, showings, negotiations, deals } = selectFunnelStages(funnel);
  const toDeal = leads && deals && leads.count > 0 ? Math.round((deals.count / leads.count) * 100) : null;
  const toNegotiation =
    showings && negotiations && showings.count > 0 ? Math.round((negotiations.count / showings.count) * 100) : null;

  const agents = agentsData ?? [];
  const agentsVisible = agents.slice(0, agentsShown);
  // Без права на финансы сервер не отдаёт комиссию (null) — тогда полосы по сделкам.
  const seesMoney = agents.some((a) => a.commission !== null);
  const commissionMax = Math.max(1, ...agents.map((a) => a.commission ?? 0));
  const dealsMax = Math.max(1, ...agents.map((a) => a.dealsClosed));
  const topByShowings = [...agents].filter((a) => a.showings > 0).sort((a, b) => b.showings - a.showings).slice(0, 5);
  const showingsMax = Math.max(1, ...topByShowings.map((a) => a.showings));

  const donutRows = (sourcesData?.sources ?? []).filter((s) => s.total > 0).sort((a, b) => b.total - a.total);
  const donutTotal = donutRows.reduce((s, x) => s + x.total, 0);

  // Шапка макета и прежняя шапка экрана стояли друг над другом: на телефоне
  // заголовок «Отчёты» с подписью печатался ДВАЖДЫ (владелец, 15.09.2026).
  // Убираем прежнюю ровно тогда, когда отрисована макетная, — и только её
  // текстовую часть: кнопки выгрузки живут в том же `.pg-h` и нужны на обеих
  // ширинах.
  const mhHeaderShown = !rangeError && mobile && !clean && !funnelLoading && !funnelError && funnel.length > 0;

  return (
    <ReportsFrame clean={clean}>
      {mhHeaderShown && (
        <div className="rh2" style={MH_HOST}>
          <div className="mh">
            <ShellOwnHeader />
            <div className="top">
              <div className="grow">
                <h1 className="s">Отчёты</h1>
              </div>
            </div>
            <div className="body">
              {/* Плитки-сводка — макет `renderReports`: прибыль/лиды/сделки/конверсия.
                  На /reports нет «прибыли» — первая плитка честно про комиссию за
                  период (то же число, что и в воронке ниже), выдумывать нельзя. */}
              <div className="sec" style={{ marginTop: 4 }}>
                {/* Плитки телефонной сводки: markup .v/.l из макета `renderReports`
                    (`.rh2 .mh .tile`), отдельный от эталонной `.hd`/`b`/`small` —
                    StatTile сюда не встаёт, класс `.tile` остаётся на кликабельном
                    теге, чтобы стиль не поменялся (владелец, 15.09.2026: плитки
                    должны вести куда-нибудь; здесь — к воронке за период ниже). */}
                <div className="tiles">
                  {deals?.commission != null && (
                    <button type="button" className="tile" onClick={() => scrollToSection("funnel-section")} title="Воронка за период — ниже">
                      <div className="v">{nums(deals.commission)} с.</div>
                      <div className="l">комиссия за период</div>
                    </button>
                  )}
                  <button type="button" className="tile" onClick={() => scrollToSection("funnel-section")} title="Воронка за период — ниже">
                    <div className="v">{leads?.count ?? "—"}</div>
                    <div className="l">новых лидов</div>
                  </button>
                  <button type="button" className="tile" onClick={() => scrollToSection("funnel-section")} title="Воронка за период — ниже">
                    <div className="v">{deals?.count ?? "—"}</div>
                    <div className="l">закрытых сделок</div>
                  </button>
                  <button type="button" className="tile" onClick={() => scrollToSection("funnel-section")} title="Воронка за период — ниже">
                    <div className="v">{toDeal !== null ? `${toDeal} %` : "—"}</div>
                    <div className="l">сделки / новые лиды за период</div>
                  </button>
                </div>
              </div>
              {agents.length > 0 && (
                <div className="sec">
                  <div className="sec-t">
                    <h2>По агентам</h2>
                  </div>
                  <div className="card-s">
                    {topByShowings.length > 0
                      ? topByShowings.map((row) => (
                          <div className="row" key={row.agentId}>
                            <span className="t">
                              <span className="n">{row.agentName}</span>
                              <span className="s">
                                {row.dealsClosed} {row.dealsClosed === 1 ? "сделка" : "сделок"}
                                {row.commission !== null && ` · ${nums(row.commission)} с.`}
                              </span>
                            </span>
                          </div>
                        ))
                      : agentsVisible.slice(0, 5).map((row) => (
                          <div className="row" key={row.agentId}>
                            <span className="t">
                              <span className="n">{row.agentName}</span>
                              <span className="s">
                                {row.dealsClosed} {row.dealsClosed === 1 ? "сделка" : "сделок"}
                                {row.commission !== null && ` · ${nums(row.commission)} с.`}
                              </span>
                            </span>
                          </div>
                        ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <Rh2Screen>
        <div className="pg-h">
          {!mhHeaderShown && (
            <div>
              <h1>Отчёты</h1>
              <p className="sub">
                {clean ? (isAgent ? "Ваши показатели по фактическим записям CRM." : "Показатели команды по фактическим записям CRM.") : <>Воронка и эффективность агентов за период. Считается по фактическим записям CRM, вручную ничего не правится.</>}
              </p>
            </div>
          )}
          {/* Выгрузки — под своим правом: сервер их всё равно закроет, а кнопка,
              дающая отказ, только раздражает. */}
          {can("properties.export") && (
            <div className="acts">
              {clean && <details className="relative text-sm">
                <summary className="min-h-11 cursor-pointer rounded-xl px-4 py-3">Вспомогательная выгрузка объектов</summary>
                <div className="flex flex-wrap gap-2 py-3">
                  <button className="pill ghost" type="button" disabled={exporting !== null} onClick={() => exportProperties("csv")}>Объекты CSV</button>
                  <button className="pill ghost" type="button" disabled={exporting !== null} onClick={() => exportProperties("json")}>Объекты JSON</button>
                </div>
                <p className="max-w-[42ch] text-sm text-gray">Список объектов, а не выгрузка отчёта за выбранный период.</p>
              </details>}
              {!clean && <>
              <button
                className="pill ghost"
                type="button"
                disabled={exporting !== null}
                onClick={() => exportProperties("csv")}
              >
                Объекты CSV
              </button>
              <button
                className="pill ghost"
                type="button"
                disabled={exporting !== null}
                onClick={() => exportProperties("json")}
              >
                Объекты JSON
              </button>
              </>}
            </div>
          )}
        </div>

        <MoneyTabs />
        {clean && <nav className="clean-report-section-nav" aria-label="Разделы отчётов">
          {[["funnel-section", "Воронка"], ["agents-report-section", "Команда"], ["sources-report-section", "Источники"], ["hot-properties-section", "Объекты"]].map(([id, label]) => <button key={id} type="button" onClick={() => scrollToSection(id)}>{label}</button>)}
        </nav>}

        {exportError && (
          <div className="state err">
            <span className="dot crit" /> {exportError}
          </div>
        )}

        <div className={clean ? "card tight !px-5 !py-4" : "card tight"}>
          <div className={clean ? "filters !items-end !gap-4 [&_.lab]:!text-sm [&_.inp]:!min-h-11 [&_.inp]:!text-base [&_.seg_button]:!min-h-11 [&_.seg_button]:!text-sm" : "filters"}>
            <div className="hscroll">
              <div className="seg" role="tablist" aria-label="Период отчёта">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    role="tab"
                    aria-selected={preset === p.key}
                    onClick={() => applyPreset(p.key)}
                  >
                    {p.label}
                  </button>
                ))}
                <button type="button" role="tab" aria-selected={preset === "custom"} onClick={() => setPreset("custom")}>
                  Свой период
                </button>
              </div>
            </div>
            <label className="field">
              <span className="lab">С какого дня</span>
              <input
                className="inp"
                type="date"
                value={from}
                style={{ maxWidth: 180 }}
                onChange={(e) => {
                  setPreset("custom");
                  setFrom(e.target.value);
                  setAgentsShown(PAGE);
                }}
              />
            </label>
            <label className="field">
              <span className="lab">По какой день</span>
              <input
                className="inp"
                type="date"
                value={to}
                style={{ maxWidth: 180 }}
                onChange={(e) => {
                  setPreset("custom");
                  setTo(e.target.value);
                  setAgentsShown(PAGE);
                }}
              />
            </label>
            <button
              className={clean ? "pill ghost" : "pill"}
              type="button"
              onClick={() => {
                refetchFunnel();
                refetchAgents();
                refetchSources();
              }}
              disabled={!!rangeError}
            >
              Обновить
            </button>
          </div>
        </div>

        {rangeError ? <p className="state err" role="alert">{rangeError}. Исправьте период, чтобы увидеть показатели.</p> : <>
        {clean && funnelData && !funnelLoading && !funnelError && <div className="tiles" aria-label="Основные показатели за выбранный период">
          <StatTile label="Новые лиды" value={leads?.count ?? "—"} line="за выбранный период" onClick={() => scrollToSection("funnel-section")} />
          <StatTile label="Показы" value={showings?.count ?? "—"} line="за выбранный период" onClick={() => scrollToSection("funnel-section")} />
          <StatTile label="Закрытые сделки" value={deals?.count ?? "—"} line="за выбранный период" onClick={() => scrollToSection("funnel-section")} />
          {deals?.commission != null
            ? <StatTile label="Комиссия" value={<Rh2Money value={deals.commission} cur="сомони" />} line="по закрытым сделкам" onClick={() => scrollToSection("funnel-section")} />
            : <StatTile label="Сделки / новые лиды" value={toDeal === null ? "—" : `${toDeal} %`} line="соотношение событий за период" onClick={() => scrollToSection("funnel-section")} />}
        </div>}

        {/* Воронка за период */}
        <div className="sec" id="funnel-section">
          <div className="sec-h">
            <h2>Воронка за период</h2>
            <span className="note">
              {dot(from)} по {dot(to)}
            </span>
          </div>
          <div className="card tight">
            {funnelLoading ? (
              <div className="state">
                <span className="sk w40" />
                <span className="sk w28" /> Считаем отчёт
              </div>
            ) : funnelError ? (
              /* Раньше отказ загрузки просто оставлял блок пустым навсегда: ни
                 сообщения, ни способа повторить, владелец сам бы решил, что
                 воронка «сломалась». */
              <div className="state err">
                <span className="dot crit" />{" "}
                {funnelErrObj instanceof Error ? funnelErrObj.message : "Воронка не загрузилась"}. Это сбой связи, а не
                нулевой период.
                <button
                  className="lk"
                  type="button"
                  style={{ color: "inherit", textDecoration: "underline" }}
                  onClick={() => refetchFunnel()}
                >
                  Повторить
                </button>
              </div>
            ) : isFunnelEmpty(funnel) ? (
              <div className="empty">
                <span className="ic">
                  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
                  </svg>
                </span>
                <p>За этот период показов и сделок не было. Выберите период пошире, например текущий месяц.</p>
                <button className="pill ghost" type="button" onClick={() => applyPreset("month")}>
                  Показать месяц
                </button>
              </div>
            ) : (
              <>
                <Rh2Bars
                  items={funnel.map((s) => ({
                    key: s.key,
                    name: s.label,
                    share: s.count / funnelMax,
                    value: String(s.count),
                  }))}
                />
                <div className="prog-legend" style={{ marginTop: 16 }}>
                  {toDeal !== null && (
                    <span>
                      <b>{toDeal} %</b>сделки / новые лиды за период
                    </span>
                  )}
                  {toNegotiation !== null && (
                    <span>
                      <b>{toNegotiation} %</b>переговоры / показы за период
                    </span>
                  )}
                  {deals?.commission != null && (
                    <span>
                      <b>
                        <Rh2Money value={deals.commission} />
                      </b>
                      комиссия за период
                    </span>
                  )}
                </div>
                {(toDeal !== null || toNegotiation !== null) && <p className="note">
                  Это соотношения событий, а не конверсия одних и тех же клиентов. События считаются по своим датам,
                  поэтому результат может быть больше 100 %.
                </p>}
              </>
            )}
          </div>
        </div>

        {/* Эффективность по агентам */}
        <div className="sec" id="agents-report-section">
          <div className="sec-h">
            <h2>Эффективность по агентам</h2>
            <span className="note">
              {dot(from)} по {dot(to)}
            </span>
          </div>
          <div className="card tight">
            {agentsLoading ? (
              <div className="state">
                <span className="sk w40" />
                <span className="sk w28" /> Считаем отчёт
              </div>
            ) : agentsError ? (
              <div className="state err">
                <span className="dot crit" />{" "}
                {agentsErrObj instanceof Error ? agentsErrObj.message : "Эффективность по агентам не загрузилась"}.
                <button
                  className="lk"
                  type="button"
                  style={{ color: "inherit", textDecoration: "underline" }}
                  onClick={() => refetchAgents()}
                >
                  Повторить
                </button>
              </div>
            ) : agents.length === 0 ? (
              <p className="state">За этот период показов и сделок не было. Выберите период пошире.</p>
            ) : (
              <>
                <div className="tbl-wrap only-wide" {...scrollableRegion("Отчёт по агентам")}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th scope="col">Агент</th>
                        <th scope="col" className="num">Показы</th>
                        <th scope="col" className="num">Сделки</th>
                        {seesMoney && <th scope="col" className="num">Комиссия</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {agentsVisible.map((row) => (
                        <tr key={row.agentId}>
                          <td>
                            <span className="wrap">
                              <AgentAvatar row={row} />
                              {row.agentName}
                            </span>
                          </td>
                          <td className="num">{row.showings}</td>
                          <td className="num">{row.dealsClosed}</td>
                          {seesMoney && (
                            <td className="num">
                              <Rh2Money value={row.commission ?? 0} />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="only-narrow">
                  <Rh2Bars
                    items={agentsVisible.map((row) => ({
                      key: row.agentId,
                      name: row.agentName,
                      share: seesMoney ? (row.commission ?? 0) / commissionMax : row.dealsClosed / dealsMax,
                      value: seesMoney ? nums(row.commission ?? 0) : String(row.dealsClosed),
                    }))}
                  />
                  <p className="state">
                    {seesMoney
                      ? "Полоса это комиссия за период. Показы и сделки видно в карточке сотрудника."
                      : "Полоса это закрытые сделки за период. Показы видно в карточке сотрудника."}
                  </p>
                </div>
                <p className="state">
                  Показаны {agentsVisible.length} из {agents.length}.{" "}
                  {agents.length > agentsVisible.length && (
                    <button className="lk" type="button" onClick={() => setAgentsShown((c) => c + PAGE)}>
                      Показать ещё ({agents.length - agentsVisible.length})
                    </button>
                  )}
                </p>
              </>
            )}
          </div>
        </div>

        {/* «Топ по показам» и «Откуда приходят» — в одном ряду на широком экране
            (`.cols2`, theme-royal-home-2026.css): полосы и кольцо одинаково
            невысокие и независимые, а порознь оставляли по половине пустого
            ряда. Воронка и таблица по агентам остаются однорядными: у первой
            пять ступеней в строку, у второй девять колонок. Если «Топа» нет
            (показов за период не было), кольцо занимает ряд целиком — auto-fit
            схлопывает пустой столбец. */}
        <div className="cols2">
        {/* «Топ по показам» — блок, который был только на телефоне. */}
        {topByShowings.length > 0 && (
          <div className="sec">
            <div className="sec-h">
              <h2>Топ по показам</h2>
              <span className="note">за тот же период</span>
            </div>
            <div className="card tight">
              <Rh2Bars
                items={topByShowings.map((row) => ({
                  key: row.agentId,
                  name: row.agentName,
                  share: row.showings / showingsMax,
                  value: String(row.showings),
                }))}
              />
            </div>
          </div>
        )}

        {/* «Откуда приходят» — кольцо источников, тоже с телефонного экрана. */}
        <div className="sec" id="sources-report-section">
          <div className="sec-h">
            <h2>Откуда приходят</h2>
            <span className="note">{sourcesLoading ? "Загружаем источники…" : sourcesError ? "Данные недоступны" : `${donutTotal} лидов за период`}</span>
          </div>
          <div className="card tight">
            {sourcesError ? (
              <div className="state err">
                <span className="dot crit" /> Источники лидов не загрузились.
                <button
                  className="lk"
                  type="button"
                  style={{ color: "inherit", textDecoration: "underline" }}
                  onClick={() => refetchSources()}
                >
                  Повторить
                </button>
              </div>
            ) : sourcesLoading ? (
              <div className="state" role="status">
                <span className="sk w40" /> Загружаем источники лидов
              </div>
            ) : donutRows.length === 0 ? (
              <p className="state">За этот период лидов не было.</p>
            ) : (
              <Rh2Donut
                total={donutTotal}
                middleLabel="лидов"
                ariaLabel={`Доли каналов: ${donutRows
                  .map((s) => `${CLIENT_SOURCE_LABELS[s.source as ClientSource] ?? s.source} ${Math.round((s.total / donutTotal) * 100)} процентов`)
                  .join(", ")}`}
                slices={donutRows.map((s) => ({
                  key: s.source,
                  label: CLIENT_SOURCE_LABELS[s.source as ClientSource] ?? s.source,
                  value: s.total,
                  quantity: `${s.total} лидов, ${Math.round((s.total / donutTotal) * 100)} %`,
                }))}
              />
            )}
          </div>
        </div>
        </div>

        </>}
        {/* «Горячие объекты» (28.09.2026) — чем интересуются прямо сейчас:
            сервер считал это с 09.09, а экрана не было. */}
        <HotPropertiesSection />

        {/* «Спрос и предложение» (03.10.2026): где не хватает объектов, где их много,
            и какие объекты в продаже никто не ищет. Сервер: GET /reports/demand-supply. */}
        <DemandSupplySection />

        {/* Месячные отчёты — про закрытый месяц целиком, а не про выбранный
            вверху диапазон дат. Компонент общий с настройками, в тему пока не
            переносился: перенос «Месячных отчётов» и «Разбора» задачей не стоял. */}
        <div className="sec">
          <MonthlyReports />
        </div>

        {/* Разбор проблемных мест (решение владельца 11.08.2026). Отдельно от
            месячного отчёта нарочно: тот отвечает «сколько заработали», этот —
            «где теряем». */}
        <div className="sec">
          <ProblemReports />
        </div>

        {isAgent && (
          <div className="quiet">
            <span className="txt">
              Здесь только ваши показатели. Цифры коллег, воронка агентства и комиссия по офису видны администратору и
              директору.
            </span>
          </div>
        )}
      </Rh2Screen>
    </ReportsFrame>
  );
}

/**
 * «Горячие объекты»: какими объектами в продаже больше всего интересуются за
 * неделю или месяц — по ним решают, что запускать в рекламу. Своё окно 7/30
 * дней, не общий период отчёта: вопрос «что горит сейчас», а не «что было».
 * Строка ведёт в карточку объекта.
 */
function HotPropertiesSection() {
  const [days, setDays] = useState<7 | 30>(7);
  const { data, isLoading, isError, refetch } = useHotProperties(days);
  const items = data?.items ?? [];
  const max = Math.max(1, ...items.map((i) => i.people));
  return (
    <div className="sec" id="hot-properties-section">
      <div className="sec-h">
        <h2>Горячие объекты</h2>
        <span className="note">кем интересуются больше всего</span>
      </div>
      <div className="card tight">
        <div className="seg" role="tablist" aria-label="За сколько дней">
          {([7, 30] as const).map((d) => (
            <button key={d} type="button" role="tab" aria-selected={days === d} onClick={() => setDays(d)}>
              {d} дней
            </button>
          ))}
        </div>
        {isError ? (
          <div className="state err">
            <span className="dot crit" /> Список не загрузился.
            <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => refetch()}>
              Повторить
            </button>
          </div>
        ) : isLoading ? (
          <p className="state">Считаем интерес к объектам…</p>
        ) : items.length === 0 ? (
          <p className="state">За эти дни к объектам в продаже интереса не было.</p>
        ) : (
          <div style={{ marginTop: "var(--s3)" }}>
          <Rh2Bars
            items={items.map((p) => ({
              key: p.propertyId,
              name: (
                <Link className="lk" to={`/properties/${p.propertyId}`} title={`${p.title}${p.districtName ? `, ${p.districtName}` : ""}`}>
                  №{p.shortId} · {p.title}
                </Link>
              ),
              share: p.people / max,
              value: `${p.people} ${pluralizeRu(p.people, ["человек", "человека", "человек"])}`,
            }))}
          />
          </div>
        )}
      </div>
    </div>
  );
}

/** Кружок сотрудника: фото, если есть, иначе инициалы (класс `.av` прототипа). */
export function AgentAvatar({ row }: { row: AgentReportRow }) {
  return (
    <span className="av" aria-hidden="true" style={{ overflow: "hidden" }}>
      {row.avatarUrl ? (
        <img src={row.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        initials(row.agentName)
      )}
    </span>
  );
}
