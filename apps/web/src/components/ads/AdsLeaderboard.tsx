import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { AdLeaderboardItem } from "../../hooks/useAds";
import { pickLeaderboard } from "../../lib/adsView";
import { formatMoneyExact } from "../../lib/format";

/**
 * РЕЙТИНГ ОБЪЕКТОВ ПО ЦЕНЕ ОБРАЩЕНИЯ (03.10.2026, `GET /ads/leaderboard`).
 *
 * Компактный список в один столбец (13.10.2026): сверху — где обращения дешёвые
 * (зелёная цена), ниже — где деньги ушли, а результата мало (жёлтая цена; красная,
 * если обращений нет вовсе). До шести строк в каждой группе; фото убраны. Клик по
 * строке — карточка объекта. Выбор строк — `pickLeaderboard` (lib/adsView.ts, с
 * тестом): объект без обращений получает подпись «обращений нет», а не цену
 * «0 сомони», и в «дешёвые» не попадает.
 */
const MAX_ROWS = 6;

export function AdsLeaderboard({ query }: { query: UseQueryResult<AdLeaderboardItem[]> }) {
  const { data, isLoading, isError, error, refetch } = query;
  const { cheap, costly } = useMemo(() => pickLeaderboard(data ?? [], MAX_ROWS), [data]);

  if (isLoading) {
    return (
      <div className="state">
        <span className="sk w40" />
        <span className="sk w22" /> Считаем рейтинг объектов
      </div>
    );
  }
  if (isError) {
    return (
      <div className="state err">
        <span className="dot crit" /> {error instanceof Error ? error.message : "Рейтинг не загрузился"} — это не
        значит, что объектов нет.{" "}
        <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => void refetch()}>
          Повторить
        </button>
      </div>
    );
  }
  if ((data ?? []).length === 0) {
    return (
      <div className="empty">
        <p>За этот период по объектам рекламы нет.</p>
      </div>
    );
  }

  return (
    <div className="adsx-lb">
      <Column title="Дешёвые обращения" tone="ok" empty="Пока ни у одного объекта нет обращений." rows={cheap.slice(0, MAX_ROWS)} />
      <Column title="Дорого стоит, мало результата" tone="warn" empty="Таких объектов нет." rows={costly.slice(0, MAX_ROWS)} />
    </div>
  );
}

type Tone = "ok" | "warn";

function Column({
  title,
  tone,
  empty,
  rows,
}: {
  title: string;
  tone: Tone;
  empty: string;
  rows: AdLeaderboardItem[];
}) {
  return (
    <section aria-label={title}>
      <div className="quiet" style={{ marginBottom: 4 }}>
        <span className={`dot ${tone}`} aria-hidden />
        <span className="txt">
          <b>{title}</b>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="state">{empty}</p>
      ) : (
        <ol className="list adsx-lb-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((r) => {
            const none = r.conversations === 0 || r.costPerConversationTjs == null;
            // Зелёный — дёшево; жёлтый — дорого, но обращения есть; красный — деньги ушли, обращений нет.
            const color = none ? "crit" : tone;
            return (
              <li key={r.propertyId}>
                <Link className="row adsx-lb-row" to={`/properties/${r.shortId}`}>
                  <div className="t">
                    <b>
                      №{r.shortId}
                      {r.title ? ` · ${r.title}` : ""}
                    </b>
                    <span>
                      потрачено {formatMoneyExact(r.spendTjs, "TJS")} · обращений {r.conversations}
                    </span>
                  </div>
                  <span className={`adsx-lb-price ${color}`}>
                    {none ? "обращений нет" : formatMoneyExact(r.costPerConversationTjs ?? 0, "TJS")}
                    {!none && <small>за обращение</small>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
