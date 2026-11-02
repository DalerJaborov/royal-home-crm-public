import { MarketWhatsAppButton } from "./MarketWhatsAppButton";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useMarketDynamics } from "../hooks/useMarket";
import { formatMoney, pluralizeRu } from "../lib/format";
import { marketSourceName } from "../lib/marketSource";
import type { MarketDynamicsData, MarketGoneListing } from "../types";

/**
 * «Динамика рынка» внутри блока «Рынок»: что происходит с похожими объявлениями,
 * которые ушли с площадки (Somon/Paydo) за 90 дней. Все числа считает сервер
 * (GET /market/property/:id/dynamics); здесь только показ.
 *
 * Слова: «ушло с площадки», не «продано» — объявление могло быть снято или истечь.
 * Каждая цифра честно показывает, по скольким объявлениям она посчитана; меньше
 * порога — цифры нет вовсе. На телефоне секция свёрнута, на ПК раскрыта.
 */

export interface DynamicsTile {
  key: "speed" | "price" | "cuts" | "sellers";
  label: string;
  text: string;
  hint?: string;
}

const MINUS = "−";

/** Подписи к цифрам простым русским. Нет данных по блоку — плитки нет. */
export function dynamicsTiles(d: MarketDynamicsData): DynamicsTile[] {
  const tiles: DynamicsTile[] = [];

  if (d.speed.medianDays != null) {
    const n = d.speed.medianDays;
    tiles.push({
      key: "speed",
      label: "Как быстро уходят",
      text: `Уходят за ~${n} ${pluralizeRu(n, ["день", "дня", "дней"])}`,
      hint: `по ${d.speed.sampleSize} ушедшим объявлениям`,
    });
  }

  if (d.price.diffPercent != null) {
    const diff = d.price.diffPercent;
    const abs = Math.abs(diff);
    if (abs < 3) {
      tiles.push({ key: "price", label: "Что уходит по цене", text: "Ушедшие по цене как висящие", hint: "цена за м², медиана" });
    } else if (diff < 0) {
      tiles.push({
        key: "price",
        label: "Что уходит по цене",
        text: `Ушедшие дешевле висящих на ${abs}%`,
        hint: "цена за м²; похоже, дорогие висят дольше",
      });
    } else {
      tiles.push({
        key: "price",
        label: "Что уходит по цене",
        text: `Ушедшие дороже висящих на ${abs}%`,
        hint: "цена за м²; похоже, спрос держит цену",
      });
    }
  }

  if (d.price.cutSharePercent != null) {
    const share = d.price.cutSharePercent;
    tiles.push({
      key: "cuts",
      label: "Снижали цену до ухода",
      text:
        share === 0
          ? "Цену не снижал никто"
          : `Снижали цену: ${share}% объявлений${d.price.avgCutPercent ? `, в среднем ${MINUS}${d.price.avgCutPercent}%` : ""}`,
      hint: `по ${d.price.cutSampleSize} ушедшим с историей цены`,
    });
  }

  if (d.sellers.realtorPercent != null && d.sellers.ownerPercent != null) {
    tiles.push({
      key: "sellers",
      label: "Кто продаёт",
      text: `Риелторов ${d.sellers.realtorPercent}%, собственников ${d.sellers.ownerPercent}%`,
      hint: `${d.sellers.realtorListings} из ${d.sellers.sampleSize} объявлений — от риелторов`,
    });
  }

  return tiles;
}

function goneAgoLabel(days: number): string {
  return days <= 0 ? "ушло сегодня" : `ушло ${days} дн. назад`;
}

