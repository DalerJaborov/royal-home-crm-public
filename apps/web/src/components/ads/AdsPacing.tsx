import type { UseQueryResult } from "@tanstack/react-query";
import type { AdPacingAccount, AdPacingResponse } from "@royal-home/shared";
import { Gauge } from "lucide-react";
import {
  buildMonthBars,
  dayShort,
  describeForecast,
  describeRatio,
} from "../../lib/adsCreativesPacingView";
import { formatMoneyExact } from "../../lib/format";

/**
 * ТЕМП РАСХОДА (03.10.2026, `GET /ads/pacing`): сколько потрачено сегодня против
 * обычного дня, прогноз на месяц и долг.
 *
 * ТРИ ЧИСЛА: сегодня / обычный день (среднее последних 7 полных дней) / прогноз на
 * месяц с вилкой «от–до» — одна цифра выдавала бы точность, которой у прогноза нет. Под
 * ними — мини-график расхода по дням месяца (SVG без библиотек), строка долга и карты
 * и красные флаги. Мало данных — «нет данных», а не выдуманное число.
 *
 * ЧАСОВОЙ ПОЯС: «сегодня» и месяц считаются по Душанбе, а Meta режет сутки по поясу
 * кабинета — подпись `timezoneNote` стоит на экране всегда, не в подсказке (на телефоне
 * `title` не виден).
 *
 * ОБЛИК — `.sec-h`, `.card`, `.quiet`, `.state`; один адаптивный файл. Числа — сетка
 * `auto-fit` с `min(100%, …)`: на 320 px они встают в столбик, горизонтального скролла нет.
 * Столбики графика растягиваются на ширину (`preserveAspectRatio="none"`), подписи —
 * обычным HTML-текстом под ним, так что шрифт не масштабируется вместе с SVG.
 */
export function AdsPacing({ query }: { query: UseQueryResult<AdPacingResponse> }) {
  const { data, isLoading, isError, error, refetch } = query;

  if (isLoading && !data) {
    return (
      <div className="state" role="status">
        <span className="sk w40" />
        <span className="sk w22" /> Считаем темп расхода
      </div>
    );
  }
  if (isError && !data) {
    return (
      <div className="state err" role="alert">
        <span className="dot crit" /> {error instanceof Error ? error.message : "Темп расхода не загрузился"} — это
        не значит, что расхода нет.{" "}
        <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => void refetch()}>
          Повторить
        </button>
      </div>
    );
  }
  if (!data) return null;
  if (!data.enabled && data.monthSpentTjs === 0 && data.series.every((p) => p.spendTjs === 0)) {
    return (
      <div className="empty">
        <span className="ic">
          <Gauge className="i" aria-hidden />
        </span>
        <p>Рекламный кабинет не подключён — темпа расхода нет.</p>
      </div>
    );
  }

  const forecast = describeForecast(data.forecastState, data.forecast);
  const ratio = describeRatio(data.ratioToUsual);
  const bars = buildMonthBars(data.series, data.usualDayTjs);
  const hasSpend = data.series.some((p) => p.spendTjs > 0);
  const first = data.series[0];
  const last = data.series[data.series.length - 1];

  return (
    <div>
      {data.flags.map((f, i) => (
        <div className="quiet crit" role="alert" key={`${f.kind}-${i}`} style={{ marginBottom: 8 }}>
          <span className="dot crit" aria-hidden />
          <span className="txt">{f.text}</span>
        </div>
      ))}

      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))",
          gap: "var(--s4)",
        }}
      >
        <Big
          label={`Сегодня (${dayShort(data.today)})`}
          value={formatMoneyExact(data.todayTjs, "TJS")}
          sub={ratio ? `${ratio}` : "обычного дня пока нет"}
        />
        <Big
          label="Обычный день"
          value={formatMoneyExact(data.usualDayTjs, "TJS")}
          sub={`среднее за 7 полных дней, данные есть за ${data.baselineDaysWithData} из 7`}
        />
        <Big
          label="Прогноз на месяц"
          value={forecast.headline}
          sub={forecast.range ?? forecast.note ?? undefined}
          extra={forecast.range ? forecast.note : null}
        />
      </dl>

      <p style={{ margin: "12px 0 0", fontSize: "var(--fs-14)", color: "var(--muted)" }}>
        В этом месяце потрачено <b style={{ color: "var(--ink)" }}>{formatMoneyExact(data.monthSpentTjs, "TJS")}</b>, день{" "}
        {data.dayOfMonth} из {data.daysInMonth}.
      </p>

      {hasSpend ? (
        <figure style={{ margin: "12px 0 0" }}>
          <svg
            viewBox={`0 0 ${bars.width} ${bars.height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Расход по дням месяца: с ${dayShort(first.date)} по ${dayShort(last.date)}, всего ${formatMoneyExact(
              data.monthSpentTjs,
              "TJS"
            )}; самый дорогой день ${formatMoneyExact(bars.max, "TJS")}. Пунктир — обычный день ${formatMoneyExact(data.usualDayTjs, "TJS")}.`}
            style={{ display: "block", width: "100%", height: 96 }}
          >
            {bars.bars.map((b) => (
              <rect
                key={b.date}
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={1}
                fill={b.flag === "high" ? "var(--crit)" : b.flag === "today" ? "var(--pill)" : "var(--faint)"}
              >
                <title>{`${dayShort(b.date)}: ${formatMoneyExact(b.value, "TJS")}`}</title>
              </rect>
            ))}
            {bars.usualY != null && (
              <line
                x1={0}
                x2={bars.width}
                y1={bars.usualY}
                y2={bars.usualY}
                stroke="var(--muted)"
                strokeWidth={1.5}
                strokeDasharray="5 4"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          <figcaption
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 4,
              fontSize: "var(--fs-13)",
              color: "var(--muted)",
            }}
          >
            <span>{dayShort(first.date)}</span>
            <span>{dayShort(last.date)}</span>
          </figcaption>
          <p style={{ margin: "4px 0 0", fontSize: "var(--fs-13)", color: "var(--muted)" }}>
            Пунктир — обычный день, тёмный столбик — сегодня, красный — день вдвое выше обычного.
          </p>
        </figure>
      ) : (
        <p className="state">В этом месяце расхода пока нет.</p>
      )}

      <Accounts accounts={data.accounts} />

      <p className="state" style={{ paddingBottom: 0 }}>
        {data.timezoneNote}
        {data.dataStale && " Данные Meta давно не обновлялись — «нет расхода сегодня» по ним не утверждаем."}
      </p>
    </div>
  );
}

