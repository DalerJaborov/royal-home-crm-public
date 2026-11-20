import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { monthShort, monthTitle, pluralizeRu } from "@royal-home/shared";
import { useCan } from "../../../../lib/permissions";
import { useNavigation } from "../../../../lib/navigation";
import { dushanbeDate, dushanbeDayKey } from "../../../../lib/date";
import { formatMoney } from "../../../../lib/format";
import { lazyWithReload } from "../../../../lib/lazyWithReload";
import { mcOk, useMissionControl, usePropertiesPendingReview, type McFirstLineItem, type McMarketingChannel } from "../../../../hooks/useMissionControl";
import { useProperties } from "../../../../hooks/useProperties";
import { usePultActionRows, usePultActionStatus } from "../../../pult/PultActions";
import { CleanDecisionRow } from "../../../clean/CleanDecisionRow";
import { RoyalIcon } from "../../RoyalIcon";
import { RH_SEVERITY_ICON, RhAvatar, RhBlockState, RhCircle, RhGroup, RhRow, RhSection, RhTile } from "../../ui";
import { channelBrand, monthPace } from "../time";
import { HomeColumns, num } from "../charts";
import { FullScreenToggle } from "./full";

/**
 * ГЛАВНАЯ ДИРЕКТОРА И АДМИНА — блоки ядра (перенесены из pages/TodayRoyal.tsx, home-core 20.11.2026).
 *
 * Данные — те же запросы, что у пульта: снимок `useMissionControl` (живое + зоны),
 * очередь решений `usePultActionRows`, объекты на проверке. Каждый блок зовёт их сам —
 * TanStack Query сводит одинаковые ключи в один поход, лишних запросов нет. Графики
 * берут то, что снимок уже несёт (`marketing.pulse30`, `commission12`): ни одного
 * нового запроса. Блок без источника не рисуется, числа не выдумываются; выключенный
 * модуль пульта сервер не присылает вовсе — блок просто не появляется.
 */

const PultClean = lazyWithReload(() => import("../../../../pages/PultClean").then((m) => ({ default: m.PultClean })));

/** Общее чтение снимка для блоков директора (один и тот же кэш у всех). */
function useDirector() {
  const can = useCan();
  const { all: navigation } = useNavigation();
  const hasRoute = (path: string) => navigation.some((item) => item.to === path);
  const canView = can("dashboard.analytics");
  const mc = useMissionControl(canView);
  const data = mc.data;
  return {
    can, hasRoute, canView, ...mc,
    hero: data?.hero && mcOk(data.hero) ? data.hero : null,
    team: data?.team && mcOk(data.team) ? data.team : null,
    bot: data?.bot && mcOk(data.bot) ? data.bot : null,
    system: data?.system && mcOk(data.system) ? data.system : null,
    marketing: data?.marketing && mcOk(data.marketing) ? data.marketing : null,
    clientsZone: data?.clientsZone && mcOk(data.clientsZone) ? data.clientsZone : null,
    commission12: data?.commission12 && mcOk(data.commission12) ? data.commission12 : null,
    firstLineBroken: !!data?.firstLine && !mcOk(data.firstLine),
    firstLine: data?.firstLine && mcOk(data.firstLine) ? data.firstLine : null,
  };
}

