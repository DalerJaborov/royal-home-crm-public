import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { MoreHorizontal, Phone } from "lucide-react";
import {
  AGENT_GLANCE_DAYS,
  formatClientCode,
  type AgentGlance,
  type AgentGlanceDrillKey,
  type AgentGlanceIssue,
  type AgentGlancePeriod,
  type AgentIssueKind,
} from "@royal-home/shared";
import type { AgentLive, AgentOverview } from "../../../hooks/useAgentOverview";
import type { AgentHandoverBatch } from "../../../hooks/useAgents";
import { useAgentGlance, useAgentGlanceDrill } from "../../../hooks/useAgentGlance";
import type { TeamMember } from "../../../hooks/useTeam";
import { callAttemptText, chatChip, headerSubtitle, leadsPaused, canPauseLeads } from "../../../lib/agentCardText";
import { dushanbeDate } from "../../../lib/date";
import { formatMoney, PROPERTY_STATUS_LABELS, pluralizeRu, relativeTime } from "../../../lib/format";
import { ROLE_LABELS } from "../../../lib/roles";
import { useGoBack } from "../../../hooks/useGoBack";
import { dealStageText } from "../../../lib/dealStageText";
import { Rh2BarChart, type Rh2BarChartItem } from "../../rh2/Rh2BarChart";
import { Rh2Inline } from "../../rh2/Rh2Scope";
import { Rh2Sheet } from "../../rh2/Rh2Sheet";
import { loadView } from "../../rh2/Rh2ErrorState";
import type { RoyalIconName } from "../royalIconData";
import { RoyalSection } from "../clients/RoyalSection";
import { RoyalAmount } from "../money/RoyalAmount";
import { RhAvatar, RhBlockState, RhButton, RhCircle, RhGroup, RhRow, RhSection, RhSegmented, RhTabs, RhTile } from "../ui";
import { pillTone, tileTone, type TileMeaning } from "../tileTone";

/**
 * КАРТОЧКА СОТРУДНИКА В «НОВОМ ВИДЕ» — «ОДНИМ ВЗГЛЯДОМ» (22.11.2026).
 *
 * Слова владельца: «зайти в карточку агента и одним взглядом всё узнать, всё кликабельно;
 * сейчас тупо списки — нужны графики и наглядность». Порядок экрана:
 *   1. шапка — крупное круглое фото, имя, роль, «в сети», одно главное действие «Позвонить»;
 *   2. плитки за неделю или месяц — каждая открывает список записей за цифрой;
 *   3. «Что не так» — покупатели и продавцы раздельно, по три главных строки и «ещё N»;
 *   4. график по дням (звонки, показы, KPI) с подсказкой по наведению и касанию;
 *   5. вкладки: объекты, клиенты, переписка, звонки, сделки — по пять строк и «Все».
 * Только разметка: данные приходят из pages/TeamMemberDetail.tsx (те же запросы и окна,
 * что у прежнего вида) и из GET /agents/:id/glance (lib/agentGlance.ts на сервере).
 */
export interface RoyalAgentCardProps {
  id: string;
  /** Карточка не открывается (нет права, нет сотрудника, отказ запроса). */
  errorText: string | null;
  loading: boolean;
  onRetry?: () => void;
  data: AgentOverview | undefined;
  liveData: AgentLive | undefined;
  liveFailed: boolean;
  member: TeamMember | undefined;
  canManage: boolean;
  /** Деньги видит только тот, у кого есть finance.view (плитка «Комиссия» без него не рисуется). */
  seesMoney: boolean;
  /** Одной строкой: «Говорит с …», ближайшая задача или последнее действие. */
  nowText: string | null;
  call: { pending: boolean; error: string | null; run: () => void };
  pendingHandover: AgentHandoverBatch | null;
  revertNote: { ok: string | null; error: string | null };
  onFreeze: () => void;
  onLeadPause: () => void;
  onHandover: () => void;
  onRevert: () => void;
  overlays: ReactNode;
}

