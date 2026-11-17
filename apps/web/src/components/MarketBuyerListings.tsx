import { ExternalLink, Search } from "lucide-react";
import type { MarketBuyerListing, MarketBuyerListingsResponse, MarketBuyerSummary } from "@royal-home/shared";
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
 *
 * Узкий подбор (17.11.2026): сервер отдаёт лучшие десять (район, комнаты, цена около бюджета, только
 * собственники, только то, что сбор видел за последние дни); остальное — кнопкой «Показать ещё».
 * Объявление без района — внизу и с подписью «район не указан».
 */

function listingMain(l: MarketBuyerListing): string {
  const parts: string[] = [];
  if (l.rooms) parts.push(`${l.rooms} к`);
  if (l.areaSqm) parts.push(`${formatArea(l.areaSqm)} м²`);
  if (l.floor) parts.push(l.totalFloors ? `${l.floor}/${l.totalFloors} эт.` : `${l.floor} эт.`);
  return parts.length ? parts.join(" · ") : l.title;
}

/**
 * Одна короткая строка над списком (14.11.2026): типичная цена объявлений в районе и с комнатами покупателя
 * и как его бюджет к ней относится. Числа считает сервер (порог MIN_SAMPLE приходит как minSample); меньше
 * порога строка честно говорит «данных мало» и чисел не показывает. Тот же узел на ПК и телефоне.
 */
export function marketBuyerLineText(m: MarketBuyerSummary): string | null {
  const place = [m.districtName, m.rooms ? `${m.rooms}-комнатные` : null].filter(Boolean).join(", ");
  if (m.status === "no_segment") return "Укажите район и число комнат в пожеланиях, тогда здесь появится типичная цена рынка.";
  if (m.status === "insufficient") {
    return `Рынок (${place}): данных мало, объявлений ${m.count}, для цены нужно от ${m.minSample}. Цен не называем.`;
  }
  const typical = `${formatMoney(m.medianPriceTjs ?? 0, "TJS")}${m.medianPerSqmTjs != null ? ` (${formatMoney(m.medianPerSqmTjs, "TJS")}/м²)` : ""}`;
  const head = `Рынок (${place}): типичная цена ${typical} по ${m.count} объявл.`;
  const p = m.budgetVsMedianPercent;
  if (p == null) return head;
  if (p === 0) return `${head} Бюджет клиента равен типичной цене.`;
  return `${head} Бюджет клиента на ${Math.abs(p)}% ${p > 0 ? "выше" : "ниже"} типичной цены.`;
}

export interface MarketBuyerMore {
  /** Есть ли ещё страница. */
  hasMore: boolean;
  loading: boolean;
  /** Прошлая попытка «Показать ещё» не удалась. */
  failed?: boolean;
  onMore: () => void;
}

/**
 * `data` — первая страница (подписи, строка рынка, total), `listings` — все загруженные страницы подряд.
 * Без `listings` показывается первая страница.
 */
export function MarketBuyerListingsView({
  data,
  listings = data.listings,
  more,
}: {
  data: MarketBuyerListingsResponse;
  listings?: MarketBuyerListing[];
  more?: MarketBuyerMore;
}) {
  if (data.status === "not_buyer" || data.status === "pending_acceptance") return null;
  return (
    <section className="card" aria-label="Объявления с площадок" data-testid="market-buyer-listings">
      <div className="sec-h stack">
        <h2>С площадок (Somon/Paydo)</h2>
      </div>
      <p className="sub">
        Чужие объявления с сайтов, не наши объекты. Цены в объявлениях — не цены сделок.
        {data.criteria.length > 0 ? ` Ищем: ${data.criteria.join(", ")}.` : ""}
        {data.freshDays > 0 ? ` Только то, что было на сайте за последние ${data.freshDays} ${daysWord(data.freshDays)}.` : ""}
      </p>
      {data.status === "ok" && data.clientDistrictMissing && (
        <p className="sub" data-testid="market-district-missing">Район в пожеланиях не указан, поэтому подбор по всему городу.</p>
      )}
      {data.ownersOnly?.enabled && data.ownersOnly.total > 0 && (
        <p className="sub" data-testid="market-owners-only">
          Показаны только собственники: {data.ownersOnly.kept} из {data.ownersOnly.total} объявлений.
        </p>
      )}
      {data.market && marketBuyerLineText(data.market) && (
        <p className="sub" style={{ marginTop: 10, fontWeight: 600 }} data-testid="market-buyer-line">{marketBuyerLineText(data.market)}</p>
      )}
      {data.status === "no_criteria" ? (
        <Rh2EmptyState
          icon={Search}
          title="Не из чего подбирать"
          hint="Укажите район или бюджет в пожеланиях покупателя — тогда здесь появятся объявления."
        />
      ) : listings.length === 0 ? (
        <Rh2EmptyState icon={Search} title="Сейчас на площадках нет подходящих объявлений" hint="Список обновляется по мере появления новых." />
      ) : (
        <>
          <div className="list">
            {listings.map((l) => (
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
                    {[marketSourceName(l.source), l.districtUnknown ? "район не указан" : l.districtName, `размещено ${dushanbeDate(l.publishedAt)}`]
                      .filter(Boolean)
                      .join(" · ")}
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
          {data.total > listings.length && (
            <p className="sub">Показаны лучшие {listings.length} из {data.total}{data.totalIsLowerBound ? "+" : ""}.</p>
          )}
          {more?.hasMore && (
            <button type="button" className="pill ghost" onClick={more.onMore} disabled={more.loading} data-testid="market-buyer-more">
              {more.loading ? "Загружаем…" : "Показать ещё"}
            </button>
          )}
          {more?.failed && !more.loading && <p className="sub" role="status">Не удалось загрузить ещё, нажмите кнопку ещё раз.</p>}
        </>
      )}
    </section>
  );
}

/** «суток» после числа: 1 сутки, 2–4 суток, 5+ суток — во всех случаях «суток», кроме 1 и 21, 31… */
function daysWord(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? "сутки" : "суток";
}

export function MarketBuyerListings({ clientId }: { clientId: string }) {
  const query = useMarketBuyerListings(clientId);
  const { isLoading, refetch, isFetching } = query;
  const pages = query.data?.pages ?? [];
  const data = pages[0];
  if (isLoading) {
    return (
      <section className="card" aria-busy="true" aria-label="Объявления с площадок">
        <div className="sec-h stack"><h2>С площадок (Somon/Paydo)</h2></div>
        <p role="status" className="sub">Ищем на площадках…</p>
      </section>
    );
  }
  // Сбой «Показать ещё» не прячет уже показанное: экран ошибки — только когда нет первой страницы.
  if (!data) {
    return (
      <section className="card" aria-label="Объявления с площадок">
        <div className="sec-h stack"><h2>С площадок (Somon/Paydo)</h2></div>
        <Rh2ErrorState message="Не удалось загрузить объявления с площадок." onRetry={() => void refetch()} retrying={isFetching} />
      </section>
    );
  }
  return (
    <MarketBuyerListingsView
      data={data}
      listings={pages.flatMap((p) => p.listings)}
      more={{ hasMore: !!query.hasNextPage, loading: query.isFetchingNextPage, failed: query.isFetchNextPageError, onMore: () => void query.fetchNextPage() }}
    />
  );
}
