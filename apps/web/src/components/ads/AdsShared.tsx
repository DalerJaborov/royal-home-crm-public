import { useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, ChevronDown } from "lucide-react";
import { useAdInsights, useRefreshAdInsights, type AdRow } from "../../hooks/useAds";
import type { MarketingFunnelChannel } from "../../hooks/useReports";
import { formatMoneyExact, pluralizeRu } from "../../lib/format";
import { scrollableRegion } from "../../lib/a11y";

/**
 * Общие куски экрана «Реклама» (`pages/Ads.tsx` — экран один на обе ширины,
 * узкую раскладку делают медиазапросы темы).
 *
 * Облик — тема «Royal Home 2026»: раскрывающийся разбор — `.acc`/`.acc-h`/`.acc-b`
 * эталона, чужая реклама — строки `.prow` с действием в `.act`.
 */
export type Tab = "ads" | "properties" | "unmatched" | "foreign";

/**
 * Разбор ИИ трат за месяц — сворачиваемая строка над списком объявлений (03.09.2026).
 *
 * Раньше он раскрывался сам и занимал пол-экрана над списком, ради которого сюда
 * и приходят; вдобавок каждое открытие раздела просило у модели свежий текст.
 * Теперь это строка, и запрос уходит только когда её раскрыли.
 */
