import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { NO_CONTACT_TEXT, pluralizeRu } from "@royal-home/shared";
import { useCan, useCanCreateProperty, useIsReadOnly } from "../../../lib/permissions";
import { useNavigation } from "../../../lib/navigation";
import { useAuthStore } from "../../../store/auth";
import { dushanbeDate, dushanbeDayKey } from "../../../lib/date";
import { formatMoney } from "../../../lib/format";
import { defaultPeriod } from "../../../lib/directorFormat";
import { mcOk, useMissionControl } from "../../../hooks/useMissionControl";
import { useTeamLive } from "../../../hooks/useTeamLive";
import { useDirectorDashboard } from "../../../hooks/useDirectorDashboard";
import { ShowingQuickForm } from "../../ShowingQuickForm";
import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";
import { RhAvatar, RhBlockState, RhCircle, RhGroup, RhRow, RhSection, blockState, type RhTone } from "../ui";
import { loadView } from "../../rh2/Rh2ErrorState";
import { pillTone } from "../tileTone";
import { channelBrand, monthPace, useMinuteNow } from "../home/time";
import { agentStatus, commissionTrend, previousMonthPeriod, waitLabel } from "../home/leader";
import { useHomeLayoutPrefs } from "../home/prefs";
import { num } from "../home/charts";
import { gaugePoint, gaugeView, lostTotal, planPercent, sourceColumns } from "./model";

/**
 * БЛОКИ ГЛАВНОЙ РУКОВОДИТЕЛЯ «КАК В МАКЕТЕ» (пачка home2, 27.11.2026; макет
 * docs/design/oblik-2026-11-17/royal-home.src.html — moneyHero, tilesBlock, quickBlock,
 * speedBlock, crewBlock, sourcesBlock).
 *
 * Данные — только уже существующие запросы: снимок пульта (`useMissionControl`, право
 * dashboard.analytics), живая сводка команды (`useTeamLive`) и сводка дашборда
 * (`useDirectorDashboard`, право reports.view — оно у этих ролей есть по определению главной).
 * TanStack Query сводит одинаковые ключи соседних блоков в один поход. Чего в данных нет,
 * того на экране нет: ни «зависших сделок», ни «нормы 15 мин» из макета — у CRM такого
 * числа нет, поэтому плашки другие (см. журнал пачки).
 */

/** Снимок пульта для блоков пачки — один кэш с блоками ядра главной. */
function useSnap() {
  const can = useCan();
  const { all: navigation } = useNavigation();
  const canView = can("dashboard.analytics");
  const mc = useMissionControl(canView);
  const data = mc.data;
  return {
    can, canView, mc,
    /** Состояние снимка: «грузится», «нет связи», «не загрузилось» или «готов» (общая loadView). */
    mcView: loadView(mc),
    hasRoute: (path: string) => navigation.some((item) => item.to === path),
    hero: data?.hero && mcOk(data.hero) ? data.hero : null,
    bot: data?.bot && mcOk(data.bot) ? data.bot : null,
    team: data?.team && mcOk(data.team) ? data.team : null,
    firstLine: data?.firstLine && mcOk(data.firstLine) ? data.firstLine : null,
    firstLineBroken: !!data?.firstLine && !mcOk(data.firstLine),
  };
}

/** «48 200 с.» → число и валюта отдельно (валюта мельче, как в макете); текст не меняется. */
function moneyParts(value: number): [string, string] {
  const text = formatMoney(Math.round(value), "TJS");
  const at = text.lastIndexOf(" ");
  return at > 0 ? [text.slice(0, at), text.slice(at + 1)] : [text, ""];
}

/** Мини-плашка плиты: значок, крупное число, короткая подпись и (если есть) сумма строкой ниже. */
function Mini({ icon, value, label, note, tone, to }: { icon: RoyalIconName; value: ReactNode; label: string; note?: string; tone?: "warn"; to?: string }) {
  const body = <>
    <RoyalIcon name={icon} size={24} />
    <b className="ry-num" data-tone={tone}>{value}</b>
    <span className="h2-mini-label">{label}</span>
    {note && <span className="h2-mini-note ry-num">{note}</span>}
  </>;
  return to ? <Link to={to} className="h2-mini">{body}</Link> : <span className="h2-mini">{body}</span>;
}

