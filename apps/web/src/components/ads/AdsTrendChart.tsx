import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { AdTrendPoint } from "@royal-home/shared";
import { formatMoneyExact } from "../../lib/format";
import { Rh2Chart } from "../rh2/Rh2Chart";
import { axisLabel, niceTop } from "../rh2/Rh2BarChart";

/**
 * РАСХОД И ОБРАЩЕНИЯ ПО ДНЯМ (03.10.2026, `GET /ads/trend`).
 *
 * Площадь — выбранная величина (расход / обращения / показы), линия поверх —
 * вторая: к расходу и показам добавляются обращения, к обращениям — расход. У
 * линии своя шкала (подпись в легенде): деньги в сотнях сомони и обращения в
 * единицах на одной оси дали бы одну плоскую линию. Точные значения обоих рядов
 * — в подсказке (наведение, касание, клавиатура), как у остальных графиков темы.
 *
 * Свой SVG без библиотек, геометрия та же, что у `Rh2BarChart` (viewBox 640×210):
 * график живёт в `.chart.wide`, на телефоне прокручивается вбок, а не сжимает
 * подписи до нечитаемых.
 *
 * ПУСТОТА ЧЕСТНАЯ: нет точек или во всех ноль — «данных за период нет», а не
 * плоская линия, похожая на «реклама стоит».
 */
export type TrendMetric = "spend" | "conversations" | "impressions";

const METRICS: { key: TrendMetric; label: string; unit: string }[] = [
  { key: "spend", label: "Расход", unit: "расход" },
  { key: "conversations", label: "Обращения", unit: "обращения" },
  { key: "impressions", label: "Показы", unit: "показы" },
];

const LEFT = 52;
const RIGHT = 628;
const TOP = 20;
const ZERO = 170;
/** Подписи и остановки табуляции на каждый день — до этого числа дней; дальше график не забивает Tab. */
const FOCUSABLE_UP_TO = 31;

function valueOf(p: AdTrendPoint, m: TrendMetric): number {
  return m === "spend" ? p.spendTjs : m === "conversations" ? p.conversations : p.impressions;
}

function fmt(m: TrendMetric, v: number): string {
  return m === "spend" ? formatMoneyExact(v, "TJS") : Math.round(v).toLocaleString("ru-RU");
}

/** «3 окт.» из «2026-10-03…»: день в календарном виде, без пересчёта часового пояса. */
function dayLabel(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" });
}

