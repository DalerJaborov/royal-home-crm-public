import { Link } from "react-router-dom";
import { pluralizeRu } from "@royal-home/shared";
import { useCan } from "../../../../lib/permissions";
import { dushanbeDate, dushanbeDayKey } from "../../../../lib/date";
import { formatMoney } from "../../../../lib/format";
import { mcOk, useMissionControl, type McHero } from "../../../../hooks/useMissionControl";
import { useTeamLive } from "../../../../hooks/useTeamLive";
import { RoyalIcon } from "../../RoyalIcon";
import { RhAvatar, RhBlockState, RhGroup, RhRow, RhSection } from "../../ui";
import { HomeChip } from "../parts";
import { monthPace, useMinuteNow } from "../time";
import { agentStatus, commissionTrend, previousMonthPeriod } from "../leader";
import { num } from "../charts";

/**
 * ОБЩИЕ БЛОКИ ГЛАВНЫХ РУКОВОДИТЕЛЕЙ (20.11.2026): плита денег директора и акционера,
 * «Команда» директора и РОП, спокойная строка пустого блока. Одна реализация на роли —
 * правила (тренд, период, состояние сотрудника) лежат в ../leader.ts под тестом.
 */

const money = (n: number) => formatMoney(Math.round(n), "TJS");

/**
 * Плита денег: комиссия месяца, сравнение с прошлым месяцем на ту же точку, план (если он
 * задан в Настройках — иначе плана нет и процента нет), ожидаемая комиссия по сделкам в
 * работе и заявки сегодня против вчера. Все числа — из героя-строки снимка пульта.
 */