/**
 * Плита «Комиссия»: сумма месяца, полоса плана с отметкой «сколько месяца прошло» и три
 * мини-плашки. Есть только при праве на деньги (сервер иначе комиссии не присылает).
 * Плашки: процент плана (план задан) или «задать план»; сделки в работе с ожидаемым закрытием
 * в этом месяце (иначе покупатели в работе); клиенты, с кем никто не связывался.
 */
export function CommissionPlate() {
  const d = useSnap();
  const now = useMinuteNow();
  if (!d.canView) return null;
  const view = d.mcView;
  if (view === "loading" && !d.mc.data) return <div className="h2-plate h2-plate-skel" aria-busy="true" aria-label="Загрузка" />;
  if (!d.hero) return view === "error" || view === "offline" ? <RhSection title="Комиссия">{blockState(d.mc)}</RhSection> : null;
  const c = d.hero.commission;
  if (!d.mc.data?.seesMoney || !c) return null;
  const pct = planPercent(c.fact, c.plan, c.planIsDefault);
  const pace = monthPace(dushanbeDayKey(now));
  const month = dushanbeDate(now, { month: "long" });
  const trend = commissionTrend(c.fact, c.previousMonthToDate);
  const period = previousMonthPeriod(now);
  const [value, unit] = moneyParts(c.fact);
  const pipeline = c.pipeline && c.pipeline.deals > 0 ? c.pipeline : null;
  const inWork = d.hero.dealsInPipeline;
  const noContact = inWork.stuckTotal;
  const settingsTo = d.hasRoute("/settings") && d.can("settings.manage") ? "/settings?tab=money" : undefined;
  return (
    <section className="h2-plate" aria-label={`Комиссия за ${month}`} data-block-body="plate">
      <span className="h2-plate-head">
        <span className="h2-plate-label"><RoyalIcon name="banknote" size={26} />Комиссия · {month}</span>
        {d.hasRoute("/finance") && <Link to="/finance" className="h2-plate-link">Деньги</Link>}
      </span>
      <span className="h2-plate-value ry-num">{value}{unit && <small> {unit}</small>}</span>
      {trend && (
        <span className="h2-plate-trend" data-dir={trend.dir}>
          {trend.pct === null ? `больше, чем за ${period.range}`
            : trend.dir === "flat" ? `столько же, сколько за ${period.range}`
            : `${trend.dir === "up" ? "больше" : "меньше"} на ${trend.pct}%, чем за ${period.range}`}
        </span>
      )}
      {pct !== null && (
        <span className="h2-plate-bar" role="img" aria-label={`План выполнен на ${pct}%, прошло ${Math.round(pace * 100)}% месяца`}>
          <span className="h2-plate-fill" style={{ width: `${Math.min(100, pct)}%` }} />
          <span className="h2-plate-pace" style={{ left: `${pace * 100}%` }} />
        </span>
      )}
      <span className="h2-minis">
        {pct !== null
          ? <Mini icon="trend-up" value={`${pct}%`} label="плана" note={formatMoney(Math.round(c.plan), "TJS")} />
          : settingsTo ? <Mini icon="trend-up" value="План" label="задать" to={settingsTo} /> : null}
        {pipeline
          ? <Mini icon="handshake" value={num(pipeline.deals)} label={`в ${pluralizeRu(pipeline.deals, ["сделке", "сделках", "сделках"])}`}
            note={`≈ ${formatMoney(Math.round(pipeline.expectedTjs), "TJS")}`} to={d.hasRoute("/deals") ? "/deals" : undefined} />
          : <Mini icon="handshake" value={num(inWork.count)} label="в работе" note={pluralizeRu(inWork.count, ["покупатель", "покупателя", "покупателей"])} to={d.hasRoute("/clients") ? "/clients" : undefined} />}
        {typeof noContact === "number" && (
          <Mini icon="circle-alert" value={num(noContact)} label={noContact > 0 ? NO_CONTACT_TEXT.tile : NO_CONTACT_TEXT.zero} tone={noContact > 0 ? "warn" : undefined}
            to={noContact > 0 && d.hasRoute("/clients") ? "/clients?slice=noContact" : undefined} />
        )}
      </span>
    </section>
  );
}

