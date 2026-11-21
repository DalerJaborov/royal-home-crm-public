import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DirectorAgentRow, DirectorDashboardResponse, DirectorDrillKey, DirectorKpi } from "@royal-home/shared";
import { RhButton, RhGroup, RhRow, RhSection } from "../look/ui";
import { RoyalIcon } from "../look/RoyalIcon";
import type { RoyalIconName } from "../look/royalIconData";
import { tileTone, type TileVariant } from "../look/tileTone";
import { RoyalAmount } from "../look/money/RoyalAmount";
import { dushanbeDate } from "../../lib/date";
import {
  compareDelta, minutesLabel, sharePct, percentLabel, planRemainder, sortRows,
  type DashboardBlock, type DeltaView, type SortDir,
} from "../../lib/directorFormat";

/**
 * БЛОКИ ДАШБОРДА РУКОВОДИТЕЛЯ (21.11.2026). Только показ: данные и действия приходят
 * пропсами, поэтому блоки проверяются vitest без сети. Деньги рисуются ТОЛЬКО при
 * `data.seesMoney` — без права finance.view плиток, столбцов и колец с деньгами нет вовсе.
 */

export const nums = (n: number) => Math.round(n).toLocaleString("ru-RU");
export const moneyTjs = (n: number) => `${nums(n)} с.`;

const KPI_ICON: Record<string, RoyalIconName> = {
  newLeads: "user-plus", contacted: "phone-call", noContact: "phone-missed", showings: "eye",
  meetings: "calendar-days", negotiations: "messages-square", deals: "handshake", revenue: "banknote",
};
const KPI_NOUN: Partial<Record<string, [string, string, string]>> = {
  newLeads: ["заявка", "заявки", "заявок"], contacted: ["заявка", "заявки", "заявок"], noContact: ["заявка", "заявки", "заявок"],
  showings: ["показ", "показа", "показов"], meetings: ["встреча", "встречи", "встреч"], negotiations: ["заявка", "заявки", "заявок"],
  deals: ["сделка", "сделки", "сделок"],
};

/** Цвет плитки по смыслу: «без контакта» — срочное, сделки и выручка — хороший итог, остальное — справка. */
export function kpiTileVariant(kpi: DirectorKpi): TileVariant {
  if (kpi.key === "noContact") return tileTone("urgent", kpi.value);
  if (kpi.key === "deals" || kpi.key === "revenue") return tileTone("good", kpi.value);
  return tileTone("info", kpi.value);
}

export function DeltaNote({ delta }: { delta: DeltaView | null }) {
  if (!delta) return <span className="dd-delta" data-tone="neutral">нет данных для сравнения</span>;
  return (
    <span className="dd-delta" data-tone={delta.tone}>
      <span aria-hidden="true">{delta.arrow === "up" ? "↑" : delta.arrow === "down" ? "↓" : "→"}</span> {delta.text}
    </span>
  );
}

/** Плитка KPI: число, стрелка и «на X больше, чем в прошлом периоде». Есть список — это кнопка. */
export function KpiTile({ kpi, onDrill }: { kpi: DirectorKpi; onDrill: (key: DirectorDrillKey, label: string) => void }) {
  const isMoney = kpi.unit === "tjs";
  const delta = compareDelta(kpi.value, kpi.prev, kpi.goodWhen, isMoney ? null : KPI_NOUN[kpi.key] ?? null);
  const deltaMoney = isMoney && delta && kpi.value !== null && kpi.prev !== null
    ? { ...delta, text: `на ${nums(Math.abs(kpi.value - kpi.prev))} с. ${kpi.value > kpi.prev ? "больше" : "меньше"}, чем в прошлом периоде` }
    : delta;
  const inner = (
    <>
      <span className="ry-tile-label"><RoyalIcon name={KPI_ICON[kpi.key] ?? "stack"} size={26} />{kpi.label}</span>
      <span className="ry-tile-value ry-num">{kpi.value === null ? "—" : nums(kpi.value)}{isMoney && kpi.value !== null && <small>с.</small>}</span>
      <DeltaNote delta={isMoney ? deltaMoney : delta} />
    </>
  );
  const drillKey = kpi.drillKey;
  const variant = kpiTileVariant(kpi);
  const wide = isMoney ? "true" : undefined;
  if (drillKey) {
    return (
      <button type="button" className="ry-tile dd-tile" data-variant={variant} data-wide={wide} data-kpi={kpi.key}
        aria-label={`${kpi.label}: ${kpi.value === null ? "нет данных" : nums(kpi.value)}. Открыть список`}
        onClick={() => onDrill(drillKey, kpi.label)}>{inner}</button>
    );
  }
  return <div className="ry-tile dd-tile" data-variant={variant} data-wide={wide} data-kpi={kpi.key}>{inner}</div>;
}

