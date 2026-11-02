import { useState } from "react";
import { ChevronDown, ExternalLink, TrendingUp } from "lucide-react";
import { useMarketEstimate } from "../hooks/useMarket";
import { formatMoney } from "../lib/format";

/**
 * Рыночная оценка по аналогам — общий блок для карточки клиента ("что он
 * может себе позволить") и карточки объекта ("дорого/в рынке/дёшево").
 * Считает apps/api/src/lib/market/comps.ts::estimateFromComps через
 * GET /market/estimate — сама медиану не пересчитывает.
 *
 * Тихо ничего не рендерит, если аналогов слишком мало (владелец: пустой блок
 * на каждой карточке без района засоряет экран сильнее, чем его отсутствие) —
 * ровно так же молчит estimateFromComps при sampleSize < MIN_SAMPLE.
 */

/**
 * Грубая типичная площадь квартиры для N комнат в Душанбе — только чтобы
 * прикинуть, дотягивает ли бюджет клиента до нижней четверти рынка (p25).
 * Не связана с фильтром аналогов (тот считается по площади объекта, если она
 * есть, — у клиента её нет вовсе), это отдельная прикидка для подсказки.
 */
function typicalAreaForRooms(rooms: number): number {
  return 20 + rooms * 20;
}
export function MarketEstimateCard({
  districtName,
  rooms,
  areaSqm,
  referencePriceTjs,
  referenceLabel,
  variant = "property",
}: {
  districtName?: string | null;
  rooms?: number | null;
  areaSqm?: number | null;
  /** Цена объекта или бюджет клиента в сомони — для сравнения "дорого/дёшево". */
  referencePriceTjs?: number | null;
  /** Подпись к referencePriceTjs, например "Бюджет клиента: 800 000 – 1 000 000 с." */
  referenceLabel?: string | null;
  /** "property" — акцент на вердикте дорого/дёшево + источники; "client" — акцент на медиане района. */
  variant?: "property" | "client";
}) {
  const [showSources, setShowSources] = useState(false);
  const { data, isLoading } = useMarketEstimate({
    districtName,
    rooms,
    areaSqm,
    priceTjs: referencePriceTjs,
  });

  if (isLoading || !data || data.medianPerSqm == null) return null;

  const requestLine = [districtName, rooms ? `${rooms}-комн` : null].filter(Boolean).join(", ");
  const verdict = data.comparison?.verdict;

  // Только для карточки клиента: бюджета одного мало, чтобы сказать
  // "дорого/дёшево" — площади у клиента нет. Вместо этого грубо прикидываем,
  // хватает ли бюджета хотя бы на нижнюю четверть рынка (p25) для типичной
  // площади под его число комнат.
  const budgetBelowTypical =
    variant === "client" && rooms && referencePriceTjs && data.p25PerSqm
      ? referencePriceTjs / typicalAreaForRooms(rooms) < data.p25PerSqm
      : false;
  const verdictLabel =
    verdict === "below"
      ? `На ${Math.abs(data.comparison?.diffPercent ?? 0)}% ниже рынка`
      : verdict === "above"
        ? `На ${data.comparison?.diffPercent ?? 0}% выше рынка`
        : verdict === "market"
          ? "В рынке"
          : null;
  const verdictColor =
    verdict === "below" ? "text-green bg-green-bg" : verdict === "above" ? "text-red bg-red-bg" : "text-gray-500 bg-hover-tint";
  const verdictDot = verdict === "below" ? "🟢" : verdict === "above" ? "🔴" : "⚪";

  return (
    <div className="bg-card border border-line rounded-card shadow-sm p-4">
      <div className="flex items-center gap-2 mb-2">
        <TrendingUp className="w-3.5 h-3.5 text-blue shrink-0" />
        <h3 className="text-[15px] font-semibold">Рыночная оценка</h3>
      </div>

      {variant === "property" && verdictLabel && (
        <div className={`inline-flex items-center gap-1.5 text-[13px] font-semibold rounded-badge px-2.5 py-1 mb-2 ${verdictColor}`}>
          <span>{verdictDot}</span>
          {verdictLabel}
        </div>
      )}

      <p className="text-[13px] text-gray-500 leading-relaxed">
        {variant === "client" && requestLine ? `Рынок по запросу клиента: ${requestLine} — ` : "Медиана: "}
        {formatMoney(data.medianPerSqm, "TJS")}/м²
        {data.estimatedPriceTjs ? ` (≈ ${formatMoney(data.estimatedPriceTjs, "TJS")})` : ""}
      </p>
      <p className="text-[13px] text-gray-400 mt-0.5">{data.basis}</p>

      {referenceLabel && (
        <p className="text-[13px] mt-2 pt-2 border-t border-line-soft">
          {referenceLabel}
          {budgetBelowTypical && (
            <span className="text-amber font-semibold"> — бюджет ниже типичного предложения района</span>
          )}
        </p>
      )}

      {data.listings.length > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-line-soft">
          <button
            type="button"
            onClick={() => setShowSources((v) => !v)}
            className="flex items-center gap-1 text-[13px] font-semibold text-blue"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSources ? "rotate-180" : ""}`} />
            Источники ({data.listings.length})
          </button>
          {showSources && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {data.listings.map((l) => (
                <li key={l.sourceUrl} className="text-[13px] flex items-center justify-between gap-2">
                  <a
                    href={l.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-blue hover:underline truncate min-w-0"
                  >
                    <ExternalLink className="w-3 h-3 shrink-0" />
                    <span className="truncate">{l.title || l.source}</span>
                  </a>
                  <span className="text-gray-400 shrink-0">
                    {l.pricePerSqmTjs ? `${formatMoney(l.pricePerSqmTjs, "TJS")}/м²` : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