/**
 * Две плитки макета: лаймовая «Ждут ответа» (клиенты в чатах ждут человека) и чёрная «Горит»
 * (первая линия снимка). Под ними — то, что прежде показывала полоса «Требует внимания» и чего
 * нет в плитках: пропущенные звонки, заявки без принятия; у РОП ещё просрочки агентов.
 * Строка появляется, только когда число больше нуля.
 */
export function PulseTiles({ role }: { role: string }) {
  const d = useSnap();
  const live = useTeamLive(d.canView);
  // Плитка ведёт к блоку на этой же главной, только если он не выключен в «Оформлении».
  const { hidden } = useHomeLayoutPrefs(role);
  if (!d.canView) return null;
  const view = d.mcView;
  if (view === "loading" || view === "offline") return blockState(d.mc);
  const waiting = d.bot?.attention?.waitingHuman;
  const oldest = waiting?.items?.length ? Math.max(...waiting.items.map((item) => item.waitingMinutes)) : null;
  const burning = d.firstLine?.totalCount ?? null;
  const rop = role === "HEAD_OF_SALES";
  const unaccepted = typeof live.data?.unacceptedTotal === "number" ? live.data.unacceptedTotal : 0;
  const late = typeof live.data?.escalatedTotal === "number" ? live.data.escalatedTotal : 0;
  const overdue = d.team ? d.team.agents.reduce((sum, agent) => sum + (agent.overdueTasks ?? 0), 0) : 0;
  const rows: ReactNode[] = [];
  if (d.hero && d.hero.missedCallsToday > 0) rows.push(
    <RhRow key="missed" to={d.hasRoute("/calls") ? "/calls" : undefined} lead={<RhCircle icon="phone-missed" tone={pillTone("overdue")} filled />}
      title="Пропущенные звонки" sub="сегодня" right={<b className="ry-num ry-count">{num(d.hero.missedCallsToday)}</b>} />,
  );
  if (unaccepted > 0) rows.push(
    <RhRow key="unaccepted" to="/clients?slice=pending" lead={<RhCircle icon="user-plus" tone={pillTone(late > 0 ? "overdue" : "today")} />}
      title="Ждут принятия" sub={late > 0 ? `время вышло: ${num(late)}` : "заявки у агентов"} subTone={late > 0 ? "crit" : undefined}
      right={<b className="ry-num ry-count">{num(unaccepted)}</b>} />,
  );
  // «Команда» на этой главной рисуется, только если не выключена, есть раздел «Команда» и есть агенты (CrewBlock).
  const crewShown = !hidden.has("crew") && d.hasRoute("/team") && !!d.team && Array.isArray(d.team.agents) && d.team.agents.length > 0;
  if (rop && overdue > 0) rows.push(
    <RhRow key="overdue" to={crewShown ? "#ry-leader-crew" : d.hasRoute("/team") ? "/team" : undefined} lead={<RhCircle icon="hourglass" tone={pillTone("today")} />}
      title="Просрочки агентов" sub="задачи после срока" right={<b className="ry-num ry-count">{num(overdue)}</b>} />,
  );
  if (!waiting && burning === null && !d.firstLineBroken && rows.length === 0) {
    return view === "error" ? blockState(d.mc) : null;
  }
  const burnTo = d.firstLine && d.firstLine.items.length > 0 && !hidden.has("burning") ? "#ry-burning" : d.hasRoute("/oversight") ? "/oversight" : undefined;
  return (
    <div className="h2-pulse" data-block-body="tiles">
      <div className="h2-tiles">
        {waiting && (
          <Tile variant={waiting.count > 0 ? "brand" : "calm"} icon="message-circle" label="Ждут ответа" value={num(waiting.count)}
            note={waiting.count > 0 ? (oldest !== null ? `дольше всех ${waitLabel(oldest)}` : "клиенты в чатах") : "всё спокойно"}
            to={d.hasRoute("/messages") ? "/messages" : undefined} />
        )}
        {burning !== null ? (
          <Tile variant={burning > 0 ? "ink" : "calm"} icon="flame" label="Горит" value={num(burning)} note={burning > 0 ? "срочное сейчас" : "всё спокойно"} to={burnTo} />
        ) : d.firstLineBroken ? (
          // Первая линия не посчиталась — не «всё спокойно» и не пропажа плитки: так и говорим.
          <Tile variant="calm" icon="flame" label="Горит" value="—" note="не загрузилось" />
        ) : null}
      </div>
      {d.firstLineBroken && <RhBlockState kind="error" onRetry={() => void d.mc.refetch()} />}
      {rows.length > 0 && <RhGroup label="Ещё срочно">{rows}</RhGroup>}
      {/* Живая сводка не пришла — «ждут принятия» неизвестно: говорим это, а не молчим. */}
      {loadView(live) === "error" && <RhBlockState kind="error" onRetry={() => void live.refetch()} />}
    </div>
  );
}

