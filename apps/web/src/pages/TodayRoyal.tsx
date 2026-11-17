import { Suspense, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { pluralizeRu, type ProblemReportMetrics, type SalesControlHome } from "@royal-home/shared";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { useCan } from "../lib/permissions";
import { useNavigation } from "../lib/navigation";
import { dushanbeDate, dushanbeDayKey, dushanbeHour, dushanbeTime } from "../lib/date";
import { formatMoney } from "../lib/format";
import { lazyWithReload } from "../lib/lazyWithReload";
import { mcOk, useMissionControl, usePropertiesPendingReview, type McFirstLineItem, type McMarketingChannel } from "../hooks/useMissionControl";
import { useProperties } from "../hooks/useProperties";
import { usePultActionRows } from "../components/pult/PultActions";
import { CleanDecisionRow } from "../components/clean/CleanDecisionRow";
import { useTeamLive } from "../hooks/useTeamLive";
import { useDashboardSummary } from "../hooks/useDashboard";
import { useClients } from "../hooks/useClients";
import { buildShowings } from "../lib/agentDay";
import { RoyalIcon } from "../components/look/RoyalIcon";
import { RH_SEVERITY_ICON, RhAvatar, RhBlockState, RhButton, RhCircle, RhGroup, RhRow, RhSection, RhTile, type RhBrand } from "../components/look/ui";

/**
 * «СЕГОДНЯ» В НОВОМ ВИДЕ (облик royal, 18.11.2026).
 *
 * Один адаптивный экран на телефон и ПК (раскладку делает theme-look-royal.css
 * контейнерными запросами). Рисуется только при `data-ui-look="royal"` — решает
 * Dashboard.tsx; у остальных сотрудников главная не меняется.
 *
 * ДАННЫЕ — только те же запросы, что у нынешних главных: директор и админ —
 * снимок `useMissionControl` + `usePultActionRows` (как PultClean), РОП —
 * `/dashboard/sales-control`, `useTeamLive`, недельный разбор потерь (как
 * HeadOfSalesHome), агент — `useDashboardSummary` и `useClients` (как
 * AgentHome). Блок без источника не рисуется, числа не выдумываются. Выключенный
 * модуль пульта сервер не присылает вовсе — блок просто не появляется.
 *
 * НИЧЕГО НЕ ТЕРЯЕМ: внизу «Весь экран» монтирует прежнюю главную роли целиком,
 * со всеми её действиями (ИИ, очереди, принятие задач, графики).
 *
 * ПОРЯДОК БЛОКОВ — массив по роли (`BLOCKS`). Перестановку из настроек
 * (`home.blocks[роль]` в Agent.preferences) добавить отдельной правкой: сюда
 * придёт сохранённый порядок вместо умолчания.
 */

const PultClean = lazyWithReload(() => import("./PultClean").then((m) => ({ default: m.PultClean })));
const HeadOfSalesHome = lazyWithReload(() => import("../components/home/HeadOfSalesHome").then((m) => ({ default: m.HeadOfSalesHome })));
const AgentHome = lazyWithReload(() => import("../components/home/AgentHome").then((m) => ({ default: m.AgentHome })));

export const ROYAL_HOME_BLOCKS = {
  DIRECTOR: ["money", "decisions", "burning", "check", "team", "channels", "full"],
  HEAD_OF_SALES: ["ropTiles", "ropTasks", "ropTeam", "ropLosses", "full"],
  AGENT: ["agentTiles", "agentPending", "agentShowings", "full"],
} as const;
export type RoyalHomeRole = keyof typeof ROYAL_HOME_BLOCKS;

export function royalHomeRole(role: string | undefined): RoyalHomeRole | null {
  return role === "DIRECTOR" || role === "ADMIN" ? "DIRECTOR" : role === "HEAD_OF_SALES" ? "HEAD_OF_SALES" : role === "AGENT" ? "AGENT" : null;
}

/** Приветствие по времени суток в Душанбе. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Доброе утро";
  if (hour >= 12 && hour < 18) return "Добрый день";
  if (hour >= 18 && hour < 23) return "Добрый вечер";
  return "Доброй ночи";
}

/** Доля прошедшего месяца по Душанбе (метка темпа на полосе плана). */
export function monthPace(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(1, Math.max(0, day / days));
}

/** Канал заявок → логотип в родном цвете. Неизвестный канал — нейтральный круг. */
export function channelBrand(source: string): RhBrand | null {
  const s = source.toLowerCase();
  if (s.includes("whatsapp")) return "whatsapp";
  if (s.includes("telegram")) return "telegram";
  if (s.includes("instagram")) return "instagram";
  if (s.includes("site") || s.includes("web") || s.includes("сайт")) return "site";
  if (s.includes("call") || s.includes("phone") || s.includes("звон")) return "calls";
  return null;
}

function capitalize(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function Greeting() {
  const agent = useAuthStore((s) => s.agent);
  const firstName = agent?.fullName?.trim().split(/\s+/)[0] ?? "";
  const hello = greetingFor(dushanbeHour());
  const date = capitalize(dushanbeDate(new Date(), { weekday: "long", day: "numeric", month: "long" }));
  return (
    <header className="ry-hello">
      <p className="ry-hello-line">{firstName ? `${hello}, ${firstName}` : hello}</p>
      <h1 className="ry-hello-date">{date}</h1>
    </header>
  );
}

/** Прежняя главная роли целиком — по нажатию, отдельным куском. */
function FullScreenToggle({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="ry-full" aria-label={label}>
      <RhButton variant="gray" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <RoyalIcon name="layout-dashboard" size={22} />{open ? "Свернуть" : label}
      </RhButton>
      {open && <div className="ry-full-body"><Suspense fallback={<RhBlockState kind="loading" />}>{children}</Suspense></div>}
    </section>
  );
}

export function TodayRoyal() {
  const role = royalHomeRole(useAuthStore((s) => s.agent?.role));
  return (
    <div className="ry-today" data-role={role ?? undefined}>
      <Greeting />
      {role === "DIRECTOR" ? <DirectorToday /> : role === "HEAD_OF_SALES" ? <RopToday /> : role === "AGENT" ? <AgentToday /> : null}
    </div>
  );
}

/* ============================ директор и админ ============================ */

function DirectorToday() {
  const can = useCan();
  const { all: navigation } = useNavigation();
  const hasRoute = (path: string) => navigation.some((item) => item.to === path);
  const canView = can("dashboard.analytics");
  const { data, isLoading, isError, refetch } = useMissionControl(canView);
  const rows = usePultActionRows(canView);
  const pending = usePropertiesPendingReview(canView);
  const props = useProperties({ page: 1 }, canView);

  const hero = data?.hero && mcOk(data.hero) ? data.hero : null;
  const team = data?.team && mcOk(data.team) ? data.team : null;
  const bot = data?.bot && mcOk(data.bot) ? data.bot : null;
  const system = data?.system && mcOk(data.system) ? data.system : null;
  const marketing = data?.marketing && mcOk(data.marketing) ? data.marketing : null;
  const clientsZone = data?.clientsZone && mcOk(data.clientsZone) ? data.clientsZone : null;
  const firstLineBroken = !!data?.firstLine && !mcOk(data.firstLine);
  const firstLine = data?.firstLine && mcOk(data.firstLine) ? data.firstLine : null;
  const photoById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of props.data?.items ?? []) {
      const t = p.photos?.[0]?.thumbUrl ?? p.photos?.[0]?.url;
      if (t) m.set(p.id, t);
    }
    for (const p of pending.data ?? []) {
      const photo = p.photos?.[0]?.thumbUrl;
      if (photo) m.set(p.id, photo);
    }
    return m;
  }, [props.data, pending.data]);

  if (!canView) return <RhBlockState kind="empty" />;
  if (isError && !data) return <RhBlockState kind="error" onRetry={() => void refetch()} />;

  const showMoney = !!hero?.commission && !!data?.seesMoney;
  const blocks: Record<(typeof ROYAL_HOME_BLOCKS.DIRECTOR)[number], ReactNode> = {
    money: (
      <div className="ry-strip" key="money">
        {isLoading && !data ? <div className="ry-hero ry-hero-skeleton" aria-busy="true" /> : showMoney && hero?.commission ? (
          <MoneyHero
            fact={hero.commission.fact} plan={hero.commission.planIsDefault ? null : hero.commission.plan}
            deals={hero.dealsInPipeline.count} leadsToday={hero.leadsToday.count}
            to={hasRoute("/finance") ? "/finance" : undefined}
          />
        ) : hero ? (
          <RhTile variant="plain" icon="handshake" label="Сделки идут" value={hero.dealsInPipeline.count} to={hasRoute("/deals") ? "/deals" : undefined} />
        ) : null}
        {bot?.attention && (
          <RhTile variant="brand" icon="message-circle" label="Ждут ответа" value={bot.attention.waitingHuman.count} to={hasRoute("/messages") ? "/messages" : undefined} />
        )}
        {(firstLine || firstLineBroken) && (
          <RhTile variant="ink" icon="flame" label="Горит" value={firstLine ? firstLine.totalCount : "—"} to="#ry-burning" alert={firstLineBroken} />
        )}
        {hero && hero.firstResponse.medianMinYesterday !== null && (
          <RhTile variant="plain" icon="clock" label="Ответ вчера" value={Math.round(hero.firstResponse.medianMinYesterday)} unit="мин" />
        )}
        {hero && !showMoney && (
          <RhTile variant="plain" icon="user-plus" label="Заявки сегодня" value={hero.leadsToday.count} to={hasRoute("/clients") ? "/clients" : undefined} />
        )}
      </div>
    ),
    decisions: (
      <RhSection key="decisions" title="Нужно ваше решение" to={hasRoute("/oversight") ? "/oversight" : undefined} className="ry-col-a">
        {rows === null ? <RhBlockState kind={isError ? "error" : "loading"} onRetry={() => void refetch()} />
          : rows.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Решений нет" /></RhGroup>
          : <div className="ry-decisions clean">{rows.slice(0, 6).map((row) => <CleanDecisionRow key={row.id} row={row} photos={photoById} />)}</div>}
      </RhSection>
    ),
    burning: (firstLine || firstLineBroken || isLoading) ? (
      <RhSection key="burning" id="ry-burning" title="Горит сейчас" to={hasRoute("/oversight") ? "/oversight" : undefined} className="ry-col-b">
        {firstLineBroken ? <RhBlockState kind="error" onRetry={() => void refetch()} />
          : !firstLine ? <RhBlockState kind="loading" />
          : firstLine.items.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Всё спокойно" /></RhGroup>
          : <RhGroup>{firstLine.items.slice(0, 6).map((item) => <BurningRow key={item.id} item={item} />)}</RhGroup>}
      </RhSection>
    ) : null,
    check: (() => {
      const items: ReactNode[] = [];
      if (hero && hasRoute("/calls") && hero.missedCallsToday > 0)
        items.push(<RhRow key="missed" to="/calls" lead={<RhCircle icon="phone-missed" tone="warn" />} title="Пропущенные звонки" sub="сегодня" right={<b className="ry-num ry-count">{hero.missedCallsToday}</b>} />);
      if (team?.showingsToday && team.showingsToday.count > 0 && hasRoute("/calendar"))
        items.push(<RhRow key="showings" to="/calendar" lead={<RhCircle icon="calendar-days" tone="a5" />} title="Показы сегодня" sub={`подтверждено ${team.showingsToday.confirmed}`} right={<b className="ry-num ry-count">{team.showingsToday.count}</b>} />);
      if (pending.data && pending.data.length > 0 && hasRoute("/properties"))
        items.push(<RhRow key="review" to="/properties?status=PENDING_REVIEW" lead={<RhCircle icon="building-2" tone="a2" />} title="Объекты на проверке" right={<b className="ry-num ry-count">{pending.data.length}</b>} />);
      if (clientsZone?.deleteRequests && clientsZone.deleteRequests.total > 0 && hasRoute("/archive") && (can("clients.delete") || can("properties.delete")))
        items.push(<RhRow key="delete" to={clientsZone.deleteRequests.clients > 0 && can("clients.delete") ? "/archive#delete-requests" : "/archive"} lead={<RhCircle icon="archive" tone="a4" />} title="Заявки на удаление" right={<b className="ry-num ry-count">{clientsZone.deleteRequests.total}</b>} />);
      if (system && can("auditLog.view") && hasRoute("/health") && (system.errorsToday > 0 || (system.unresolvedTotal ?? 0) > 0))
        items.push(<RhRow key="errors" to="/health" lead={<RhCircle icon="gauge" tone={system.errorsToday >= 10 ? "crit" : "warn"} />} title="Ошибки системы" sub="за сегодня" right={<b className="ry-num ry-count">{system.errorsToday}</b>} />);
      return items.length ? <RhSection key="check" title="Проверить" className="ry-col-a"><RhGroup>{items}</RhGroup></RhSection> : null;
    })(),
    team: team && team.agents.length > 0 && hasRoute("/team") ? (
      <RhSection key="team" title="Команда" to="/team" className="ry-col-b">
        <div className="ry-team">
          {team.agents.slice(0, 6).map((agent) => (
            <Link key={agent.id} to={`/team/${agent.id}`} className="ry-team-person">
              <RhAvatar name={agent.fullName} src={agent.avatarUrl} size={64} />
              <b>{agent.fullName.split(/\s+/)[0]}</b>
              <span className="ry-team-status" data-tone={agent.pendingAccept > 0 ? "warn" : undefined}>
                {agent.pendingAccept > 0 ? `ждут ${agent.pendingAccept}` : isOnline(agent.lastSeenAt) ? "на связи" : "не в сети"}
              </span>
            </Link>
          ))}
        </div>
      </RhSection>
    ) : null,
    channels: marketing && marketing.funnel.length > 0 ? (
      <RhSection key="channels" title="Заявки за месяц" to={hasRoute("/sources") ? "/sources" : undefined}>
        <Channels funnel={marketing.funnel} />
      </RhSection>
    ) : null,
    full: <FullScreenToggle key="full" label="Весь пульт"><PultClean /></FullScreenToggle>,
  };
  return <div className="ry-blocks">{ROYAL_HOME_BLOCKS.DIRECTOR.map((id) => blocks[id])}</div>;
}

