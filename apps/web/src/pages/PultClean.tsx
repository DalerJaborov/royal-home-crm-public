import { formatPropertyCode } from "../lib/clientFormat";
import { CleanLoadError } from "../components/clean/CleanLoadError";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import {
  ArrowUpRight,
  Bell,
  Briefcase,
  ChevronRight,
  Coins,
  MessageCircle,
  Plus,
  Search,
  Sparkles,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { buildPultView, pluralizeRu } from "@royal-home/shared";
import {
  CAvatar,
  CButton,
  CCard,
  CChip,
  CHead,
  CLink,
  CRing,
  cn,
} from "../components/clean/ui";
import { usePultActionRows, usePultActionStatus } from "../components/pult/PultActions";
import { CleanDecisionRow } from "../components/clean/CleanDecisionRow";
import { CleanDirectorAi } from "../components/clean/CleanDirectorAi";
import { CleanFeaturedProperty } from "../components/clean/CleanFeaturedProperty";
import { CleanPultExtras } from "../components/clean/CleanPultExtras";
import { CleanWorkQueues } from "../components/clean/CleanWorkQueues";
import { CommandPaletteLazy } from "../components/CommandPaletteLazy";
import { CleanControlTiles, CleanFinancialPulse, CleanSystemBotDetails } from "../components/clean/CleanPultOperations";
import {
  mcOk,
  useMissionControl,
  usePropertiesPendingReview,
  type McFirstLine,
  type McHero,
} from "../hooks/useMissionControl";
import { useProperties, useProperty } from "../hooks/useProperties";
import { useCan, useCanCreateProperty } from "../lib/permissions";
import { useNavigation } from "../lib/navigation";
import { dushanbeDate, dushanbeHour, dushanbeTime } from "../lib/date";
import { formatMoney } from "../lib/format";
import { useAuthStore } from "../store/auth";

/**
 * ПУЛЬТ ДИРЕКТОРА «ROYAL CLEAN» — пробная сборка в коде (07.10.2026, маршрут /pult).
 *
 * Зачем: владелец отверг пульт E4 по виду и прислал 13 референсов; язык разобран в
 * docs/design/director-pult-2026-10/reference-analysis.md, макет — index.html там же.
 * Это тот макет один в один, но на живых данных и на стеке референсов: Tailwind,
 * компоненты в стиле shadcn (`components/clean/ui.tsx`), иконки Lucide, график
 * Recharts, появление блоков через Motion.
 *
 * Данные — те же, что у DirectorHome: снимок `useMissionControl` (ничего нового не
 * запрашиваем), решения `usePultActionRows` с их настоящими действиями и отменой,
 * фотографии объектов из обычного списка `/properties`. Чего сервер не отдал —
 * блок не рисуется, числа не выдумываются.
 */

const ease = [0.2, 0.8, 0.2, 1] as const;
const fadeUp = (i: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24, ease, delay: i * 0.04 },
});

