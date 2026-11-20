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
 * сервер считает их когортой карточек периода). Сравнение — та же доска за
 * прошлый отрезок той же длины (lib/adsCompare.ts). Нет числа — пишем «нет
 * данных», а не ноль: выдумывать цифры нельзя.
 */
export function AdsDirectorTiles({ totals, previous, previousLabel, pacing, syncedAt, periodLabel }: {
  totals: Totals | undefined;
  /** Итоги прошлого периода; undefined — ещё грузятся или сравнивать не с чем. */
  previous: Totals | undefined;
  previousLabel: string;
  pacing: AdPacingResponse | undefined;
  syncedAt: string | null;
  periodLabel: string;
}) {
  const spend = totals?.periodTjs ?? 0;
  const stats = totals?.leadStats ?? null;
  const prevStats = previous?.leadStats ?? null;
  const dealCost = stats && stats.deals > 0 ? spend / stats.deals : null;
  const prevDealCost = prevStats && prevStats.deals > 0 && previous ? previous.periodTjs / prevStats.deals : null;
  const romi = stats?.romi ?? null;
  const forecast = pacing ? describeForecast(pacing.forecastState, pacing.forecast) : null;
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
          value={stats?.costPerLeadTjs != null ? formatMoneyExact(stats.costPerLeadTjs, "TJS") : "нет заявок"}
          delta={stats?.costPerLeadTjs != null ? <Rh2DeltaChip value={stats.costPerLeadTjs} previous={prevStats?.costPerLeadTjs} positiveIsGood={false} periodLabel={previousLabel} /> : null}
          sub={stats ? `${stats.leads} ${pluralizeRu(stats.leads, ["заявка", "заявки", "заявок"])} с рекламы` : "нет данных о заявках"}
        />
        <Tile
          label="Цена сделки"
          value={dealCost !== null ? formatMoneyExact(dealCost, "TJS") : "сделок пока нет"}
          delta={dealCost !== null ? <Rh2DeltaChip value={dealCost} previous={prevDealCost} positiveIsGood={false} periodLabel={previousLabel} /> : null}
          sub={stats ? `${stats.deals} ${pluralizeRu(stats.deals, ["сделка", "сделки", "сделок"])} с рекламных заявок` : "нет данных о сделках"}
        />
        <Tile
          label="Окупаемость"
          value={romi !== null ? `${romi > 0 ? "+" : ""}${Math.round(romi * 100)} %` : "нет расхода"}
          tone={romi === null ? undefined : romi >= 0 ? "ok" : "crit"}
          sub={stats && romi !== null
            ? `комиссия ${formatMoneyExact(stats.commissionTjs, "TJS")} на ${formatMoneyExact(spend, "TJS")} рекламы`
            : "считается, когда есть расход"}
        />
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
