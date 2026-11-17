import { MarketWhatsAppButton } from "./MarketWhatsAppButton";
import { useState } from "react";
import { ExternalLink, TrendingUp } from "lucide-react";
import { useMarketProperty } from "../hooks/useMarket";
import { formatArea, formatMoney } from "../lib/format";
import { marketSourceName } from "../lib/marketSource";
import { MarketDynamics } from "./MarketDynamics";
import type { MarketPropertyEstimate, MarketSimilarListing } from "../types";

export { marketSourceName };

/**
 * Блок «Рынок» в карточке объекта: дорого / в рынке / дёшево относительно
 * похожих объявлений Somon и Paydo. Один адаптивный компонент для ПК и телефона
 * (на телефоне компактнее, лишние объявления прячутся за «Ещё N похожих»).
 *
 * Все числа считает сервер (GET /market/property/:id); здесь только показ.
 * Меньше 8 похожих — «Данных мало», без числа и вердикта. Не квартира/дом —
 * блока нет вовсе. Цены в объявлениях — не цены сделок (сказано в «Основании»).
 */

const REPAIR_LABEL: Record<string, string> = {
  SHELL: "коробка",
  WHITE: "предчистовая",
  PARTIAL: "частичный ремонт",
  RENOVATED: "с ремонтом",
  DESIGNER: "дизайнерский",
};

const VERDICT_VIEW = {
  above: { label: "Дорого", cls: "text-red bg-red-bg", mark: "bg-red" },
  below: { label: "Дёшево", cls: "text-green bg-green-bg", mark: "bg-green" },
  market: { label: "В рынке", cls: "text-green bg-green-bg", mark: "bg-green" },
} as const;

/** Положение отметки на шкале в процентах: середина рынка = 50%, ±10% («в рынке») ≈ ±16 п.п. */
export function scalePosition(diffPercent: number): number {
  return Math.min(96, Math.max(4, 50 + diffPercent * 1.6));
}

/** Подпись «владелец» у краёв шкалы выравниваем по краю, иначе она вылезает за блок. */
export function markLabelStyle(position: number): { left?: string; right?: string; transform?: string } {
  if (position < 10) return { left: "0" };
  if (position > 90) return { right: "0" };
  return { left: `${position}%`, transform: "translateX(-50%)" };
}

function houseTrait(l: MarketSimilarListing): string | null {
  const parts: string[] = [];
  if (l.isNewBuilding === true) parts.push("новостройка");
  else if (l.isNewBuilding === false) parts.push("старый фонд");
  if (l.buildingReady === true) parts.push("сдан");
  else if (l.buildingReady === false) parts.push("строится");
  return parts.length ? parts.join(", ") : null;
}

function listingMain(l: MarketSimilarListing): string {
  const parts: string[] = [];
  if (l.rooms) parts.push(`${l.rooms} к`);
  if (l.areaSqm) parts.push(`${formatArea(l.areaSqm)} м²`);
  if (l.floor) parts.push(l.totalFloors ? `${l.floor}/${l.totalFloors}` : `${l.floor} эт.`);
  if (l.repair && REPAIR_LABEL[l.repair]) parts.push(REPAIR_LABEL[l.repair]);
  return parts.join(" · ") || l.title;
}

function headerTitle(s: MarketPropertyEstimate["subject"]): string {
  const parts = ["Рынок"];
  if (s.districtName) parts.push(s.districtName);
  if (s.rooms) parts.push(`${s.rooms} комн.`);
  if (s.areaSqm) parts.push(`${formatArea(s.areaSqm)} м²`);
  return parts.join(" · ");
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] sm:text-[13px] text-gray-500">{label}</div>
      <div className="text-[16px] sm:text-[20px] font-semibold tabular-nums">{children}</div>
    </div>
  );
}

