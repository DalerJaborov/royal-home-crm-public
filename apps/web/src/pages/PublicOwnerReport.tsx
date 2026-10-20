import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { OwnerReportResponse } from "@royal-home/shared";

import { formatMoney } from "../lib/format";
import {
  periodTiles,
  reportDateTime,
  topicBarPercent,
  weekBars,
  weekChartSummary,
} from "../lib/ownerReportView";
import "../owner-report.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: OwnerReportResponse }
  | { kind: "invalid" }
  | { kind: "error" };

/** Потолок ожидания: страницу открывают с телефона по слабой сети, вечная полоса загрузки хуже ошибки с повтором. */
const FETCH_TIMEOUT_MS = 30_000;

const PERIODS = [
  { key: "all", label: "За всё время" },
  { key: "week", label: "7 дней" },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];

/**
 * Публичная страница «Отчёт владельцу объекта» — «Что мы сделали для вашей квартиры»
 * (03.10.2026, GET /api/v1/public/owner-report/:token). Открывается владельцем квартиры
 * БЕЗ входа в CRM, вне AppLayout: ни сайдбара, ни навигации.
 *
 * Только агрегаты — числа, темы вопросов и рекомендация; ни имён, ни телефонов, ни денег
 * компании сервер не присылает (см. packages/shared/src/ownerReport.ts).
 *
 * Без cookie и аналитики: запрос идёт голым fetch с `credentials: "omit"`, а не через
 * `api()` (тот подмешивает сессию сотрудника, идентификатор устройства и повторы). Страница
 * просит поисковики её не индексировать (мета-тег ставится на время жизни страницы;
 * заголовок X-Robots-Tag шлёт и сам сервер).
 */