export function KpiBlock({ data, onDrill }: { data: DirectorDashboardResponse; onDrill: (key: DirectorDrillKey, label: string) => void }) {
  // Без права на деньги плитки денег не рисуются вовсе: сервер отдаёт value=null, но и пустой плитки быть не должно.
  const kpis = data.kpis.filter((k) => k.unit !== "tjs" || data.seesMoney);
  return (
    <RhSection title="Главные цифры" id="dd-kpi">
      <div className="dd-kpis">{kpis.map((k) => <KpiTile key={k.key} kpi={k} onDrill={onDrill} />)}</div>
    </RhSection>
  );
}

/** Воронка: горизонтальные полосы, конверсия — от предыдущего шага и от заявок периода. */
export function FunnelBlock({ data }: { data: DirectorDashboardResponse }) {
  const steps = data.funnel.steps;
  const max = Math.max(1, ...steps.map((s) => s.count));
  return (
    <RhSection title="Воронка" id="dd-funnel">
      <div className="dd-card">
        {steps.every((s) => s.count === 0) ? <p className="dd-quiet">За этот период заявок не было.</p> : (
          <ol className="dd-funnel" aria-label="Воронка продаж">
            {steps.map((s) => (
              <li key={s.key} className="dd-funnel-row">
                <span className="dd-funnel-name">{s.label}</span>
                <span className="dd-bar" role="img" aria-label={`${s.label}: ${nums(s.count)}`}><span style={{ "--v": s.count / max } as CSSProperties} /></span>
                <b className="dd-funnel-count ry-num">{nums(s.count)}</b>
                <span className="dd-funnel-conv">
                  {s.conversionFromPrev === null ? "первый шаг" : `${percentLabel(s.conversionFromPrev)} от предыдущего`}
                  {s.conversionFromFirst !== null && s.conversionFromPrev !== null ? ` · ${percentLabel(s.conversionFromFirst)} от заявок` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </RhSection>
  );
}

/** Причины отказа — столбики; самая частая первой. */
export function ReasonsBlock({ data, onDrill }: { data: DirectorDashboardResponse; onDrill: (key: DirectorDrillKey, label: string) => void }) {
  const rows = [...data.lossReasons].filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  const total = rows.reduce((s, r) => s + r.count, 0);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <RhSection title="Почему теряем клиентов" id="dd-reasons">
      <div className="dd-card">
        {rows.length === 0 ? <p className="dd-quiet">Отказов за этот период нет.</p> : (
          <>
            <ul className="dd-reasons" aria-label="Причины отказа">
              {rows.map((r) => (
                <li key={r.reason} className="dd-reason">
                  <span className="dd-reason-name">{r.label}</span>
                  <span className="dd-bar" role="img" aria-label={`${r.label}: ${nums(r.count)}`}><span style={{ "--v": r.count / max } as CSSProperties} /></span>
                  <b className="ry-num">{nums(r.count)}</b>
                  <span className="dd-reason-share">{percentLabel(sharePct(r.count, total))}</span>
                </li>
              ))}
            </ul>
            <RhButton variant="ghost" onClick={() => onDrill("lost", "Потерянные заявки")}>Открыть список отказов</RhButton>
          </>
        )}
      </div>
    </RhSection>
  );
}

/** Скорость первого ответа и дисциплина: клик по «без контакта» и «просрочено» открывает список. */
export function SpeedBlock({ data, onDrill }: { data: DirectorDashboardResponse; onDrill: (key: DirectorDrillKey, label: string) => void }) {
  const s = data.speed;
  const noContactVariant = tileTone("urgent", s.noContactCount);
  const overdueVariant = tileTone("urgent", s.overdueTasks);
  return (
    <RhSection title="Скорость ответа" id="dd-speed">
      <div className="dd-kpis" data-count="4">
        <div className="ry-tile dd-tile" data-variant="plain">
          <span className="ry-tile-label"><RoyalIcon name="clock" size={26} />Первый ответ</span>
          <span className="ry-tile-value ry-num dd-time">{minutesLabel(s.medianMin)}</span>
          <span className="dd-delta" data-tone="neutral">обычно · по {nums(s.answered)} заявкам с ответом</span>
        </div>
        <div className="ry-tile dd-tile" data-variant="plain">
          <span className="ry-tile-label"><RoyalIcon name="gauge" size={26} />Среднее время</span>
          <span className="ry-tile-value ry-num dd-time">{minutesLabel(s.avgMin)}</span>
          <span className="dd-delta" data-tone="neutral">от заявки до первого контакта</span>
        </div>
        <button type="button" className="ry-tile dd-tile" data-variant={noContactVariant} onClick={() => onDrill(s.noContactDrillKey, "Без первого контакта")}
          aria-label={`Без контакта: ${nums(s.noContactCount)}. Открыть список`}>
          <span className="ry-tile-label"><RoyalIcon name="phone-missed" size={26} />Без контакта</span>
          <span className="ry-tile-value ry-num">{nums(s.noContactCount)}</span>
          <span className="dd-delta" data-tone="neutral">заявки, до которых не дошли</span>
        </button>
        <button type="button" className="ry-tile dd-tile" data-variant={overdueVariant} onClick={() => onDrill(s.overdueDrillKey, "Просроченные задачи")}
          aria-label={`Просрочено задач: ${nums(s.overdueTasks)}. Открыть список`}>
          <span className="ry-tile-label"><RoyalIcon name="circle-alert" size={26} />Просрочено задач</span>
          <span className="ry-tile-value ry-num">{nums(s.overdueTasks)}</span>
          <span className="dd-delta" data-tone="neutral">на сейчас</span>
        </button>
      </div>
    </RhSection>
  );
}

/** Источники: заявки, сделки и (при праве на деньги) комиссия. */
export function SourcesBlock({ data }: { data: DirectorDashboardResponse }) {
  const rows = data.sources.filter((r) => r.leads > 0 || r.deals > 0).sort((a, b) => b.leads - a.leads);
  return (
    <RhSection title="Откуда приходят" id="dd-sources">
      {rows.length === 0 ? <div className="dd-card"><p className="dd-quiet">Заявок за этот период нет.</p></div> : (
        <RhGroup label="Источники заявок">
          {rows.map((r) => (
            <RhRow key={r.source} title={r.label}
              sub={`${nums(r.leads)} ${r.leads === 1 ? "заявка" : "заявок"} · ${nums(r.deals)} ${r.deals === 1 ? "сделка" : "сделок"}${sharePct(r.deals, r.leads) !== null ? ` · ${percentLabel(sharePct(r.deals, r.leads))}` : ""}`}
              right={data.seesMoney && r.commission !== null ? <b className="ry-num"><RoyalAmount text={moneyTjs(r.commission)} /></b> : <b className="ry-num">{nums(r.leads)}</b>} />
          ))}
        </RhGroup>
      )}
    </RhSection>
  );
}

/** План и факт комиссии за месяц: кольцо с процентом и остаток. Блок есть только при праве на деньги. */
export function PlanBlock({ data, settingsTo }: { data: DirectorDashboardResponse; settingsTo?: string }) {
  const p = data.plan;
  const hasPlan = p.commissionPlan !== null && p.commissionPlan > 0 && p.fact !== null;
  const pct = hasPlan ? Math.max(0, Math.round(p.pct ?? sharePct(p.fact, p.commissionPlan) ?? 0)) : 0;
  const monthName = (() => {
    const [y, m] = p.month.split("-").map(Number);
    return y && m ? dushanbeDate(new Date(Date.UTC(y, m - 1, 15)), { month: "long", year: "numeric" }) : p.month;
  })();
  return (
    <RhSection title={`План и факт · ${monthName}`} id="dd-plan">
      <div className="dd-card dd-plan">
        <p className="dd-quiet dd-plan-note">План один на всю компанию, берётся за месяц конца периода; фильтры менеджера, источника и клиентов к нему не применяются.</p>
        {hasPlan ? (
          <>
            <div className="dd-ring" role="img" aria-label={`План выполнен на ${pct} процентов`}>
              <svg viewBox="0 0 36 36" aria-hidden="true">
                <circle className="dd-ring-track" cx="18" cy="18" r="15.9155" pathLength={100} />
                <circle className="dd-ring-fill" cx="18" cy="18" r="15.9155" pathLength={100} style={{ "--p": Math.min(100, pct) } as CSSProperties} />
              </svg>
              <b className="ry-num"><span>{pct}</span><small>%</small></b>
            </div>
            <div className="dd-plan-text">
              <p className="dd-plan-fact"><b className="ry-num"><RoyalAmount text={moneyTjs(p.fact ?? 0)} /></b> из <RoyalAmount text={moneyTjs(p.commissionPlan ?? 0)} /></p>
              <p className="dd-quiet">{planRemainder(p.fact ?? 0, p.commissionPlan ?? 0, "с.")}</p>
            </div>
          </>
        ) : (
          <div className="dd-plan-text">
            <p className="dd-quiet">План комиссии на этот месяц не задан.{settingsTo ? <> Его ставят в <Link to={settingsTo}>Настройках</Link>.</> : " Его ставит администратор в Настройках."}</p>
            {p.fact !== null && <p className="dd-plan-fact">Комиссия за месяц: <b className="ry-num"><RoyalAmount text={moneyTjs(p.fact)} /></b></p>}
          </div>
        )}
      </div>
    </RhSection>
  );
}

type AgentCol = { id: string; label: string; get: (a: DirectorAgentRow) => number | string | null; money?: boolean; text?: (a: DirectorAgentRow) => string };

function agentColumns(seesMoney: boolean): AgentCol[] {
  const cols: AgentCol[] = [
    { id: "name", label: "Менеджер", get: (a) => a.name },
    { id: "leads", label: "Заявки", get: (a) => a.leads },
    { id: "contacted", label: "Обработано", get: (a) => a.contacted },
    { id: "calls", label: "Звонки", get: (a) => a.calls },
    { id: "messages", label: "Сообщения", get: (a) => a.messages },
    { id: "meetings", label: "Встречи", get: (a) => a.meetings },
    { id: "showings", label: "Показы", get: (a) => a.showings },
    { id: "deals", label: "Сделки", get: (a) => a.deals },
  ];
  if (seesMoney) cols.push({ id: "commission", label: "Комиссия", get: (a) => a.commission, money: true, text: (a) => (a.commission === null ? "—" : moneyTjs(a.commission)) });
  cols.push(
    { id: "conversion", label: "Конверсия", get: (a) => a.conversion, text: (a) => percentLabel(a.conversion) },
    { id: "overdue", label: "Просрочено", get: (a) => a.overdueTasks },
    { id: "last", label: "Был активен", get: (a) => a.lastActivityAt, text: (a) => lastSeen(a.lastActivityAt) },
  );
  return cols;
}

export function lastSeen(iso: string | null): string {
  if (!iso) return "—";
  return dushanbeDate(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Таблица агентов: сортировка по любому столбцу; на телефоне — карточки; клик по имени — карточка сотрудника. */
export function AgentsBlock({ data, mobile }: { data: DirectorDashboardResponse; mobile: boolean }) {
  const cols = agentColumns(data.seesMoney);
  const [sort, setSort] = useState<{ id: string; dir: SortDir }>({ id: "deals", dir: "desc" });
  const col = cols.find((c) => c.id === sort.id) ?? cols[0]!;
  const rows = sortRows(data.agents, col.get, sort.dir);
  const pick = (id: string) => setSort((cur) => (cur.id === id ? { id, dir: cur.dir === "asc" ? "desc" : "asc" } : { id, dir: id === "name" ? "asc" : "desc" }));
  return (
    <RhSection title="Менеджеры" id="dd-agents">
      {rows.length === 0 ? <div className="dd-card"><p className="dd-quiet">За этот период у менеджеров нет данных.</p></div> : mobile ? (
        <>
          <div className="dd-sortbar">
            <label className="dd-filter"><span>Сортировка</span>
              <select value={sort.id} onChange={(e) => setSort({ id: e.target.value, dir: e.target.value === "name" ? "asc" : "desc" })}>
                {cols.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
            <RhButton variant="secondary" onClick={() => setSort({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })} aria-label={sort.dir === "asc" ? "По возрастанию" : "По убыванию"}>{sort.dir === "asc" ? "↑" : "↓"}</RhButton>
          </div>
          <ul className="dd-agent-cards">
            {rows.map((a) => (
              <li key={a.id} className="dd-agent-card">
                <Link to={`/team/${a.id}`} className="dd-agent-name">{a.name}{!a.isActive && <span className="dd-muted"> · не работает</span>}</Link>
                <dl className="dd-agent-grid">
                  {cols.filter((c) => c.id !== "name").map((c) => (
                    <div key={c.id}><dt>{c.label}</dt><dd className="ry-num">{c.text ? c.text(a) : c.get(a) ?? "—"}</dd></div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="dd-card dd-table-wrap hscroll" role="region" aria-label="Таблица менеджеров" tabIndex={0}>
          <table className="dd-table">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.id} scope="col" data-sorted={sort.id === c.id ? "true" : undefined} aria-sort={sort.id === c.id ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} data-num={c.id === "name" ? undefined : "true"}>
                    <button type="button" onClick={() => pick(c.id)}>{c.label}<span aria-hidden="true">{sort.id === c.id ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}</span></button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  {cols.map((c) => c.id === "name" ? (
                    <th key={c.id} scope="row"><Link to={`/team/${a.id}`}>{a.name}</Link>{!a.isActive && <span className="dd-muted"> · не работает</span>}</th>
                  ) : (
                    <td key={c.id} className="ry-num" data-num="true">{c.text ? c.text(a) : c.get(a) ?? "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </RhSection>
  );
}

/** Порядок блоков берёт `blockOrder` (lib/directorFormat): директору — деньги и план, РОПу — скорость и менеджеры. */
export function DirectorBlocks({ data, order, mobile, settingsTo, onDrill }: {
  data: DirectorDashboardResponse; order: DashboardBlock[]; mobile: boolean; settingsTo?: string;
  onDrill: (key: DirectorDrillKey, label: string) => void;
}) {
  const render: Record<DashboardBlock, ReactNode> = {
    kpi: <KpiBlock key="kpi" data={data} onDrill={onDrill} />,
    plan: data.seesMoney ? <PlanBlock key="plan" data={data} settingsTo={settingsTo} /> : null,
    speed: <SpeedBlock key="speed" data={data} onDrill={onDrill} />,
    agents: <AgentsBlock key="agents" data={data} mobile={mobile} />,
    funnel: <FunnelBlock key="funnel" data={data} />,
    sources: <SourcesBlock key="sources" data={data} />,
    reasons: <ReasonsBlock key="reasons" data={data} onDrill={onDrill} />,
  };
  return <div className="dd-blocks">{order.map((b) => render[b])}</div>;
}