function MoneyHero({ fact, plan, deals, leadsToday, to }: { fact: number; plan: number | null; deals: number; leadsToday: number; to?: string }) {
  const pct = plan && plan > 0 ? Math.round((fact / plan) * 100) : null;
  const pace = monthPace(dushanbeDayKey(new Date()));
  const month = dushanbeDate(new Date(), { month: "long" });
  const body = <>
    <span className="ry-hero-label"><RoyalIcon name="banknote" size={24} />Комиссия · {month}</span>
    <span className="ry-hero-value ry-num">{formatMoney(Math.round(fact), "TJS")}</span>
    {pct !== null && (
      <span className="ry-hero-bar" role="img" aria-label={`План выполнен на ${pct}%, по времени прошло ${Math.round(pace * 100)}% месяца`}>
        <span className="ry-hero-fill" style={{ width: `${Math.min(100, pct)}%` }} />
        <span className="ry-hero-pace" style={{ left: `${pace * 100}%` }} />
      </span>
    )}
    <span className="ry-hero-minis">
      {pct !== null && <span><b className="ry-num">{pct}%</b> плана</span>}
      <span><b className="ry-num">{deals}</b> {pluralizeRu(deals, ["сделка идёт", "сделки идут", "сделок идут"])}</span>
      <span><b className="ry-num">{leadsToday}</b> {pluralizeRu(leadsToday, ["заявка сегодня", "заявки сегодня", "заявок сегодня"])}</span>
    </span>
  </>;
  return to ? <Link to={to} className="ry-hero">{body}</Link> : <div className="ry-hero">{body}</div>;
}