function pathOf(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

export function AdsTrendChart({ query }: { query: UseQueryResult<AdTrendPoint[]> }) {
  const [metric, setMetric] = useState<TrendMetric>("spend");
  const { data, isLoading, isError, error, refetch } = query;

  if (isLoading) {
    return (
      <div className="state">
        <span className="sk w40" />
        <span className="sk w22" /> Загружаем график по дням
      </div>
    );
  }
  if (isError) {
    return (
      <div className="state err">
        <span className="dot crit" /> {error instanceof Error ? error.message : "График не загрузился"} — это не
        значит, что данных нет.{" "}
        <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => void refetch()}>
          Повторить
        </button>
      </div>
    );
  }

  const points = data ?? [];
  const hasData = points.some((p) => p.spendTjs > 0 || p.conversations > 0 || p.impressions > 0);
  if (!hasData) {
    return (
      <div className="empty">
        <p>Данных за период нет.</p>
      </div>
    );
  }

  const secondary: TrendMetric = metric === "conversations" ? "spend" : "conversations";
  const top = niceTop(Math.max(...points.map((p) => valueOf(p, metric)), 0));
  const top2 = niceTop(Math.max(...points.map((p) => valueOf(p, secondary)), 0));
  const n = points.length;
  const x = (i: number) => (n === 1 ? (LEFT + RIGHT) / 2 : LEFT + ((RIGHT - LEFT) * i) / (n - 1));
  const y = (v: number, t: number) => ZERO - Math.max(0, Math.min(1, v / t)) * (ZERO - TOP);

  const main: [number, number][] = points.map((p, i) => [x(i), y(valueOf(p, metric), top)]);
  const second: [number, number][] = points.map((p, i) => [x(i), y(valueOf(p, secondary), top2)]);
  const area = `${pathOf(main)} L${x(n - 1).toFixed(1)},${ZERO} L${x(0).toFixed(1)},${ZERO} Z`;

  const first = points[0];
  const last = points[n - 1];
  const mid = points[Math.floor((n - 1) / 2)];
  const step = n === 1 ? RIGHT - LEFT : (RIGHT - LEFT) / (n - 1);
  const label = METRICS.find((m) => m.key === metric)?.unit ?? "";
  const secondLabel = METRICS.find((m) => m.key === secondary)?.unit ?? "";
  const total = points.reduce((acc, p) => acc + valueOf(p, metric), 0);

  return (
    <div>
      <div className="hscroll">
        <div className="seg" role="tablist" aria-label="Что показывать на графике">
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={metric === m.key}
              onClick={() => setMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <Rh2Chart className="wide">
          <svg
            viewBox="0 0 640 210"
            role="img"
            aria-label={`График по дням: ${label} ${fmt(metric, total)} за ${n} дн., линия — ${secondLabel}. С ${dayLabel(first.date)} по ${dayLabel(last.date)}.`}
          >
            <line className="gl" x1={LEFT} y1={TOP} x2={RIGHT} y2={TOP} />
            <line className="gl" x1={LEFT} y1={70} x2={RIGHT} y2={70} />
            <line className="gl" x1={LEFT} y1={120} x2={RIGHT} y2={120} />
            <line className="ax" x1={LEFT} y1={ZERO} x2={RIGHT} y2={ZERO} />
            <text className="axl" x="46" y="24" textAnchor="end">
              {axisLabel(top)}
            </text>
            <text className="axl" x="46" y="74" textAnchor="end">
              {axisLabel((top * 2) / 3)}
            </text>
            <text className="axl" x="46" y="124" textAnchor="end">
              {axisLabel(top / 3)}
            </text>
            <text className="axl" x="46" y="174" textAnchor="end">
              0
            </text>

            <path className="ar" d={area} />
            <path className="ln" d={pathOf(main)} />
            <path
              className="ln"
              d={pathOf(second)}
              style={{ stroke: "var(--pill)", strokeDasharray: "5 4" }}
              aria-hidden="true"
            />
            <circle className="pt" cx={main[n - 1][0]} cy={main[n - 1][1]} r="4" />

            {/* Крайние значения основной величины — подписью над точкой. */}
            <text className="val" x={main[0][0]} y={Math.max(12, main[0][1] - 8)} textAnchor="start">
              {fmt(metric, valueOf(first, metric))}
            </text>
            {n > 1 && (
              <text className="val" x={main[n - 1][0]} y={Math.max(12, main[n - 1][1] - 8)} textAnchor="end">
                {fmt(metric, valueOf(last, metric))}
              </text>
            )}

            <text className="axl" x={x(0)} y="188" textAnchor="start">
              {dayLabel(first.date)}
            </text>
            {n > 2 && (
              <text className="axl" x={x(Math.floor((n - 1) / 2))} y="188" textAnchor="middle">
                {dayLabel(mid.date)}
              </text>
            )}
            {n > 1 && (
              <text className="axl" x={x(n - 1)} y="188" textAnchor="end">
                {dayLabel(last.date)}
              </text>
            )}

            {points.map((p, i) => (
              <rect
                key={p.date}
                className="hit"
                x={x(i) - step / 2}
                y="0"
                width={step}
                height={ZERO}
                tabIndex={n <= FOCUSABLE_UP_TO ? 0 : undefined}
                data-tip={`${dayLabel(p.date)}|Расход ${formatMoneyExact(p.spendTjs, "TJS")} · обращений ${p.conversations} · показов ${p.impressions.toLocaleString("ru-RU")}`}
              />
            ))}
          </svg>
        </Rh2Chart>
      </div>

      <div className="lgd">
        <span>
          <i /> {label} (площадь)
        </span>
        <span>
          <i style={{ background: "var(--pill)" }} /> {secondLabel} (линия, своя шкала)
        </span>
      </div>
    </div>
  );
}

/**
 * Мини-график расхода для карточки-сводки: линия без осей и подписей. Это
 * украшение к числу рядом, поэтому скрыт от диктора (`aria-hidden`) — всё то же
 * самое читается в большом графике ниже.
 */
export function AdsSparkline({ points }: { points: AdTrendPoint[] | undefined }) {
  if (!points || points.length < 2 || !points.some((p) => p.spendTjs > 0)) return null;
  const W = 96;
  const H = 26;
  const max = Math.max(...points.map((p) => p.spendTjs), 1);
  const path = pathOf(
    points.map((p, i): [number, number] => [(W * i) / (points.length - 1), H - 2 - (p.spendTjs / max) * (H - 4)])
  );
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden="true"
      focusable="false"
      style={{ flex: "none", overflow: "visible" }}
    >
      <path d={path} fill="none" stroke="var(--pill)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
