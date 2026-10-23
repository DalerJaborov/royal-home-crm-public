import { Link } from "react-router-dom";
import { ArrowUpRight, Bot, ChevronDown, HeartPulse, ListChecks, UsersRound, MessageCircle } from "lucide-react";
import type { McBot, McControlGaps, McHero, McSystem } from "../../hooks/useMissionControl";
import { formatMoney } from "../../lib/format";
import { pluralizeRu } from "@royal-home/shared";
import { CCard, CChip, CHead, CLink } from "./ui";

/** Same counters and destination as DirectorHome; no inferred or merged totals. */
export function CleanControlTiles({ control, allowed }: { control: McControlGaps | undefined; allowed: boolean }) {
  if (!control || !allowed) return null;
  const tiles = [
    { label: "Просроченные задачи", data: control.overdueTasks, icon: ListChecks, slice: "slice-overdue-tasks" },
    { label: "На лимите нагрузки", data: control.atLimit, icon: UsersRound, slice: "slice-agents-at-limit" },
    { label: "Без ответа после показа", data: control.silentAfterShowing, icon: MessageCircle, slice: "slice-silent-after-showing" },
  ];
  return (
    <section className="grid gap-3 min-[1180px]:grid-cols-3" aria-label="Контроль руководителя">
      {tiles.map(({ label, data, icon: Icon, slice }) => (
        // «Присмотр» держит срезы одним экраном: ссылка с якорем открывает именно тот список, что показан в плитке.
        <Link key={label} to={`/oversight#${slice}`} className="grid min-w-0 grid-cols-[1fr_auto] gap-2 rounded-[20px] bg-card p-5 text-ink no-underline shadow-sm transition-colors hover:bg-row-alt">
          <span className="flex items-center gap-2 text-[16px]"><Icon size={20} aria-hidden="true" />{label}</span>
          <ArrowUpRight size={20} aria-hidden="true" />
          <strong className="text-[32px] font-semibold leading-tight tabular-nums">{data.count}</strong>
          <CChip tone={data.count > 0 ? "warn" : "gray"} className="self-center justify-self-end">Присмотр</CChip>
          {data.reason && <span className="col-span-2 text-[14px] text-gray-600">{data.reason}</span>}
        </Link>
      ))}
    </section>
  );
}

/** hero.profit is a cash balance in the API: receipts minus expenses, not accounting profit. */
export function CleanFinancialPulse({ hero, canSeeMoney, moneyRoute }: { hero: McHero | null; canSeeMoney: boolean; moneyRoute: boolean }) {
  if (!canSeeMoney || !hero || !hero.profit && !hero.commission) return null;
  return (
    <CCard>
      <CHead title="Денежный пульс" right={moneyRoute ? <CLink to="/finance" variant="soft" size="icon" aria-label="Открыть деньги"><ArrowUpRight /></CLink> : undefined} />
      <div className="clean-financial-metrics grid gap-5">
        {hero.profit && <div>
          <p className="m-0 text-[16px] text-gray-600">Баланс дня · сегодня</p>
          <p className="my-2 text-[28px] font-semibold leading-tight tabular-nums">{formatMoney(Math.round(hero.profit.todayTjs), "TJS")}</p>
          <p className="m-0 text-[14px] text-gray-600">Поступления минус расходы. Предыдущий день: {formatMoney(Math.round(hero.profit.previousTodayTjs), "TJS")}</p>
        </div>}
        {hero.commission && <div>
          <p className="m-0 text-[16px] text-gray-600">Прогноз комиссии к концу месяца</p>
          <p className="my-2 text-[28px] font-semibold leading-tight tabular-nums">{formatMoney(Math.round(hero.commission.forecastEndOfMonth), "TJS")}</p>
          <p className="m-0 text-[14px] text-gray-600">Если текущий темп комиссии сохранится · {hero.commission.planIsDefault ? "план не задан" : `${Math.round(hero.commission.forecastPercent)}% плана`}. Это прогноз, а не полученные деньги.</p>
        </div>}
      </div>
    </CCard>
  );
}