function GoneRow({ l }: { l: MarketGoneListing }) {
  const sub = [
    marketSourceName(l.source),
    `висело ${l.daysListed} дн.`,
    goneAgoLabel(l.goneDaysAgo),
    l.priceCutPercent ? `снижали на ${l.priceCutPercent}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const seller = [l.isRealtor ? "риелтор" : "собственник", l.sellerName].filter(Boolean).join(" · ");
  return (
    <>
      <a
        href={l.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-between gap-3 pt-2.5 text-[14px] hover:bg-hover-tint"
      >
        <span className="min-w-0">
          <span className="block truncate">{l.title}</span>
          <span className="block truncate text-[13px] text-gray-500">{sub}</span>
        </span>
        <em className="not-italic font-semibold whitespace-nowrap tabular-nums">
          {l.priceTjs != null ? formatMoney(l.priceTjs, "TJS") : "—"}
        </em>
      </a>
      <div className="flex items-center gap-2 pb-2.5 text-[13px] text-gray-500">
        <span className="truncate">{seller}</span>
        {l.sellerPhone && (
          <a href={`tel:${l.sellerPhone}`} className="font-medium text-blue whitespace-nowrap tabular-nums">
            {l.sellerPhone}
          </a>
        )}
        <MarketWhatsAppButton sourceUrl={l.sourceUrl} source={l.source} title={l.title} phone={l.sellerPhone} className="ml-auto" />
      </div>
    </>
  );
}

/** Чистое представление — отдельно от запроса, чтобы проверять без сети. */
export function MarketDynamicsView({ data }: { data: MarketDynamicsData }) {
  const [open, setOpen] = useState(false);
  const [allGone, setAllGone] = useState(false);
  if (data.status === "unsupported") return null;

  const tiles = data.status === "ok" ? dynamicsTiles(data) : [];
  const mobileGone = 3;
  const gone = data.recentlyGone;

  return (
    <div className="mt-4 border-t border-line-soft pt-3" role="group" aria-label="Динамика рынка">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="sm:hidden flex w-full items-center justify-between py-1 text-[14px] font-semibold text-blue"
      >
        <span>Динамика рынка</span>
        <ChevronRight className={`w-4 h-4 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
      </button>
      <h4 className="hidden sm:block text-[13px] font-semibold text-gray-500 mb-2">Динамика рынка</h4>

      <div className={`${open ? "block" : "hidden"} sm:block mt-2 sm:mt-0`}>
        {tiles.length === 0 ? (
          <p className="text-[13px] text-gray-500">Данных о динамике пока мало (каталог собирается)</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-4 gap-y-3">
            {tiles.map((t) => (
              <div key={t.key} className="min-w-0">
                <div className="text-[13px] text-gray-500">{t.label}</div>
                <div className="text-[15px] font-semibold">{t.text}</div>
                {t.hint && <div className="text-[13px] text-gray-500">{t.hint}</div>}
              </div>
            ))}
          </div>
        )}

        {gone.length > 0 && (
          <div className="mt-4">
            <h5 className="text-[13px] font-semibold text-gray-500 mb-1">Недавно ушли с площадки</h5>
            <ul className="border-t border-line-soft">
              {gone.map((l, i) => (
                <li
                  key={l.sourceUrl}
                  className={`${i >= mobileGone && !allGone ? "hidden sm:block" : "block"} border-b border-line-soft`}
                >
                  <GoneRow l={l} />
                </li>
              ))}
              {gone.length > mobileGone && !allGone && (
                <li className="sm:hidden border-b border-line-soft">
                  <button type="button" onClick={() => setAllGone(true)} className="w-full text-left py-2.5 text-[14px] font-semibold text-blue">
                    Ещё {gone.length - mobileGone} ›
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}

        <p className="mt-3 text-[13px] text-gray-500 leading-relaxed">
          «Ушло» — объявление пропало с площадки: его могли продать, снять или оно истекло. Считаем за {data.windowDays} дней
          по {data.goneCount} ушедшим и {data.activeCount} висящим похожим; срок — от первого появления в нашем каталоге.
        </p>
      </div>
    </div>
  );
}

export function MarketDynamics({ propertyId }: { propertyId: string }) {
  const { data, isLoading } = useMarketDynamics(propertyId);
  if (isLoading || !data) return null;
  return <MarketDynamicsView data={data} />;
}
