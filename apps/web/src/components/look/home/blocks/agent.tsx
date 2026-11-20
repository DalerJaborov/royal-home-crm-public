import { pluralizeRu } from "@royal-home/shared";
import { dushanbeTime } from "../../../../lib/date";
import { lazyWithReload } from "../../../../lib/lazyWithReload";
import { useDashboardSummary } from "../../../../hooks/useDashboard";
import { useClients } from "../../../../hooks/useClients";
import { buildShowings } from "../../../../lib/agentDay";
import { RhAvatar, RhBlockState, RhCircle, RhGroup, RhRow, RhSection, RhTile } from "../../ui";
import { HomeBars, num } from "../charts";
import { FullScreenToggle } from "./full";

/**
 * ГЛАВНАЯ АГЕНТА — блоки ядра (перенесены из pages/TodayRoyal.tsx, home-core 20.11.2026).
 *
 * Те же запросы, что у AgentHome: `useDashboardSummary` и заявки, ждущие принятия;
 * сервер сам ограничивает выборку правами агента. «Позвонить сейчас» и «Мой месяц»
 * берут поля той же сводки (`firstCallDue`, `assignedBySupervisor`, `funnel`) — ни
 * одного нового запроса. Номеров телефонов на главной нет (решение владельца 19.11).
 */
const AgentHome = lazyWithReload(() => import("../../../home/AgentHome").then((m) => ({ default: m.AgentHome })));

function useAgentDay() {
  const summary = useDashboardSummary();
  const tasks = Array.isArray(summary.data?.tasksToday) ? summary.data.tasksToday : [];
  return { summary, tasks };
}

function usePending() {
  const pendingPage = useClients({ pageSize: 20, pendingAcceptance: true });
  const pending = pendingPage.data?.items ?? [];
  return { pendingPage, pending, pendingTotal: pendingPage.data?.total ?? pending.length };
}

export function AgentTiles() {
  const { summary, tasks } = useAgentDay();
  const { pendingPage, pendingTotal } = usePending();
  return (
    <div className="ry-strip ry-strip-tiles">
      <RhTile variant="brand" icon="user-plus" label="Новые заявки" value={pendingPage.data ? pendingTotal : "—"} to="#ry-agent-pending" alert={pendingPage.isError} />
      <RhTile variant="ink" icon="calendar-days" label="Показы сегодня" value={summary.data ? buildShowings(tasks).length : "—"} to="#ry-agent-showings" alert={summary.isError} />
      <RhTile variant="plain" icon="list-checks" label="Дела сегодня" value={summary.data ? tasks.length : "—"} to="/calendar" />
    </div>
  );
}

export function AgentPending() {
  const { pendingPage, pending } = usePending();
  return (
    <RhSection id="ry-agent-pending" title="Ждут принятия" to="/clients" className="ry-col-a">
      {pendingPage.isPending ? <RhBlockState kind="loading" /> : pendingPage.isError ? <RhBlockState kind="error" onRetry={() => void pendingPage.refetch()} />
        : pending.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Новых заявок нет" /></RhGroup>
        : <RhGroup>{pending.slice(0, 6).map((client) => (
          <RhRow key={client.id} to={`/clients/${client.shortId}`} lead={<RhAvatar name={client.fullName} />} title={client.fullName} sub="новая заявка" subTone="warn" />
        ))}</RhGroup>}
    </RhSection>
  );
}