/**
 * Плитка макета. Цвет — по смыслу (решение владельца 27.11, правило 20.11 «ноль — серым»): лайм и
 * чёрная — только когда число больше нуля; ноль — спокойная светлая плитка той же формы.
 */
function Tile({ variant, icon, label, value, note, to }: { variant: "brand" | "ink" | "calm"; icon: RoyalIconName; label: string; value: string; note: string; to?: string }) {
  const inner = <>
    <span className="h2-tile-label"><RoyalIcon name={icon} size={24} />{label}</span>
    <span className="h2-tile-value ry-num">{value}</span>
    <span className="h2-tile-note">{note}</span>
  </>;
  if (to?.startsWith("#")) {
    return <a href={to} className="h2-tile" data-variant={variant} onClick={(event) => { event.preventDefault(); document.getElementById(to.slice(1))?.scrollIntoView({ block: "start" }); }}>{inner}</a>;
  }
  if (to) return <Link to={to} className="h2-tile" data-variant={variant}>{inner}</Link>;
  return <div className="h2-tile" data-variant={variant}>{inner}</div>;
}

/**
 * Четыре круга быстрых действий макета: «Клиент» (форма нового клиента), «Показ» (выбор клиента
 * и запись показа — та же форма, что в меню «+»), «Объект» (мастер нового объекта), «Задачи»
 * (контроль задач команды: отдельной формы новой задачи в CRM нет, поэтому круг ведёт туда, где
 * задачи видны). Каждый — только при своём праве, как в меню «+».
 */
export function QuickActions() {
  const can = useCan();
  const readOnly = useIsReadOnly();
  const canCreateProperty = useCanCreateProperty();
  const { all: navigation } = useNavigation();
  const [showing, setShowing] = useState(false);
  const hasRoute = (path: string) => navigation.some((item) => item.to === path);
  const items: { key: string; label: string; icon: RoyalIconName; tone: RhTone; to?: string; onClick?: () => void }[] = [];
  if (!readOnly && hasRoute("/clients")) items.push({ key: "client", label: "Клиент", icon: "user-plus", tone: "a0", to: "/clients?new=1" });
  if (!readOnly) items.push({ key: "showing", label: "Показ", icon: "calendar-plus", tone: "a2", onClick: () => setShowing(true) });
  if (canCreateProperty) items.push({ key: "object", label: "Объект", icon: "building-2", tone: "a5", to: "/properties/new" });
  if (can("dashboard.analytics") && hasRoute("/oversight")) items.push({ key: "tasks", label: "Задачи", icon: "list-checks", tone: "a4", to: "/oversight" });
  if (!items.length) return null;
  return (
    <>
      <nav className="h2-quick" aria-label="Быстрые действия" data-block-body="quick">
        {items.map((item) => {
          const body = <><RhCircle icon={item.icon} tone={item.tone} size={60} /><span>{item.label}</span></>;
          return item.to
            ? <Link key={item.key} to={item.to} className="h2-q">{body}</Link>
            : <button key={item.key} type="button" className="h2-q" onClick={item.onClick}>{body}</button>;
        })}
      </nav>
      {showing && <ShowingQuickForm clean onClose={() => setShowing(false)} />}
    </>
  );
}

/**
 * «Ответ вчера» (блок «Скорость ответа» макета) — шкала на настоящем числе: медиана первого ответа за вчера (снимок
 * пульта). Шкала — час, потому что «дольше часа» — уже существующий в CRM порог долгого ответа
 * (утренняя сводка); нормы «15 мин» в CRM нет, и на экране её нет. Нет медианы — нет блока.
 */
