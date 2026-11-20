import { useQuery } from "@tanstack/react-query";
import { pluralizeRu, type ProblemReportMetrics, type SalesControlHome } from "@royal-home/shared";
import { api } from "../../../../lib/api";
import { useAuthStore } from "../../../../store/auth";
import { useCan } from "../../../../lib/permissions";
import { dushanbeTime } from "../../../../lib/date";
import { lazyWithReload } from "../../../../lib/lazyWithReload";
import { useTeamLive } from "../../../../hooks/useTeamLive";
import { mcOk, useMissionControl } from "../../../../hooks/useMissionControl";
import { RhBlockState, RhCircle, RhGroup, RhRow, RhSection, RhTile } from "../../ui";
import { tileTone } from "../../tileTone";
import { HomeBars, num } from "../charts";
import { waitLabel } from "../leader";
import { FullScreenToggle } from "./full";
import { HomeQuiet, LeaderTeam } from "./leader";

/**
 * ГЛАВНАЯ РОП — блоки ядра (перенесены из pages/TodayRoyal.tsx, home-core 20.11.2026).
 *
 * Те же запросы и ключи кэша, что у HeadOfSalesHome: `/dashboard/sales-control`,
 * `useTeamLive`, недельный разбор потерь — общий кэш, без второго похода.
 *
 * Свой набор РОП (20.11.2026, разбор кадров critic-director-rop §2): не общая заготовка
 * «Ждут принятия / Просрочено / Нужен отчёт», а то, чем РОП управляет — клиенты ждут
 * ответа, пропущенные звонки, просроченные задачи агентов, заявки, не принятые вовремя;
 * распределение заявок по агентам и «Команда» с последней активностью. Числа — из снимка
 * пульта (право dashboard.analytics у РОП есть) и живой сводки команды; денег РОП не видит,
 * сервер их ему и не присылает.
 */
const HeadOfSalesHome = lazyWithReload(() => import("../../../home/HeadOfSalesHome").then((m) => ({ default: m.HeadOfSalesHome })));

function useRopWork() {
  const actorId = useAuthStore((s) => s.agent?.id);
  return useQuery({ queryKey: ["rop-work", actorId], enabled: !!actorId,
    queryFn: () => api<SalesControlHome>("/dashboard/sales-control"), refetchInterval: 60_000 });
}

/** Ответ без поля — пустой список, а не падение всей главной (класс 18.11.2026). */
function tasksOf(data: SalesControlHome | undefined) {
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

/** Четыре плитки РОП: срочное больше нуля — красным, ноль — серым (tileTone). */
export function RopTiles() {
  const can = useCan();
  const canView = can("dashboard.analytics");
  const mc = useMissionControl(canView);
  const live = useTeamLive(canView);
  if (!canView) return null;
  const data = mc.data;
  const hero = data?.hero && mcOk(data.hero) ? data.hero : null;
  const bot = data?.bot && mcOk(data.bot) ? data.bot : null;
  const team = data?.team && mcOk(data.team) ? data.team : null;
  const waiting = bot?.attention?.waitingHuman;
  const oldest = waiting?.items?.length ? Math.max(...waiting.items.map((item) => item.waitingMinutes)) : null;
  const overdue = team ? team.agents.reduce((sum, agent) => sum + (agent.overdueTasks ?? 0), 0) : null;
  const late = live.data ? live.data.escalatedTotal ?? null : null;
  const missed = hero ? hero.missedCallsToday : null;
  const dash = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n);
  return (
    <div className="ry-strip ry-strip-tiles" data-tiles="4">
      <RhTile variant={tileTone("urgent", waiting?.count)} icon="message-circle" label="Ждут ответа" value={dash(waiting?.count)}
        note={waiting && waiting.count > 0 && oldest !== null ? `дольше всех ${waitLabel(oldest)}` : "клиенты в чатах"}
        to="/messages" alert={mc.isError} />
      <RhTile variant={tileTone("urgent", missed)} icon="phone-missed" label="Пропущенные звонки" value={dash(missed)} note="сегодня" to="/calls" />
      <RhTile variant={tileTone("urgent", overdue)} icon="hourglass" label="Просрочки агентов" value={dash(overdue)} note="задачи после срока" to="#ry-leader-team" />
      <RhTile variant={tileTone("urgent", late)} icon="user-plus" label="Не приняли вовремя" value={dash(late)} note="заявки, время вышло" to="/clients?slice=pending" alert={live.isError} />
    </div>
  );
}