export function PultClean() {
  const [searchOpen, setSearchOpen] = useState(false);
  const can = useCan();
  const canCreateProperty = useCanCreateProperty();
  const { all: navigation } = useNavigation();
  const hasRoute = (path: string) => navigation.some((item) => item.to === path);
  const canView = can("dashboard.analytics");
  const agent = useAuthStore((s) => s.agent);
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const { data, isLoading, isError, refetch } = useMissionControl(canView);
  const pultView = useMemo(() => data ? buildPultView(data, dushanbeHour()) : null, [data]);
  const reducedMotion = useReducedMotion();
  const enter = (i: number) => reducedMotion ? {} : fadeUp(i);
  const rows = usePultActionRows(canView);
  const actionStatus = usePultActionStatus(canView);
  const pending = usePropertiesPendingReview(canView);
  const props = useProperties({ page: 1 }, canView);

  const hero = data?.hero && mcOk(data.hero) ? data.hero : null;
  const team = data?.team && mcOk(data.team) ? data.team : null;
  const system = data?.system && mcOk(data.system) ? data.system : null;
  const bot = data?.bot && mcOk(data.bot) ? data.bot : null;
  const properties =
    data?.properties && mcOk(data.properties) ? data.properties : null;
  const marketing =
    data?.marketing && mcOk(data.marketing) ? data.marketing : null;
  const commission =
    data?.commission12 && mcOk(data.commission12) ? data.commission12 : null;
  const clientsZone =
    data?.clientsZone && mcOk(data.clientsZone) ? data.clientsZone : null;
  const firstLineData = data?.firstLine && mcOk(data.firstLine) ? data.firstLine : null;
  const firstLine = firstLineData?.items ?? [];

  // These queues can describe the same underlying problem: never add their counts.
  const critCount = firstLine.filter((i) => i.severity === "critical").length;
  const limitedCriticalCount = !!firstLineData && firstLineData.totalCount > firstLine.length;
  const urgentDecisions = (rows ?? []).filter((row) => row.tone === "crit").length;
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
  const topId = properties?.extra?.topOfWeek?.id ?? null;
  const cachedTop = (props.data?.items ?? []).find((p) => p.id === topId);
  // The featured property may be older than the first catalog page. Reuse its existing detail query.
  const featured = useProperty(canView && topId && !props.isLoading && !cachedTop ? String(properties?.extra?.topOfWeek?.shortId ?? topId) : undefined);
  // An unavailable featured property only hides its card; the rest of the pult stays complete.
  const incomplete = isError || props.isError || pending.isError || actionStatus.isError ||
    !!data && Object.values(data).some((v) => typeof v === "object" && v !== null && "error" in v);

  const showFirstLine = isLoading || incomplete || !!firstLineData?.totalCount || firstLine.length > 0;
  const criticalEventsTarget = showFirstLine ? "#clean-first-line" : hasRoute("/oversight") ? "/oversight" : undefined;

  if (!canView) {
    return (
      <div className="p-6">
        <CCard>
          <p className="text-gray-600">Раздел доступен только руководству.</p>
        </CCard>
      </div>
    );
  }

  const today = dushanbeDate(new Date(), {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const top = topId
    ? (cachedTop ?? featured.data ?? null)
    : ((props.data?.items ?? []).find((p) => p.photos?.length) ?? (props.data?.items ?? [])[0] ?? null);
  const topPhoto = top
    ? (top.photos?.[0]?.url ?? top.photos?.[0]?.thumbUrl)
    : undefined;
  return (
    <div aria-busy={isLoading || props.isLoading || pending.isLoading || featured.isLoading || rows === null && !incomplete} className="clean mx-auto grid max-w-[1440px] gap-4 px-4 pb-10 pt-2 font-sans text-[14px] text-ink">
      {isError && <CleanLoadError title="Пульт руководителя" retry={refetch} />}
      {data && Object.entries({ hero: "Показатели дня и денежный пульс", team: "Команда", system: "Система и контроль", calls: "Звонки", commission12: "Комиссия за 12 месяцев", marketing: "Маркетинг и публикации", clientsZone: "Клиенты и рабочие очереди", video: "Подготовка объектов", bot: "Помощник", properties: "Объекты", firstLine: "Критические события" }).map(([key, title]) => {
        const section = data[key as keyof typeof data];
        return section && typeof section === "object" && "error" in section ? <CleanLoadError key={key} title={title} retry={refetch} /> : null;
      })}
      {/* ---- Ряд A: приветствие + KPI | фото объекта ---- */}
      <motion.section
        {...enter(0)}
        className="clean-overview grid gap-4 lg:grid-cols-[minmax(0,1fr)_560px]"
      >
        <div className="clean-greeting">
          <h1 className="m-0 text-[34px] font-normal leading-[1.1] tracking-[-.025em]">
            Сегодня в Royal Home
          </h1>
          <p role="status" className="mb-5 mt-2 max-w-[46ch] text-[14px] text-gray-600">
            {firstName ? `${firstName}, ` : ""}{today}.{" "}
            {isLoading
              ? "Собираем картину дня…"
              : incomplete ? "Часть данных недоступна. Итоги могут быть неполными."
              : critCount > 0
                ? `${limitedCriticalCount ? "Не менее " : ""}${critCount} ${pluralizeRu(critCount, ["критическое событие ждёт", "критических события ждут", "критических событий ждут"])} вашего внимания.`
                : limitedCriticalCount ? "Первая линия показана частично. Проверьте полную очередь."
                : "Критических событий нет."}
          </p>
          <div className="clean-overview-actions flex flex-wrap gap-2">
            {hasRoute("/reports") && <CLink to="/reports" variant="soft" size="md">Отчёты</CLink>}
            {canCreateProperty && <CLink to="/properties/new" variant="primary" size="md"><Plus /> Создать объект</CLink>}
          </div>
          <div className="clean-kpis grid gap-3.5 sm:grid-cols-3">
            <Kpi
              icon={<TriangleAlert />}
              label="Событий первой линии"
              value={firstLineData ? String(firstLineData.totalCount) : "—"}
              to={criticalEventsTarget}
            >
              <span className="text-[14px] text-gray-600">Критических {limitedCriticalCount ? "не менее " : ""}{critCount}</span>
            </Kpi>
            {hero ? (
              <Kpi
                icon={<UserRound />}
                label="Новых клиентов"
                value={String(hero.leadsToday.count)}
                to={hasRoute("/clients") ? "/clients" : undefined}
              >
                <CChip
                  tone={hero.leadsToday.deltaVsYesterday >= 0 ? "ok" : "warn"}
                >
                  {hero.leadsToday.deltaVsYesterday >= 0 ? "+" : ""}
                  {hero.leadsToday.deltaVsYesterday} к вчера
                </CChip>
              </Kpi>
            ) : null}
            {hero?.commission && data?.seesMoney ? (
              <Kpi
                icon={<Coins />}
                label="Валовая комиссия месяца"
                value={formatMoney(Math.round(hero.commission.fact), "TJS")}
                to={hasRoute("/finance") ? "/finance" : undefined}
              >
                <CChip
                  tone={hero.commission.forecastPercent >= 100 ? "ok" : "gray"}
                >
                  план {formatMoney(Math.round(hero.commission.plan), "TJS")}
                </CChip>
              </Kpi>
            ) : hero ? (
              <Kpi
                icon={<Briefcase />}
                label="Сделок в работе"
                value={String(hero.dealsInPipeline.count)}
                to={hasRoute("/deals") ? "/deals" : undefined}
              />
            ) : null}
          </div>
        </div>
      </motion.section>

      {/* ---- Ряд B: решения и первая линия | объект ---- */}
      <motion.section
        {...enter(1)}
        className="clean-workqueue grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_400px]"
      >
        <div className="grid gap-4">
          <CCard>
            <CHead
              title="Нужны ваши решения"
              count={rows ? rows.length : "…"}
              right={
                <>
                  {urgentDecisions > 0 ? (
                    <CChip tone="crit">Срочных решений: {urgentDecisions}</CChip>
                  ) : null}
                  {hasRoute("/oversight") && <Link
                    to="/oversight"
                    className="inline-flex items-center gap-1 text-[13px] text-gray-500 hover:text-ink"
                  >
                    Присмотр <ArrowUpRight className="size-4" />
                  </Link>}
                </>
              }
            />
            {actionStatus.isError && rows !== null && rows.length > 0 && (
              <p role="alert">Часть очереди решений недоступна. Ниже показаны только загруженные задачи.</p>
            )}
            {rows === null && incomplete ? <p role="alert">Не удалось загрузить очередь. Обновите страницу, чтобы повторить.</p> : rows === null ? (
              <div className="grid gap-1.5" role="status" aria-label="Загружаем очередь решений">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-[72px] animate-pulse rounded-[14px] bg-row-alt"
                  />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="m-0 text-gray-600">
                {incomplete ? "Не удалось получить всю очередь решений." : "Очередь решений пуста."}
              </p>
            ) : (
              <div className="grid gap-1.5">
                {rows.map((r) => (
                  <CleanDecisionRow key={r.id} row={r} photos={photoById} />
                ))}
              </div>
            )}
          </CCard>
          {showFirstLine && <PultFirstLine firstLine={firstLineData} isLoading={isLoading} incomplete={incomplete} />}
        </div>

        <div className="grid gap-4">
          {top && <CleanFeaturedProperty
            to={`/properties/${top.shortId}`}
            title={top.title}
            subtitle={[top.district?.name ?? top.address, formatMoney(top.price, top.currency)].filter(Boolean).join(" · ")}
            photo={topPhoto}
            showings={properties?.extra?.topOfWeek?.showings}
            featured={!!topId}
          />}
        </div>
      </motion.section>

      {/* ---- Сводка дня: напоминания | денежный пульс | комиссия ---- */}
      <motion.section {...enter(2)} className="clean-day-summary grid items-start gap-4">
          <CCard>
            <CHead
              title="Напоминания"
              right={
                hasRoute("/oversight") && <CLink to="/oversight" variant="soft" size="icon" aria-label="Открыть присмотр">
                  <ArrowUpRight className="size-4" />
                </CLink>
              }
            />
            <div className="grid gap-1.5">
              {hero && <PultContactReminders hero={hero} canCalls={hasRoute("/calls")} canClients={hasRoute("/clients")} />}
              {critCount > 0 ? (
                <Reminder
                  to="#clean-first-line"
                  hl
                  title="Критические события"
                  sub="В загруженной первой линии"
                  ring={<CChip tone="crit">{critCount}</CChip>}
                />
              ) : null}
              {team?.showingsToday && team.showingsToday.count > 0 ? (
                <Reminder
                  to="/calendar"
                  title="Показы"
                  sub={`${team.showingsToday.count} сегодня · подтверждено ${team.showingsToday.confirmed}`}
                  ring={
                    <CRing
                      value={Math.round(
                        (team.showingsToday.confirmed /
                          team.showingsToday.count) *
                          100,
                      )}
                      label={team.showingsToday.count}
                    />
                  }
                />
              ) : null}
              {pending.data && pending.data.length > 0 ? (
                <Reminder
                  to="/properties?status=PENDING_REVIEW"
                  title="На проверке"
                  sub={`${pending.data.length} ${pluralizeRu(pending.data.length, ["объект ждёт", "объекта ждут", "объектов ждут"])} вашего слова`}
                  ring={
                    <CChip tone="warn">{pending.data.length}</CChip>
                  }
                />
              ) : null}
              {clientsZone?.deleteRequests &&
              clientsZone.deleteRequests.total > 0 && hasRoute("/archive") && (can("clients.delete") || can("properties.delete")) ? (
                <Reminder
                  to={clientsZone.deleteRequests.clients > 0 && can("clients.delete") ? "/archive#delete-requests" : "/archive"}
                  title="Заявки на удаление"
                  sub={`${clientsZone.deleteRequests.total} от агентов`}
                  ring={
                    <CChip tone="warn">{clientsZone.deleteRequests.total}</CChip>
                  }
                />
              ) : null}
              {system && can("auditLog.view") && hasRoute("/health") ? (
                <Reminder
                  to="/health"
                  title="Ошибки системы"
                  sub={
                    system.errorsToday === 0
                      ? "за сутки без ошибок"
                      : `${system.errorsToday} неразобранных за сутки`
                  }
                  ring={
                    <CChip tone="gray">{system.errorsToday}</CChip>
                  }
                />
              ) : null}
            </div>
            {can("insights.view") && hasRoute("/insights") && <Link
              to="/insights"
              className="mt-3 flex items-center gap-3 rounded-[14px] bg-gradient-to-r from-blue/10 to-transparent p-3 text-ink no-underline hover:from-blue/15"
            >
              <span className="grid size-9 place-items-center rounded-full bg-blue text-white shadow-[0_8px_20px_-10px_rgb(var(--rgb-accent)/.9)]">
                <Sparkles className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <b className="block text-[14px] font-semibold">ИИ-помощник</b>
                <span className="text-[13px] text-gray-500">
                  Открыть разбор работы команды
                </span>
              </span>
              <ChevronRight className="size-4 text-gray-500" />
            </Link>}
          </CCard>

          <div className="clean-financial-summary grid min-w-0 gap-4">
          <CleanFinancialPulse hero={hero} canSeeMoney={!!data?.seesMoney && can("finance.view")} moneyRoute={hasRoute("/finance")} />
          {commission && commission.months.length > 0 && data?.seesMoney ? (
            <CCard>
              <CHead
                title="Комиссия"
                right={
                  <span className="inline-flex h-9 items-center rounded-full bg-row-alt px-3.5 text-[13px] text-gray-700">
                    12 месяцев
                  </span>
                }
              />
              <div className="text-[28px] font-semibold leading-none tracking-[-.03em] tabular-nums">
                {formatMoney(Math.round(commission.totalTjs), "TJS")}
                <small className="ml-1.5 text-[13px] font-medium text-gray-500">
                  за год
                </small>
              </div>
              <div className="mt-2 h-[130px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={commission.months.map((m) => ({
                      m: monthShort(m.month),
                      v: Math.round(m.amountTjs),
                    }))}
                    margin={{ top: 10, right: 4, left: 4, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="cleanArea"
                        x1="0"
                        x2="0"
                        y1="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor="rgb(var(--rgb-accent))"
                          stopOpacity={0.28}
                        />
                        <stop
                          offset="100%"
                          stopColor="rgb(var(--rgb-accent))"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="m"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 13, fill: "rgb(var(--rgb-g500))" }}
                      interval="preserveStartEnd"
                    />
                    <Tooltip
                      cursor={{
                        stroke: "rgb(var(--rgb-accent))",
                        strokeDasharray: "3 3",
                      }}
                      content={({ active, payload, label }) =>
                        active && payload?.length ? (
                          <div className="rounded-[10px] border border-line-soft bg-card px-3 py-1.5 text-[13px] font-semibold shadow-md">
                            {label} ·{" "}
                            {formatMoney(Number(payload[0].value), "TJS")}
                          </div>
                        ) : null
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="v"
                      stroke="rgb(var(--rgb-accent))"
                      strokeWidth={2.5}
                      fill="url(#cleanArea)"
                      isAnimationActive={!reducedMotion}
                      animationDuration={1400}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <details className="mt-3"><summary className="cursor-pointer text-[16px]">Комиссия по месяцам · значения</summary><table className="w-full text-[16px]"><caption className="sr-only">Комиссия за 12 месяцев, сомони</caption><thead><tr><th scope="col">Месяц</th><th scope="col">Комиссия</th></tr></thead><tbody>{commission.months.map((item) => <tr key={item.month}><th scope="row">{item.month}</th><td>{formatMoney(item.amountTjs, "TJS")}</td></tr>)}</tbody></table></details>
            </CCard>
          ) : null}
          </div>
      </motion.section>

      {/* ---- Ряд C: объекты | показы + команда ---- */}
      <motion.section
        {...enter(2)}
        className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_400px]"
      >
        <CCard>
          <CHead
            title="Объекты, которым нужно внимание"
            right={
              <Link
                to="/properties"
                className="inline-flex items-center gap-1 text-[13px] text-gray-500 hover:text-ink"
              >
                Все {properties ? properties.available : ""}{" "}
                <ArrowUpRight className="size-4" />
              </Link>
            }
          />
          {(() => {
            const cards: {
              id: string;
              shortId: number;
              title: string;
              photo?: string;
              chip: { tone: "warn" | "gray"; text: string };
              sub?: string;
            }[] = [];
            for (const p of pending.data ?? [])
              cards.push({
                id: p.id,
                shortId: p.shortId,
                title: p.title,
                photo: p.photos?.[0]?.thumbUrl ?? photoById.get(p.id),
                chip: { tone: "warn", text: "На проверке" },
              });
            for (const p of properties?.extra?.idle?.items ?? []) {
              if (cards.some((c) => c.id === p.id)) continue;
              cards.push({
                id: p.id,
                shortId: p.shortId,
                title: p.title,
                photo: photoById.get(p.id),
                chip: { tone: "gray", text: `без показов ${p.idleDays} дн` },
              });
            }
            const show = cards.slice(0, 2);
            return show.length === 0 ? (
              <p className="m-0 text-gray-600">
                {props.isLoading || pending.isLoading ? "Загружаем объекты…" : incomplete || pending.isError ? "Очередь объектов недоступна." : "Объектов, требующих внимания, нет."}
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {show.map((c) => (
                  <Link
                    key={c.id}
                    to={`/properties/${c.shortId}`}
                    className="group grid gap-2 text-ink no-underline"
                  >
                    <div className="relative h-[180px] overflow-hidden rounded-[14px] bg-row-alt">
                      <Photo
                        src={c.photo}
                        className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                      />
                      <CChip
                        tone={c.chip.tone}
                        className="absolute left-2 top-2"
                      >
                        {c.chip.text}
                      </CChip>
                    </div>
                    <b className="truncate text-[14px] font-semibold">
                      {formatPropertyCode(c.shortId)} · {c.title}
                    </b>
                  </Link>
                ))}
              </div>
            );
          })()}
        </CCard>

        <div className="grid gap-4">
          {team?.showingsToday && team.showingsToday.items.length > 0 ? (
            <CCard>
              <CHead
                title="Показы сегодня"
                count={team.showingsToday.count}
                right={
                  <CLink to="/calendar" variant="soft" size="icon" aria-label="Открыть календарь">
                    <ArrowUpRight className="size-4" />
                  </CLink>
                }
              />
              <div className="grid gap-1.5">
                {team.showingsToday.items.slice(0, 4).map((s) => (
                  <Link
                    key={s.id}
                    to={s.clientHref}
                    className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl bg-row-alt p-2.5 pr-3 text-ink no-underline hover:bg-line-soft"
                  >
                    <span className="text-[16px] font-semibold tabular-nums">
                      {dushanbeTime(s.at)}
                    </span>
                    <span className="min-w-0">
                      <b className="block truncate text-[14px] font-semibold">
                        {s.clientName}
                      </b>
                      <span className="block truncate text-[13px] text-gray-500">
                        {s.propertyTitle ?? "объект не указан"} · {s.agentName}
                      </span>
                    </span>
                    <CChip tone={s.confirmed ? "ok" : "warn"}>
                      {s.confirmed ? "Подтверждён" : "Ждём ответ"}
                    </CChip>
                  </Link>
                ))}
              </div>
            </CCard>
          ) : null}

          {team && team.agents.length > 0 && hasRoute("/team") ? (
            <CCard>
              <CHead
                title="Команда"
                count={`${team.agents.filter((a) => isOnline(a.lastSeenAt)).length} из ${team.agents.length} на связи`}
                right={
                  <CLink to="/team" variant="soft" size="icon" aria-label="Открыть команду">
                    <ArrowUpRight className="size-4" />
                  </CLink>
                }
              />
              <div className="grid gap-3">
                {team.agents.slice(0, 5).map((a) => {
                  const day = team.day?.rows.find((r) => r.agentId === a.id);
                  return (
                    <Link
                      key={a.id}
                      to={`/team/${a.id}`}
                      aria-label={`Открыть ${a.fullName}`}
                      className="grid min-h-11 grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-3 rounded-2xl p-2 text-ink no-underline transition-colors hover:bg-row-alt"
                    >
                      <CAvatar src={a.avatarUrl} name={a.fullName} size={44} />
                      <div className="min-w-0">
                        <b className="block truncate text-[14px] font-semibold">
                          {a.fullName}
                        </b>
                        <span className="block truncate text-[13px] text-gray-500">
                          {day
                            ? `сегодня: ${day.calls} зв · ${day.showings} показ · ${day.tasksDone} задач`
                            : isOnline(a.lastSeenAt)
                              ? "на связи"
                              : "офлайн"}
                          {a.pendingAccept > 0
                            ? ` · ${a.pendingAccept} ждут принятия`
                            : ""}
                        </span>
                      </div>
                      <span className="flex size-11 items-center justify-center rounded-full bg-row-alt" aria-hidden="true">
                        <ArrowUpRight className="size-5" />
                      </span>
                    </Link>
                  );
                })}
              </div>
            </CCard>
          ) : null}
        </div>
      </motion.section>

      <CleanControlTiles control={system?.control} allowed={hasRoute("/oversight")} />
      <CleanPultExtras key={agent?.id}
        canTrainer={can("settings.manage")}
        canVacancies={can("vacancies.view") && hasRoute("/vacancies")}
        canSettings={can("settings.manage") && hasRoute("/settings")}
        newApplications={system?.newApplications}
      />
      <CleanSystemBotDetails
        system={system} bot={bot} canHealth={hasRoute("/health")}
        canMessages={hasRoute("/messages")} canBotLearning={hasRoute("/ai-learning")}
        canSeeMoney={!!data?.seesMoney && can("finance.view")}
      />

      {/* ---- Ряд D: ИИ-инструменты | воронка 7 дней ---- */}
      <motion.section {...enter(3)} className="grid gap-4 lg:grid-cols-2">
        <CCard>
          <CHead
            title="ИИ-помощник"
            count="быстрый доступ"
          />
          <CleanDirectorAi enabled={canView} askEnabled={!!data && !data.modulesOff.includes("ask")} areas={pultView?.areas} />
          <div className="grid gap-2.5 sm:grid-cols-3">
            {can("insights.view") && hasRoute("/insights") && <Tool
              to="/insights"
              icon={<Sparkles />}
              title="Разбор к собранию"
              sub="По каждому агенту: что сделано, что просрочено"
            />}
            {hasRoute("/clients") && <Tool
              to="/clients"
              icon={<UserRound />}
              title="Подобрать объекты клиентам"
              sub="Открыть клиентов и подобрать предложения"
            />}
            {hasRoute("/notifications") && <Tool
              to="/notifications"
              icon={<Bell />}
              title="Уведомления"
              sub="События и сообщения, требующие внимания"
            />}
          </div>
        </CCard>
        {marketing?.pulse30 && marketing.pulse30.days.length > 0 ? (
          <CCard>
            <CHead
              title="Обращения и показы"
              count="последние 7 дней"
              right={
                hasRoute("/sources") && <CLink to="/sources" variant="soft" size="icon" aria-label="Открыть источники">
                  <ArrowUpRight className="size-4" />
                </CLink>
              }
            />
            <Funnel days={marketing.pulse30.days.slice(-7)} />
          </CCard>
        ) : null}
      </motion.section>

      {data && <CleanWorkQueues data={data} allowedRoute={hasRoute} propertyPhotos={photoById} />}

      {/* нижняя строка действий — как в референсах, быстрые кнопки одной линией */}
      <div className="flex flex-wrap items-center gap-2.5 pt-2">
        {hasRoute("/clients") && <CLink to="/clients?new=1" variant="white" size="md">
          <Plus /> Клиент
        </CLink>}
        {canCreateProperty && <CLink to="/properties/new" variant="white" size="md">
          <Plus /> Объект
        </CLink>}
        <CButton variant="white" size="md" onClick={() => setSearchOpen(true)}>
          <Search /> Поиск
        </CButton>
        {can("insights.view") && hasRoute("/insights") && <CLink to="/insights" variant="primary" size="md" className="ml-auto">
          Отчёт за день <ArrowUpRight />
        </CLink>}
      </div>
      {searchOpen && <CommandPaletteLazy onClose={() => setSearchOpen(false)} />}
    </div>
  );
}