export function SpeedGauge() {
  const d = useSnap();
  if (!d.canView || !d.hero) return null;
  const gauge = gaugeView(d.hero.firstResponse.medianMinYesterday);
  if (!gauge) return null;
  const minutes = Math.round(d.hero.firstResponse.medianMinYesterday ?? 0);
  const none = d.hero.firstResponse.noneCountYesterday;
  const knob = gaugePoint(gauge.share);
  return (
    // Шкала — за ВЧЕРА (снимок пульта), а «Скорость ответа» в «Аналитике» — за выбранный период:
    // подпись говорит «вчера», нажатие ведёт к подробностям ниже.
    <a href="#dd-speed" className="h2-speed" data-block-body="speed"
      aria-label={`Ответ вчера: обычно ${minutes} мин, ${gauge.verdict}${none > 0 ? `, без ответа ${none}` : ""}. Подробнее — в «Аналитике»`}
      onClick={(event) => { event.preventDefault(); document.getElementById("dd-speed")?.scrollIntoView({ block: "start" }); }}>
      <span className="h2-speed-label"><RoyalIcon name="gauge" size={26} />Ответ вчера</span>
      <div className="h2-gauge" aria-hidden="true">
        <svg viewBox="0 0 200 112" aria-hidden="true">
          <path className="h2-gauge-track" pathLength={100} d="M20 100A80 80 0 0 1 180 100" />
          <path className="h2-gauge-fill" data-tone={gauge.tone} pathLength={100} d="M20 100A80 80 0 0 1 180 100" style={{ strokeDasharray: `${gauge.share * 100} 100` }} />
          <circle className="h2-gauge-knob" cx={knob.x} cy={knob.y} r="9" />
        </svg>
        <span className="h2-gauge-value"><b className="ry-num">{num(minutes)}</b> мин</span>
      </div>
      <span className="h2-speed-foot">
        <span className="h2-chip" data-tone={gauge.tone}>{gauge.verdict}</span>
        <span>первый ответ, обычно{none > 0 ? ` · без ответа ${num(none)}` : ""}</span>
      </span>
    </a>
  );
}

/**
 * «Команда» макета — круги с фото, точка состояния и число тревог; под именем одна строка
 * состояния (не прячем: «не принял вовремя», «сегодня не заходил», «просрочено», «сейчас в CRM»).
 * Те же данные и правила, что «Команда сегодня» ядра главной (home/leader.ts: agentStatus).
 */
export function CrewBlock() {
  const d = useSnap();
  const live = useTeamLive(d.canView);
  const now = useMinuteNow();
  if (!d.canView || !d.hasRoute("/team")) return null;
  if (!d.team) {
    const state = blockState(d.mc);
    if (state) return <RhSection title="Команда" to="/team">{state}</RhSection>;
    if (d.mc.data?.team && !mcOk(d.mc.data.team)) return <RhSection title="Команда" to="/team"><RhBlockState kind="error" onRetry={() => void d.mc.refetch()} /></RhSection>;
    return null;
  }
  if (!Array.isArray(d.team.agents) || d.team.agents.length === 0) return null;
  const lateById = new Map((Array.isArray(live.data?.agents) ? live.data.agents : []).map((a) => [a.id, a.escalated ?? 0]));
  const people = d.team.agents.map((agent) => {
    const late = lateById.get(agent.id) ?? 0;
    const status = agentStatus(agent, { lateLeads: late, workdayStartAt: d.team!.workdayStartAt, now });
    const alarms = late + (agent.overdueTasks ?? 0);
    return { agent, status, alarms };
  }).sort((a, b) => a.status.rank - b.status.rank || b.agent.activeLoad - a.agent.activeLoad);
  const shown = people.slice(0, 12);
  return (
    <RhSection id="ry-leader-crew" title="Команда" to="/team">
      <div className="h2-crew">
        {shown.map(({ agent, status, alarms }) => {
          const text = status.flag?.text ?? status.seen;
          const dot = status.flag ? (status.flag.tone === "muted" ? "muted" : status.flag.tone) : status.seen === "сейчас в CRM" ? "ok" : "muted";
          return (
            <Link key={agent.id} to={`/team/${agent.id}`} className="h2-crew-person" aria-label={`${agent.fullName}: ${text}${alarms > 0 ? `, тревог ${alarms}` : ""}`}>
              <span className="h2-crew-av">
                <RhAvatar name={agent.fullName} src={agent.avatarUrl} size={64} />
                {alarms > 0 && <b className="h2-crew-badge ry-num" aria-hidden="true">{alarms}</b>}
                <i className="h2-crew-dot" data-tone={dot} aria-hidden="true" />
              </span>
              <span className="h2-crew-name">{agent.fullName.split(/\s+/)[0]}</span>
              <span className="h2-crew-status" data-tone={status.flag && status.flag.tone !== "muted" ? pillTone(status.flag.tone === "crit" ? "overdue" : "today") : undefined}>{text}</span>
            </Link>
          );
        })}
      </div>
      {people.length > shown.length && <p className="h2-quiet">Ещё {people.length - shown.length} — в разделе «Команда».</p>}
      {/* Без живой сводки не видно, кто не принял заявку вовремя: так и говорим. */}
      {loadView(live) === "error" && <RhBlockState kind="error" onRetry={() => void live.refetch()} />}
    </RhSection>
  );
}