export function AiDigest({ month }: { month: string | undefined }) {
  const [open, setOpen] = useState(false);
  const insights = useAdInsights(month ?? "", open && !!month);
  const refresh = useRefreshAdInsights();

  return (
    <div className="acc">
      <button className="acc-h" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Sparkles className="i" aria-hidden />
        <h3>Разбор ИИ: что делать с этими деньгами</h3>
        <ChevronDown className="i ch" aria-hidden />
      </button>

      {open && (
        <div className="acc-b">
          {insights.isLoading ? (
            <div className="state">
              <span className="sk w40" />
              <span className="sk w22" /> Смотрим на цифры
            </div>
          ) : insights.isError ? (
            <div className="state err">
              <span className="dot crit" />{" "}
              {insights.error instanceof Error ? insights.error.message : "Не удалось собрать разбор"}
            </div>
          ) : insights.data?.text ? (
            <>
              <p style={{ whiteSpace: "pre-line", paddingTop: "var(--s3)" }}>{insights.data.text}</p>
              <div className="acts" style={{ marginTop: "var(--s3)" }}>
                <button
                  className="pill ghost sm"
                  type="button"
                  onClick={() => month && refresh.mutate(month)}
                  disabled={refresh.isPending}
                >
                  {refresh.isPending ? "Пересобираем…" : "Пересобрать разбор"}
                </button>
              </div>
            </>
          ) : insights.data?.reason === "ai" ? (
            /* «Расходов не было» и «модель не ответила» — разные вещи, и до
               03.09.2026 экран писал на них одно и то же. */
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">
                Разбор не собрался: модель не ответила. Расходы при этом на месте — они в списке выше.
              </span>
              <button
                className="lnk"
                type="button"
                onClick={() => month && refresh.mutate(month)}
                disabled={refresh.isPending}
              >
                {refresh.isPending ? "Пробуем…" : "Попробовать снова"}
              </button>
            </div>
          ) : (
            <p className="state">Пока не из чего: за этот период расходов на рекламу не было.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Чужая реклама: строка и одно действие — вернуть объявление себе. */
export function ForeignList({
  rows,
  onReclaim,
  busy,
}: {
  rows: AdRow[];
  onReclaim: (id: string) => void;
  busy: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p>Чужой рекламы в кабинете нет.</p>
      </div>
    );
  }
  return (
    <div className="list" style={{ marginTop: 12 }}>
      {rows.map((ad) => (
        <div className="prow wrapt" key={ad.id}>
          <div className="t">
            <b>{ad.campaignName ?? ad.name}</b>
            <span>
              {formatMoneyExact(ad.spendOriginal, ad.currency)}
              {ad.postUrl && (
                <>
                  {" · "}
                  <a className="lk" href={ad.postUrl} target="_blank" rel="noreferrer">
                    публикация
                  </a>
                </>
              )}
            </span>
          </div>
          <div className="act">
            <button className="pill ghost sm" type="button" onClick={() => onReclaim(ad.id)} disabled={busy}>
              Это наше
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * «Откуда приходят клиенты» — источники за месяц (тот же отчёт воронки, что
 * строит `/sources`, здесь без урезания под свои шесть колонок эталона).
 * Деньги показываем, только если они пришли: у роли без `finance.view` сервер
 * отдаёт `spendMonthTjs: null` по каждому каналу — тогда денежные колонки не
 * рисуем вовсе, а не пишем нули.
 */
/** «2026-10» → «октябрь 2026»: подпись периода человеческими словами. */
function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const name = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)).toLocaleDateString("ru-RU", { month: "long", timeZone: "UTC" });
  return `${name} ${m[1]}`;
}

export function AdsSourcesTable({
  month,
  channels,
  compact = false,
}: {
  month: string;
  channels: MarketingFunnelChannel[];
  /**
   * Узкая правая колонка (13.10.2026): вместо таблицы и отдельных полос — строки
   * «канал — N клиентов · цена клиента / без затрат» и под каждой полоса доли.
   * Без пропа — полный вид, как был.
   */
  compact?: boolean;
}) {
  const withLeads = channels.filter((c) => c.leadsMonth > 0);
  if (withLeads.length === 0) {
    return null;
  }
  const seesMoney = withLeads.some((c) => c.spendMonthTjs != null);
  const maxLeads = Math.max(...withLeads.map((c) => c.leadsMonth));
  const paidWithCost = withLeads.filter((c) => c.spendMonthTjs != null && c.spendMonthTjs > 0 && c.costPerLeadTjs != null);
  const cheapest =
    paidWithCost.length > 1
      ? paidWithCost.reduce((a, b) => (b.costPerLeadTjs! < a.costPerLeadTjs! ? b : a))
      : null;

  if (compact) {
    return (
      <>
        <div className="sec-h">
          <h2>Откуда приходят клиенты</h2>
          <span className="note">за {monthLabel(month)}</span>
        </div>
        <div className="card adsx-src">
          {withLeads.map((c) => {
            const price = !seesMoney
              ? null
              : c.spendMonthTjs === 0
                ? "без затрат"
                : c.costPerLeadTjs != null
                  ? `цена клиента ${formatMoneyExact(c.costPerLeadTjs, "TJS")}`
                  : "цена клиента: нет данных";
            return (
              <div className="adsx-src-i" key={c.source}>
                <div className="adsx-src-h">
                  <Link className="lk" to={`/clients?source=${c.source}`}>
                    {c.label}
                  </Link>
                  <span className="adsx-src-v">
                    {c.leadsMonth} {pluralizeRu(c.leadsMonth, ["клиент", "клиента", "клиентов"])}
                    {price && <span className="adsx-dim"> · {price}</span>}
                  </span>
                </div>
                <div className="bar" aria-hidden>
                  <i style={{ width: `${maxLeads > 0 ? Math.max(3, Math.round((c.leadsMonth / maxLeads) * 100)) : 0}%` }} />
                </div>
              </div>
            );
          })}
          {!seesMoney && (
            <p className="state" style={{ paddingBottom: 0 }}>
              Нет данных: у вашей роли нет доступа к суммам расхода — видны только клиенты.
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="sec-h">
        <h2>Откуда приходят клиенты</h2>
        <span className="note">за {monthLabel(month)}{seesMoney ? ", деньги в сомони" : ""}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap only-wide" {...scrollableRegion("Источники клиентов")}>
          <table className="tbl">
            <caption className="vh">
              Источники клиентов: сколько пришло, сколько сделок, сколько стоил один клиент
            </caption>
            <thead>
              <tr>
                <th scope="col">Источник</th>
                <th scope="col" className="num">Клиентов</th>
                <th scope="col" className="num">Сделок</th>
                {seesMoney && <th scope="col" className="num">Потрачено</th>}
                {seesMoney && <th scope="col" className="num">Цена клиента</th>}
                {seesMoney && <th scope="col" className="num">Сомони за сделку</th>}
              </tr>
            </thead>
            <tbody>
              {withLeads.map((c) => {
                const perDeal =
                  c.dealsClosedMonth > 0 && c.spendMonthTjs != null ? c.spendMonthTjs / c.dealsClosedMonth : null;
                const pricier =
                  cheapest && c.source !== cheapest.source && c.costPerLeadTjs != null
                    ? c.costPerLeadTjs / cheapest.costPerLeadTjs! >= 1.4
                    : false;
                return (
                  <tr key={c.source}>
                    <td>
                      <Link className="lk" to={`/clients?source=${c.source}`}>
                        {c.label}
                      </Link>
                    </td>
                    <td className="num">{c.leadsMonth}</td>
                    <td className="num">{c.dealsClosedMonth}</td>
                    {seesMoney && (
                      <td className="num">
                        {c.spendMonthTjs != null ? formatMoneyExact(c.spendMonthTjs, "TJS") : "нет данных"}
                      </td>
                    )}
                    {seesMoney && (
                      <td className="num">
                        {c.spendMonthTjs === 0
                          ? "без затрат"
                          : c.costPerLeadTjs != null
                            ? formatMoneyExact(c.costPerLeadTjs, "TJS")
                            : "нет данных"}
                        {pricier && (
                          <span className="chip mute" style={{ marginLeft: 6 }}>
                            в {(c.costPerLeadTjs! / cheapest!.costPerLeadTjs!).toFixed(1)} раза дороже {cheapest!.label}
                          </span>
                        )}
                      </td>
                    )}
                    {seesMoney && (
                      <td className="num" style={c.dealsClosedMonth === 0 ? { color: "var(--crit)" } : undefined}>
                        {perDeal != null
                          ? formatMoneyExact(perDeal, "TJS")
                          : c.dealsClosedMonth === 0
                            ? "сделок нет"
                            : "нет данных"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="list only-narrow">
          {withLeads.map((c) => (
            <div className="prow" key={c.source}>
              <div className="t">
                <b>
                  <Link className="lk" to={`/clients?source=${c.source}`}>
                    {c.label}
                  </Link>
                </b>
                <span>
                  {c.leadsMonth} {pluralizeRu(c.leadsMonth, ["клиент", "клиента", "клиентов"])},{" "}
                  {c.dealsClosedMonth > 0
                    ? `${c.dealsClosedMonth} ${pluralizeRu(c.dealsClosedMonth, ["сделка", "сделки", "сделок"])}`
                    : "сделок нет"}
                </span>
              </div>
              {seesMoney && (
                <span className="pr">
                  {c.spendMonthTjs === 0 ? (
                    <>
                      без затрат
                      <small>денег не тратим</small>
                    </>
                  ) : c.costPerLeadTjs != null ? (
                    <>
                      {formatMoneyExact(c.costPerLeadTjs, "TJS")}
                      <small>цена клиента</small>
                    </>
                  ) : (
                    "нет данных"
                  )}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="sec-t">Сколько людей приносит каждый канал</div>
        <div className="bars">
          {withLeads.map((c) => (
            <div className="b" key={c.source}>
              <span className="nm3">{c.label}</span>
              <span className="tr">
                <i style={{ "--v": maxLeads > 0 ? c.leadsMonth / maxLeads : 0 } as React.CSSProperties} />
              </span>
              <span className="vl">{c.leadsMonth}</span>
            </div>
          ))}
        </div>
        {!seesMoney && (
          <p className="state" style={{ paddingBottom: 0 }}>
            Нет данных: у вашей роли нет доступа к суммам расхода — видны только клиенты и сделки.
          </p>
        )}
      </div>
    </>
  );
}