export function MoneyHero({ commission, leadsToday, financeTo, settingsTo }: {
  commission: NonNullable<McHero["commission"]>;
  leadsToday?: McHero["leadsToday"];
  financeTo?: string;
  settingsTo?: string;
}) {
  const now = useMinuteNow();
  const { fact } = commission;
  const plan = commission.planIsDefault ? null : commission.plan;
  const pct = plan && plan > 0 ? Math.round((fact / plan) * 100) : null;
  const pace = monthPace(dushanbeDayKey(now));
  const month = dushanbeDate(now, { month: "long" });
  const period = previousMonthPeriod(now);
  const trend = commissionTrend(fact, commission.previousMonthToDate);
  const pipeline = commission.pipeline && commission.pipeline.deals > 0 && commission.pipeline.expectedTjs > 0 ? commission.pipeline : null;
  const yesterday = leadsToday ? leadsToday.count - leadsToday.deltaVsYesterday : null;
  const trendText = !trend ? null
    : trend.pct === null ? `больше, чем за ${period.range}: тогда было 0 с.`
    : trend.dir === "flat" ? `столько же, сколько за ${period.range}`
    : `${trend.dir === "up" ? "больше" : "меньше"} на ${trend.pct}%, чем за ${period.range} (${money(commission.previousMonthToDate ?? 0)})`;
  return (
    <div className="ry-hero" data-hero="money">
      <span className="ry-hero-head">
        <span className="ry-hero-label"><RoyalIcon name="banknote" size={24} />Комиссия за {month}</span>
        {financeTo && <Link to={financeTo} className="ry-hero-link">Деньги</Link>}
      </span>
      <span className="ry-hero-value ry-num">{money(fact)}</span>
      {trendText && (
        <span className="ry-hero-trend" data-dir={trend!.dir}>
          {trend!.dir !== "flat" && <RoyalIcon name="trend-up" size={20} className="ry-hero-trend-icon" />}
          <span>{trendText}</span>
        </span>
      )}
      {pct !== null && (
        <span className="ry-hero-bar" role="img" aria-label={`План выполнен на ${pct}%, по времени прошло ${Math.round(pace * 100)}% месяца`}>
          <span className="ry-hero-fill" style={{ width: `${Math.min(100, pct)}%` }} />
          <span className="ry-hero-pace" style={{ left: `${pace * 100}%` }} />
        </span>
      )}
      <span className="ry-hero-minis">
        {pct !== null && plan !== null && <span><span className="ry-hero-mini-text"><b className="ry-num">{pct}%</b> плана {money(plan)}</span></span>}
        {pct === null && settingsTo && <Link to={settingsTo} className="ry-hero-mini-link">Задать план месяца</Link>}
        {pipeline && (
          <span title="Оценка по сделкам в работе с учётом стадии, как в «Прогнозе комиссии»">
            <span className="ry-hero-mini-text">ожидается ≈ <b className="ry-num">{money(pipeline.expectedTjs)}</b> по {pipeline.deals} {pluralizeRu(pipeline.deals, ["сделке", "сделкам", "сделкам"])} в работе</span>
          </span>
        )}
        {(commission.previousMonthTotal ?? 0) > 0 && (
          <span><span className="ry-hero-mini-text">{period.month} целиком: <b className="ry-num">{money(commission.previousMonthTotal ?? 0)}</b></span></span>
        )}
        {leadsToday && (
          <span>
            <span className="ry-hero-mini-text">
              <b className="ry-num">{leadsToday.count}</b> {pluralizeRu(leadsToday.count, ["заявка", "заявки", "заявок"])} сегодня
              {yesterday !== null && yesterday >= 0 && <> · вчера {yesterday}</>}
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

/** Пустой блок одной спокойной строкой: заголовок блока и «пока нет данных» (или своя причина). */
export function HomeQuiet({ title, text = "пока нет данных", className }: { title: string; text?: string; className?: string }) {
  return (
    <p className={`ry-home-quiet${className ? ` ${className}` : ""}`}>
      <b>{title}</b><span>{text}</span>
    </p>
  );
}

/**
 * «Команда» руководителя: по строке на сотрудника — когда заходил в CRM, звонков
 * сегодня, сколько в работе, просрочки; справа одна главная пометка (не принял
 * вовремя, сегодня не заходил, просрочено, ждут принятия, на паузе). Тревожные — сверху.
 *
 * Данные: снимок пульта (`team`: присутствие, нагрузка, просроченные задачи, дела за
 * день, час начала дня) и живая сводка команды (кто не принял заявку вовремя). Оба
 * открыты правом dashboard.analytics — оно же у директора, админа и РОП.
 */
export function LeaderTeam({ id, className, to = "/team", limit = 8 }: { id?: string; className?: string; to?: string; limit?: number }) {
  const can = useCan();
  const canView = can("dashboard.analytics");
  const mc = useMissionControl(canView);
  const live = useTeamLive(canView);
  const now = useMinuteNow();
  const team = mc.data?.team && mcOk(mc.data.team) ? mc.data.team : null;
  if (!canView) return null;
  if (!team) {
    if (mc.isLoading) return <RhSection title="Команда" to={to} className={className}><RhBlockState kind="loading" /></RhSection>;
    if (mc.isError || (mc.data?.team && !mcOk(mc.data.team))) return <RhSection title="Команда" to={to} className={className}><RhBlockState kind="error" onRetry={() => void mc.refetch()} /></RhSection>;
    return null;
  }
  // Агентов нет вовсе — показывать нечего (а не «пустая команда» строкой).
  if (!Array.isArray(team.agents) || team.agents.length === 0) return null;
  const lateById = new Map((Array.isArray(live.data?.agents) ? live.data.agents : []).map((a) => [a.id, a.escalated ?? 0]));
  // Звонки и дела за день сервер отдаёт по каждому агенту (team.agents), а не обрезанным списком «Дня команды».
  const rows = team.agents.map((agent) => ({
    agent,
    status: agentStatus(agent, { lateLeads: lateById.get(agent.id) ?? 0, workdayStartAt: team.workdayStartAt, now }),
  })).sort((a, b) => a.status.rank - b.status.rank || b.agent.activeLoad - a.agent.activeLoad);
  const shown = rows.slice(0, limit);
  return (
    <RhSection id={id} title="Команда сегодня" to={to} className={className}>
      <RhGroup>
        {shown.map(({ agent, status }) => {
          const parts = [status.seen];
          if (typeof agent.callsToday === "number") parts.push(`звонков ${num(agent.callsToday)}`);
          // Плитки РОП ведут сюда: «просрочено» и «не принял вовремя» видны у каждого, даже когда пометка справа о другом.
          const late = lateById.get(agent.id) ?? 0;
          if (late > 0 && !status.flag?.text.startsWith("не принял")) parts.push(`не принял вовремя ${num(late)}`);
          if ((agent.overdueTasks ?? 0) > 0 && !status.flag?.text.startsWith("просрочено")) parts.push(`просрочено задач ${num(agent.overdueTasks ?? 0)}`);
          parts.push(`в работе ${num(agent.activeLoad)}`);
          return (
            <RhRow key={agent.id} to={`/team/${agent.id}`}
              lead={<RhAvatar name={agent.fullName} src={agent.avatarUrl} size={48} />}
              title={agent.fullName}
              sub={parts.join(" · ")}
              right={status.flag ? <HomeChip tone={status.flag.tone}>{status.flag.text}</HomeChip> : undefined} />
          );
        })}
      </RhGroup>
      {rows.length > shown.length && <p className="ry-home-quiet-note">Ещё {rows.length - shown.length} — в разделе «Команда».</p>}
    </RhSection>
  );
}