type SourcePeriod = "week" | "month";

/**
 * «Заявки» макета — столбики по источникам за неделю или месяц и строка «Потеряно». Числа —
 * из сводки дашборда (тот же запрос и кэш, что у «Аналитики» ниже, без фильтров), «Потеряно» —
 * сумма причин отказа за тот же период БЕЗ фильтров (подпись так и говорит: у «Аналитики» ниже период
 * и фильтры могут быть другими) и ведёт к разбору причин там.
 */
export function SourcesColumns() {
  const role = useAuthStore((s) => s.agent?.role);
  const can = useCan();
  const [period, setPeriod] = useState<SourcePeriod>(defaultPeriod(role) === "week" ? "week" : "month");
  const enabled = can("reports.view");
  const query = useDirectorDashboard({ preset: period }, enabled);
  if (!enabled) return null;
  const state = query.data ? null : blockState(query);
  const data = query.data;
  const cols = data ? sourceColumns(data.sources) : null;
  const lost = data ? lostTotal(data) : 0;
  return (
    <section className="ry-section" aria-label="Заявки по источникам" data-block-body="sources">
      <header className="ry-section-head">
        <h2>Заявки</h2>
        <span className="h2-per" role="radiogroup" aria-label="Период заявок">
          {([["week", "Неделя"], ["month", "Месяц"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={period === id} tabIndex={period === id ? 0 : -1}
              onClick={() => setPeriod(id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setPeriod(period === "week" ? "month" : "week");
              }}>{label}</button>
          ))}
        </span>
      </header>
      {state ?? (cols && (
        <div className="h2-cols">
          {cols.columns.length === 0 ? (
            <RhRow lead={<RhCircle icon="inbox" tone="a0" />} title={period === "week" ? "За неделю заявок нет" : "За месяц заявок нет"} />
          ) : (
            <div className="h2-cols-grid" role="img" aria-label={cols.columns.map((c) => `${c.label}: ${c.leads}`).join(", ")} data-count={cols.columns.length}>
              {cols.columns.map((c) => {
                const brand = channelBrand(c.source);
                return (
                  <div key={c.source} className="h2-src">
                    <b className="ry-num">{num(c.leads)}</b>
                    <span className="h2-src-track"><i data-top={c.top ? "true" : undefined} style={{ height: `${Math.round(Math.max(0.06, c.share) * 100)}%` }} /></span>
                    {brand ? <RhCircle brand={brand} /> : <RhCircle icon="globe" tone="a0" />}
                    <span className="h2-src-name">{c.label}</span>
                  </div>
                );
              })}
            </div>
          )}
          {cols.restLeads > 0 && (
            <RhRow lead={<RhCircle icon="stack" tone="a3" />} title="Другие источники" sub={`${cols.restCount} ${pluralizeRu(cols.restCount, ["источник", "источника", "источников"])}`}
              right={<b className="ry-num ry-count">{num(cols.restLeads)}</b>} />
          )}
          <RhRow to="#dd-reasons" lead={<RhCircle icon="x-circle" tone={lost > 0 ? pillTone("overdue") : "a0"} filled={lost > 0} />}
            title="Потеряно" sub={`${period === "week" ? "за неделю" : "за месяц"}, все менеджеры и источники${lost > 0 ? " · почему — в «Аналитике»" : ""}`}
            right={<b className="ry-num ry-count" data-tone={lost > 0 ? pillTone("overdue") : undefined}>{num(lost)}</b>} />
        </div>
      ))}
    </section>
  );
}
