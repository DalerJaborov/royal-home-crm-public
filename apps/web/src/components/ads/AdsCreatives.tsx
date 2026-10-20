import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { AdCreativeRow, AdCreativesResponse } from "@royal-home/shared";
import { ExternalLink, Image as ImageIcon } from "lucide-react";
import { DELIVERY } from "../../lib/adsView";
import { costOrNone, describeLowData, groupCreatives } from "../../lib/adsCreativesPacingView";
import { formatMoneyExact, pluralizeRu } from "../../lib/format";
import { scrollableRegion } from "../../lib/a11y";

/**
 * КРЕАТИВЫ: ЧТО РАБОТАЕТ (03.10.2026, `GET /ads/creatives`; плотный вид — 13.10.2026).
 *
 * Одна таблица `.tbl` вместо сетки больших карточек и сегмент «Лучшие / Хуже всего /
 * Мало данных / Все» над ней: директору нужно сравнить объявления столбиками, а не
 * листать картинки. Колонки: №, креатив (заголовок + объект и состояние), расход,
 * обращения (число · цена), клиенты, цена клиента (жирно), оценка. Реклама самого
 * агентства лежит отдельной строкой и места в рейтинге не занимает.
 *
 * Миниатюр больше нет: ссылки Meta протухают, а смысл строки всегда держится на
 * тексте. Оценка — слово в чипе, а не только цвет. На телефоне (< 640 px) таблица
 * заменена списком `.list` + `.row` (`only-wide`/`only-narrow`, как в `AdsSourcesTable`).
 * Шрифты — токены темы, не мельче 13 px.
 */

/** Сколько строк видно до нажатия «Показать все». */
const PREVIEW = 10;

type SegKey = "best" | "worst" | "lowData" | "all";
type Thresholds = { minSpendTjs: number; minImpressions: number };
type Verdict = { label: string; tone: "ok" | "mute" | "crit" };

/** Оценка строки словом: «деньги впустую» — клиентов нет при расходе, остальное по метке сервера. */
function verdictOf(row: AdCreativeRow): Verdict {
  switch (row.mark) {
    case "best":
      return { label: row.rankPosition === 1 ? "лучше всех" : "хорошо", tone: "ok" };
    case "worst":
      return { label: row.leads === 0 && row.spendTjs > 0 ? "деньги впустую" : "дорого", tone: "crit" };
    case "lowData":
      return { label: "мало данных", tone: "mute" };
    default:
      return { label: "средне", tone: "mute" };
  }
}

/** «общее · 4 объекта» / «1 объект» / «без объекта» + состояние («идёт»). */
function subOf(row: AdCreativeRow): string {
  const objects =
    row.objectsCount > 1
      ? `общее · ${row.objectsCount} ${pluralizeRu(row.objectsCount, ["объект", "объекта", "объектов"])}`
      : row.objectsCount === 1
        ? "1 объект"
        : "без объекта";
  return `${objects} · ${DELIVERY[row.delivery].label.toLowerCase()}`;
}