/** Чистое представление — отдельно от запроса, чтобы его можно было проверять без сети. */
export function MarketBlockView({ data, propertyId }: { data: MarketPropertyEstimate; propertyId?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (data.status === "unsupported") return null;

  const title = headerTitle(data.subject);

  if (data.status === "insufficient" || data.medianPerSqm == null || data.estimatedPriceTjs == null) {
    return (
      <section className="bg-card border border-line rounded-card shadow-sm p-3 sm:p-4" aria-label="Рынок">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold min-w-0">
            <TrendingUp className="w-3.5 h-3.5 text-blue shrink-0" aria-hidden />
            <span className="truncate">{title}</span>
          </h3>
          <span className="rounded-badge px-2.5 py-1 text-[13px] font-semibold text-gray-500 bg-hover-tint shrink-0">
            Данных мало
          </span>
        </div>
        <p className="mt-2 text-[13px] text-gray-500">
          Похожих объявлений за {data.windowDays} дней найдено {data.sampleSize} — для честной оценки нужно хотя бы 8.
          Цену рынка не показываем, чтобы не вводить в заблуждение.
        </p>
      </section>
    );
  }

  const verdict = data.comparison?.verdict ?? "unknown";
  const view = verdict === "unknown" ? null : VERDICT_VIEW[verdict];
  const asking = data.subject.askingPriceTjs;
  const diff = data.comparison?.diffPercent ?? (asking ? Math.round((asking / data.estimatedPriceTjs - 1) * 100) : null);
  const diffLabel = diff == null || verdict === "market" ? "" : ` ${diff > 0 ? "+" : ""}${diff}%`;
  const hasRange = data.rangeLowTjs != null && data.rangeHighTjs != null;
  const mobileVisible = 3;
  // Кнопка раскрывает только показанные строки; «остальные в выборке» (moreCount) — отдельной строкой без кнопки.
  const hiddenOnMobile = Math.max(0, data.listings.length - mobileVisible);
  const sourcesLine = data.sources.map((s) => `${marketSourceName(s.source)} (${s.count})`).join(" + ");

  return (
    <section className="bg-card border border-line rounded-card shadow-sm p-3 sm:p-4" aria-label="Рынок">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold min-w-0">
          <TrendingUp className="w-3.5 h-3.5 text-blue shrink-0" aria-hidden />
          <span className="truncate sm:whitespace-normal">
            <span className="sm:hidden">Рынок</span>
            <span className="hidden sm:inline">{title}</span>
          </span>
        </h3>
        {view && (
          <span className={`rounded-badge px-2.5 sm:px-3 py-1 text-[13px] sm:text-[14px] font-semibold shrink-0 ${view.cls}`}>
            {view.label}
            {verdict === "market" ? "" : <span className="hidden sm:inline">{diffLabel ? ` ·${diffLabel} к рынку` : ""}</span>}
            <span className="sm:hidden">{diffLabel}</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
        {asking != null && <Stat label="Просит владелец">{formatMoney(asking, "TJS")}</Stat>}
        <Stat label="Середина рынка">{formatMoney(data.estimatedPriceTjs, "TJS")}</Stat>
        {hasRange && (
          <Stat label="Вилка (типичный разброс)">
            <span className="text-[14px] sm:text-[20px]">
              {formatMoney(data.rangeLowTjs as number, "TJS")} – {formatMoney(data.rangeHighTjs as number, "TJS")}
            </span>
          </Stat>
        )}
        <Stat label="За м²">
          {asking != null && data.subject.areaSqm > 0 ? (
            <>
              {formatMoney(Math.round(asking / data.subject.areaSqm), "TJS")}
              <span className="text-gray-500 font-normal"> / {formatMoney(data.medianPerSqm, "TJS")}</span>
            </>
          ) : (
            formatMoney(data.medianPerSqm, "TJS")
          )}
        </Stat>
      </div>

      {diff != null && (
        <div className="mt-5 mb-1" aria-hidden>
          <div className="relative h-2.5 rounded-full" style={{ background: "linear-gradient(90deg, rgb(var(--rgb-green) / .35) 0 34%, rgb(var(--rgb-green) / .65) 34% 66%, rgb(var(--rgb-green) / .35) 66%)" }}>
            <span className="absolute -top-1.5 w-[3px] h-[22px] rounded-sm bg-ink" style={{ left: "50%" }} />
            <span className="absolute -top-6 -translate-x-1/2 text-[13px] whitespace-nowrap" style={{ left: "50%" }}>середина</span>
            <span className={`absolute -top-1.5 w-[3px] h-[22px] rounded-sm ${view?.mark ?? "bg-ink"}`} style={{ left: `${scalePosition(diff)}%` }} />
            <span
              data-testid="owner-mark-label"
              className={`absolute top-4 text-[13px] whitespace-nowrap font-medium ${verdict === "above" ? "text-red" : verdict === "below" ? "text-green" : ""}`}
              style={markLabelStyle(scalePosition(diff))}
            >
              владелец
            </span>
          </div>
          <div className="flex justify-between text-[13px] sm:text-[13px] text-gray-500 mt-7">
            <span>дёшево</span>
            <span>в рынке</span>
            <span>дорого</span>
          </div>
        </div>
      )}

      {data.listings.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[13px] font-semibold text-gray-500 mb-1">
            <span className="hidden sm:inline">{data.listings.length} похожих объявлений</span>
            <span className="sm:hidden">Похожие объявления</span>
          </h4>
          <ul className="border-t border-line-soft">
            {data.listings.map((l, i) => {
              const trait = houseTrait(l);
              const sub = [marketSourceName(l.source), l.districtName, trait].filter(Boolean).join(" · ");
              const hideOnMobile = i >= mobileVisible && !expanded;
              return (
                <li key={l.sourceUrl} className={`${hideOnMobile ? "hidden sm:flex" : "flex"} items-center gap-2 border-b border-line-soft`}>
                  <a
                    href={l.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 py-2.5 text-[14px] hover:bg-hover-tint"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{listingMain(l)}</span>
                      <span className="flex items-center gap-1 text-[13px] text-gray-500">
                        <ExternalLink className="w-3 h-3 shrink-0" aria-hidden />
                        <span className="truncate">{sub}</span>
                      </span>
                    </span>
                    <em className="not-italic font-semibold whitespace-nowrap tabular-nums">
                      {l.priceTjs != null ? formatMoney(l.priceTjs, "TJS") : "—"}
                    </em>
                  </a>
                  <MarketWhatsAppButton sourceUrl={l.sourceUrl} source={l.source} title={l.title} />
                </li>
              );
            })}
            {hiddenOnMobile > 0 && !expanded && (
              <li className="sm:hidden border-b border-line-soft">
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="w-full text-left! py-2.5! text-[14px]! font-semibold! text-blue!"
                >
                  Ещё {hiddenOnMobile} похожих ›
                </button>
              </li>
            )}
          </ul>
          {data.moreCount > 0 && (
            <p className="mt-2 text-[13px] text-gray-500">и ещё {data.moreCount} в выборке</p>
          )}
        </div>
      )}

      {propertyId && <MarketDynamics propertyId={propertyId} />}

      <p className="mt-3 text-[13px] text-gray-500 leading-relaxed">
        <span className="sm:hidden">
          {data.sampleSize} объявлений за {data.windowDays} дн.: {data.basis}
        </span>
        <span className="hidden sm:inline">
          Основание: медиана по {data.sampleSize} объявлениям — {data.basis}.
          {sourcesLine ? ` Данные ${sourcesLine} за ${data.windowDays} дней.` : ` За ${data.windowDays} дней.`} Цены в объявлениях — не цены сделок.
        </span>
      </p>
    </section>
  );
}

export function MarketBlock({ propertyId }: { propertyId: string }) {
  const { data, isLoading } = useMarketProperty(propertyId);
  if (isLoading || !data) return null;
  return <MarketBlockView data={data} propertyId={propertyId} />;
}
