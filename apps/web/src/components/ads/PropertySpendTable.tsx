import type { UseQueryResult } from "@tanstack/react-query";
import { ExternalLink, Image as ImageIcon } from "lucide-react";
import { Link } from "react-router-dom";
import type { AdSpendPropertyRow, AdSpendReport } from "../../hooks/useAds";
import { formatMoneyExact } from "../../lib/format";
import { scrollableRegion } from "../../lib/a11y";

/**
 * СКОЛЬКО ВЛОЖЕНО В КАЖДЫЙ ОБЪЕКТ.
 *
 * Четыре колонки вместо шести: объект, деньги, обращения с их ценой, показы.
 * Ушли «кампания» (у бустов Instagram там у всех одинаковое «Публикация:
 * "Продаётся квартира"») и «комментарии» — по ним никто не принимал решений, а
 * ширину строки они съедали, выдавливая цену обращения за край экрана.
 *
 * Суммы — до дирама: сервер считает их целыми сотыми, итог равен сумме колонки
 * ровно, а не «примерно» (api: lib/money.ts).
 *
 * ОБЛИК — тема «Royal Home 2026», эталон `screens/ads.html`: широкий экран —
 * таблица `.tbl` в `.tbl-wrap.only-wide`, узкий — те же данные строками `.prow`
 * в `.only-narrow` (ровно тот приём, которым эталон раскладывает таблицы).
 */