/* ================= детали ================= */

function Kpi({
  icon,
  label,
  value,
  children,
  to,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  children?: ReactNode;
  to?: string;
}) {
  const content = (
    <CCard className="clean-kpi grid gap-3 p-[18px_20px]">
      <div className="flex items-center gap-2.5 text-[13px] text-gray-600">
        <span className="grid size-7 place-items-center rounded-full bg-row-alt text-gray-700 [&_svg]:size-4">
          {icon}
        </span>
        {label}
      </div>
      <div className="clean-kpi-value text-[40px] font-semibold leading-none tracking-[-.03em] tabular-nums">
        {value}
      </div>
      {children ? <div>{children}</div> : <div className="h-[26px]" />}
    </CCard>
  );
  if (!to) return content;
  const className = "block min-w-0 rounded-[20px] text-ink no-underline transition-transform duration-200 hover:-translate-y-0.5 motion-reduce:transform-none";
  return to.startsWith("#") ? <a href={to} className={className}>{content}</a> : <Link to={to} className={className}>{content}</Link>;
}

function Reminder({
  to,
  title,
  sub,
  ring,
  hl,
}: {
  to: string;
  title: string;
  sub: string;
  ring: ReactNode;
  hl?: boolean;
}) {
  return (
    <Link
      to={to}
      onClick={to.startsWith("#") ? (event) => { event.preventDefault(); document.getElementById(to.slice(1))?.scrollIntoView({ behavior: "auto", block: "start" }); } : undefined}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_36px_16px] items-center gap-2.5 rounded-[14px] px-4 py-3.5 text-ink no-underline transition-colors",
        hl ? "bg-blue/10 hover:bg-blue/15" : "bg-row-alt hover:bg-line-soft",
      )}
    >
      <span className="min-w-0">
        <b className="block text-[16px] font-semibold">{title}</b>
        <span className="block text-[13px] text-gray-500">{sub}</span>
      </span>
      {ring}
      <ChevronRight className="size-4 text-gray-500" />
    </Link>
  );
}