const SEVERITY_TONE = { critical: "crit", warn: "warn", info: "info" } as const;
function BurningRow({ item }: { item: McFirstLineItem }) {
  const tone = SEVERITY_TONE[item.severity];
  return (
    <RhRow to={item.href} label={item.text}
      lead={<RhCircle icon={RH_SEVERITY_ICON[tone]} tone={tone} filled={tone === "crit"} />}
      title={item.text}
      sub={item.severity === "critical" ? "Срочно" : item.severity === "warn" ? "Важно" : "К сведению"}
      subTone={tone === "crit" ? "crit" : tone === "warn" ? "warn" : undefined}
    />
  );
}

function Channels({ funnel }: { funnel: McMarketingChannel[] }) {
  const items = funnel.filter((c) => c.leadsMonth > 0).sort((a, b) => b.leadsMonth - a.leadsMonth).slice(0, 6);
  const max = Math.max(1, ...items.map((c) => c.leadsMonth));
  if (!items.length) return <RhGroup><RhRow lead={<RhCircle icon="inbox" tone="a0" />} title="Заявок за месяц пока нет" /></RhGroup>;
  return (
    <RhGroup>
      {items.map((c) => {
        const brand = channelBrand(c.source);
        return (
          <div key={c.source} className="ry-row ry-bar-row">
            {brand ? <RhCircle brand={brand} /> : <RhCircle icon="globe" tone="a0" />}
            <span className="ry-row-text">
              <span className="ry-row-title">{c.label}</span>
              <span className="ry-bar" aria-hidden="true"><span style={{ width: `${(c.leadsMonth / max) * 100}%` }} /></span>
            </span>
            <span className="ry-row-right"><b className="ry-num ry-count">{c.leadsMonth}</b></span>
          </div>
        );
      })}
    </RhGroup>
  );
}

