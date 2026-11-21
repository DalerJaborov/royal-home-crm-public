import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { reportDateRangeError, type DirectorDrillKey, type DirectorPeriodPreset } from "@royal-home/shared";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import { loadView } from "../components/rh2/Rh2ErrorState";
import { RoyalSection } from "../components/look/clients/RoyalSection";
import { RhBlockState, RhButton, RhSegmented } from "../components/look/ui";
import { RuDateField } from "../components/look/fields/RuFields";
import { DirectorBlocks } from "../components/director/DirectorBlocks";
import { DirectorDrillSheet } from "../components/director/DirectorDrillSheet";
import { CLIENT_SOURCE_LABELS } from "../lib/clientFormat";
import { dushanbeDate, dushanbeTime, dushanbeFirstDayOfMonthKey, dushanbeTodayKey } from "../lib/date";
import { blockOrder, defaultPeriod } from "../lib/directorFormat";
import { useCan } from "../lib/permissions";
import { usesDashboardHome } from "../lib/homeDashboard";
import { useAuthStore } from "../store/auth";
import { useAgents } from "../hooks/useAgents";
import { useMobileUx } from "../hooks/useMobileUx";
import { useRoyalLook } from "../hooks/useRoyalLook";
import { downloadDirectorExport, useDirectorDashboard, type DirectorFilters } from "../hooks/useDirectorDashboard";

/**
 * ДАШБОРД ДИРЕКТОРА (ТЗ владельца 21.11.2026) — /director. Один экран на ПК и телефон,
 * один для директора и РОП: порядок блоков и период по умолчанию зависят от роли
 * (`lib/directorFormat`). Доступ — `reports.view`, агенту экран не показывается; деньги — только
 * при праве finance.view (сервер отдаёт `seesMoney`, без него денег в разметке нет вовсе).
 */

const PERIODS: { id: DirectorPeriodPreset; label: string }[] = [
  { id: "day", label: "День" }, { id: "week", label: "Неделя" }, { id: "month", label: "Месяц" },
  { id: "quarter", label: "Квартал" }, { id: "year", label: "Год" }, { id: "custom", label: "Свои даты" },
];

/** Старый адрес /director (закладки, ссылки): дашборд теперь на главной «/». */
export function DirectorDashboard() {
  const royal = useRoyalLook();
  const can = useCan();
  const role = useAuthStore((s) => s.agent?.role);
  if (royal && usesDashboardHome(role, can)) return <Navigate to="/" replace />;
  return <RoyalSection name={royal ? "director" : undefined}><DirectorGate /></RoyalSection>;
}

/**
 * Дашборд внутри главной (блок «dashboard» ядра): без обёртки экрана и без своего h1 —
 * заголовок страницы на главной один, приветствие. Метка раздела director нужна его стилям.
 */
export function DirectorDashboardBlock() {
  const role = useAuthStore((s) => s.agent?.role);
  return (
    <RoyalSection name="director">
      <div data-ry-section="director"><DirectorScreen role={role} embedded /></div>
    </RoyalSection>
  );
}

function DirectorGate() {
  const can = useCan();
  const role = useAuthStore((s) => s.agent?.role);
  if (!can("reports.view") || role === "AGENT") {
    return (
      <Rh2Screen>
        <div className="pg-h"><div><h1>Дашборд директора</h1><p className="sub">Нет доступа к этому разделу. Уточните права у администратора.</p></div></div>
      </Rh2Screen>
    );
  }
  return <DirectorScreen role={role} />;
}

