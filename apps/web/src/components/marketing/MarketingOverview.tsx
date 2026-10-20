import { CalendarClock, Eye, Heart, Radio, Send, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import {
  usePostAnalysis,
  usePostStats,
  usePublishSchedule,
  type PostStats,
  type PostStatsFreeVideo,
  type PostStatsItem,
  type PostStatsPlatform,
} from "../../hooks/useMarketing";
import { useDashboardHeatmapChannels } from "../../hooks/useCharts";
import { channelMeta } from "../../lib/channelMeta";
import { formatPropertyCode } from "../../lib/clientFormat";
import { dushanbeDayKey } from "@royal-home/shared";
import { Rh2ChannelActivity } from "../rh2/Rh2ChannelActivity";
import { FreeScheduleRow, ScheduleRow } from "./PublishSchedulePanel";
import { FirstSecondsBlock } from "./FirstSecondsBlock";
import { PropertyHealthDot } from "../PropertyHealthDot";
import { usePropertiesNeedsHelp } from "../../hooks/usePropertiesHealth";

/**
 * «ОБЗОР» МАРКЕТИНГА — ВСЁ НА ОДНОМ ЭКРАНЕ (24.09.2026, владелец: «такой
 * раздел, где есть все инструменты для маркетолога, чтобы одним взглядом мы
 * всё поняли, где что происходит, … чтобы не прыгать туда-сюда»).
 *
 * Сверху вниз — в порядке вопросов, которые задают каждое утро:
 *   1. что сегодня выходит и не застряло ли что-то (кнопки прямо здесь);
 *   2. как работают площадки — все пять, и честно, какая цифр не отдаёт;
 *   3. какие ролики зашли лучше всего и почему (анализатор), и где теряем
 *      зрителей в первые секунды (FirstSecondsBlock);
 *   4. в какой час выход работает лучше — по нашим же роликам;
 *   5. где сейчас живёт аудитория, по каналам.
 *
 * Сам ничего не считает: каждый блок — готовый ответ сервера, тот же, что на
 * подробных вкладках («Расписание», «Каналы», «Источники»). Упал один запрос —
 * пропадает его блок, а не весь экран.
 */

const PLATFORM_ORDER = ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK", "TELEGRAM"] as const;

const CHANNEL_LABELS: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  WHATSAPP: "WhatsApp",
  TELEGRAM: "Telegram",
  WEBSITE: "Чат на сайте",
  PHONE: "Телефон",
};

function num(n: number): string {
  return n.toLocaleString("ru-RU");
}

