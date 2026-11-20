import { useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { monthShort, monthTitle, pluralizeRu } from "@royal-home/shared";
import { useCan } from "../../../../lib/permissions";
import { useNavigation } from "../../../../lib/navigation";
import { dushanbeDate } from "../../../../lib/date";
import { formatMoney } from "../../../../lib/format";
import { lazyWithReload } from "../../../../lib/lazyWithReload";
import { mcOk, useMissionControl, usePropertiesPendingReview, type McFirstLineItem, type McMarketingChannel } from "../../../../hooks/useMissionControl";
import { useProperties } from "../../../../hooks/useProperties";
import { usePultActionRows, usePultActionStatus } from "../../../pult/PultActions";
import { CleanDecisionRow } from "../../../clean/CleanDecisionRow";
import { RH_SEVERITY_ICON, RhBlockState, RhCircle, RhGroup, RhRow, RhSection, RhTile } from "../../ui";
import { tileTone } from "../../tileTone";
import { channelBrand } from "../time";
import { HomeColumns, num } from "../charts";
import { waitLabel } from "../leader";
import type { HomeBlockProps } from "../core";
import { FullScreenToggle } from "./full";
import { HomeQuiet, LeaderTeam, MoneyHero } from "./leader";

/**
 * ГЛАВНАЯ ДИРЕКТОРА И АДМИНА — блоки ядра (перенесены из pages/TodayRoyal.tsx, home-core 20.11.2026).
 *
 * Данные — те же запросы, что у пульта: снимок `useMissionControl` (живое + зоны),
 * очередь решений `usePultActionRows`, объекты на проверке. Каждый блок зовёт их сам —
 * TanStack Query сводит одинаковые ключи в один поход, лишних запросов нет. Графики
 * берут то, что снимок уже несёт (`marketing.pulse30`, `commission12`): ни одного
 * нового запроса. Блок без источника не рисуется, числа не выдумываются; выключенный
 * модуль пульта сервер не присылает вовсе — блок просто не появляется.
 *
 * Главные руководителей (20.11.2026): плита денег сравнивает с прошлым месяцем и планом,
 * цвет плиток — только по смыслу (`tileTone`), «Горит» живёт одним блоком без плитки-дубля,
 * пустые графики — одной спокойной строкой. Акционер берёт отсюда деньги и тренды, без
 * операционных плиток (у него и прав на действия нет).
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

/**
 * Деньги и плитки сверху. Без права на аналитику — прежняя строка «только руководству».
 * Директор и админ: плита денег + «Ждут ответа» и «Пропущенные звонки» (срочное — красным,
 * ноль — серым) и «Первый ответ». Акционер: плита денег + сделки, расходы и заявки месяца.
 */
export function DirectorMoney({ role }: HomeBlockProps) {
  const d = useDirector();
  if (!d.canView) return <RhGroup><RhRow lead={<RhCircle icon="shield-check" tone="a3" />} title="Раздел доступен только руководству." /></RhGroup>;
  if (d.isError && !d.data) return <RhBlockState kind="error" onRetry={() => void d.refetch()} />;
  const { hero, bot, commission12, marketing } = d;
  const showMoney = !!hero?.commission && !!d.data?.seesMoney;
  const shareholder = role === "SHAREHOLDER";
  const waiting = bot?.attention?.waitingHuman;
  const oldestWait = waiting?.items?.length ? Math.max(...waiting.items.map((item) => item.waitingMinutes)) : null;
  const lastMonth = commission12?.months?.length ? commission12.months[commission12.months.length - 1] : null;
  const monthName = dushanbeDate(new Date(), { month: "long" });
  const leadsMonth = marketing?.funnel ? marketing.funnel.reduce((sum, c) => sum + c.leadsMonth, 0) : null;
  const tiles: ReactNode[] = [];
  if (!shareholder) {
    if (waiting) tiles.push(
      <RhTile key="waiting" variant={tileTone("urgent", waiting.count)} icon="message-circle" label="Ждут ответа" value={waiting.count}
        note={waiting.count > 0 && oldestWait !== null ? `дольше всех ${waitLabel(oldestWait)}` : "клиенты в чатах"}
        to={d.hasRoute("/messages") ? "/messages" : undefined} />,
    );
    if (hero && d.hasRoute("/calls")) tiles.push(
      <RhTile key="missed" variant={tileTone("urgent", hero.missedCallsToday)} icon="phone-missed" label="Пропущенные звонки" value={hero.missedCallsToday} note="сегодня" to="/calls" />,
    );
    if (hero && hero.firstResponse.medianMinYesterday !== null) tiles.push(
      <RhTile key="response" variant={tileTone("info", hero.firstResponse.medianMinYesterday)} icon="clock" label="Первый ответ" value={Math.round(hero.firstResponse.medianMinYesterday)} unit="мин" note="вчера, в среднем" />,
    );
    if (hero && !showMoney) tiles.push(
      <RhTile key="leads" variant={tileTone("info", hero.leadsToday.count)} icon="user-plus" label="Заявки сегодня" value={hero.leadsToday.count} to={d.hasRoute("/clients") ? "/clients" : undefined} />,
    );
  } else {
    if (lastMonth) tiles.push(
      <RhTile key="deals" variant={tileTone("good", lastMonth.deals)} icon="handshake" label="Сделки закрыты" value={lastMonth.deals} note={`за ${monthName}`} to={d.hasRoute("/deals") ? "/deals" : undefined} />,
    );
    if (commission12 && commission12.expensesMonthTjs > 0) tiles.push(
      <RhTile key="expenses" variant={tileTone("info", commission12.expensesMonthTjs)} icon="banknote" label="Расходы" value={formatMoney(Math.round(commission12.expensesMonthTjs), "TJS")} note={`за ${monthName}`} to={d.hasRoute("/finance") ? "/finance" : undefined} />,
    );
    if (leadsMonth !== null) tiles.push(
      <RhTile key="leadsMonth" variant={tileTone("info", leadsMonth)} icon="user-plus" label="Заявки" value={leadsMonth} note={`за ${monthName}`} />,
    );
  }
  return (
    <div className="ry-strip" data-strip="money">
      {d.isLoading && !d.data ? <div className="ry-hero ry-hero-skeleton" aria-busy="true" /> : showMoney && hero?.commission ? (
        <MoneyHero commission={hero.commission} leadsToday={shareholder ? undefined : hero.leadsToday}
          financeTo={d.hasRoute("/finance") ? "/finance" : undefined}
          settingsTo={d.hasRoute("/settings") && d.can("settings.manage") ? "/settings?tab=money" : undefined} />
      ) : hero ? (
        <RhTile variant={tileTone("info", hero.dealsInPipeline.count)} icon="handshake" label="Покупатели в работе" value={hero.dealsInPipeline.count} to={d.hasRoute("/clients") ? "/clients" : undefined} />
      ) : null}
      {tiles}
    </div>
  );
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
    <RhSection id="ry-burning" title={firstLine && firstLine.totalCount > 0 ? `Горит сейчас · ${firstLine.totalCount}` : "Горит сейчас"} to={d.hasRoute("/oversight") ? "/oversight" : undefined} className="ry-col-b">
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
  const { team, clientsZone, system, can, hasRoute } = d;
  const items: ReactNode[] = [];
  // Пропущенные звонки — плиткой наверху (20.11.2026): здесь был бы дубль той же цифры.
  if (team?.showingsToday && team.showingsToday.count > 0 && hasRoute("/calendar"))
    items.push(<RhRow key="showings" to="/calendar" lead={<RhCircle icon="calendar-days" tone="a5" />} title="Показы сегодня" sub={`подтверждено ${team.showingsToday.confirmed}`} right={<b className="ry-num ry-count">{team.showingsToday.count}</b>} />);
  if (pending.data && pending.data.length > 0 && hasRoute("/properties"))
    items.push(<RhRow key="review" to="/properties?status=PENDING_REVIEW" lead={<RhCircle icon="building-2" tone="a2" />} title="Объекты на проверке" right={<b className="ry-num ry-count">{pending.data.length}</b>} />);
  if (clientsZone?.deleteRequests && clientsZone.deleteRequests.total > 0 && hasRoute("/archive") && (can("clients.delete") || can("properties.delete")))
    items.push(<RhRow key="delete" to={clientsZone.deleteRequests.clients > 0 && can("clients.delete") ? "/archive#delete-requests" : "/archive"} lead={<RhCircle icon="archive" tone="a4" />} title="Заявки на удаление" right={<b className="ry-num ry-count">{clientsZone.deleteRequests.total}</b>} />);
  if (system && can("auditLog.view") && hasRoute("/health") && (system.errorsToday > 0 || (system.unresolvedTotal ?? 0) > 0))
    items.push(<RhRow key="errors" to="/health" lead={<RhCircle icon="gauge" tone={system.errorsToday >= 10 ? "crit" : "warn"} />} title="Сбои в работе CRM" sub="за сегодня" right={<b className="ry-num ry-count">{system.errorsToday}</b>} />);
  return items.length ? <RhSection title="Проверить" className="ry-col-a"><RhGroup>{items}</RhGroup></RhSection> : null;
}

/** «Команда» — общий блок руководителей (./leader.tsx): кто когда заходил, звонки, просрочки. */
export function DirectorTeam() {
  const d = useDirector();
  if (!d.canView || !d.hasRoute("/team")) return null;
  return <LeaderTeam className="ry-col-b" />;
}

/** «Заявки за месяц» по каналам — полосы в родных цветах каналов. */
export function DirectorChannels() {
  const d = useDirector();
  const { marketing } = d;
  if (!d.canView || !marketing) return null;
  const month = dushanbeDate(new Date(), { month: "long" });
  if (!marketing.funnel.some((c) => c.leadsMonth > 0)) return <HomeQuiet title={`Заявки за ${month}`} />;
  return (
    <RhSection title={`Заявки за ${month} по источникам`} to={d.hasRoute("/sources") ? "/sources" : undefined}>
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
              {c.dealsClosedMonth > 0 && <span className="ry-row-sub">{c.dealsClosedMonth} {pluralizeRu(c.dealsClosedMonth, ["сделка", "сделки", "сделок"])}</span>}
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
  if (!d.canView || !pulse || !Array.isArray(pulse.days)) return null;
  if (pulse.days.length === 0 || pulse.leadsTotal + pulse.showingsTotal === 0) return <HomeQuiet title="Заявки за 30 дней" className="ry-col-a" />;
  const last = pulse.days[pulse.days.length - 1];
  return (
    <RhSection title="Заявки за 30 дней" to={d.hasRoute("/sources") ? "/sources" : undefined} className="ry-col-a">
      <HomeColumns
        note={`всего ${num(pulse.leadsTotal)} ${pluralizeRu(pulse.leadsTotal, ["заявка", "заявки", "заявок"])} и ${num(pulse.showingsTotal)} ${pluralizeRu(pulse.showingsTotal, ["показ", "показа", "показов"])} · столбик — заявки за день`}
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
  if (!d.canView || !d.data?.seesMoney || !c || !Array.isArray(c.months)) return null;
  // Один месяц с деньгами — не график, а та же цифра, что в плите денег: тихой строкой.
  const withMoney = c.months.filter((m) => m.amountTjs > 0).length;
  if (withMoney < 2) return <HomeQuiet title="Комиссия по месяцам" text={withMoney === 1 ? "пока только один месяц с комиссией" : undefined} className="ry-col-b" />;
  const last = c.months[c.months.length - 1];
  return (
    <RhSection title="Комиссия по месяцам" to={d.hasRoute("/finance") ? "/finance" : undefined} className="ry-col-b">
      <HomeColumns
        note={`за 12 месяцев ${formatMoney(Math.round(c.totalTjs), "TJS")} · столбик — комиссия месяца`}
        ariaLabel={`Комиссия по месяцам: ${c.months.map((m) => `${monthTitle(m.month)} ${num(Math.round(m.amountTjs))}`).join(", ")} сомони`}
        lastValueLabel={`${num(Math.round(last.amountTjs))} с.`}
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