function isOnline(lastSeenAt?: string | null): boolean {
  return !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < 15 * 60_000;
}

/* ================================ РОП ================================ */

function RopToday() {
  const actorId = useAuthStore((s) => s.agent?.id);
  const can = useCan();
  // Те же запросы и ключи кэша, что у HeadOfSalesHome: общий кэш, без второго похода.
  const work = useQuery({ queryKey: ["rop-work", actorId], enabled: !!actorId,
    queryFn: () => api<SalesControlHome>("/dashboard/sales-control"), refetchInterval: 60_000 });
  const canSeeTeam = can("dashboard.analytics") && can("team.viewFull");
  const team = useTeamLive(canSeeTeam);
  const teamData = canSeeTeam ? team.data : undefined;
  const canSeeLosses = can("reports.view");
  const losses = useQuery({ queryKey: ["problem-reports", "week"], enabled: canSeeLosses,
    queryFn: () => api<{ id: string; metrics: ProblemReportMetrics }[]>("/reports/problems?period=week") });
  const lossReport = losses.data?.[0]?.metrics;
  const lossSection = lossReport?.sections.find((section) => section.key === "clients");

  const tasks = work.data?.tasks ?? [];
  const waiting = work.data ? tasks.filter((task) => task.responseAction === "RECEIPT").length : null;
  const reporting = work.data ? tasks.filter((task) => task.responseAction === "ACTION").length : null;
  const overdue = work.data ? tasks.filter((task) => task.dueAt && Date.parse(task.dueAt) < Date.now()).length : null;
  const load = teamData ? teamData.agents.reduce((sum, agent) => sum + agent.activeLoad, 0) : null;

  const blocks: Record<(typeof ROYAL_HOME_BLOCKS.HEAD_OF_SALES)[number], ReactNode> = {
    ropTiles: (
      <div className="ry-strip ry-strip-tiles" key="ropTiles">
        <RhTile variant="brand" icon="inbox" label="Ждут принятия" value={waiting ?? "—"} to="#ry-rop-tasks" alert={work.isError} />
        <RhTile variant="ink" icon="hourglass" label="Просрочено" value={overdue ?? "—"} to="#ry-rop-tasks" />
        <RhTile variant="plain" icon="list-checks" label="Нужен отчёт" value={reporting ?? "—"} to="#ry-rop-tasks" />
        {load !== null && <RhTile variant="plain" icon="users" label="В работе у команды" value={load} to="/team" />}
      </div>
    ),
    ropTasks: (
      <RhSection key="ropTasks" id="ry-rop-tasks" title="Требуют ответа" to="/calendar" linkLabel="Календарь" className="ry-col-a">
        {work.isPending ? <RhBlockState kind="loading" /> : work.isError ? <RhBlockState kind="error" onRetry={() => void work.refetch()} />
          : tasks.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Задач нет" /></RhGroup>
          : <RhGroup>{tasks.slice(0, 8).map((task) => {
            const late = !!task.dueAt && Date.parse(task.dueAt) < Date.now();
            return (
              <RhRow key={task.id} to={`/clients/${task.clientShortId}`}
                lead={<RhCircle icon={late ? "hourglass" : task.responseAction === "ACTION" ? "list-checks" : "inbox"} tone={late ? "crit" : task.responseAction === "RECEIPT" ? "warn" : "a0"} />}
                title={task.clientName}
                sub={task.responseAction === "RECEIPT" ? "ждёт принятия" : task.responseAction === "ACTION" ? "нужен отчёт" : task.title}
                subTone={late ? "crit" : undefined}
                right={task.dueAt ? <span className="ry-row-time" data-tone={late ? "crit" : undefined}>{dushanbeTime(task.dueAt)}</span> : undefined} />
            );
          })}</RhGroup>}
      </RhSection>
    ),
    ropTeam: canSeeTeam ? (
      <RhSection key="ropTeam" title="Команда" to="/team" className="ry-col-b">
        {team.isPending ? <RhBlockState kind="loading" /> : team.isError ? <RhBlockState kind="error" onRetry={() => void team.refetch()} />
          : !teamData?.agents.length ? null
          : <RhGroup>{teamData.agents.slice(0, 8).map((agent) => (
            <RhRow key={agent.id} to={`/team/${agent.id}`} lead={<RhAvatar name={agent.fullName} src={agent.avatarUrl} size={48} />}
              title={agent.fullName} sub={agent.pendingAccept > 0 ? `ждут принятия: ${agent.pendingAccept}` : undefined} subTone={agent.pendingAccept > 0 ? "warn" : undefined}
              right={<b className="ry-num ry-count" title="Клиентов в работе">{agent.activeLoad}</b>} />
          ))}</RhGroup>}
      </RhSection>
    ) : null,
    ropLosses: canSeeLosses && lossSection && lossSection.metrics.length > 0 ? (
      <RhSection key="ropLosses" title="Где теряем клиентов" to="/reports" linkLabel="Весь разбор" className="ry-col-a">
        <RhGroup>{lossSection.metrics.slice(0, 5).map((metric) => (
          <RhRow key={metric.key} to={metric.href ?? "/reports"} lead={<RhCircle icon="target" tone="a4" />} title={metric.label} right={<b className="ry-num ry-count">{metric.value}</b>} />
        ))}</RhGroup>
      </RhSection>
    ) : null,
    full: <FullScreenToggle key="full" label="Весь кабинет"><HeadOfSalesHome /></FullScreenToggle>,
  };
  return <div className="ry-blocks">{ROYAL_HOME_BLOCKS.HEAD_OF_SALES.map((id) => blocks[id])}</div>;
}