export function AgentShowings() {
  const { summary, tasks } = useAgentDay();
  const showings = summary.data ? buildShowings(tasks) : [];
  return (
    <RhSection id="ry-agent-showings" title="Показы сегодня" to="/calendar" linkLabel="Календарь" className="ry-col-b">
      {summary.isPending ? <RhBlockState kind="loading" /> : summary.isError ? <RhBlockState kind="error" onRetry={() => void summary.refetch()} />
        : showings.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="calendar-days" tone="a5" />} title="Показов нет" /></RhGroup>
        : <RhGroup>{showings.slice(0, 6).map((showing) => (
          <RhRow key={showing.id} to={showing.client?.shortId ? `/clients/${showing.client.shortId}` : "/calendar"}
            lead={<RhCircle icon="calendar-days" tone="a5" />}
            title={showing.client?.fullName ?? "Показ"} sub={showing.confirmedAt ? "подтверждён" : "ждём ответ"} subTone={showing.confirmedAt ? "ok" : undefined}
            right={<span className="ry-row-time">{dushanbeTime(showing.nextActionDate!)}</span>} />
        ))}</RhGroup>}
    </RhSection>
  );
}

/**
 * «Позвонить сейчас»: принятые заявки, по которым не закрыт срок первого звонка
 * (самая срочная сверху — порядок сервера), и клиенты, которых назначил руководитель.
 * Срок прошёл — красным и словами сервера, что будет дальше. Пусто — блока нет.
 */
export function AgentFirstCalls() {
  const { summary } = useAgentDay();
  const due = Array.isArray(summary.data?.firstCallDue) ? summary.data.firstCallDue : [];
  const assigned = Array.isArray(summary.data?.assignedBySupervisor) ? summary.data.assignedBySupervisor : [];
  if (due.length + assigned.length === 0) return null;
  const now = Date.now();
  return (
    <RhSection title="Позвонить сейчас" to="/clients" className="ry-col-a">
      <RhGroup>
        {due.slice(0, 6).map((row) => {
          const late = Date.parse(row.dueAt) < now;
          return (
            <RhRow key={row.id} to={`/clients/${row.shortId}`}
              lead={<RhCircle icon={late ? "hourglass" : "phone-call"} tone={late ? "crit" : "warn"} filled={late} />}
              title={row.fullName}
              sub={late ? ["срок первого звонка прошёл", row.afterDue].filter(Boolean).join(" · ") : `первый звонок до ${dushanbeTime(row.dueAt)}`}
              subTone={late ? "crit" : "warn"}
              right={<span className="ry-row-time" data-tone={late ? "crit" : undefined}>{dushanbeTime(row.dueAt)}</span>} />
          );
        })}
        {assigned.slice(0, 4).map((row) => (
          <RhRow key={`a-${row.id}`} to={`/clients/${row.shortId}`}
            lead={<RhCircle icon="user-plus" tone="a1" />}
            title={row.fullName}
            sub={row.byName ? `назначил ${row.byName}` : "назначил руководитель"} />
        ))}
      </RhGroup>
    </RhSection>
  );
}

/** Подписи шагов воронки бытовыми словами; неизвестный шаг — подписью сервера. */
const STEP_LABELS: Record<string, string> = {
  leads: "Новые заявки", contacted: "На связи", showings: "Показы", negotiations: "Переговоры", deals: "Сделки",
};

/** «Мой месяц» — шаги работы с клиентами за месяц (`funnel` сводки), полосами. */
export function AgentMonth() {
  const { summary } = useAgentDay();
  const funnel = Array.isArray(summary.data?.funnel) ? summary.data.funnel : [];
  if (funnel.length === 0 || funnel.every((step) => !step.count)) return null;
  const max = Math.max(1, ...funnel.map((step) => step.count));
  const leads = funnel.find((step) => step.key === "leads")?.count ?? 0;
  return (
    <RhSection title="Мой месяц" to="/clients" className="ry-col-b">
      <HomeBars
        note={`${num(leads)} ${pluralizeRu(leads, ["новая заявка", "новые заявки", "новых заявок"])} с начала месяца`}
        items={funnel.map((step) => ({ key: step.key, name: STEP_LABELS[step.key] ?? step.label, share: step.count / max, value: num(step.count) }))}
      />
    </RhSection>
  );
}

export function AgentFull() {
  return <FullScreenToggle label="Весь экран"><AgentHome /></FullScreenToggle>;
}
