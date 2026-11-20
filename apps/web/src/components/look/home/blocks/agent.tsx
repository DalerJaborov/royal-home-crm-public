import { pluralizeRu } from "@royal-home/shared";
import { dushanbeTime } from "../../../../lib/date";
import { lazyWithReload } from "../../../../lib/lazyWithReload";
import { useDashboardSummary } from "../../../../hooks/useDashboard";
import { useClients } from "../../../../hooks/useClients";
import { buildShowings } from "../../../../lib/agentDay";
import { RhAvatar, RhCircle, RhGroup, RhRow, RhSection, RhTile, blockState } from "../../ui";
import { HomeBars, num } from "../charts";
import { FullScreenToggle } from "./full";
import { CallClientButton } from "../../../CallClientButton";
import { pillTone } from "../../tileTone";

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
  const pendingState = blockState(pendingPage);
  return (
    <RhSection id="ry-agent-pending" title="Ждут принятия" to="/clients" className="ry-col-a">
      {pendingState ? pendingState
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
  const showingsState = blockState(summary);
  return (
    <RhSection id="ry-agent-showings" title="Показы сегодня" to="/calendar" linkLabel="Календарь" className="ry-col-b">
      {showingsState ? showingsState
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
  // Клиент, назначенный руководителем, обычно стоит и в «первом звонке» — показываем
  // его один раз, строкой срока (как прежний AgentHome: `!due.has(c.id)`).
  const dueIds = new Set(due.map((row) => row.id));
  const assigned = (Array.isArray(summary.data?.assignedBySupervisor) ? summary.data.assignedBySupervisor : []).filter((row) => !dueIds.has(row.id));
  if (due.length + assigned.length === 0) return null;
  const now = Date.now();
  return (
    <RhSection title="Позвонить сейчас" to="/clients" className="ry-col-a">
      <RhGroup>
        {due.slice(0, 6).map((row) => {
          const late = Date.parse(row.dueAt) < now;
          // Звонок прямо из строки (пачка D1): раньше агенту надо было открыть карточку и
          // искать «Позвонить» там. Кнопка — соседка ссылки, а не внутри неё (кнопка в ссылке
          // открывала бы карточку вместо звонка). Номер не печатаем: решение владельца 19.11.
          return (
            <div key={row.id} className="ry-agent-call-row">
              <RhRow to={`/clients/${row.shortId}`}
                lead={<RhCircle icon={late ? "hourglass" : "phone-call"} tone={pillTone(late ? "overdue" : "today")} filled={late} />}
                title={row.fullName}
                sub={late ? ["срок вышел, позвоните сейчас", row.afterDue].filter(Boolean).join(" · ") : `первый звонок до ${dushanbeTime(row.dueAt)}`}
                subTone={late ? "crit" : "warn"}
                right={<span className="ry-row-time" data-tone={late ? pillTone("overdue") : undefined}>{dushanbeTime(row.dueAt)}</span>} />
              <CallClientButton clientId={row.id} phone={row.phone} variant="icon" label={`Позвонить: ${row.fullName}`}
                title="Позвонить через CRM" className="ry-agent-call-btn" stopPropagation={false} />
            </div>
          );
        })}
        {assigned.slice(0, 4).map((row) => (
          <div key={`a-${row.id}`} className="ry-agent-call-row">
            <RhRow to={`/clients/${row.shortId}`}
              lead={<RhCircle icon="user-plus" tone="a1" />}
              title={row.fullName}
              sub={row.byName ? `назначил ${row.byName}` : "назначил руководитель"} />
            <CallClientButton clientId={row.id} phone={row.phone} variant="icon" label={`Позвонить: ${row.fullName}`}
              title="Позвонить через CRM" className="ry-agent-call-btn" stopPropagation={false} />
          </div>
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