export function AdsCreatives({ query }: { query: UseQueryResult<AdCreativesResponse> }) {
  const { data, isLoading, isError, error, refetch } = query;
  const [picked, setPicked] = useState<SegKey | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (isLoading) {
    return (
      <div className="state" role="status">
        <span className="sk w40" />
        <span className="sk w22" /> Считаем, какие креативы работают
      </div>
    );
  }
  if (isError) {
    return (
      <div className="state err" role="alert">
        <span className="dot crit" /> {error instanceof Error ? error.message : "Рейтинг креативов не загрузился"} —
        это не значит, что объявлений нет.{" "}
        <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => void refetch()}>
          Повторить
        </button>
      </div>
    );
  }
  if (!data || (data.rows.length === 0 && data.brand.length === 0)) {
    return (
      <div className="empty">
        <span className="ic">
          <ImageIcon className="i" aria-hidden />
        </span>
        <p>За этот период платных объявлений с расходом нет.</p>
        <span className="sub">Мало данных для рейтинга: выберите период длиннее или дождитесь расхода.</span>
      </div>
    );
  }

  const { best, worst, rest } = groupCreatives(data.rows);
  const lowData = rest.filter((r) => r.mark === "lowData");
  const noRanks = data.rankedBy === "none";
  const segs: { key: SegKey; label: string; rows: AdCreativeRow[] }[] = [
    { key: "best", label: "Лучшие", rows: best },
    { key: "worst", label: "Хуже всего", rows: worst },
    { key: "lowData", label: "Мало данных", rows: lowData },
    { key: "all", label: "Все", rows: data.rows },
  ];
  // По умолчанию — лучшие; лучших нет (мало данных для рейтинга) — все, а не пустая таблица.
  const active: SegKey = picked ?? (best.length > 0 ? "best" : "all");
  const current = segs.find((x) => x.key === active) ?? segs[3]!;
  const shown = showAll ? current.rows : current.rows.slice(0, PREVIEW);

  return (
    <div>
      {/* Чем ранжировали — всегда видимой строкой: цифры без основания читать нельзя. */}
      <div className="quiet" style={{ marginBottom: 12 }}>
        <span className={noRanks ? "dot warn" : "dot ok"} aria-hidden />
        <span className="txt">{data.rankedByNote}</span>
      </div>

      {data.rows.length === 0 ? (
        <div className="empty">
          <p>Мало данных для рейтинга.</p>
        </div>
      ) : (
        <>
          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Какие креативы показывать">
              {segs.map((x) => (
                <button
                  key={x.key}
                  type="button"
                  role="tab"
                  aria-selected={active === x.key}
                  onClick={() => {
                    setPicked(x.key);
                    setShowAll(false);
                  }}
                >
                  {x.label} <span className="n">{x.rows.length}</span>
                </button>
              ))}
            </div>
          </div>

          {current.rows.length === 0 ? (
            <p className="state">В этой группе объявлений нет.</p>
          ) : (
            <>
              <div className="tbl-wrap only-wide adsx-cr" {...scrollableRegion("Креативы: что работает")}>
                <table className="tbl">
                  <caption className="vh">
                    Креативы: расход, обращения, клиенты, цена клиента и оценка по каждому объявлению
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className="num">№</th>
                      <th scope="col">Креатив</th>
                      <th scope="col" className="num">Расход</th>
                      <th scope="col" className="num">Обращений</th>
                      <th scope="col" className="num">Клиентов</th>
                      <th scope="col" className="num">Цена клиента</th>
                      <th scope="col">Оценка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row, i) => (
                      <CreativeTr key={row.adId} row={row} n={i + 1} thresholds={data.thresholds} />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="list only-narrow adsx-cr-list">
                {shown.map((row, i) => (
                  <CreativeRow key={row.adId} row={row} n={i + 1} thresholds={data.thresholds} />
                ))}
              </div>

              {current.rows.length > PREVIEW && (
                <button
                  className="pill ghost sm"
                  type="button"
                  style={{ marginTop: 12 }}
                  aria-expanded={showAll}
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? "Свернуть" : `Показать все (${current.rows.length})`}
                </button>
              )}
            </>
          )}
        </>
      )}

      {data.brand.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="quiet">
            <span className="dot" aria-hidden />
            <span className="txt">
              <b>Реклама самого агентства</b> — в рейтинг не входит (у неё нет квартиры, которую она продаёт):{" "}
              {data.brand
                .slice(0, 5)
                .map((b) => `${b.title} — ${formatMoneyExact(b.spendTjs, "TJS")}`)
                .join(" · ")}
              {data.brand.length > 5 ? ` · и ещё ${data.brand.length - 5}` : ""}
            </span>
          </div>
        </div>
      )}

      {data.foreignCount > 0 && (
        <p className="state" style={{ paddingBottom: 0 }}>
          Чужая реклама из общего кабинета ({data.foreignCount}) в рейтинге и расходе не участвует.
        </p>
      )}
      {data.truncated && <p className="state">Показаны объявления с наибольшим расходом — остальные слишком малы для рейтинга.</p>}
      {data.leadsTruncated && (
        <p className="state">Клиентов с рекламы за период больше предела выборки — цена клиента посчитана по неполному набору.</p>
      )}
    </div>
  );
}

function PostLink({ url }: { url: string }) {
  return (
    <a className="lk" href={url} target="_blank" rel="noreferrer">
      Пост <ExternalLink className="i" aria-hidden />
    </a>
  );
}

/** «12 · 40,00 с.» или «0 · цены нет». Это обращения Meta, не клиенты CRM. */
function conversationsText(row: AdCreativeRow): string {
  return `${row.conversations} · ${costOrNone(row.costPerConversationTjs, "цены нет").text}`;
}

function CreativeTr({ row, n, thresholds }: { row: AdCreativeRow; n: number; thresholds: Thresholds }) {
  const v = verdictOf(row);
  const perLead = costOrNone(row.costPerLeadTjs, "клиентов нет");
  return (
    <tr>
      <td className="num adsx-dim">{n}</td>
      <td>
        <div className="adsx-cr-t">
          <b>{row.title}</b>
          <span>
            {subOf(row)}
            {row.mark === "lowData" && ` · ${describeLowData(row.lowDataReason, thresholds)}`}
            {row.postUrl && (
              <>
                {" · "}
                <PostLink url={row.postUrl} />
              </>
            )}
          </span>
        </div>
      </td>
      <td className="num">{formatMoneyExact(row.spendTjs, "TJS")}</td>
      <td className="num">{conversationsText(row)}</td>
      <td className="num">{row.leads}</td>
      <td className={perLead.none ? "num adsx-dim" : "num adsx-strong"}>{perLead.text}</td>
      <td>
        <span className={`chip ${v.tone}`}>{v.label}</span>
      </td>
    </tr>
  );
}

function CreativeRow({ row, n, thresholds }: { row: AdCreativeRow; n: number; thresholds: Thresholds }) {
  const v = verdictOf(row);
  const perLead = costOrNone(row.costPerLeadTjs, "клиентов нет");
  return (
    <div className="row">
      <div className="t">
        <b>
          {n}. {row.title}
        </b>
        <span>
          {subOf(row)}
          {row.mark === "lowData" && ` · ${describeLowData(row.lowDataReason, thresholds)}`}
        </span>
        <span>
          расход {formatMoneyExact(row.spendTjs, "TJS")} · обращений {conversationsText(row)}
        </span>
        <span>
          клиентов {row.leads} · цена клиента{" "}
          <strong className={perLead.none ? "adsx-dim" : "adsx-strong"}>{perLead.text}</strong>
          {row.postUrl && (
            <>
              {" · "}
              <PostLink url={row.postUrl} />
            </>
          )}
        </span>
      </div>
      <div className="act">
        <span className={`chip ${v.tone}`}>{v.label}</span>
      </div>
    </div>
  );
}