export function PropertySpendTable({ query }: { query: UseQueryResult<AdSpendReport> }) {
  const { data, isLoading, isError, error, refetch } = query;

  if (isLoading) {
    return (
      <div className="state">
        <span className="sk w40" />
        <span className="sk w22" /> Загружаем расходы по объектам
      </div>
    );
  }
  /* report.isError раньше не проверялся — строки тихо становились []-заглушкой,
     и «расходов нет» выглядело так же, как настоящий пустой месяц (аудит
     22.08.2026). */
  if (isError) {
    return (
      <div className="state err">
        <span className="dot crit" />{" "}
        {error instanceof Error ? error.message : "Не удалось загрузить расходы по объектам"}{" "}
        <button
          className="lk"
          type="button"
          style={{ color: "inherit", textDecoration: "underline" }}
          onClick={() => refetch()}
        >
          Повторить
        </button>
      </div>
    );
  }
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p>За этот период расходов на рекламу нет.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="tbl-wrap only-wide" {...scrollableRegion("Расходы на рекламу по объектам")}>
        <table className="tbl">
          <caption className="vh">Расходы на рекламу по объектам: деньги, обращения и показы</caption>
          <thead>
            <tr>
              <th scope="col">Объект</th>
              <th scope="col" className="num">
                Потрачено
              </th>
              <th scope="col" className="num">
                Обращений
              </th>
              <th scope="col" className="num">
                Показов
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <SpendTableRow key={row.property?.id ?? "unmatched"} row={row} />
            ))}
            {/* ИТОГ ПОД КОЛОНКОЙ. Он равен сумме строк копейка в копейку — раньше
                строки округлялись до сомони каждая, а итог считался отдельно, и
                столбец не сходился с числом под ним. */}
            {data && (
              <tr>
                <td>
                  <b>Итого за период</b>
                </td>
                <td className="num">
                  <b>{formatMoneyExact(data.totals.spendTjs, "TJS")}</b>
                </td>
                <td className="num">
                  <b>{data.totals.conversations}</b>
                </td>
                <td className="num">{data.totals.impressions.toLocaleString("ru-RU")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="list only-narrow">
        {rows.map((row) => (
          <SpendCardRow key={row.property?.id ?? "unmatched"} row={row} />
        ))}
        {data && (
          <div className="prow">
            <div className="t">
              <b>Итого за период</b>
              <span>
                {data.totals.conversations} обращений · {data.totals.impressions.toLocaleString("ru-RU")} показов
              </span>
            </div>
            <span className="pr">{formatMoneyExact(data.totals.spendTjs, "TJS")}</span>
          </div>
        )}
      </div>

      {data?.totals.spendOriginal != null && data.totals.currency && (
        <p className="state">
          В кабинете это {formatMoneyExact(data.totals.spendOriginal, data.totals.currency)} — по этой сумме
          отчёт сверяется с Ads Manager.
        </p>
      )}

      {data?.truncated && <p className="state">Показаны не все объявления периода — их больше тысячи.</p>}
    </div>
  );
}

/** Название объекта — одно на таблицу и на узкий список. */
function SpendSubject({ row }: { row: AdSpendPropertyRow }) {
  const property = row.property;
  if (!property) return <>Без объекта</>;
  return (
    <Link className="lk" to={`/properties/${property.shortId}`}>
      №{property.shortId} · {property.title}
    </Link>
  );
}

function SpendDetails({ row }: { row: AdSpendPropertyRow }) {
  const property = row.property;
  return (
    <>
      {row.adsCount} объявл.
      {/* Общее объявление делит деньги между объектами: сумма в строке — доля
          этого объекта, а не весь расход объявления. */}
      {row.sharedAdsCount ? ` (из них общих: ${row.sharedAdsCount}, деньги — доля объекта)` : ""}
      {/* Прибыль показываем только у проданных: до денег на руках это
          не прибыль, а гадание (см. api: adSpendReport.enrichRows). */}
      {row.profitTjs != null && (
        <>
          {" · "}
          <b style={{ color: row.profitTjs >= 0 ? "var(--ok)" : "var(--crit)" }}>
            {row.profitTjs >= 0 ? "прибыль" : "убыток"} {formatMoneyExact(Math.abs(row.profitTjs), "TJS")}
          </b>
        </>
      )}
      {property?.instagramUrl && (
        <>
          {" · "}
          <a className="lk" href={property.instagramUrl} target="_blank" rel="noreferrer">
            пост <ExternalLink className="i" aria-hidden />
          </a>
        </>
      )}
    </>
  );
}

function SpendTableRow({ row }: { row: AdSpendPropertyRow }) {
  const perConversation = row.conversations > 0 ? row.spendTjs / row.conversations : null;
  return (
    <tr>
      <td>
        <SpendSubject row={row} />
        <span className="hint" style={{ display: "block", fontSize: "var(--fs-12)", color: "var(--faint)" }}>
          <SpendDetails row={row} />
        </span>
      </td>
      <td className="num">
        {formatMoneyExact(row.spendTjs, "TJS")}
        {row.spendOriginal != null && row.currency === "USD" && (
          <span style={{ display: "block", fontSize: "var(--fs-12)", color: "var(--faint)" }}>
            {formatMoneyExact(row.spendOriginal, "USD")}
          </span>
        )}
      </td>
      <td className="num">
        {row.conversations}
        <span style={{ display: "block", fontSize: "var(--fs-12)", color: "var(--faint)" }}>
          {perConversation !== null ? `по ${formatMoneyExact(perConversation, "TJS")}` : "обращений нет"}
        </span>
      </td>
      <td className="num">{row.impressions.toLocaleString("ru-RU")}</td>
    </tr>
  );
}

function SpendCardRow({ row }: { row: AdSpendPropertyRow }) {
  const property = row.property;
  const cover = property?.coverUrl ?? row.thumbnailUrl ?? null;
  const perConversation = row.conversations > 0 ? row.spendTjs / row.conversations : null;
  return (
    <div className="prow wrapt">
      <span className="ph" aria-hidden>
        {cover ? <img src={cover} alt="" loading="lazy" /> : <ImageIcon className="i" />}
      </span>
      <div className="t">
        <b>
          <SpendSubject row={row} />
        </b>
        <span>
          <SpendDetails row={row} /> · {row.conversations} обращ.
          {perConversation !== null ? ` · по ${formatMoneyExact(perConversation, "TJS")}` : ""} ·{" "}
          {row.impressions.toLocaleString("ru-RU")} показов
        </span>
      </div>
      <span className="pr">
        {formatMoneyExact(row.spendTjs, "TJS")}
        {row.spendOriginal != null && row.currency === "USD" && (
          <small>{formatMoneyExact(row.spendOriginal, "USD")}</small>
        )}
      </span>
    </div>
  );
}