function hh(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function totalViews(post: { stats: PostStatsItem["stats"] }): number {
  return post.stats.reduce((sum, s) => sum + (s.views ?? 0), 0);
}

export function MarketingOverview({ onOpenTab }: { onOpenTab: (tab: "schedule" | "channels") => void }) {
  const schedule = usePublishSchedule(true);
  const stats = usePostStats(true);
  const analysis = usePostAnalysis(true);
  // Каналы рядом — права аналитики (как на «Источниках»): у кого их нет, сервер
  // ответит отказом, и блок просто не покажется.
  const channels = useDashboardHeatmapChannels(true, "all");

  const upcoming = schedule.data?.upcoming ?? [];
  const todayKey = dushanbeDayKey(new Date());
  const today = upcoming.filter((u) => u.at && dushanbeDayKey(new Date(u.at)) === todayKey);
  const freeUpcoming = schedule.data?.freeUpcoming ?? [];
  const freeToday = freeUpcoming.filter((u) => u.at && dushanbeDayKey(new Date(u.at)) === todayKey);
  const stuck = upcoming.filter((u) => u.jobState === "stuck" || u.overdue);
  const freeStuck = freeUpcoming.filter((u) => u.overdue);
  const queueTotal = upcoming.length + freeUpcoming.length;
  const stuckTotal = stuck.length + freeStuck.length;
  const platforms = stats.data?.platforms ?? [];
  const views = platforms.reduce((s, p) => s + p.views, 0);
  const likes = platforms.reduce((s, p) => s + p.likes, 0);

  return (
    <>
      <div className="tiles">
        <div className="tile">
          <div className="hd">
            <span className="ic" style={{ ["--c" as string]: "var(--sky)" }}>
              <CalendarClock className="i" aria-hidden />
            </span>
            Выйдет сегодня
          </div>
          <b>{schedule.data ? today.length + freeToday.length : "…"}</b>
          <small>{schedule.data ? `всего в очереди ${queueTotal}` : "загружаем очередь"}</small>
        </div>
        <div className="tile">
          <div className="hd">
            <span className="ic" style={{ ["--c" as string]: "var(--lav)" }}>
              <Eye className="i" aria-hidden />
            </span>
            Просмотры
          </div>
          <b>{stats.data ? num(views) : "…"}</b>
          <small>{stats.data ? `последние ${stats.data.posts.length} роликов, все площадки` : "собираем с площадок"}</small>
        </div>
        <div className="tile">
          <div className="hd">
            <span className="ic" style={{ ["--c" as string]: "var(--pink)" }}>
              <Heart className="i" aria-hidden />
            </span>
            Лайки
          </div>
          <b>{stats.data ? num(likes) : "…"}</b>
          <small>те же ролики</small>
        </div>
        <div className="tile">
          <div className="hd">
            <span className="ic" style={{ ["--c" as string]: stuckTotal > 0 ? "var(--crit-bg)" : "var(--lime)" }}>
              <TriangleAlert className="i" aria-hidden />
            </span>
            Застряло
            {stuckTotal > 0 && <span className="dot crit" />}
          </div>
          <b>{schedule.data ? stuckTotal : "…"}</b>
          <small className={stuckTotal > 0 ? "crit" : undefined}>
            {stuckTotal > 0 ? "час прошёл, ролик не ушёл — ниже кнопка" : "всё уходит вовремя"}
          </small>
        </div>
      </div>

      <section className="card">
        <div className="sec-h stack">
          <h2>Ближайшие публикации</h2>
          <button className="pill ghost" type="button" onClick={() => onOpenTab("schedule")}>
            Всё расписание
          </button>
        </div>
        {!schedule.data ? (
          <div className="state">
            <span className="sk w40" /> Загружаем очередь
          </div>
        ) : queueTotal === 0 ? (
          <div className="empty">
            <p>Очередь пуста: ни один принятый ролик не ждёт своего часа.</p>
          </div>
        ) : (
          <div className="list pubq">
            {/* Застрявшие — первыми: это единственное здесь, что требует рук. */}
            {[...stuck, ...upcoming.filter((u) => !stuck.includes(u))].slice(0, 5).map((item) => (
              <ScheduleRow key={item.propertyId} item={item} autoPublishEnabled={schedule.data!.autoPublishEnabled} />
            ))}
            {/* «Промо»: свободные ролики по расписанию, кнопки у них на странице «Ролики в соцсети». */}
            {freeUpcoming.slice(0, 5).map((item) => (
              <FreeScheduleRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      <NeedsHelp />

      <section className="card">
        <div className="sec-h stack">
          <h2>Площадки</h2>
          <button className="pill ghost" type="button" onClick={() => onOpenTab("channels")}>
            <Radio className="i" aria-hidden /> Подключение
          </button>
        </div>
        {stats.isLoading ? (
          <div className="state">
            <span className="sk w40" /> Собираем цифры с площадок — первый раз до минуты
          </div>
        ) : stats.error || !stats.data ? (
          <p className="state">Не получилось собрать статистику площадок. Обновите страницу чуть позже.</p>
        ) : (
          <PlatformsList platforms={stats.data.platforms} />
        )}
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Почему взлетели</h2>
          <span className="note">лучшие ролики против остальных</span>
        </div>
        <AnalysisBlock analysis={analysis.data} loading={analysis.isLoading} failed={Boolean(analysis.error)} />
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Первые секунды</h2>
          <span className="note">что в начале ролика и сколько листают дальше</span>
        </div>
        <FirstSecondsBlock />
      </section>

      {stats.data && stats.data.posts.length + (stats.data.freeVideos?.length ?? 0) > 0 && (
        <section className="card">
          <div className="sec-h stack">
            <h2>Лучшие ролики</h2>
            <span className="note">по просмотрам на всех площадках</span>
          </div>
          <TopPosts data={stats.data} />
        </section>
      )}

      {stats.data && stats.data.byHour.length > 0 && (
        <section className="card">
          <div className="sec-h stack">
            <h2>Какой час выхода работает</h2>
            <span className="note">средние просмотры ролика по часу выхода</span>
          </div>
          <HourViews byHour={stats.data.byHour} />
          {schedule.data && schedule.data.schedule.priorityHours.length > 0 && (
            <p className="heat-note">
              Сейчас расписание ставит ролики на {schedule.data.schedule.priorityHours.map(hh).join(", ")} — по
              активности аудитории. Эта полоска показывает, как на деле отработали уже вышедшие ролики.
            </p>
          )}
        </section>
      )}

      {channels.data && channels.data.channels.length > 0 && (
        <section className="card">
          <div className="sec-h stack">
            <h2>Где сейчас аудитория</h2>
            <span className="note">
              обращения по каналам, {channels.data.days} дней против {channels.data.days} до них
            </span>
          </div>
          <Rh2ChannelActivity
            channels={channels.data.channels}
            days={channels.data.days}
            labels={CHANNEL_LABELS}
            unit="событий"
          />
          <p className="heat-note">
            Подробная карта по дням и часам — <Link className="lk" to="/sources">Источники → «Когда аудитория активна»</Link>.
          </p>
        </section>
      )}
    </>
  );
}

/** Все пять площадок всегда — и честная причина у той, что цифр не отдаёт. */
function PlatformsList({ platforms }: { platforms: PostStatsPlatform[] }) {
  const byChannel = new Map(platforms.map((p) => [p.channel, p]));
  return (
    <div className="list ovw-list">
      {PLATFORM_ORDER.map((channel) => {
        const p = byChannel.get(channel);
        const label = channelMeta(channel).label;
        if (!p || !p.connected) {
          return (
            <div className="row" key={channel}>
              <div className="t">
                <b>{label}</b>
                <span>не подключена — Маркетинг → Каналы</span>
              </div>
              <span className="chip mute">нет</span>
            </div>
          );
        }
        if (!p.available) {
          return (
            <div className="row" key={channel}>
              <div className="t">
                <b>{label}</b>
                <span>{p.reason ?? "цифры пока не отдаёт"}</span>
              </div>
              <span className="chip warn">без цифр</span>
            </div>
          );
        }
        return (
          <div className="row" key={channel}>
            <div className="t">
              <b>{label}</b>
              <span>
                {num(p.views)} просмотров · {num(p.likes)} лайков · {num(p.comments)} комментариев
              </span>
              <span className="note">
                {p.posts} роликов{p.posts > 0 ? `, в среднем ${num(Math.round(p.views / p.posts))} просмотров` : ""}
              </span>
            </div>
            <span className="chip ok">работает</span>
          </div>
        );
      })}
    </div>
  );
}

type TopEntry =
  | { kind: "property"; key: string; views: number; post: PostStatsItem }
  | { kind: "free"; key: string; views: number; video: PostStatsFreeVideo };

function ChannelChips({ stats }: { stats: PostStatsItem["stats"] }) {
  return (
    <span className="chips">
      {stats.map((s) =>
        s.url ? (
          <a className="chip" key={s.channel} href={s.url} target="_blank" rel="noreferrer">
            {channelMeta(s.channel).label} {s.views !== null ? num(s.views) : "—"}
          </a>
        ) : (
          <span className="chip" key={s.channel}>
            {channelMeta(s.channel).label} {s.views !== null ? num(s.views) : "—"}
          </span>
        )
      )}
    </span>
  );
}

/** Ролики объектов и свободные («Промо») — одним списком, по сумме просмотров. */
function TopPosts({ data }: { data: PostStats }) {
  const entries: TopEntry[] = [
    ...data.posts.map((post): TopEntry => ({ kind: "property", key: post.propertyId, views: totalViews(post), post })),
    ...(data.freeVideos ?? []).map((video): TopEntry => ({ kind: "free", key: `free:${video.id}`, views: totalViews(video), video })),
  ];
  const top = entries.sort((a, b) => b.views - a.views).slice(0, 5);
  return (
    <div className="list">
      {top.map((e) => {
        const hour = e.kind === "property" ? e.post.publishHour : e.video.publishHour;
        const stats = e.kind === "property" ? e.post.stats : e.video.stats;
        return (
          <div className="row" key={e.key}>
            <div className="t">
              <b>
                {e.kind === "property" ? (
                  <Link className="lk" to={`/properties/${e.post.shortId}`}>
                    {formatPropertyCode(e.post.shortId)} · {e.post.title}
                  </Link>
                ) : (
                  <>
                    <span className="chip">Промо</span>{" "}
                    <Link className="lk" to={`/social-videos?open=${e.video.id}`}>
                      {e.video.title}
                    </Link>
                  </>
                )}
              </b>
              <span>
                {num(e.views)} просмотров
                {hour !== null ? ` · вышел в ${hh(hour)}` : ""}
              </span>
              <ChannelChips stats={stats} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Столбик на каждый час выхода, где были ролики; самый сильный — синим. */
function HourViews({ byHour }: { byHour: PostStats["byHour"] }) {
  const max = Math.max(...byHour.map((h) => h.avgViews), 1);
  const bestHour = byHour.reduce((a, b) => (b.avgViews > a.avgViews ? b : a)).hour;
  return (
    <div className="ovw-hours" role="list" aria-label="Средние просмотры по часу выхода">
      {byHour.map((h) => (
        <div className="ovw-hour" role="listitem" key={h.hour}>
          <span className="v">{num(h.avgViews)}</span>
          <span className="bar">
            <span
              className={h.hour === bestHour ? "fill hot" : "fill"}
              style={{ height: `${Math.max(4, Math.round((h.avgViews / max) * 100))}%` }}
            />
          </span>
          <span className="h">{hh(h.hour)}</span>
          <span className="n">{h.posts} шт.</span>
        </div>
      ))}
    </div>
  );
}

function AnalysisBlock({
  analysis,
  loading,
  failed,
}: {
  analysis: ReturnType<typeof usePostAnalysis>["data"];
  loading: boolean;
  failed: boolean;
}) {
  if (loading) {
    return (
      <div className="state">
        <span className="sk w40" /> Сравниваем ролики
      </div>
    );
  }
  if (failed || !analysis) return <p className="state">Разбор сейчас не собрался. Загляните чуть позже.</p>;
  if (!analysis.ready) {
    return (
      <div className="quiet">
        <span className="dot" />
        <span className="txt">{analysis.reason ?? "Роликов со статистикой пока мало для выводов."}</span>
      </div>
    );
  }
  return (
    <>
      {analysis.summary && (
        <div className="quiet">
          <Send className="i" aria-hidden />
          <span className="txt">{analysis.summary}</span>
        </div>
      )}
      <div className="list ovw-list">
        {analysis.factors.map((f) => (
          <div className="row" key={f.key}>
            <div className="t">
              <b>{f.title}</b>
              <span>
                Лучше всего: <b>{f.best}</b> — в среднем {num(Math.round(f.bestAvg))} просмотров против{" "}
                {num(Math.round(f.overallAvg))} у всех
              </span>
              <span className="note">по {f.sample} роликам</span>
            </div>
            <span className={f.lift >= 20 ? "chip ok" : "chip mute"}>
              {f.lift > 0 ? `+${Math.round(f.lift)} %` : "без разницы"}
            </span>
          </div>
        ))}
      </div>
      <p className="heat-note">
        Посчитано по {analysis.postsCounted} роликам. Это совпадения, а не законы: вывод по пяти роликам — повод
        попробовать, а не правило.
      </p>
    </>
  );
}

/**
 * «Объекты, которым нужна помощь» (24.09.2026): светофор всех объектов в
 * продаже, красные первыми. Маркетологу — что продвигать и что переснять,
 * руководителю — с кем из агентов поговорить. Подробности — во вкладке
 * «Статистика» карточки, строка ведёт прямо туда.
 */
function NeedsHelp() {
  const q = usePropertiesNeedsHelp();
  if (q.error) return null;
  return (
    <section className="card nhelp">
      <div className="sec-h stack">
        <h2>Объекты, которым нужна помощь</h2>
        {q.data && (
          <span className="counts">
            {q.data.red > 0 && <span className="chip crit">{num(q.data.red)} красных</span>}
            {q.data.yellow > 0 && <span className="chip warn">{num(q.data.yellow)} жёлтых</span>}
          </span>
        )}
      </div>
      {!q.data ? (
        <div className="state">
          <span className="sk w40" /> Проверяем объекты в продаже
        </div>
      ) : q.data.items.length === 0 ? (
        <div className="empty">
          <p>
            {q.data.checked > 0
              ? `Все ${num(q.data.checked)} объектов в продаже в порядке.`
              : "Объектов в продаже пока нет."}
          </p>
        </div>
      ) : (
        <div className="list">
          {q.data.items.map((it) => (
            <div className="row" key={it.id}>
              <div className="t">
                <b>
                  <PropertyHealthDot health={it} />
                  <Link className="lk" to={`/properties/${it.shortId}?tab=stats`}>
                    {formatPropertyCode(it.shortId)} · {it.title}
                  </Link>
                </b>
                <span>
                  {it.headline}
                  {it.tip ? `. ${it.tip}` : ""}
                </span>
              </div>
              <span className="quiet">{it.daysOnSale} дн. в продаже</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
