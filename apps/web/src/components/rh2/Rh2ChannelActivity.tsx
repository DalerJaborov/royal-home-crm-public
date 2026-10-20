import type { ChannelActivity } from "../../hooks/useCharts";

/**
 * КАНАЛЫ РЯДОМ (24.09.2026, владелец: «аналитикой и статистиками по всем
 * каналам, визуально, чтобы я всё видел»).
 *
 * Карта «Когда аудитория активна» показывает один канал за раз. Здесь все
 * каналы сразу, по строке на канал: сколько событий, больше или меньше, чем
 * за такой же срок раньше, полоска по часам суток и свой лучший час
 * публикации. Ничего не считает сама — числа приходят готовыми с сервера
 * (lib/audienceHeatmap.ts, тем же счётом, что и карта).
 *
 * Цвет один — синий акцент: ярко горят три самых живых часа канала,
 * остальные бледнее по высоте. Без цветов на каждый канал: канал подписан
 * словом, а шесть цветов на одном экране читались бы хуже слов.
 */

const DOW_WORDS: Record<number, string> = {
  0: "по воскресеньям",
  1: "по понедельникам",
  2: "по вторникам",
  3: "по средам",
  4: "по четвергам",
  5: "по пятницам",
  6: "по субботам",
};

function hh(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** «+25 %», «−10 %», «как раньше», «новый» — словами, без стрелок-загадок. */
function trend(total: number, previous: number): { text: string; tone: "ok" | "warn" | "mute" } {
  if (previous === 0) return total > 0 ? { text: "раньше не было", tone: "ok" } : { text: "пусто", tone: "mute" };
  const pct = Math.round(((total - previous) / previous) * 100);
  if (Math.abs(pct) < 5) return { text: "как раньше", tone: "mute" };
  return pct > 0 ? { text: `больше на ${pct} %`, tone: "ok" } : { text: `меньше на ${-pct} %`, tone: "warn" };
}

function HourBars({ byHour, lively }: { byHour: number[]; lively: number[] }) {
  const max = Math.max(...byHour, 1);
  const W = 24 * 10;
  const H = 40;
  return (
    <svg className="chact-bars" viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label="Активность по часам суток">
      {byHour.map((n, h) => {
        const barH = n === 0 ? 1 : Math.max(3, Math.round((n / max) * H));
        return (
          <rect
            key={h}
            x={h * 10 + 1}
            y={H - barH}
            width={8}
            height={barH}
            rx={2}
            className={lively.includes(h) ? "hot" : n === 0 ? "none" : "cold"}
          >
            <title>{`${hh(h)} — ${n}`}</title>
          </rect>
        );
      })}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} x={h * 10 + 1} y={H + 12} className="lbl">
          {hh(h)}
        </text>
      ))}
    </svg>
  );
}

export function Rh2ChannelActivity({
  channels,
  days,
  labels,
  unit,
}: {
  channels: ChannelActivity[];
  days: number;
  labels: Record<string, string>;
  /** Что считаем — для подписи числа: «событий», «сообщений», «комментариев». */
  unit: string;
}) {
  const grand = channels.reduce((s, c) => s + c.total, 0);
  if (grand === 0) {
    return <p className="state">За {days} дней ни один канал не дал событий.</p>;
  }
  return (
    <div className="list chact">
      {channels.map((c) => {
        const t = trend(c.total, c.previousTotal);
        const share = Math.round((c.total / grand) * 100);
        return (
          <div className="row" key={c.channel}>
            <div className="t">
              <b>{labels[c.channel] ?? c.channel}</b>
              <span>
                {c.total} {unit} · {share} % от всех
              </span>
              <span className="chips">
                <span className={`chip ${t.tone}`}>{t.text}</span>
              </span>
              {c.total > 0 ? (
                <span className="chact-why">
                  Живее всего в {c.liveliestHours.map(hh).join(", ")}
                  {c.busiestDow !== null ? `, ${DOW_WORDS[c.busiestDow]}` : ""}. Публиковать для этого канала — в{" "}
                  {c.publishHours.map(hh).join(", ")}.
                </span>
              ) : (
                <span className="chact-why">За {days} дней из этого канала ничего не было.</span>
              )}
            </div>
            {c.total > 0 && <HourBars byHour={c.byHour} lively={c.liveliestHours} />}
          </div>
        );
      })}
    </div>
  );
}
