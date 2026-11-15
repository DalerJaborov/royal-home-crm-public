import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { formatPropertyCode, type MarketOverpricedResponse } from "@royal-home/shared";
import { useMarketOverpriced } from "../hooks/useMarket";
import { formatArea, formatMoney } from "../lib/format";
import { Rh2EmptyState } from "./rh2/Rh2EmptyState";
import { Rh2ErrorState } from "./rh2/Rh2ErrorState";

/**
 * «Наши объекты дороже рынка» (14.11.2026): квартиры в продаже, которые просят больше, чем в среднем просят
 * на Somon и Paydo в том же районе, с теми же комнатами (и ремонтом, если он известен и объявлений хватает).
 * Для директора и маркетолога: повод поговорить с собственником о цене. Все числа и отбор считает сервер
 * (GET /market/overpriced, lib/market/overpriced.ts); здесь только показ. Один адаптивный узел на ПК и телефон.
 * Честно о точности: это быстрая прикидка по сегменту, точный разбор по площади и этажу открывает карточка объекта.
 */

/** Сколько строк видно до «Показать ещё». */
const PAGE = 10;

export function MarketOverpricedView({ data, shown = PAGE, onMore }: { data: MarketOverpricedResponse; shown?: number; onMore?: () => void }) {
  const visible = data.items.slice(0, shown);
  return (
    <section className="card" aria-label="Наши объекты дороже рынка" data-testid="market-overpriced">
      <div className="sec-h stack">
        <h2>Наши объекты дороже рынка</h2>
      </div>
      <p className="sub">
        Квартиры в продаже, которые просят больше чем на {data.thresholdPercent}% выше типичной цены объявлений в том же районе и с теми
        же комнатами. Это прикидка: точный разбор по площади и этажу в карточке объекта. Цены в объявлениях не цены сделок.
      </p>
      {data.items.length === 0 ? (
        <Rh2EmptyState
          icon={CheckCircle2}
          title="Сейчас таких объектов нет"
          hint={
            data.checked === 0
              ? "В продаже нет квартир с ценой и площадью для сравнения."
              : `Сравнили ${data.checked - data.withoutData} из ${data.checked} объектов; у остальных на рынке меньше ${data.minSample} похожих объявлений, числа не показываем.`
          }
        />
      ) : (
        <>
          <div className="list">
            {visible.map((i) => (
              <div className="row wrapt" key={i.propertyId} data-testid="market-overpriced-row">
                <div className="t">
                  <b>
                    <Link to={`/properties/${i.shortId}`} aria-label={`${formatPropertyCode(i.shortId)}: открыть объект`}>
                      {formatPropertyCode(i.shortId)} · {i.title}
                    </Link>
                  </b>
                  <span>
                    {i.districtName} · {i.rooms} комн. · {formatArea(i.areaSqm)} м² · по {i.sampleSize} объявл.
                  </span>
                </div>
                <span className="chip warn">+{i.diffPercent}%</span>
                <span className="meta">
                  <b>{formatMoney(i.askingPriceTjs, "TJS")}</b>
                  <small> · рынок около {formatMoney(i.estimatedPriceTjs, "TJS")}</small>
                </span>
              </div>
            ))}
          </div>
          {visible.length < data.items.length && onMore && (
            <button type="button" className="pill ghost" onClick={onMore}>
              Показать ещё · {data.items.length - visible.length}
            </button>
          )}
        </>
      )}
      {data.truncated && <p className="sub">Объектов больше предела выборки: проверены самые свежие.</p>}
    </section>
  );
}

export function MarketOverpriced() {
  const { data, isLoading, isError, refetch, isFetching } = useMarketOverpriced();
  const [shown, setShown] = useState(PAGE);
  if (isLoading) {
    return (
      <section className="card" aria-busy="true" aria-label="Наши объекты дороже рынка">
        <div className="sec-h stack"><h2>Наши объекты дороже рынка</h2></div>
        <p role="status" className="sub">Сравниваем наши цены с рынком…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section className="card" aria-label="Наши объекты дороже рынка">
        <div className="sec-h stack"><h2>Наши объекты дороже рынка</h2></div>
        <Rh2ErrorState message="Не удалось загрузить список." onRetry={() => void refetch()} retrying={isFetching} />
      </section>
    );
  }
  return <MarketOverpricedView data={data} shown={shown} onMore={() => setShown((n) => n + PAGE)} />;
}