const PERIOD_OPTIONS = [
  { id: "week" as const, label: "Неделя" },
  { id: "month" as const, label: "Месяц" },
];
const PERIOD_WORD: Record<AgentGlancePeriod, string> = { week: "за неделю", month: "за месяц" };

const KIND_TITLE: Record<AgentIssueKind, string> = { BUYER: "Покупатели", SELLER: "Продавцы", OTHER: "Другие клиенты" };
const KIND_ICON: Record<AgentIssueKind, RoyalIconName> = { BUYER: "users", SELLER: "house", OTHER: "users-round" };
const TOP_ISSUES = 3;
const TAB_ROWS = 5;

export function RoyalAgentCard(p: RoyalAgentCardProps) {
  return <RoyalSection name="team"><RoyalAgentBody {...p} /></RoyalSection>;
}

function RoyalAgentBody(p: RoyalAgentCardProps) {
  const { data } = p;
  const goBack = useGoBack("/team");
  const [period, setPeriod] = useState<AgentGlancePeriod>("week");
  const glance = useAgentGlance(data ? p.id : undefined, period);
  const glanceView = loadView(glance);
  const [drill, setDrill] = useState<{ key: AgentGlanceDrillKey; label: string } | null>(null);
  const [issuesFor, setIssuesFor] = useState<AgentIssueKind | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className="rh2 screens ry-agc" data-ry-section="team">
      <div className="scr">
        <button type="button" className="ry-agc-back" onClick={goBack}>← Команда</button>

        {p.loading && <RhBlockState kind="loading" />}
        {!p.loading && p.errorText && (
          <div className="ry-state" role="alert"><span>{p.errorText}</span>{p.onRetry && <RhButton variant="secondary" onClick={p.onRetry}>Повторить</RhButton>}</div>
        )}

        {data && (
          <>
            <Hero {...p} data={data} onMore={() => setMoreOpen(true)} />

            <RhSection title="Одним взглядом">
              <div className="ry-agc-bar">
                <RhSegmented value={period} options={PERIOD_OPTIONS} onChange={setPeriod} label="Период" />
                <p className="ry-meta">Последние {AGENT_GLANCE_DAYS[period]} {pluralizeRu(AGENT_GLANCE_DAYS[period], ["день", "дня", "дней"])}. Нажмите на цифру, чтобы увидеть, из чего она.</p>
              </div>
              {glance.data ? (
                <Tiles g={glance.data} seesMoney={p.seesMoney} onOpen={(key, label) => setDrill({ key, label })} />
              ) : (
                <GlanceState view={glanceView} onRetry={() => void glance.refetch()} />
              )}
              {p.liveData && p.liveData.leads.unaccepted > 0 && (
                <Link className="ry-agc-note" to={`/clients?agentId=${p.id}`} data-tone="warn">Выдано, но не принято: {p.liveData.leads.unaccepted}</Link>
              )}
            </RhSection>

            <RhSection id="problems" title="Что не так">
              {glance.data ? (
                <Issues g={glance.data} data={data} onAll={setIssuesFor} />
              ) : (
                <GlanceState view={glanceView} onRetry={() => void glance.refetch()} />
              )}
            </RhSection>

            <RhSection title="Активность по дням">
              {glance.data ? <DayChart g={glance.data} /> : <GlanceState view={glanceView} onRetry={() => void glance.refetch()} />}
            </RhSection>

            <Tabs {...p} data={data} />
          </>
        )}
      </div>

      {drill && <DrillSheet id={p.id} period={period} drill={drill} onClose={() => setDrill(null)} />}
      {issuesFor && glance.data && (
        <Rh2Sheet wide title={`${KIND_TITLE[issuesFor]}: что не так`} onClose={() => setIssuesFor(null)}>
          <RhGroup label={KIND_TITLE[issuesFor]}>
            {glance.data.issues.filter((i) => i.kind === issuesFor).map((i, n) => <IssueRow key={`${i.code}-${i.clientShortId}-${n}`} issue={i} />)}
          </RhGroup>
          {glance.data.issuesCapped && <p className="ry-meta">Показаны самые давние: список упёрся в предел выборки.</p>}
        </Rh2Sheet>
      )}
      {moreOpen && data && (
        <Rh2Sheet title="Ещё" onClose={() => setMoreOpen(false)} ariaLabel={`Действия: ${data.agent.fullName}`}>
          <RhGroup>
            <RhRow onClick={() => { window.location.href = `tel:${data.agent.phone}`; }} title="Позвонить на мобильный" sub={data.agent.phone}
              lead={<RhCircle icon="phone" tone="a1" />} />
            {data.agent.email && (
              <RhRow onClick={() => { window.location.href = `mailto:${data.agent.email}`; }} title="Написать письмо" sub={data.agent.email}
                lead={<RhCircle icon="send" tone="a3" />} />
            )}
            {p.canManage && p.member && canPauseLeads(p.member) && (
              <RhRow onClick={() => { setMoreOpen(false); p.onLeadPause(); }} title={leadsPaused(p.member) ? "Вернуть в раздачу заявок" : "Пауза заявок"}
                sub="Новые заявки не приходят, пока пауза" lead={<RhCircle icon="hourglass" tone="a5" />} />
            )}
            {p.canManage && p.pendingHandover && (
              <RhRow onClick={() => { setMoreOpen(false); p.onRevert(); }}
                title={`Вернуть дела (${dushanbeDate(p.pendingHandover.createdAt, { day: "2-digit", month: "2-digit" })})`}
                sub="Вернуть всё, что передали другим" lead={<RhCircle icon="archive" tone="a2" />} />
            )}
          </RhGroup>
        </Rh2Sheet>
      )}
      {p.overlays}
    </div>
  );
}

