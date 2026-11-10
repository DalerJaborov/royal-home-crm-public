import { ExternalLink, Search } from "lucide-react";
import type { MarketBuyerListing, MarketBuyerListingsResponse } from "@royal-home/shared";
import { useMarketBuyerListings } from "../hooks/useMarket";
import { dushanbeDate } from "../lib/date";
import { formatArea, formatMoney } from "../lib/format";
import { marketSourceName } from "../lib/marketSource";
import { Rh2EmptyState } from "./rh2/Rh2EmptyState";
import { Rh2ErrorState } from "./rh2/Rh2ErrorState";

/**
 * «С площадок (Somon/Paydo)» — секция подбора покупателя рядом с нашими объектами (10.11.2026).
 *
 * Это ЧУЖИЕ объявления: наши объекты тут не показываются (сервер убирает всё, что признано нашим),
 * а подпись под заголовком и чип «Чужое» на каждой строке говорят это прямо. Один адаптивный
 * компонент для ПК и телефона: на телефоне карточка клиента рисует тот же узел (`overviewProperties`),
 * раскладку ≤820 px даёт сама тема. Все отборы и порядок считает сервер
 * (GET /clients/:id/market-listings); здесь только показ.
 */

function listingMain(l: MarketBuyerListing): string {
  const parts: string[] = [];
  if (l.rooms) parts.push(`${l.rooms} к`);
  if (l.areaSqm) parts.push(`${formatArea(l.areaSqm)} м²`);
  if (l.floor) parts.push(l.totalFloors ? `${l.floor}/${l.totalFloors} эт.` : `${l.floor} эт.`);
  return parts.length ? parts.join(" · ") : l.title;
}

export function MarketBuyerListingsView({ data }: { data: MarketBuyerListingsResponse }) {
  if (data.status === "not_buyer" || data.status === "pending_acceptance") return null;
  return (
    <section className="card" aria-label="Объявления с площадок" data-testid="market-buyer-listings">
      <div className="sec-h stack">
        <h2>С площадок (Somon/Paydo)</h2>
      </div>
      <p className="sub">
        Чужие объявления с сайтов, не наши объекты. Цены в объявлениях — не цены сделок.
        {data.criteria.length > 0 ? ` Ищем: ${data.criteria.join(", ")}.` : ""}
      </p>
      {data.status === "no_criteria" ? (
        <Rh2EmptyState
          icon={Search}
          title="Не из чего подбирать"
          hint="Укажите район или бюджет в пожеланиях покупателя — тогда здесь появятся объявления."
        />
      ) : data.listings.length === 0 ? (
        <Rh2EmptyState icon={Search} title="Сейчас на площадках нет подходящих объявлений" hint="Список обновляется по мере появления новых." />
      ) : (
        <>
          <div className="list">
            {data.listings.map((l) => (
              <div className="row wrapt" key={l.sourceUrl}>
                <div className="t">
                  <b>
                    <a
                      href={l.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1"
                      aria-label={`${listingMain(l)}, ${marketSourceName(l.source)}: открыть объявление на сайте`}
                    >
                      {listingMain(l)}
                      <ExternalLink className="w-3 h-3 shrink-0" aria-hidden />
                    </a>
                  </b>
                  <span>
                    {[marketSourceName(l.source), l.districtName, `размещено ${dushanbeDate(l.publishedAt)}`].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <span className="chip">Чужое</span>
                <span className="meta">
                  <b>{formatMoney(l.priceTjs, "TJS")}</b>
                  {l.pricePerSqmTjs != null && <small> · {formatMoney(l.pricePerSqmTjs, "TJS")}/м²</small>}
                </span>
              </div>
            ))}
          </div>
          {data.total > data.listings.length && (
            <p className="sub">Показаны ближайшие {data.listings.length} из {data.total}.</p>
          )}
        </>
      )}
    </section>
  );
}

export function MarketBuyerListings({ clientId }: { clientId: string }) {
  const { data, isLoading, isError, refetch, isFetching } = useMarketBuyerListings(clientId);
  if (isLoading) {
    return (
      <section className="card" aria-busy="true" aria-label="Объявления с площадок">
        <div className="sec-h stack"><h2>С площадок (Somon/Paydo)</h2></div>
        <p role="status" className="sub">Ищем на площадках…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section className="card" aria-label="Объявления с площадок">
        <div className="sec-h stack"><h2>С площадок (Somon/Paydo)</h2></div>
        <Rh2ErrorState message="Не удалось загрузить объявления с площадок." onRetry={() => void refetch()} retrying={isFetching} />
      </section>
    );
  }
  return <MarketBuyerListingsView data={data} />;
}
