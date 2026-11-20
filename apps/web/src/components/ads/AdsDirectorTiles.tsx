import type { AdPacingResponse } from "@royal-home/shared";
import type { AdsBoard } from "../../hooks/useAds";
import { formatMoneyExact, pluralizeRu } from "../../lib/format";
import { agoRu } from "../../lib/adsView";
import { describeForecast, describeRatio } from "../../lib/adsCreativesPacingView";
import { Rh2DeltaChip } from "../rh2/Rh2DeltaChip";

type Totals = AdsBoard["totals"];

/**
 * ГЛАВНЫЕ ЦИФРЫ «РЕКЛАМЫ» ДЛЯ ДИРЕКТОРА (новый вид, 20.11.2026).
 *
 * Вопрос директора — «сколько потратил и сколько это принесло, лучше или хуже,
 * чем было». Всё берётся из ответа доски, который уже приходит на экран
 * (`totals.leadStats`: заявки с рекламы, сделки, комиссия компании, окупаемость —
 * сервер считает их по карточкам периода). Сравнение — та же доска за прошлый
 * отрезок той же длины (lib/adsCompare.ts).
 *
 * Три разных «нет» не смешиваются (ревью PR 336): нет данных (расчёт не пришёл),
 * нет расхода (цене не из чего взяться), нет заявок или сделок при расходе.
 * Окупаемость — деньги компании: без права finance.view плитки нет вовсе (сервер
 * и так отдаёт комиссию и окупаемость пустыми).
 */
export function AdsDirectorTiles({ totals, previous, previousLabel, pacing, syncedAt, periodLabel, seesMoney }: {
  totals: Totals | undefined;
  /** Итоги прошлого периода; undefined — ещё грузятся или сравнивать не с чем. */
  previous: Totals | undefined;
  previousLabel: string;
  pacing: AdPacingResponse | undefined;
  syncedAt: string | null;
  periodLabel: string;
  /** Право finance.view: показывать ли окупаемость (комиссию компании). */
  seesMoney: boolean;
}) {
  const spend = totals?.periodTjs ?? 0;
  const stats = totals?.leadStats ?? null;
  const prevStats = previous?.leadStats ?? null;
  const noSpend = spend <= 0;
  const leadCost = stats && !noSpend ? stats.costPerLeadTjs : null;
  const dealCost = stats && !noSpend && stats.deals > 0 ? spend / stats.deals : null;
  const prevSpent = !!previous && previous.periodTjs > 0;
  const prevLeadCost = prevSpent && prevStats ? prevStats.costPerLeadTjs : null;
  const prevDealCost = prevSpent && prevStats && prevStats.deals > 0 ? previous!.periodTjs / prevStats.deals : null;
  const showRomi = seesMoney && !!stats && stats.commissionTjs !== null;
  const romi = stats?.romi ?? null;
  const forecast = pacing ? describeForecast(pacing.forecastState, pacing.forecast) : null;

  const leadValue = !stats ? "нет данных" : noSpend ? "—" : leadCost !== null ? formatMoneyExact(leadCost, "TJS") : "нет заявок";
  const leadSub = !stats
    ? "заявки с рекламы не посчитались"
    : noSpend
      ? "расхода не было"
      : `${stats.leads.toLocaleString("ru-RU")} ${pluralizeRu(stats.leads, ["заявка", "заявки", "заявок"])} с рекламы`;
  const dealValue = !stats ? "нет данных" : noSpend ? "—" : dealCost !== null ? formatMoneyExact(dealCost, "TJS") : "сделок пока нет";
  const dealSub = !stats
    ? "сделки с рекламы не посчитались"
    : noSpend
      ? "расхода не было"
      : `${stats.deals.toLocaleString("ru-RU")} ${pluralizeRu(stats.deals, ["сделка", "сделки", "сделок"])} с рекламных заявок`;

  return (
    <>
      <div className="tiles ry-ads-tiles" aria-label="Главное о рекламе за период">
        <Tile
          label={`Потрачено за ${periodLabel}`}
          value={formatMoneyExact(spend, "TJS")}
          delta={<Rh2DeltaChip value={spend} previous={previous?.periodTjs} positiveIsGood={false} periodLabel={previousLabel} />}
          sub={syncedAt ? `сверено ${agoRu(syncedAt, Date.now())}` : "ещё не сверялись"}
        />
        <Tile
          label="Цена заявки"
          value={leadValue}
          delta={leadCost !== null ? <Rh2DeltaChip value={leadCost} previous={prevLeadCost} positiveIsGood={false} periodLabel={previousLabel} /> : null}
          sub={leadSub}
        />
        <Tile
          label="Цена сделки"
          value={dealValue}
          delta={dealCost !== null ? <Rh2DeltaChip value={dealCost} previous={prevDealCost} positiveIsGood={false} periodLabel={previousLabel} /> : null}
          sub={dealSub}
        />
        {showRomi && stats && (
          <Tile
            label="Окупаемость"
            value={romi !== null ? `${romi > 0 ? "+" : ""}${Math.round(romi * 100)} %` : "—"}
            tone={romi === null ? undefined : romi >= 0 ? "ok" : "crit"}
            sub={romi !== null && stats.commissionTjs !== null
              ? `комиссия ${formatMoneyExact(stats.commissionTjs, "TJS")} на ${formatMoneyExact(spend, "TJS")} рекламы`
              : "расхода не было — окупаться нечему"}
          />
        )}
      </div>
      {pacing && (
        <p className="state ry-ads-pace">
          Сегодня {formatMoneyExact(pacing.todayTjs, "TJS")}
          {pacing.usualDayTjs > 0 ? ` · обычно ${formatMoneyExact(pacing.usualDayTjs, "TJS")} в день` : ""}
          {describeRatio(pacing.ratioToUsual) && pacing.usualDayTjs > 0 ? ` (${describeRatio(pacing.ratioToUsual)})` : ""}
          {forecast && forecast.headline !== "нет данных" ? ` · до конца месяца ${forecast.headline}${forecast.range ? `, ${forecast.range}` : ""}` : ""}
        </p>
      )}
    </>
  );
}

function Tile({ label, value, sub, delta, tone }: { label: string; value: string; sub: string; delta?: React.ReactNode; tone?: "ok" | "crit" }) {
  return (
    <div className="tile" data-tone={tone}>
      <div className="hd">{label}</div>
      <b className="money" style={{ fontSize: "var(--fs-23)" }}>
        {value}
        {delta}
      </b>
      <span style={{ fontSize: "var(--fs-13)", color: "var(--muted)" }}>{sub}</span>
    </div>
  );
}
