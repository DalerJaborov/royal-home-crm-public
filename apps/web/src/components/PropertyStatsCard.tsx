import { useQuery } from "@tanstack/react-query";
import { Flame } from "lucide-react";
import { NEIGHBORS_COMPARISON_ENABLED } from "@royal-home/shared";
import type {
  PropertyFunnelStep,
  PropertyHealthColor,
  PropertyNeighbors,
  PropertyPlatformsResponse,
  PropertySiteDay,
  PropertyStatsResponse,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { channelMeta } from "../lib/channelMeta";
import { leakIndex } from "../lib/propertyFunnel";

/**
 * ВКЛАДКА «СТАТИСТИКА» КАРТОЧКИ ОБЪЕКТА (24.09.2026, владелец: «в любой
 * карточке объекта видеть всю статистику — минималистично, подробно, ярко,
 * чтобы агент или директор могли видеть»).
 *
 * Один компонент на телефон и компьютер (правило CLAUDE.md «desktop и mobile
 * в одной правке»): на компьютере — вкладка, на телефоне — секция в стеке.
 * Сверху вниз — в порядке вопросов: что с объектом и что делать (светофор) →
 * где теряются люди (путь покупателя) → дорого ли (соседи) → как смотрят
 * (график) → где смотрят (площадки).
 *
 * Сам ничего не решает: светофор, соседей и «загорелся» считает сервер
 * (lib/propertyStats.ts). Площадки — отдельным запросом: они едут по сети, и
 * главное не ждёт их.
 */

function num(n: number): string {
  return n.toLocaleString("ru-RU");
}

const LIGHT_LABEL: Record<PropertyHealthColor, string> = {
  green: "Зелёный",
  yellow: "Жёлтый",
  red: "Красный",
  gray: "Серый",
};

export function PropertyStatsCard({ propertyId }: { propertyId: string }) {
  const stats = useQuery({
    queryKey: ["property-stats", propertyId],
    queryFn: () =>
      api<PropertyStatsResponse>(`/properties/${propertyId}/stats`),
    staleTime: 5 * 60_000,
  });
  const platforms = useQuery({
    queryKey: ["property-stats-platforms", propertyId],
    queryFn: () =>
      api<PropertyPlatformsResponse>(
        `/properties/${propertyId}/stats/platforms`,
      ),
    staleTime: 30 * 60_000,
    retry: false,
  });

  if (stats.isLoading) {
    return (
      <section className="card">
        <div className="state">
          <span className="sk w40" /> Считаем статистику объекта
        </div>
      </section>
    );
  }
  if (stats.error || !stats.data) {
    return (
      <section className="card">
        <p className="state">
          Статистику объекта сейчас посчитать не получилось. Обновите страницу
          чуть позже.
        </p>
      </section>
    );
  }
  const s = stats.data;
  // «Увидели ролик» знает только запрос площадок — пока он едет, ступень честно «…».
  const funnel = s.funnel.map((step) =>
    step.key === "seen"
      ? {
          ...step,
          count: platforms.data?.seen ?? null,
          pending: platforms.isLoading,
        }
      : { ...step, pending: false },
  );

  return (
    <div className="pst">
      <section
        className={`card pst-light ${s.health.color}`}
        aria-label={`Светофор объекта: ${LIGHT_LABEL[s.health.color]}`}
      >
        <span className="lamp" aria-hidden />
        <div className="body">
          <h2>{s.health.headline}</h2>
          {s.hot.hot && (
            <span className="chip hot">
              <Flame className="i" aria-hidden /> Загорелся:{" "}
              {num(s.hot.recentViews)} просмотров за 2 дня
              {s.hot.ratio != null
                ? `, в ${String(s.hot.ratio).replace(".", ",")} раза больше обычного`
                : ""}
            </span>
          )}
          {s.health.tips.length > 0 && (
            <ul className="tips">
              {s.health.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Путь покупателя</h2>
          <span className="note">за всё время объекта</span>
        </div>
        <Funnel steps={funnel} />
      </section>

      {NEIGHBORS_COMPARISON_ENABLED && (
        <section className="card">
          <div className="sec-h stack">
            <h2>Соседи</h2>
            <span className="note">
              {s.neighbors.scope || "похожие в районе"}
            </span>
          </div>
          <Neighbors n={s.neighbors} />
        </section>
      )}

      {/* Пока сайт не отдаёт данные, пустой блок с заглушкой не рисуем. */}
      {s.siteConnected && (
      <section className="card">
        <div className="sec-h stack">
          <h2>Просмотры на сайте</h2>
          <span className="note">последние 30 дней</span>
        </div>
        <>
            <SiteChart days={s.siteDays} hotSince={s.hot.since} />
            <div className="pst-clicks">
              <span>
                <b>{num(s.siteTotals.views)}</b> открытий
              </span>
              <span>
                <b>{num(s.siteTotals.visitors)}</b> человек
              </span>
              <span>
                <b>{num(s.siteTotals.whatsapp)}</b> нажали WhatsApp
              </span>
              <span>
                <b>{num(s.siteTotals.favorite)}</b> в избранное
              </span>
              <span>
                <b>{num(s.siteTotals.share)}</b> поделились
              </span>
            </div>
        </>
      </section>
      )}

      <section className="card">
        <div className="sec-h stack">
          <h2>Площадки</h2>
          <span className="note">просмотры роликов этого объекта</span>
        </div>
        {platforms.isLoading ? (
          <div className="state">
            <span className="sk w40" /> Собираем цифры с площадок
          </div>
        ) : platforms.error ? (
          <p className="state">
            Площадки сейчас не отвечают. Попробуйте чуть позже.
          </p>
        ) : !platforms.data || platforms.data.platforms.length === 0 ? (
          <div className="empty">
            <p>Ролик этого объекта ещё не выходил ни на одной площадке.</p>
          </div>
        ) : (
          <div className="list ovw-list">
            {platforms.data.platforms.map((p) => (
              <div className="row" key={p.channel}>
                <div className="t">
                  <b>{channelMeta(p.channel).label}</b>
                  {/* Лайки и комментарии показываем, даже если просмотров нет (12.10.2026): раньше их
                      прятали вместе с просмотрами, и строка писала «не отдала число» при живых лайках. */}
                  <span>
                    {[
                      p.views != null ? `${num(p.views)} просмотров` : null,
                      p.likes != null ? `${num(p.likes)} лайков` : null,
                      p.comments != null ? `${num(p.comments)} комментариев` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {p.views == null && <span>{p.note ?? "площадка не отдала число"}</span>}
                </div>
                {p.url ? (
                  <a
                    className="pill ghost"
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Открыть
                  </a>
                ) : (
                  p.views != null || !p.note ? (
                    <span className={`chip ${p.views != null ? "ok" : "mute"}`}>
                      {p.views != null ? "есть цифры" : "без цифр"}
                    </span>
                  ) : null
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

type FunnelView = PropertyFunnelStep & { pending: boolean };

function Funnel({ steps }: { steps: FunnelView[] }) {
  const leak = leakIndex(steps);
  const max = Math.max(1, ...steps.map((s) => s.count ?? 0));
  return (
    <ol className="pst-funnel">
      {steps.map((step, i) => {
        const prev = i > 0 ? steps[i - 1].count : null;
        const share =
          prev && step.count != null && prev > 0
            ? Math.min(100, Math.round((step.count / prev) * 100))
            : null;
        return (
          <li key={step.key} className={i === leak ? "leak" : undefined}>
            <b className="n">
              {step.pending ? "…" : step.count != null ? num(step.count) : "—"}
            </b>
            <span className="lbl">{step.label}</span>
            <span className="bar" aria-hidden>
              <span
                style={{
                  width: `${step.count ? Math.max(4, Math.round((step.count / max) * 100)) : 0}%`,
                }}
              />
            </span>
            <span className="hint">
              {i === leak
                ? `Здесь теряется больше всего людей — дошли ${share}%`
                : share != null
                  ? `дошли ${share}%`
                  : step.hint}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Neighbors({ n }: { n: PropertyNeighbors }) {
  const hasCompare = n.pricePerSqm != null && n.medianPerSqm != null;
  const top = Math.max(n.pricePerSqm ?? 0, n.medianPerSqm ?? 0, 1);
  const diffText =
    n.diffPct == null
      ? null
      : Math.abs(n.diffPct) < 2
        ? "Цена на уровне соседей"
        : n.diffPct > 0
          ? `Дороже соседей на ${Math.round(n.diffPct)}%`
          : `Дешевле соседей на ${Math.round(-n.diffPct)}%`;
  const tone =
    n.diffPct == null
      ? ""
      : n.diffPct >= 15
        ? "crit"
        : n.diffPct >= 5
          ? "warn"
          : "ok";
  return (
    <div className="pst-nb">
      {hasCompare ? (
        <>
          <p className={`big ${tone}`}>{diffText}</p>
          <div className="pair">
            <span className="k">Этот объект</span>
            <span className="bar mine" aria-hidden>
              <span
                style={{
                  width: `${Math.round(((n.pricePerSqm ?? 0) / top) * 100)}%`,
                }}
              />
            </span>
            <b>{num(n.pricePerSqm!)} с/м²</b>
          </div>
          <div className="pair">
            <span className="k">Обычно у соседей</span>
            <span className="bar" aria-hidden>
              <span
                style={{
                  width: `${Math.round(((n.medianPerSqm ?? 0) / top) * 100)}%`,
                }}
              />
            </span>
            <b>{num(n.medianPerSqm!)} с/м²</b>
          </div>
          <p className="quiet">Сравнили с {n.sample} похожими в продаже; цены пересчитаны в сомони.</p>
        </>
      ) : (
        <p className="quiet">
          {n.pricePerSqm != null
            ? `Цена за м² — ${num(n.pricePerSqm)} сомони. `
            : ""}
          Похожих в продаже меньше трёх — сравнивать не с чем.
        </p>
      )}
      {n.onSale && (
        <p className="days">
          В продаже <b>{n.daysOnSale}</b> дн.
          {n.typicalDaysToSell != null ? (
            <>
              {" "}
              · похожие обычно продаются за <b>{n.typicalDaysToSell}</b> дн.
            </>
          ) : (
            " · продаж похожих за год мало, обычного срока нет"
          )}
        </p>
      )}
    </div>
  );
}

function SiteChart({ days, hotSince }: { days: PropertySiteDay[]; hotSince: string | null }) {
  const max = Math.max(1, ...days.map((d) => d.views));
  const last = days.length - 1;
  // Столбики и подписи — обычной разметкой, а не SVG (12.10.2026): рисунок с viewBox растягивался на
  // ширину карточки вместе с текстом, и даты на ПК вырастали до 40 px, а столбики — в «таблетки».
  return (
    <div className="pst-chart" role="img" aria-label="Просмотры страницы объекта на сайте по дням">
      <div className="bars" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d) => {
          const hot = hotSince != null && d.day >= hotSince;
          const pct = d.views > 0 ? Math.max(4, Math.round((d.views / max) * 100)) : 0;
          return (
            <span className="col" key={d.day} title={`${d.day.slice(8, 10)}.${d.day.slice(5, 7)}: ${d.views}`}>
              {pct > 0 && <i className={hot ? "fill hot" : "fill"} style={{ height: `${pct}%` }} />}
            </span>
          );
        })}
      </div>
      <div className="axis" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d, i) =>
          // Подпись — раз в неделю, считая от сегодня: последняя всегда «сегодня».
          (last - i) % 7 === 0 ? (
            <span key={d.day} className={i === last ? "lbl end" : "lbl"} style={{ gridColumn: i + 1 }}>
              {i === last ? "сегодня" : `${d.day.slice(8, 10)}.${d.day.slice(5, 7)}`}
            </span>
          ) : null
        )}
      </div>
    </div>
  );
}