function Tool({
  to,
  icon,
  title,
  sub,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <Link
      to={to}
      className="grid gap-2 rounded-[14px] bg-row-alt p-3.5 text-ink no-underline transition-[background-color,transform] duration-300 hover:-translate-y-px hover:bg-blue/10"
    >
      <span className="grid size-9 place-items-center rounded-full bg-blue text-white [&_svg]:size-4">
        {icon}
      </span>
      <span>
        <b className="block text-[14px] font-semibold">{title}</b>
        <span className="text-[13px] text-gray-500">{sub}</span>
      </span>
    </Link>
  );
}

function Funnel({
  days,
}: {
  days: { date: string; leads: number; showings: number }[];
}) {
  const max = Math.max(1, ...days.flatMap((d) => [d.leads, d.showings]));
  return (
    <div className="grid h-[150px] grid-cols-7 items-end gap-2">
      {days.map((d) => (
        <div key={d.date} className="flex h-full flex-col justify-end gap-1.5">
          <b className="text-[16px] font-semibold leading-none">{d.leads} <span className="text-[13px] font-normal">обр.</span></b>
          <span className="text-[13px] text-gray-500">{d.showings} пок.</span>
          <div className="flex h-[86px] items-end gap-1" aria-hidden="true">
            <div className="flex-1 rounded-t bg-blue/25" style={{ height: `${d.leads / max * 100}%` }} />
            <div className="flex-1 rounded-t bg-blue" style={{ height: `${d.showings / max * 100}%` }} />
          </div>
          <span className="text-[13px] text-gray-500">{dayShort(d.date)}</span>
        </div>
      ))}
    </div>
  );
}