/* ------------------------------- шапка -------------------------------- */

function Hero(p: RoyalAgentCardProps & { data: AgentOverview; onMore: () => void }) {
  const { data, member } = p;
  const a = data.agent;
  const online = !!p.liveData?.now.online;
  const hasMore = !!a.email || !!a.phone || (p.canManage && ((member && canPauseLeads(member)) || !!p.pendingHandover));
  return (
    <header className="ry-agc-hero">
      <span className="ry-agc-photo">
        <RhAvatar name={a.fullName} src={a.avatarUrl} size={96} />
        <span className="ry-pres ry-agc-dot" data-on={online} aria-hidden="true" />
      </span>
      <div className="ry-agc-who">
        <h1 className="ry-title">{a.fullName}</h1>
        <p className="ry-agc-sub" data-online={online || undefined}>
          {online && <span className="ry-agc-live">В сети</span>}
          {headerSubtitle(ROLE_LABELS[a.role], p.liveData, member).split(" · ").filter((part) => !(online && part === "в сети")).join(" · ")}
          {!a.isActive && " · деактивирован"}
        </p>
        {p.nowText && <p className="ry-agc-now">{p.nowText}</p>}
      </div>
      <div className="ry-agc-acts">
        {a.sipExtension ? (
          <RhButton variant="primary" disabled={p.call.pending} onClick={p.call.run} title={`Позвонить через АТС на внутренний ${a.sipExtension}`}>
            <Phone size={20} strokeWidth={2} aria-hidden="true" />{p.call.pending ? "Соединяем…" : "Позвонить"}
          </RhButton>
        ) : (
          <a className="ry-btn" data-variant="primary" href={`tel:${a.phone}`}><Phone size={20} strokeWidth={2} aria-hidden="true" />Позвонить</a>
        )}
        {p.canManage && member && (
          <>
            <RhButton variant="secondary" onClick={p.onFreeze}>{member.frozen ? "Вернуть в строй" : "Отпуск / больничный"}</RhButton>
            <RhButton variant="secondary" onClick={p.onHandover}>Передать дела</RhButton>
          </>
        )}
        {hasMore && (
          <button type="button" className="ry-more-btn" aria-label="Ещё действия" onClick={p.onMore}>
            <MoreHorizontal size={22} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
      {(p.call.error || p.revertNote.ok || p.revertNote.error) && (
        <div className="ry-agc-notes">
          {p.call.error && <p className="ry-agc-note" data-tone="crit" role="alert">{p.call.error}</p>}
          {p.revertNote.error && <p className="ry-agc-note" data-tone="crit" role="alert">{p.revertNote.error}</p>}
          {p.revertNote.ok && <p className="ry-agc-note" data-tone="ok" role="status">{p.revertNote.ok}</p>}
        </div>
      )}
    </header>
  );
}

/* ------------------------------- плитки ------------------------------- */

const nums = (n: number) => Math.round(n).toLocaleString("ru-RU");

function Tiles({ g, seesMoney, onOpen }: { g: AgentGlance; seesMoney: boolean; onOpen: (key: AgentGlanceDrillKey, label: string) => void }) {
  const tiles: { key: AgentGlanceDrillKey; icon: RoyalIconName; label: string; value: number; meaning: TileMeaning; note?: string; money?: boolean }[] = [
    { key: "buyers", icon: "users", label: "Покупатели в работе", value: g.buyersInWork, meaning: "info", note: "сейчас" },
    { key: "sellers", icon: "house", label: "Продавцы в работе", value: g.sellersInWork, meaning: "info", note: "сейчас" },
    { key: "calls", icon: "phone-call", label: "Звонки", value: g.calls.total, meaning: "info", note: `поговорил ${g.calls.talked}` },
    { key: "missed", icon: "phone-missed", label: "Пропущено входящих", value: g.calls.missed, meaning: "urgent", note: PERIOD_WORD[g.period] },
    { key: "showings", icon: "eye", label: "Показы", value: g.showings, meaning: "info", note: PERIOD_WORD[g.period] },
    { key: "deals", icon: "handshake", label: "Сделки", value: g.deals.total, meaning: "good", note: `закрыто ${g.deals.completed}` },
    ...(g.commission !== null && seesMoney
      ? [{ key: "commission" as const, icon: "banknote" as const, label: "Комиссия", value: g.commission, meaning: "good" as const, note: PERIOD_WORD[g.period], money: true }]
      : []),
    { key: "overdue", icon: "clock", label: "Просрочено задач", value: g.overdueTasks, meaning: "urgent", note: "нужно закрыть" },
    { key: "waiting", icon: "messages-square", label: "Ждут ответа", value: g.waitingForReply, meaning: "urgent", note: "клиент написал" },
  ];
  return (
    <div className="ry-agc-tiles" role="list" aria-label="Показатели сотрудника">
      {tiles.map((t) => (
        <div role="listitem" key={t.key}>
          <RhTile variant={tileTone(t.meaning, t.value)} icon={t.icon} label={t.label} note={t.note}
            value={t.money ? <RoyalAmount text={`${nums(t.value)} с.`} /> : nums(t.value)}
            onClick={() => onOpen(t.key, t.label)} />
        </div>
      ))}
    </div>
  );
}

function GlanceState({ view, onRetry }: { view: ReturnType<typeof loadView>; onRetry: () => void }) {
  return <RhBlockState kind={view === "ready" ? "loading" : view} onRetry={view === "loading" ? undefined : onRetry} />;
}

/* ----------------------------- что не так ------------------------------ */

function IssueRow({ issue }: { issue: AgentGlanceIssue }) {
  return (
    <RhRow to={`/clients/${issue.clientShortId}`} title={issue.clientName || "Без имени"}
      sub={`${issue.sub} · ${relativeTime(issue.at)}`} subTone={issue.severity} />
  );
}

function Issues({ g, data, onAll }: { g: AgentGlance; data: AgentOverview; onAll: (kind: AgentIssueKind) => void }) {
  const groups = useMemo(() => {
    const kinds: AgentIssueKind[] = ["BUYER", "SELLER", ...(g.issues.some((i) => i.kind === "OTHER") ? ["OTHER" as const] : [])];
    return kinds.map((kind) => ({ kind, items: g.issues.filter((i) => i.kind === kind) }));
  }, [g.issues]);
  const p = data.problems;
  const signals =
    p.silentAfterShowing.total + p.refusedHighScore.total + p.endlessNegotiations.total + (p.lossSeries ? 1 : 0) + data.violations.flaggedShowingCalls;
  const signalParts = [
    p.silentAfterShowing.total > 0 && `тишина после показа ${p.silentAfterShowing.total}`,
    p.refusedHighScore.total > 0 && `отказ при хорошем скоринге ${p.refusedHighScore.total}`,
    p.endlessNegotiations.total > 0 && `вечные переговоры ${p.endlessNegotiations.total}`,
    p.lossSeries && `серия потерь ${p.lossSeries.count}`,
    data.violations.flaggedShowingCalls > 0 && `красные флаги после показа ${data.violations.flaggedShowingCalls}`,
  ].filter(Boolean).join(", ");
  return (
    <>
      <div className="ry-agc-issues">
        {groups.map(({ kind, items }) => {
          const top = items.slice(0, TOP_ISSUES);
          const rest = items.length - top.length;
          return (
            <section key={kind} className="ry-agc-col" aria-label={KIND_TITLE[kind]}>
              <header className="ry-agc-col-h">
                <RhCircle icon={KIND_ICON[kind]} tone={items.length > 0 ? "a0" : "ok"} size={44} />
                <h3>{KIND_TITLE[kind]}</h3>
                <span className="ry-agc-count" data-tone={items.length > 0 ? pillTone("overdue", items.length) : pillTone("good")}>{items.length > 0 ? items.length : "всё хорошо"}</span>
              </header>
              {top.length > 0 ? (
                <RhGroup label={KIND_TITLE[kind]}>
                  {top.map((i, n) => <IssueRow key={`${i.code}-${i.clientShortId}-${n}`} issue={i} />)}
                </RhGroup>
              ) : (
                <p className="ry-meta">Нет просрочек, ожиданий и клиентов без контакта.</p>
              )}
              {rest > 0 && <RhButton variant="secondary" onClick={() => onAll(kind)}>Ещё {rest}</RhButton>}
            </section>
          );
        })}
      </div>
      {signals > 0 && (
        <RhGroup label="Контроль руководителя">
          <RhRow to="/oversight" title="Сигналы контроля руководителя" sub={signalParts} right={<b className="ry-num">{signals}</b>}
            lead={<RhCircle icon="shield-check" tone="a4" size={44} />} />
        </RhGroup>
      )}
    </>
  );
}

/* -------------------------------- график ------------------------------- */

type Metric = "calls" | "showings" | "kpi";
const METRICS = [
  { id: "calls" as const, label: "Звонки" },
  { id: "showings" as const, label: "Показы" },
  { id: "kpi" as const, label: "KPI" },
];

function DayChart({ g }: { g: AgentGlance }) {
  const [metric, setMetric] = useState<Metric>("calls");
  const items = useMemo<Rh2BarChartItem[]>(() => g.series.map((d, i) => {
    const value = metric === "kpi" ? (d.kpi ?? 0) : d[metric];
    const day = dushanbeDate(d.date, { day: "numeric", month: "long" });
    const tip = metric === "kpi"
      ? `${day}|${d.kpi === null ? "KPI не считался" : `KPI ${d.kpi} из 100`}`
      : `${day}|${value} ${metric === "calls" ? pluralizeRu(value, ["звонок", "звонка", "звонков"]) : pluralizeRu(value, ["показ", "показа", "показов"])}`;
    const dayNum = String(Number(d.date.slice(8, 10)));
    const showLabel = g.series.length <= 8 || i === g.series.length - 1 || i % 5 === 0;
    return { key: d.date, label: showLabel ? dayNum : "", value, tip };
  }), [g.series, metric]);
  const total = items.reduce((s, i) => s + i.value, 0);
  const worked = g.series.filter((d) => d.kpi !== null);
  const kpiAvg = worked.length ? Math.round(worked.reduce((s, d) => s + (d.kpi ?? 0), 0) / worked.length) : null;
  const summary = metric === "kpi"
    ? kpiAvg === null ? "За этот период KPI не считался." : `Средний KPI: ${kpiAvg} из 100.`
    : `Всего ${total} ${metric === "calls" ? pluralizeRu(total, ["звонок", "звонка", "звонков"]) : pluralizeRu(total, ["показ", "показа", "показов"])} ${PERIOD_WORD[g.period]}.`;
  const empty = items.every((i) => i.value === 0);
  return (
    <div className="ry-home-chart" data-chart="columns">
      <div className="ry-agc-bar">
        <RhSegmented value={metric} options={METRICS} onChange={setMetric} label="Что показывать на графике" />
        <p className="ry-home-chart-note">{summary} Наведите или коснитесь столбика: появится день и число.</p>
      </div>
      {empty && metric !== "kpi" ? (
        <p className="ry-home-chart-note">За этот период ничего не было.</p>
      ) : (
        <Rh2Inline>
          <Rh2BarChart items={items} responsive ariaLabel={`${METRICS.find((m) => m.id === metric)?.label} по дням ${PERIOD_WORD[g.period]}`} />
        </Rh2Inline>
      )}
    </div>
  );
}

/* -------------------------------- вкладки ------------------------------ */

type TabId = "properties" | "clients" | "chats" | "calls" | "deals";

function Tabs(p: RoyalAgentCardProps & { data: AgentOverview }) {
  const [tab, setTab] = useState<TabId>("properties");
  const { data, liveData } = p;
  const tabs = [
    { id: "properties" as const, label: `Объекты ${data.properties.total}` },
    { id: "clients" as const, label: `Клиенты ${data.clients.total}` },
    { id: "chats" as const, label: "Переписка" },
    { id: "calls" as const, label: "Звонки" },
    { id: "deals" as const, label: `Сделки ${data.deals.total}` },
  ];
  const all: Record<TabId, string> = {
    properties: `/properties?agentId=${p.id}`,
    clients: `/clients?agentId=${p.id}`,
    chats: "/messages",
    calls: `/calls?agentId=${p.id}`,
    deals: `/deals?agentId=${p.id}`,
  };
  const wait = (empty: string, rows: unknown[] | undefined): ReactNode | null =>
    p.liveFailed && !rows ? <RhBlockState kind="error" /> : !rows ? <RhBlockState kind="loading" /> : rows.length === 0 ? <p className="ry-meta">{empty}</p> : null;
  let body: ReactNode;
  if (tab === "properties") {
    body = data.properties.last.length === 0 ? <p className="ry-meta">Объектов пока нет.</p> : (
      <RhGroup label="Объекты">
        {data.properties.last.slice(0, TAB_ROWS).map((o) => (
          <RhRow key={o.id} to={`/properties/${o.shortId}`} title={o.title} sub={`${formatMoney(o.price, o.currency)} · ${PROPERTY_STATUS_LABELS[o.status]}`} />
        ))}
      </RhGroup>
    );
  } else if (tab === "clients") {
    body = data.clients.last.length === 0 ? <p className="ry-meta">Клиентов пока нет.</p> : (
      <RhGroup label="Клиенты">
        {data.clients.last.slice(0, TAB_ROWS).map((c) => (
          <RhRow key={c.id} to={`/clients/${c.shortId}`} title={c.fullName}
            sub={`${c.kind === "SELLER" ? "Продавец" : c.kind === "BUYER" ? "Покупатель" : "Клиент"} · ${formatClientCode(c.shortId, c.kind)}`} />
        ))}
      </RhGroup>
    );
  } else if (tab === "chats") {
    body = wait("Переписки с клиентами нет.", liveData?.chats) ?? (
      <RhGroup label="Переписка">
        {liveData!.chats.slice(0, TAB_ROWS).map((c) => {
          const chip = chatChip(c.lastFrom);
          return (
            <RhRow key={c.conversationId} to={`/messages?open=${c.conversationId}`} title={c.client.fullName}
              sub={`${c.lastText || "…"} · ${relativeTime(c.lastMessageAt)}`} subTone={chip?.crit ? "crit" : undefined}
              right={chip ? <span className="ry-agc-chip" data-tone={chip.crit ? pillTone("overdue") : undefined}>{chip.text}</span> : undefined} />
          );
        })}
      </RhGroup>
    );
  } else if (tab === "calls") {
    body = wait("Разговоров с записью пока не было.", liveData?.calls.last) ?? (
      <RhGroup label="Звонки">
        {liveData!.calls.last.slice(0, TAB_ROWS).map((c) => (
          <RhRow key={c.id} to={`/clients/${c.client.shortId}?tab=calls`} title={c.client.fullName}
            sub={`${callAttemptText(c)} · ${relativeTime(c.createdAt)}`}
            right={c.score != null ? <b className="ry-num">{c.score}</b> : undefined} />
        ))}
      </RhGroup>
    );
  } else {
    body = data.deals.last.length === 0 ? <p className="ry-meta">Сделок пока нет.</p> : (
      <RhGroup label="Сделки">
        {data.deals.last.slice(0, TAB_ROWS).map((d) => (
          <RhRow key={d.id} to={`/properties/${d.property.shortId}`} title={d.property.title} sub={`${d.client.fullName} · ${dealStageText(d)}`}
            right={d.commissionAmount ? <b className="ry-num">{formatMoney(d.commissionAmount, d.currency)}</b> : undefined} />
        ))}
      </RhGroup>
    );
  }
  return (
    <RhSection title="Подробнее" to={all[tab]} linkLabel="Все →">
      <RhTabs value={tab} tabs={tabs} onChange={setTab} label="Разделы карточки" idPrefix="agc" className="ry-agc-tabs" />
      <div role="tabpanel" id={`agc-panel-${tab}`} aria-labelledby={`agc-tab-${tab}`} className="ry-agc-panel">{body}</div>
    </RhSection>
  );
}

/* ----------------------------- список за плиткой ----------------------------- */

function DrillSheet({ id, period, drill, onClose }: {
  id: string; period: AgentGlancePeriod; drill: { key: AgentGlanceDrillKey; label: string }; onClose: () => void;
}) {
  const query = useAgentGlanceDrill(id, drill.key, period);
  const view = loadView(query);
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const noteDay = drill.key === "buyers" || drill.key === "sellers" || drill.key === "overdue" || drill.key === "waiting" ? "сейчас" : PERIOD_WORD[period];
  return (
    <Rh2Sheet wide onClose={onClose} title={`${drill.label}: ${noteDay}`} className="dd-sheet">
      <div className="ry-agc-drill" data-testid="agent-glance-drill">
        {view !== "ready" ? <RhBlockState kind={view} onRetry={() => void query.refetch()} /> : items.length === 0 ? (
          <p className="ry-meta">Записей нет.</p>
        ) : (
          <>
            <p className="ry-meta" role="status">Показано {items.length} из {nums(total)}</p>
            <RhGroup label={drill.label}>
              {items.map((it) => (
                <RhRow key={`${it.id}`}
                  to={it.clientShortId ? `/clients/${it.clientShortId}` : it.propertyShortId ? `/properties/${it.propertyShortId}` : undefined}
                  title={it.title || "Без имени"}
                  sub={[it.sub, it.at ? relativeTime(it.at) : ""].filter(Boolean).join(" · ")}
                  right={it.amount !== null ? <b className="ry-num"><RoyalAmount text={`${nums(it.amount)} с.`} /></b> : undefined} />
              ))}
            </RhGroup>
          </>
        )}
      </div>
    </Rh2Sheet>
  );
}

