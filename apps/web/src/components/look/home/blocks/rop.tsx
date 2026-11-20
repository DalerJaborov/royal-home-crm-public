import { useQuery } from "@tanstack/react-query";
import type { ProblemReportMetrics, SalesControlHome } from "@royal-home/shared";
import { api } from "../../../../lib/api";
import { useAuthStore } from "../../../../store/auth";
import { useCan } from "../../../../lib/permissions";
import { dushanbeTime } from "../../../../lib/date";
import { lazyWithReload } from "../../../../lib/lazyWithReload";
import { useTeamLive } from "../../../../hooks/useTeamLive";
import { RhAvatar, RhBlockState, RhCircle, RhGroup, RhRow, RhSection, RhTile } from "../../ui";
import { FullScreenToggle } from "./full";

/**
 * ГЛАВНАЯ РОП — блоки ядра (перенесены из pages/TodayRoyal.tsx, home-core 20.11.2026).
 *
 * Те же запросы и ключи кэша, что у HeadOfSalesHome: `/dashboard/sales-control`,
 * `useTeamLive`, недельный разбор потерь — общий кэш, без второго похода.
 */
const HeadOfSalesHome = lazyWithReload(() => import("../../../home/HeadOfSalesHome").then((m) => ({ default: m.HeadOfSalesHome })));

function useRopWork() {
  const actorId = useAuthStore((s) => s.agent?.id);
  return useQuery({ queryKey: ["rop-work", actorId], enabled: !!actorId,
    queryFn: () => api<SalesControlHome>("/dashboard/sales-control"), refetchInterval: 60_000 });
}

function useRopTeam() {
  const can = useCan();
  const canSeeTeam = can("dashboard.analytics") && can("team.viewFull");
  const team = useTeamLive(canSeeTeam);
  return { canSeeTeam, team, teamData: canSeeTeam ? team.data : undefined };
}

/** Ответ без поля — пустой список, а не падение всей главной (класс 18.11.2026). */
function tasksOf(data: SalesControlHome | undefined) {
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

export function RopTiles() {
  const work = useRopWork();
  const { teamData } = useRopTeam();
  const tasks = tasksOf(work.data);
  const waiting = work.data ? tasks.filter((task) => task.responseAction === "RECEIPT").length : null;
  const reporting = work.data ? tasks.filter((task) => task.responseAction === "ACTION").length : null;
  const overdue = work.data ? tasks.filter((task) => task.dueAt && Date.parse(task.dueAt) < Date.now()).length : null;
  const load = Array.isArray(teamData?.agents) ? teamData.agents.reduce((sum, agent) => sum + (agent.activeLoad ?? 0), 0) : null;
  return (
    <div className="ry-strip ry-strip-tiles">
      <RhTile variant="brand" icon="inbox" label="Ждут принятия" value={waiting ?? "—"} to="#ry-rop-tasks" alert={work.isError} />
      <RhTile variant="ink" icon="hourglass" label="Просрочено" value={overdue ?? "—"} to="#ry-rop-tasks" />
      <RhTile variant="plain" icon="list-checks" label="Нужен отчёт" value={reporting ?? "—"} to="#ry-rop-tasks" />
      {load !== null && <RhTile variant="plain" icon="users" label="В работе у команды" value={load} to="/team" />}
    </div>
  );
}

export function RopTasks() {
  const work = useRopWork();
  const tasks = tasksOf(work.data);
  return (
    <RhSection id="ry-rop-tasks" title="Требуют ответа" to="/calendar" linkLabel="Календарь" className="ry-col-a">
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

export function RopTeam() {
  const { canSeeTeam, team, teamData } = useRopTeam();
  if (!canSeeTeam) return null;
  return (
    <RhSection title="Команда" to="/team" className="ry-col-b">
      {team.isPending ? <RhBlockState kind="loading" /> : team.isError ? <RhBlockState kind="error" onRetry={() => void team.refetch()} />
        : !teamData?.agents.length ? null
        : <RhGroup>{teamData.agents.slice(0, 8).map((agent) => (
          <RhRow key={agent.id} to={`/team/${agent.id}`} lead={<RhAvatar name={agent.fullName} src={agent.avatarUrl} size={48} />}
            title={agent.fullName} sub={agent.pendingAccept > 0 ? `ждут принятия: ${agent.pendingAccept}` : undefined} subTone={agent.pendingAccept > 0 ? "warn" : undefined}
            right={<b className="ry-num ry-count" title="Клиентов в работе">{agent.activeLoad}</b>} />
        ))}</RhGroup>}
    </RhSection>
  );
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