/**
 * «Распределение заявок»: у кого сколько клиентов в работе, сколько принял сегодня и
 * сколько ждёт принятия; сверху — заявки без агента. Полосы растут от левого края один
 * раз при появлении (только transform, при «меньше движения» — без анимации).
 */
export function RopSpread() {
  const can = useCan();
  const canView = can("dashboard.analytics");
  const live = useTeamLive(canView);
  if (!canView) return null;
  if (live.isPending) return <RhSection title="Распределение заявок" className="ry-col-a"><RhBlockState kind="loading" /></RhSection>;
  if (live.isError || !live.data) return <RhSection title="Распределение заявок" className="ry-col-a"><RhBlockState kind="error" onRetry={() => void live.refetch()} /></RhSection>;
  // Ответ без поля — пустое, а не падение блока (класс 18.11.2026).
  const agents = (Array.isArray(live.data.agents) ? live.data.agents : [])
    .map((a) => ({ ...a, activeLoad: a.activeLoad ?? 0, acceptedToday: a.acceptedToday ?? 0, pendingAccept: a.pendingAccept ?? 0 }))
    .sort((a, b) => b.activeLoad - a.activeLoad);
  const queued = live.data.queuedTotal ?? 0;
  if (agents.length === 0 && queued === 0) return <HomeQuiet title="Распределение заявок" className="ry-col-a" />;
  const max = Math.max(1, ...agents.map((a) => a.activeLoad));
  return (
    <RhSection title="Распределение заявок" to="/clients?slice=pending" linkLabel="Заявки" className="ry-col-a">
      {queued > 0 && (
        <RhGroup>
          <RhRow to="/clients?slice=pending" lead={<RhCircle icon="inbox" tone="warn" />}
            title={`Без агента: ${queued} ${pluralizeRu(queued, ["заявка", "заявки", "заявок"])}`} sub="ждут раздачи" />
        </RhGroup>
      )}
      {agents.length > 0 && (
        <HomeBars note="клиентов в работе у агента"
          items={agents.slice(0, 10).map((agent) => ({
            key: agent.id,
            name: (
              <span className="ry-home-bar-name">
                <span>{agent.fullName}</span>
                <small>сегодня принял {num(agent.acceptedToday)}{agent.pendingAccept > 0 ? ` · ждут принятия ${num(agent.pendingAccept)}` : ""}</small>
              </span>
            ),
            share: agent.activeLoad / max,
            value: num(agent.activeLoad),
          }))} />
      )}
    </RhSection>
  );
}

export function RopTasks() {
  const work = useRopWork();
  const tasks = tasksOf(work.data);
  return (
    <RhSection id="ry-rop-tasks" title="Мои задачи" to="/calendar" linkLabel="Календарь" className="ry-col-b">
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
  );
}

/** «Команда» — общий блок руководителей (./leader.tsx); право team.viewFull — у ссылок на карточки. */
export function RopTeam() {
  const can = useCan();
  if (!(can("dashboard.analytics") && can("team.viewFull"))) return null;
  return <LeaderTeam id="ry-leader-team" className="ry-col-b" />;
}

export function RopLosses() {
  const can = useCan();
  const canSeeLosses = can("reports.view");
  const losses = useQuery({ queryKey: ["problem-reports", "week"], enabled: canSeeLosses,
    queryFn: () => api<{ id: string; metrics: ProblemReportMetrics }[]>("/reports/problems?period=week") });
  const lossSection = losses.data?.[0]?.metrics?.sections?.find((section) => section.key === "clients");
  if (!canSeeLosses || !lossSection || lossSection.metrics.length === 0) return null;
  return (
    <RhSection title="Где теряем клиентов" to="/reports" linkLabel="Весь разбор" className="ry-col-a">
      <RhGroup>{lossSection.metrics.slice(0, 5).map((metric) => (
        <RhRow key={metric.key} to={metric.href ?? "/reports"} lead={<RhCircle icon="target" tone="a4" />} title={metric.label} right={<b className="ry-num ry-count">{metric.value}</b>} />
      ))}</RhGroup>
    </RhSection>
  );
}

export function RopFull() {
  return <FullScreenToggle label="Весь кабинет"><HeadOfSalesHome /></FullScreenToggle>;
}
