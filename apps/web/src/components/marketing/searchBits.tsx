import type { ReactNode } from "react";
import { Eye, MousePointerClick, Percent, TrendingUp } from "lucide-react";
import { SEARCH_PERIODS, type SearchMetrics, type SearchQueryRow } from "@royal-home/shared";

/**
 * Общие куски вкладки «Сайт и поиск» — одинаковые у Google (SearchPanel) и
 * Яндекса (YandexSearchPanel): четыре плитки, список запросов, выбор периода,
 * итог возврата со входа.
 */

export const num = (n: number) => Math.round(n).toLocaleString("ru-RU");
export const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")}%`;
export const place = (p: number | null) => (p == null ? "—" : p.toFixed(1).replace(".", ","));
export const dmy = (iso: string) => iso.split("-").reverse().join(".");

/** «+12% к прошлому периоду». Для места в выдаче меньше — лучше. */
function Delta({ now, before, lowerIsBetter = false }: { now: number | null; before: number | null; lowerIsBetter?: boolean }) {
  if (now == null || before == null || before === 0) return <small>прошлого периода нет</small>;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.01) return <small>как в прошлый период</small>;
  const better = lowerIsBetter ? change < 0 : change > 0;
  const text = `${change > 0 ? "+" : "−"}${Math.round(Math.abs(change) * 100)}% к прошлому периоду`;
  return <small className={better ? "ok" : "crit"}>{text}</small>;
}

function Tile({ icon, color, title, value, children }: { icon: ReactNode; color: string; title: string; value: string; children: ReactNode }) {
  return (
    <div className="tile">
      <div className="hd">
        <span className="ic" style={{ ["--c" as string]: color }}>
          {icon}
        </span>
        {title}
      </div>
      <b>{value}</b>
      {children}
    </div>
  );
}

export function SearchTiles({ totals: t, previous: p, engine }: { totals: SearchMetrics; previous: SearchMetrics; engine: string }) {
  return (
    <div className="tiles">
      <Tile icon={<MousePointerClick className="i" aria-hidden />} color="var(--sky)" title="Пришли из поиска" value={num(t.clicks)}>
        <Delta now={t.clicks} before={p.clicks} />
      </Tile>
      <Tile icon={<Eye className="i" aria-hidden />} color="var(--lav)" title={`Показы в ${engine}`} value={num(t.impressions)}>
        <Delta now={t.impressions} before={p.impressions} />
      </Tile>
      <Tile icon={<Percent className="i" aria-hidden />} color="var(--pink)" title="Нажимают" value={pct(t.ctr)}>
        <Delta now={t.ctr} before={p.ctr} />
      </Tile>
      <Tile icon={<TrendingUp className="i" aria-hidden />} color="var(--lime)" title="Среднее место" value={place(t.position)}>
        <Delta now={t.position} before={p.position} lowerIsBetter />
      </Tile>
    </div>
  );
}

export function QueryList({ rows, empty }: { rows: SearchQueryRow[]; empty: string }) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p>{empty}</p>
      </div>
    );
  }
  return (
    <div className="list">
      {rows.map((r) => (
        <div className="row" key={r.query}>
          <div className="t">
            <b>{r.query}</b>
            <span>
              {num(r.clicks)} кликов · {num(r.impressions)} показов
            </span>
          </div>
          <span className="quiet">{place(r.position)} место</span>
        </div>
      ))}
    </div>
  );
}

export function PeriodTabs({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div className="hscroll">
      <div className="seg" role="tablist" aria-label="Период">
        {SEARCH_PERIODS.map((d) => (
          <button key={d} type="button" role="tab" aria-selected={days === d} onClick={() => onChange(d)}>
            {d} дней
          </button>
        ))}
      </div>
    </div>
  );
}

/** Итог возврата со входа (`?sc=ok` или `?sc=error&reason=…`) словами. */
export function ReturnBanner({
  status,
  okText,
  reasons,
}: {
  status: { sc: string | null; reason: string | null };
  okText: string;
  reasons: Record<string, string>;
}) {
  if (status.sc === "ok") {
    return (
      <div className="quiet ok" role="status">
        <span className="dot ok" />
        <span className="txt">{okText}</span>
      </div>
    );
  }
  if (status.sc === "error") {
    return (
      <div className="quiet crit" role="status">
        <span className="dot crit" />
        <span className="txt">{reasons[status.reason ?? ""] ?? `Не подключилось: ${status.reason ?? "без причины"}.`}</span>
      </div>
    );
  }
  return null;
}

export function ErrorLine({ text }: { text: string }) {
  return (
    <div className="quiet crit" role="status">
      <span className="dot crit" />
      <span className="txt">{text}</span>
    </div>
  );
}