export function PublicOwnerReport() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [period, setPeriod] = useState<PeriodKey>("all");
  const [attempt, setAttempt] = useState(0);

  // Не индексировать и не отдавать адрес страницы другим сайтам (в токене — доступ к отчёту).
  useEffect(() => {
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    const referrer = document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    document.head.append(robots, referrer);
    const prevTitle = document.title;
    document.title = "Отчёт по объекту";
    return () => {
      robots.remove();
      referrer.remove();
      document.title = prevTitle;
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    // `cancelled` — уход со страницы или смена токена: ответ уже никому не нужен и не ошибка.
    // Обрыв по таймауту cancelled не выставляет, поэтому приходит как «не удалось загрузить».
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    setState({ kind: "loading" });
    fetch(`/api/v1/public/owner-report/${encodeURIComponent(token)}`, {
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (res.status === 404) return cancelled ? undefined : setState({ kind: "invalid" });
        if (!res.ok) return cancelled ? undefined : setState({ kind: "error" });
        const data = (await res.json()) as OwnerReportResponse;
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [token, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (state.kind === "loading") {
    return (
      <Shell>
        <div className="card" role="status" aria-live="polite">
          <div className="quiet">
            <span className="dot" />
            <span className="txt">Собираем отчёт…</span>
          </div>
        </div>
      </Shell>
    );
  }

  if (state.kind === "invalid") {
    return (
      <Shell>
        <div className="card or-empty" role="alert">
          <b>Ссылка недействительна</b>
          <span>Возможно, она устарела или была отозвана. Попросите агента прислать новую ссылку.</span>
        </div>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell>
        <div className="card or-empty" role="alert">
          <b>Не удалось загрузить отчёт</b>
          <span>Проверьте связь и попробуйте ещё раз.</span>
          <div style={{ marginTop: 16 }}>
            <button type="button" className="pill" onClick={retry}>
              Повторить
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Report data={state.data} period={period} onPeriod={setPeriod} />
    </Shell>
  );
}

/** Область эталона `.rh2` и раскладка открываются самой страницей: она вне AppLayout. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rh2 screens or-page">
      <main className="scr">
        <div className="or-wrap">{children}</div>
      </main>
    </div>
  );
}

function Report({
  data,
  period,
  onPeriod,
}: {
  data: OwnerReportResponse;
  period: PeriodKey;
  onPeriod: (p: PeriodKey) => void;
}) {
  const { agency, property, nextStep } = data;
  const tiles = periodTiles(data.periods[period]);
  const place = [property.district, property.city].filter(Boolean).join(", ");
  const generated = reportDateTime(data.generatedAt);

  return (
    <>
      <header className="or-brand">
        {agency.logoUrl && <img src={agency.logoUrl} alt="" width={44} height={44} />}
        <div>
          <b>{agency.name}</b>
          <span>{agency.slogan}</span>
        </div>
      </header>

      <div>
        <h1 className="or-title">Что мы сделали для вашей квартиры</h1>
        <p className="or-sub">Короткий отчёт о том, как идёт продажа: сколько людей увидели объект и что их интересует.</p>
      </div>

      <section className="card or-prop" aria-labelledby="or-prop-title">
        {property.photoUrl && <img className="or-photo" src={property.photoUrl} alt="" loading="eager" />}
        <div>
          <h2 id="or-prop-title" className="sec-h" style={{ margin: 0, fontSize: "var(--fs-17)" }}>
            {property.title}
          </h2>
          {place && <p className="or-sub">{place}</p>}
        </div>
        <div className="or-prop-row">
          <span className="or-price">{formatMoney(property.price, property.currency)}</span>
          <span className="chip">{SALE_LABEL[property.saleStatus]}</span>
          {property.daysOnSale != null && <span className="chip mute">В продаже {property.daysOnSale} дн.</span>}
        </div>
      </section>

      <section className="card" aria-labelledby="or-numbers">
        <div className="sec-h">
          <h2 id="or-numbers">Что уже сделано</h2>
          <div className="or-seg" role="group" aria-label="Период">
            {PERIODS.map((p) => (
              <button key={p.key} type="button" aria-pressed={period === p.key} onClick={() => onPeriod(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="or-tiles" aria-live="polite">
          {tiles.map((t) => (
            <div className="or-tile" key={t.key}>
              <b>{t.value.toLocaleString("ru-RU")}</b>
              <span>{t.label}</span>
            </div>
          ))}
        </div>
        <p className="or-note">
          {period === "week" ? "Неделя — последние 7 календарных суток по Душанбе, включая сегодня. " : ""}
          Контакты — разные люди, с которыми по этому объекту был звонок, переписка или диалог с ботом.
        </p>
      </section>

      <WeeklyChart weekly={data.weekly} />

      <section className="card" aria-labelledby="or-topics">
        <div className="sec-h">
          <h2 id="or-topics">Что спрашивают чаще всего</h2>
        </div>
        {data.topics.length === 0 ? (
          <p className="or-note">Пока вопросов по объекту накопилось мало — как только они появятся, темы будут здесь.</p>
        ) : (
          <ul className="or-topics">
            {data.topics.map((t) => (
              <li key={t.key}>
                <span>{t.label}</span>
                <span className="n">{t.count}</span>
                <span className="bar" aria-hidden="true">
                  <i style={{ width: `${topicBarPercent(data.topics, t)}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card or-next" aria-labelledby="or-next">
        <div className="sec-h">
          <h2 id="or-next">Следующий шаг</h2>
        </div>
        <h3>{nextStep.title}</h3>
        <p>{nextStep.text}</p>
        {nextStep.evidence.length > 0 && (
          <ul aria-label="На чём основана рекомендация">
            {nextStep.evidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </section>

      <footer className="or-foot">
        {generated && <div>Данные на {generated}</div>}
        <div>{agency.name}</div>
      </footer>
    </>
  );
}

const SALE_LABEL: Record<OwnerReportResponse["property"]["saleStatus"], string> = {
  AVAILABLE: "В продаже",
  SOON: "Скоро в продаже",
  RESERVED: "Забронировано",
  SOLD: "Продано",
  UNAVAILABLE: "Снят с продажи",
};

const CHART_W = 600;
const CHART_H = 190;
const PLOT_TOP = 22;
const PLOT_BOTTOM = 150;

/** Столбики интереса по неделям на SVG, без библиотек: двенадцать чисел не стоят пакета. */
function WeeklyChart({ weekly }: { weekly: OwnerReportResponse["weekly"] }) {
  const { bars } = weekBars(weekly);
  const summary = weekChartSummary(weekly);
  const slot = bars.length > 0 ? CHART_W / bars.length : CHART_W;
  const barW = Math.min(36, slot * 0.62);
  const plotH = PLOT_BOTTOM - PLOT_TOP;

  return (
    <section className="card" aria-labelledby="or-weekly">
      <div className="sec-h">
        <h2 id="or-weekly">Интерес по неделям</h2>
      </div>
      <svg className="or-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={summary}>
        <title>{summary}</title>
        {bars.map((b, i) => {
          const h = b.events > 0 ? Math.max(4, b.ratio * plotH) : 2;
          const x = i * slot + (slot - barW) / 2;
          const y = PLOT_BOTTOM - h;
          const showLabel = bars.length <= 6 || i % 2 === bars.length % 2;
          return (
            <g key={b.weekStart}>
              <rect className={b.events > 0 ? "bar" : "bar zero"} x={x} y={y} width={barW} height={h} rx={4} />
              {b.events > 0 && (
                <text className="val" x={x + barW / 2} y={y - 6} textAnchor="middle">
                  {b.events}
                </text>
              )}
              {showLabel && (
                <text x={x + barW / 2} y={PLOT_BOTTOM + 22} textAnchor="middle">
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="or-note">Каждый столбик — неделя (подписано число её понедельника): сколько раз объект отправляли, открывали и обсуждали.</p>
      <table className="sr-only">
        <caption>Интерес к объекту по неделям</caption>
        <thead>
          <tr>
            <th scope="col">Неделя с</th>
            <th scope="col">Событий</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.weekStart}>
              <td>{b.label}</td>
              <td>{b.events}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
