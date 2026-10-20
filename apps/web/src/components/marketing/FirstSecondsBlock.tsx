import { Link } from "react-router-dom";
import { OPENING_SHOT_LABELS, type FirstSecondsPost } from "@royal-home/shared";
import { useFirstSeconds } from "../../hooks/useMarketing";
import { formatPropertyCode } from "../../lib/clientFormat";

/**
 * «ПЕРВЫЕ СЕКУНДЫ» (24.09.2026, Dan: «разбор первых секунд ролика»). Блок
 * «Обзора» маркетинга: какое начало ролика досматривают дольше и на каких
 * роликах теряем зрителей сразу — с тем, что в начале, и советом ИИ, что
 * поставить туда вместо этого. Сервер — lib/firstSeconds.ts.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sec = (x: number) => `${x < 10 ? x.toFixed(1).replace(".", ",") : Math.round(x)} с`;

/** Сколько роликов показываем в «теряем зрителей» — самые слабые сверху. */
const WEAK_LIMIT = 5;

/** Чем хуже удержание, тем выше в списке: доля ушедших в первые 3 с, иначе недосмотренная доля. */
function lossOf(p: FirstSecondsPost): number | null {
  if (p.skipRate !== null) return p.skipRate;
  if (p.watchedShare !== null) return 1 - p.watchedShare;
  return null;
}

function RetentionLine({ p }: { p: FirstSecondsPost }) {
  const parts: string[] = [];
  if (p.skipRate !== null) parts.push(`${pct(p.skipRate)} листают дальше в первые 3 секунды`);
  if (p.avgWatchSec !== null) {
    const dur = p.opening?.durationSec;
    parts.push(dur ? `смотрят в среднем ${sec(p.avgWatchSec)} из ${sec(dur)}` : `смотрят в среднем ${sec(p.avgWatchSec)}`);
  } else if (p.watchedShare !== null) {
    parts.push(`досматривают в среднем ${pct(p.watchedShare)}`);
  }
  if (parts.length === 0) return null;
  return <span>{parts.join(" · ")}</span>;
}

export function FirstSecondsBlock() {
  const q = useFirstSeconds(true);

  if (q.isLoading) {
    return (
      <div className="state">
        <span className="sk w40" /> Смотрим начало роликов
      </div>
    );
  }
  if (q.error || !q.data) return <p className="state">Разбор первых секунд сейчас не собрался. Загляните чуть позже.</p>;

  const data = q.data;
  const analyzed = data.posts.filter((p) => p.opening !== null);
  const weak = [...analyzed]
    .filter((p) => lossOf(p) !== null)
    .sort((a, b) => (lossOf(b) ?? 0) - (lossOf(a) ?? 0))
    .slice(0, WEAK_LIMIT);
  // Цифр удержания нет вовсе — показываем разбор начала по слабой оценке ИИ.
  const byHook = weak.length > 0 ? weak : [...analyzed].sort((a, b) => a.opening!.hookScore - b.opening!.hookScore).slice(0, WEAK_LIMIT);

  if (data.posts.length === 0) {
    return <p className="state">Вышедших роликов пока нет — разбор появится после первых публикаций.</p>;
  }

  return (
    <>
      {data.factors.length > 0 ? (
        <div className="list ovw-list">
          {data.factors.map((f) => (
            <div className="row" key={f.key}>
              <div className="t">
                <b>{f.title}</b>
                <span>
                  Дольше всего смотрят: <b>{f.best}</b> — досматривают {pct(f.bestShare)} ролика против{" "}
                  {pct(f.overallShare)} у всех
                </span>
                <span className="note">по {f.sample} роликам</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            {data.retentionAvailable
              ? `Для сравнения нужно хотя бы 6 разобранных роликов с цифрами удержания, сейчас ${data.counted}.`
              : "Площадки пока не отдали, сколько смотрят ролики. Разбор начала ниже — по оценке ИИ."}
          </span>
        </div>
      )}

      {byHook.length > 0 && (
        <>
          <h3 className="sec-t">{weak.length > 0 ? "Где теряем зрителей сразу" : "Самое слабое начало"}</h3>
          <div className="list ovw-list">
            {byHook.map((p) => (
              <div className="row" key={p.propertyId}>
                <div className="t">
                  <b>
                    <Link className="lk" to={`/properties/${p.shortId}?tab=stats`}>
                      {formatPropertyCode(p.shortId)} · {p.title}
                    </Link>
                  </b>
                  <RetentionLine p={p} />
                  <span>
                    В начале: {OPENING_SHOT_LABELS[p.opening!.firstShot]}
                    {p.opening!.note ? ` — ${p.opening!.note}` : ""}
                  </span>
                  {p.opening!.tip && <span className="note">Совет: {p.opening!.tip}</span>}
                </div>
                <span className={p.opening!.hookScore >= 7 ? "chip ok" : "chip mute"}>начало {p.opening!.hookScore}/10</span>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="heat-note">
        ИИ смотрит три кадра первых трёх секунд каждого вышедшего ролика.
        {data.pending > 0 ? ` Ещё ${data.pending} в очереди на разбор — появятся сами.` : ""} Долю ушедших в первые 3
        секунды отдаёт только Instagram, среднее время просмотра — Instagram, Facebook и YouTube; TikTok этих цифр не даёт.
      </p>
    </>
  );
}