/** Yesterday's first-touch metrics are historical; they are not a live SLA. */
export function PultContactReminders({ hero, canCalls, canClients }: {
  hero: Pick<McHero, "missedCallsToday" | "firstResponse">; canCalls: boolean; canClients: boolean;
}) {
  const median = hero.firstResponse.medianMinYesterday;
  return (
    <>
      {canCalls && <Reminder to="/calls" title="Пропущенные звонки" sub="Сегодня" ring={<CChip tone={hero.missedCallsToday > 0 ? "warn" : "gray"}>{hero.missedCallsToday}</CChip>} />}
      {canClients && <Reminder
        to="/clients"
        title="Первое касание — вчера"
        sub={`${median === null ? "Медиана не рассчитана" : `Медиана ${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(median)} мин`} · без касания: ${hero.firstResponse.noneCountYesterday}`}
        ring={<CChip tone={hero.firstResponse.noneCountYesterday > 0 ? "warn" : "gray"}>{hero.firstResponse.noneCountYesterday}</CChip>}
      />}
    </>
  );
}

/** Render every loaded event; totalCount is context, not a promise of unloaded detail. */
export function PultFirstLine({ firstLine, isLoading, incomplete }: {
  firstLine: McFirstLine | null; isLoading: boolean; incomplete: boolean;
}) {
  const items = firstLine?.items ?? [];
  const total = firstLine ? Math.max(firstLine.totalCount, items.length) : undefined;
  return (
    <CCard id="clean-first-line">
      <CHead title="Что обсудить с командой" count={total} />
      {items.length === 0 ? (
        <p className="m-0 text-gray-600">
          {isLoading ? "Загружаем события команды…" : incomplete || !firstLine ? "Данные команды загружены не полностью." : total ? "В снимке нет подробностей событий." : "Замечаний к команде сегодня нет."}
        </p>
      ) : (
        <div className="clean-first-line grid">
          {items.map((it) => (
            <div key={it.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line-soft py-3 last:border-b-0">
              <div className="min-w-0">
                <CChip tone={it.severity === "critical" ? "crit" : it.severity === "warn" ? "warn" : "info"}>
                  {it.severity === "critical" ? "Срочно" : it.severity === "warn" ? "Важно" : "К сведению"}
                </CChip>
                <p className="mb-0 mt-1.5 text-[14px] leading-snug text-ink">{it.text}</p>
              </div>
              <CLink to={it.href} variant="soft" size="icon" aria-label="Открыть событие команды"><ArrowUpRight /></CLink>
            </div>
          ))}
        </div>
      )}
      {total !== undefined && total > items.length && (
        <p className="mb-0 mt-3 text-[14px] text-gray-600">Показаны {items.length} из {total} событий. Остальные события не вошли в загруженный снимок.</p>
      )}
    </CCard>
  );
}

/** Фото с запасным вариантом: на стенде файлов может не быть, битая картинка недопустима. */
function Photo({ src, className }: { src?: string; className?: string }) {
  const [bad, setBad] = useState<string>();
  if (!src || bad === src)
    return (
      <div
        className={cn(
          "clean-photo-empty bg-row-alt",
          className,
        )}
      ><span>Фото объекта пока не добавлено</span></div>
    );
  return (
    <img src={src} alt="" loading="lazy" decoding="async" className={className} onError={() => setBad(src)} />
  );
}

function isOnline(lastSeenAt?: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < 15 * 60_000;
}

const MONTHS = [
  "янв",
  "фев",
  "мар",
  "апр",
  "май",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];
function monthShort(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return MONTHS[m - 1] ?? ym;
}
function dayShort(date: string): string {
  const d = new Date(date);
  return Number.isNaN(d.getTime())
    ? date
    : `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}