/* ================================ агент ================================ */

function AgentToday() {
  // Те же запросы, что у AgentHome: сервер сам ограничивает выборку правами агента.
  const summary = useDashboardSummary();
  const pendingPage = useClients({ pageSize: 20, pendingAcceptance: true });
  const tasks = useMemo(() => summary.data?.tasksToday ?? [], [summary.data]);
  const showings = useMemo(() => buildShowings(tasks), [tasks]);
  const pending = pendingPage.data?.items ?? [];
  const pendingTotal = pendingPage.data?.total ?? pending.length;

  const blocks: Record<(typeof ROYAL_HOME_BLOCKS.AGENT)[number], ReactNode> = {
    agentTiles: (
      <div className="ry-strip ry-strip-tiles" key="agentTiles">
        <RhTile variant="brand" icon="user-plus" label="Новые заявки" value={pendingPage.data ? pendingTotal : "—"} to="#ry-agent-pending" alert={pendingPage.isError} />
        <RhTile variant="ink" icon="calendar-days" label="Показы сегодня" value={summary.data ? showings.length : "—"} to="#ry-agent-showings" alert={summary.isError} />
        <RhTile variant="plain" icon="list-checks" label="Дела сегодня" value={summary.data ? tasks.length : "—"} to="/calendar" />
      </div>
    ),
    agentPending: (
      <RhSection key="agentPending" id="ry-agent-pending" title="Ждут принятия" to="/clients" className="ry-col-a">
        {pendingPage.isPending ? <RhBlockState kind="loading" /> : pendingPage.isError ? <RhBlockState kind="error" onRetry={() => void pendingPage.refetch()} />
          : pending.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Новых заявок нет" /></RhGroup>
          : <RhGroup>{pending.slice(0, 6).map((client) => (
            <RhRow key={client.id} to={`/clients/${client.shortId}`} lead={<RhAvatar name={client.fullName} />} title={client.fullName} sub="новая заявка" subTone="warn" />
          ))}</RhGroup>}
      </RhSection>
    ),
    agentShowings: (
      <RhSection key="agentShowings" id="ry-agent-showings" title="Показы сегодня" to="/calendar" linkLabel="Календарь" className="ry-col-b">
        {summary.isPending ? <RhBlockState kind="loading" /> : summary.isError ? <RhBlockState kind="error" onRetry={() => void summary.refetch()} />
          : showings.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="calendar-days" tone="a5" />} title="Показов нет" /></RhGroup>
          : <RhGroup>{showings.slice(0, 6).map((showing) => (
            <RhRow key={showing.id} to={showing.client?.shortId ? `/clients/${showing.client.shortId}` : "/calendar"}
              lead={<RhCircle icon="calendar-days" tone="a5" />}
              title={showing.client?.fullName ?? "Показ"} sub={showing.confirmedAt ? "подтверждён" : "ждём ответ"} subTone={showing.confirmedAt ? "ok" : undefined}
              right={<span className="ry-row-time">{dushanbeTime(showing.nextActionDate!)}</span>} />
          ))}</RhGroup>}
      </RhSection>
    ),
    full: <FullScreenToggle key="full" label="Весь экран"><AgentHome /></FullScreenToggle>,
  };
  return <div className="ry-blocks">{ROYAL_HOME_BLOCKS.AGENT.map((id) => blocks[id])}</div>;
}