function DirectorScreen({ role, embedded = false }: { role: string | undefined; embedded?: boolean }) {
  const can = useCan();
  const mobile = useMobileUx();
  const [preset, setPreset] = useState<DirectorPeriodPreset>(defaultPeriod(role));
  const [from, setFrom] = useState(dushanbeFirstDayOfMonthKey());
  const [to, setTo] = useState(dushanbeTodayKey());
  const [agentId, setAgentId] = useState("");
  const [source, setSource] = useState("");
  const [kind, setKind] = useState("");
  const [drill, setDrill] = useState<{ key: DirectorDrillKey; label: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const rangeError = preset === "custom" ? reportDateRangeError(from, to) : null;
  const filters = useMemo<DirectorFilters>(() => ({
    preset, from: preset === "custom" ? from : undefined, to: preset === "custom" ? to : undefined,
    agentId: agentId || undefined, source: (source || undefined) as DirectorFilters["source"], kind: (kind || undefined) as DirectorFilters["kind"],
  }), [preset, from, to, agentId, source, kind]);
  const query = useDirectorDashboard(filters, !rangeError);
  const agents = useAgents();
  const data = query.data;

  // Фильтры сменились — открытый список уже про другие цифры.
  useEffect(() => { setDrill(null); }, [filters]);

  async function exportExcel() {
    setExportError(null);
    setExporting(true);
    try { await downloadDirectorExport(filters); }
    catch (error) { setExportError(error instanceof Error ? error.message : "Не удалось выгрузить таблицу"); }
    finally { setExporting(false); }
  }

  // Список под цифрой — имена клиентов: нужно право видеть всех клиентов, для сделок ещё и все сделки (как на сервере).
  const canDrill = (key: DirectorDrillKey) => can("clients.viewAll") && (key !== "deals" && key !== "negotiations" || can("deals.viewAll"));
  const view = loadView(query);
  const updated = data ? dushanbeTime(data.updatedAt) : null;
  const order = blockOrder(role, data?.seesMoney ?? false);

  const body = (
    <>
      <div className="dd" data-testid="director-dashboard">
        <header className="dd-head">
          <div className="dd-title">
            {embedded ? <h2>Показатели компании</h2> : <h1>Дашборд директора</h1>}
            <p className="sub">{updated ? <span role="status">Обновлено в {updated}</span> : "Показатели компании за период"}</p>
          </div>
          <div className="dd-acts">
            <RhButton variant="secondary" onClick={exportExcel} disabled={exporting || !!rangeError || !data}>{exporting ? "Готовим Excel…" : "Excel"}</RhButton>
            <RhButton variant="secondary" onClick={() => window.print()} disabled={!!rangeError || !data}>Печать</RhButton>
          </div>
        </header>
        {data && (
          <p className="dd-print-meta">
            Период: {dushanbeDate(data.period.from)} – {dushanbeDate(data.period.to)}
            {" · "}Менеджер: {data.filters.agentId ? (data.agents.find((a) => a.id === data.filters.agentId)?.name ?? "выбранный") : "все"}
            {" · "}Источник: {data.filters.source ? (CLIENT_SOURCE_LABELS[data.filters.source as keyof typeof CLIENT_SOURCE_LABELS] ?? data.filters.source) : "все"}
            {" · "}Клиенты: {data.filters.kind === "BUYER" ? "покупатели" : data.filters.kind === "SELLER" ? "продавцы" : "все"}
          </p>
        )}
        {exportError && <p role="alert" className="dd-quiet">{exportError}</p>}

        <div className="dd-filters">
          <RhSegmented<DirectorPeriodPreset> label="Период" className="hscroll" value={preset} options={PERIODS} onChange={setPreset} />
          {preset === "custom" && (
            <div className="dd-dates">
              <label className="dd-filter"><span>С</span><RuDateField value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="dd-filter"><span>По</span><RuDateField value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            </div>
          )}
          {rangeError && <p role="alert" className="dd-quiet">{rangeError}</p>}
          <div className="dd-selects">
            <label className="dd-filter"><span>Менеджер</span>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">Все менеджеры</option>
                {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
              </select>
              {agents.isError && !agents.data && <span className="dd-quiet" role="status">Список менеджеров не загрузился, фильтр по менеджеру недоступен.</span>}
            </label>
            <label className="dd-filter"><span>Источник</span>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Все источники</option>
                {Object.entries(CLIENT_SOURCE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            <label className="dd-filter"><span>Клиенты</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">Все</option>
                <option value="BUYER">Покупатели</option>
                <option value="SELLER">Продавцы</option>
              </select>
            </label>
          </div>
        </div>

        {rangeError ? null : view !== "ready" ? (
          <RhBlockState kind={view} onRetry={() => void query.refetch()} />
        ) : data ? (
          <DirectorBlocks data={data} order={order} mobile={mobile} onDrill={(key, label) => setDrill({ key, label })} canDrill={canDrill}
            settingsTo={can("settings.manage") ? "/settings?tab=money" : undefined} />
        ) : null}
        {!rangeError && query.isError && data && <p className="dd-quiet" role="status">Не удалось обновить, показаны прежние цифры.</p>}
      </div>
      <DirectorDrillSheet filters={filters} drill={drill} onClose={() => setDrill(null)} />
    </>
  );
  return embedded ? body : <Rh2Screen title="Дашборд директора">{body}</Rh2Screen>;
}