/** Деньги и плитки сверху. Без права на аналитику — прежняя строка «только руководству». */
export function DirectorMoney() {
  const d = useDirector();
  if (!d.canView) return <RhGroup><RhRow lead={<RhCircle icon="shield-check" tone="a3" />} title="Раздел доступен только руководству." /></RhGroup>;
  if (d.isError && !d.data) return <RhBlockState kind="error" onRetry={() => void d.refetch()} />;
  const { hero, bot, firstLine, firstLineBroken } = d;
  const showMoney = !!hero?.commission && !!d.data?.seesMoney;
  return (
    <div className="ry-strip">
      {d.isLoading && !d.data ? <div className="ry-hero ry-hero-skeleton" aria-busy="true" /> : showMoney && hero?.commission ? (
        <MoneyHero
          fact={hero.commission.fact} plan={hero.commission.planIsDefault ? null : hero.commission.plan}
          deals={hero.dealsInPipeline.count} leadsToday={hero.leadsToday.count}
          to={d.hasRoute("/finance") ? "/finance" : undefined}
        />
      ) : hero ? (
        <RhTile variant="plain" icon="handshake" label="Сделки идут" value={hero.dealsInPipeline.count} to={d.hasRoute("/deals") ? "/deals" : undefined} />
      ) : null}
      {bot?.attention && (
        <RhTile variant="brand" icon="message-circle" label="Ждут ответа" value={bot.attention.waitingHuman.count} to={d.hasRoute("/messages") ? "/messages" : undefined} />
      )}
      {(firstLine || firstLineBroken) && (
        <RhTile variant="ink" icon="flame" label="Горит" value={firstLine ? firstLine.totalCount : "—"} to="#ry-burning" alert={firstLineBroken} />
      )}
      {hero && hero.firstResponse.medianMinYesterday !== null && (
        <RhTile variant="plain" icon="clock" label="Ответ вчера" value={Math.round(hero.firstResponse.medianMinYesterday)} unit="мин" />
      )}
      {hero && !showMoney && (
        <RhTile variant="plain" icon="user-plus" label="Заявки сегодня" value={hero.leadsToday.count} to={d.hasRoute("/clients") ? "/clients" : undefined} />
      )}
    </div>
  );
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

/** «Нужно ваше решение» — прежние строки пульта со всеми их действиями. */
export function DirectorDecisions() {
  const d = useDirector();
  const rows = usePultActionRows(d.canView);
  // Упавший запрос очереди не значит «решений нет» — как у прежней главной.
  const actionStatus = usePultActionStatus(d.canView);
  const queryClient = useQueryClient();
  const retryFailed = () => void queryClient.refetchQueries({ type: "active", predicate: (query) => query.state.status === "error" });
  const pending = usePropertiesPendingReview(d.canView);
  const props = useProperties({ page: 1 }, d.canView);
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
  if (!d.canView) return null;
  return (
    <RhSection title="Нужно ваше решение" to={d.hasRoute("/oversight") ? "/oversight" : undefined} className="ry-col-a">
      {rows === null ? <RhBlockState kind={d.isError || actionStatus.isError ? "error" : "loading"} onRetry={retryFailed} />
        : rows.length === 0 ? (actionStatus.isError ? <RhBlockState kind="error" onRetry={retryFailed} />
          : <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Решений нет" /></RhGroup>)
        : <div className="ry-decisions clean">
          {actionStatus.isError && <RhBlockState kind="error" onRetry={retryFailed} />}
          {rows.slice(0, 6).map((row) => <CleanDecisionRow key={row.id} row={row} photos={photoById} />)}
        </div>}
    </RhSection>
  );
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

/** «Горит сейчас» — первая линия снимка. */
export function DirectorBurning() {
  const d = useDirector();
  const { firstLine, firstLineBroken } = d;
  if (!d.canView || !(firstLine || firstLineBroken || d.isLoading)) return null;
  return (
    <RhSection id="ry-burning" title="Горит сейчас" to={d.hasRoute("/oversight") ? "/oversight" : undefined} className="ry-col-b">
      {firstLineBroken ? <RhBlockState kind="error" onRetry={() => void d.refetch()} />
        : !firstLine ? <RhBlockState kind="loading" />
        : firstLine.items.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Всё спокойно" /></RhGroup>
        : <RhGroup>{firstLine.items.slice(0, 6).map((item) => <BurningRow key={item.id} item={item} />)}</RhGroup>}
    </RhSection>
  );
}

/** «Проверить» — счётчики, у которых есть куда перейти. */
export function DirectorCheck() {
  const d = useDirector();
  const pending = usePropertiesPendingReview(d.canView);
  if (!d.canView) return null;
  const { hero, team, clientsZone, system, can, hasRoute } = d;
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
  return items.length ? <RhSection title="Проверить" className="ry-col-a"><RhGroup>{items}</RhGroup></RhSection> : null;
}

function isOnline(lastSeenAt?: string | null): boolean {
  return !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < 15 * 60_000;
}

/** «Команда» — шесть человек из снимка. */
export function DirectorTeam() {
  const d = useDirector();
  const { team } = d;
  if (!d.canView || !team || team.agents.length === 0 || !d.hasRoute("/team")) return null;
  return (
    <RhSection title="Команда" to="/team" className="ry-col-b">
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
  );
}

/** «Заявки за месяц» по каналам — полосы в родных цветах каналов. */
export function DirectorChannels() {
  const d = useDirector();
  const { marketing } = d;
  if (!d.canView || !marketing || marketing.funnel.length === 0) return null;
  return (
    <RhSection title="Заявки за месяц" to={d.hasRoute("/sources") ? "/sources" : undefined}>
      <Channels funnel={marketing.funnel} />
    </RhSection>
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

/** «Заявки и показы за 30 дней» — из снимка (`marketing.pulse30`), без нового запроса. */
export function DirectorPulse() {
  const d = useDirector();
  const pulse = d.marketing?.pulse30;
  if (!d.canView || !pulse || !Array.isArray(pulse.days) || pulse.days.length === 0 || pulse.leadsTotal + pulse.showingsTotal === 0) return null;
  const last = pulse.days[pulse.days.length - 1];
  return (
    <RhSection title="Заявки за 30 дней" to={d.hasRoute("/sources") ? "/sources" : undefined} className="ry-col-a">
      <HomeColumns
        note={`${num(pulse.leadsTotal)} ${pluralizeRu(pulse.leadsTotal, ["заявка", "заявки", "заявок"])} · ${num(pulse.showingsTotal)} ${pluralizeRu(pulse.showingsTotal, ["показ", "показа", "показов"])}`}
        ariaLabel={`Заявки по дням за 30 дней: всего ${pulse.leadsTotal}, показов ${pulse.showingsTotal}`}
        lastValueLabel={num(last.leads)}
        items={pulse.days.map((day, index, all) => ({
          key: day.date,
          // Тридцать подписей сливаются в строку цифр: подписан каждый пятый день и сегодняшний
          // (числа каждого дня — в подсказке столбика и в описании графика для чтеца).
          label: (all.length - 1 - index) % 5 === 0 ? String(Number(day.date.slice(8, 10))) : "",
          value: day.leads,
          tip: `${dushanbeDate(`${day.date}T12:00:00Z`, { day: "numeric", month: "long" })}|заявок ${num(day.leads)} · показов ${num(day.showings)}`,
        }))}
      />
    </RhSection>
  );
}

/** «Комиссия по месяцам» — из снимка (`commission12`, только при праве на деньги). */
export function DirectorCommission() {
  const d = useDirector();
  const c = d.commission12;
  if (!d.canView || !d.data?.seesMoney || !c || !Array.isArray(c.months) || c.months.length === 0 || !(c.totalTjs > 0)) return null;
  const last = c.months[c.months.length - 1];
  return (
    <RhSection title="Комиссия по месяцам" to={d.hasRoute("/finance") ? "/finance" : undefined} className="ry-col-b">
      <HomeColumns
        note={`за год ${formatMoney(Math.round(c.totalTjs), "TJS")}`}
        ariaLabel={`Комиссия по месяцам: ${c.months.map((m) => `${monthTitle(m.month)} ${num(Math.round(m.amountTjs))}`).join(", ")} сомони`}
        lastValueLabel={num(Math.round(last.amountTjs))}
        items={c.months.map((m) => ({
          key: m.month,
          label: monthShort(m.month),
          value: m.amountTjs,
          tip: `${monthTitle(m.month)}|${num(Math.round(m.amountTjs))} сомони · ${m.deals} ${pluralizeRu(m.deals, ["сделка", "сделки", "сделок"])}`,
        }))}
      />
    </RhSection>
  );
}

/** «Весь пульт» — прежняя главная целиком, со всеми её действиями. */
export function DirectorFull() {
  const can = useCan();
  // Как прежде: без права на аналитику главная директора — одна строка «только руководству».
  if (!can("dashboard.analytics")) return null;
  return <FullScreenToggle label="Весь пульт"><PultClean /></FullScreenToggle>;
}