function Big({ label, value, sub, extra }: { label: string; value: string; sub?: string; extra?: string | null }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt style={{ fontSize: "var(--fs-14)", color: "var(--muted)" }}>{label}</dt>
      <dd style={{ margin: 0 }}>
        <b className="money" style={{ display: "block", fontSize: 23, overflowWrap: "anywhere", color: "var(--ink)" }}>
          {value}
        </b>
        {sub && <span style={{ display: "block", fontSize: "var(--fs-13)", color: "var(--muted)" }}>{sub}</span>}
        {extra && <span style={{ display: "block", fontSize: "var(--fs-13)", color: "var(--faint)" }}>{extra}</span>}
      </dd>
    </div>
  );
}

function Accounts({ accounts }: { accounts: AdPacingAccount[] | null }) {
  if (accounts == null) {
    return (
      <div className="quiet" style={{ marginTop: 12 }}>
        <span className="dot" aria-hidden />
        <span className="txt">Долг и способ оплаты подгружаются из рекламного кабинета — их пока нет в кэше.</span>
      </div>
    );
  }
  if (accounts.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      {accounts.map((a) => {
        const debt = a.balanceTjs != null && a.balanceTjs > 0 ? a.balanceTjs : null;
        return (
          <div className="quiet" key={a.id}>
            <span className={debt ? "dot warn" : "dot"} aria-hidden />
            <span className="txt">
              <b>{a.name ?? a.id}:</b> {a.fundingSource ?? "способ оплаты не виден"}
              {a.balance != null
                ? debt
                  ? ` · к оплате ${formatMoneyExact(a.balance, a.currency)}${a.currency === "TJS" ? "" : ` (≈ ${formatMoneyExact(debt, "TJS")})`}`
                  : " · долга нет"
                : " · долг не виден"}
              {a.capLeftTjs != null && ` · до лимита кабинета ${formatMoneyExact(a.capLeftTjs, "TJS")}`}
              {a.daysToCap != null && ` (≈ ${a.daysToCap.toLocaleString("ru-RU")} дн. при обычном темпе)`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