export function CleanSystemBotDetails({ system, bot, canHealth, canMessages, canBotLearning, canSeeMoney }: {
  system: McSystem | null; bot: McBot | null; canHealth: boolean; canMessages: boolean; canBotLearning: boolean; canSeeMoney: boolean;
}) {
  const visibleSystem = canHealth ? system : null;
  if (!visibleSystem && !bot) return null;
  const healthy = visibleSystem?.crons.filter((cron) => cron.healthy).length ?? 0;
  return (
    <CCard>
      <CHead title="Система и ИИ" count="текущий снимок" />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {visibleSystem && <details className="rounded-2xl bg-row-alt p-4">
          <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 text-[16px] font-semibold">
            <HeartPulse size={20} aria-hidden="true" />Система
            <CChip tone={visibleSystem.errorsToday > 0 || visibleSystem.jobsGivenUp > 0 ? "warn" : "gray"}>{visibleSystem.errorsToday} {pluralizeRu(visibleSystem.errorsToday, ["ошибка", "ошибки", "ошибок"])} сегодня</CChip>
            <ChevronDown size={20} className="ml-auto" aria-hidden="true" />
          </summary>
          <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[16px]">
            <dt>Фоновых задач в работе</dt><dd className="m-0 font-semibold">{visibleSystem.jobsRunning}</dd>
            <dt>Брошено задач · всего</dt><dd className="m-0 font-semibold">{visibleSystem.jobsGivenUp}</dd>
            <dt>Брошено за 24 часа</dt><dd className="m-0 font-semibold">{visibleSystem.jobsGivenUpLast24h}</dd>
            <dt>Регулярные проверки</dt><dd className="m-0 font-semibold">{visibleSystem.crons.length ? `${healthy} из ${visibleSystem.crons.length} в норме` : "Нет данных"}</dd>
          </dl>
          {visibleSystem.crons.length > 0 && <ul className="my-4 grid list-none gap-2 p-0 text-[14px]">
            {visibleSystem.crons.map((cron) => <li key={cron.name} className="flex items-center justify-between gap-3"><span className="min-w-0 break-words">{cron.name}</span><CChip tone={cron.healthy ? "ok" : "warn"}>{cron.healthy ? "В норме" : "Проверить"}</CChip></li>)}
          </ul>}
          <CLink to="/health" variant="soft">Здоровье системы <ArrowUpRight size={18} /></CLink>
        </details>}
        {bot && <details className="rounded-2xl bg-row-alt p-4">
          <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 text-[16px] font-semibold">
            <Bot size={20} aria-hidden="true" />ИИ за сегодня
            <CChip tone={bot.ai.errorsToday > 0 ? "warn" : "gray"}>{bot.ai.requestsToday} {pluralizeRu(bot.ai.requestsToday, ["запрос", "запроса", "запросов"])} · {bot.ai.errorsToday} {pluralizeRu(bot.ai.errorsToday, ["ошибка", "ошибки", "ошибок"])}</CChip>
            <ChevronDown size={20} className="ml-auto" aria-hidden="true" />
          </summary>
          <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[16px]">
            <dt>Доля ошибок</dt><dd className="m-0 font-semibold">{bot.ai.errorRatePercent}%</dd>
            <dt>Средний ответ ИИ</dt><dd className="m-0 font-semibold">{bot.ai.requestsToday > 0 ? `${bot.ai.avgMs} мс` : "Нет запросов"}</dd>
            <dt>Срабатываний фильтров</dt><dd className="m-0 font-semibold">{bot.guardHitsToday}</dd>
            <dt>Сообщений остановил щит</dt><dd className="m-0 font-semibold">{bot.outboundShieldToday}</dd>
            <dt>Неразобранных замечаний</dt><dd className="m-0 font-semibold">{bot.unresolvedFindings ?? "Проверка недоступна"}</dd>
            {canSeeMoney && bot.ai.costUsdToday !== null && <><dt>Расход на ИИ</dt><dd className="m-0 font-semibold">{formatMoney(bot.ai.costUsdToday, "USD")}</dd></>}
            {bot.attention && <>
              <dt>Активных диалогов</dt><dd className="m-0 font-semibold">{bot.attention.liveCount}</dd>
              <dt>Диалогов без ответа</dt><dd className="m-0 font-semibold">{bot.attention.silent.count}</dd>
              <dt>Диалогов ждут человека</dt><dd className="m-0 font-semibold">{bot.attention.waitingHuman.count}</dd>
            </>}
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            {canMessages && <CLink to="/messages" variant="soft">Открыть диалоги</CLink>}
            {canBotLearning && <CLink to="/ai-learning" variant="soft">Обучение бота</CLink>}
          </div>
        </details>}
      </div>
    </CCard>
  );
}
