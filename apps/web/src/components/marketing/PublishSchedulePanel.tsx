import { useState } from "react";
import { Link } from "react-router-dom";
import { dushanbeLocalToIso, isoToDushanbeLocal } from "@royal-home/shared";
import { usePublishAt, usePublishNow, type PublishSchedule, type PublishScheduleFreeItem, type PublishScheduleItem } from "../../hooks/useMarketing";
import { dushanbeDayLabel, dushanbeTime } from "../../lib/date";
import { formatPropertyCode } from "../../lib/clientFormat";
import { channelMeta } from "../../lib/channelMeta";

/**
 * РАЗДЕЛ «РАСПИСАНИЕ» (23.09.2026, владелец: «чтобы я видел время выхода,
 * объекты, почему именно, какие площадки»).
 *
 * До этого дня расстановка публикаций работала вслепую: слот считался при
 * приёме ролика от монтажёра и нигде не показывался. Вопрос «почему ролик
 * выйдет завтра в 12:40, а не сегодня» не имел ответа ни на одном экране — а
 * это первое, что спрашивают.
 *
 * НИЧЕГО НЕ СЧИТАЕТ САМА. Время, причина и часы приходят готовыми из
 * `GET /marketing/publish-schedule`, который берёт их из
 * `lib/publishScheduleRules.ts` — той же точки, из которой слот выбирается при
 * приёме ролика. Считать здесь «ближайший час пик» своей арифметикой означало
 * бы завести второе правило рядом с первым: экран показывал бы одно, сервер
 * делал бы другое, и разошлись бы они молча (тот самый класс «одно правило
 * написано дважды», за которым в этом репозитории уже ходили).
 *
 * ОДНА на обе ширины: узкую раскладку делают медиазапросы эталона.
 */

/** «09:00» из минут от полуночи — тем же способом, что и на сервере. */
function hhmm(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60) % 24;
  const m = minutesOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function hoursList(hours: number[]): string {
  if (hours.length === 0) return "не заданы";
  return hours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");
}

const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DOW_SHORT: Record<number, string> = { 0: "Вс", 1: "Пн", 2: "Вт", 3: "Ср", 4: "Чт", 5: "Пт", 6: "Сб" };

export function PublishSchedulePanel({ data }: { data: PublishSchedule | undefined }) {
  if (!data) {
    return (
      <div className="state">
        <span className="sk w40" />
        <span className="sk w22" /> Загружаем расписание
      </div>
    );
  }

  const { schedule, upcoming, targetChannels } = data;
  const freeUpcoming = data.freeUpcoming ?? [];

  return (
    <>
      <div className="quiet">
        <span className={schedule.enabled ? "dot ok" : "dot"} />
        <span className="txt">
          {schedule.enabled ? (
            <>
              Расписание включено: каждый ролик встаёт в самый живой свободный час сегодня, а если живые
              часы прошли или заняты — в самый активный из свободных часов того же дня. Окно публикаций{" "}
              {hhmm(schedule.windowStartMin)}–{hhmm(schedule.windowEndMin)}, между роликами {schedule.minGapMin}{" "}
              минут (за день — до {schedule.dailyCapacity}; промежуток и окно меняются в Настройках → Публикации).
            </>
          ) : (
            <>
              Расписание выключено в Настройках: каждый принятый ролик уходит в каналы сразу, пачка из десяти
              уйдёт одним залпом.
            </>
          )}
        </span>
      </div>

      {/* Почему именно эти часы — главный вопрос владельца к этому разделу.
          Источник называется прямо, и «мало данных» не прячется за красивым
          словом «по карте»: карта на двух десятках обращений — это шум. */}
      <div className="quiet">
        <span className={schedule.prioritySource === "fixed" ? "dot" : "dot ok"} />
        <span className="txt">
          {schedule.prioritySource === "instagram" ? (
            <>
              Часы выхода берутся из статистики Instagram — когда наши подписчики в сети, у каждого дня свои:{" "}
              {schedule.priorityHoursByDow
                ? DOW_ORDER.map((dow) => `${DOW_SHORT[dow]} ${hoursList(schedule.priorityHoursByDow![dow] ?? [])}`).join(
                    " · "
                  )
                : hoursList(schedule.priorityHours)}
              . Собрано за {schedule.instagramOnlineDays} дн.
            </>
          ) : schedule.prioritySource === "heatmap" ? (
            <>
              Часы выхода берутся из тепловой карты активности: {hoursList(schedule.priorityHours)}. Посчитано по{" "}
              {schedule.heatmapEvents} обращениям за {schedule.heatmapDays} дней — звонки, комментарии, переписки.
            </>
          ) : schedule.heatmapTooSparse ? (
            <>
              Тепловая карта включена, но обращений пока мало ({schedule.heatmapEvents} за {schedule.heatmapDays}{" "}
              дней) — час пик на таком числе это шум. Пока публикуем по постоянным часам из Настроек:{" "}
              {hoursList(schedule.priorityHours)}.
            </>
          ) : (
            <>
              Часы выхода заданы вручную в Настройках: {hoursList(schedule.priorityHours)}. Включите тепловую
              карту в Настройках, чтобы их выбирала активность клиентов.
            </>
          )}
        </span>
      </div>

      {/* Статистика Instagram включена, но недели ещё не набралось — говорим,
          сколько осталось, иначе тумблер в Настройках выглядит неработающим. */}
      {schedule.enabled && schedule.prioritySource !== "instagram" && schedule.instagramOnlineEnabled && (
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              {schedule.instagramOnlineDays > 0
                ? `Статистика Instagram копится: ${schedule.instagramOnlineDays} из ${schedule.instagramOnlineMinDays} дн. Наберётся неделя — часы выхода будут браться из неё.`
                : "Статистики Instagram «когда подписчики в сети» пока нет: её собирает сервер раз в сутки. Проверить доступ — Настройки → Каналы, кнопка «Проверить статистику»."}
            </span>
          </div>
        )}

      <div className="quiet">
        <span className={targetChannels.length > 0 ? "dot ok" : "dot crit"} />
        <span className="txt">
          {targetChannels.length > 0 ? (
            <>Ролик уйдёт на площадки: {targetChannels.map((c) => channelMeta(c).label).join(", ")}.</>
          ) : (
            <>Ни одна площадка не подключена — расставленные ролики никуда не уйдут. Настройки → Каналы.</>
          )}
          {!data.autoPublishEnabled &&
            " Автопубликация выключена в Настройках: ролики из очереди никуда не уйдут, пока её не включить."}
        </span>
      </div>

      <div className="sec-h stack">
        <h3 className="sec-t">Ждут своего часа</h3>
        <span className="note">{upcoming.length + freeUpcoming.length === 0 ? "очередь пуста" : `${upcoming.length + freeUpcoming.length} в очереди`}</span>
      </div>

      {upcoming.length === 0 && freeUpcoming.length === 0 ? (
        <div className="empty">
          <p>Ни один ролик не ждёт публикации. Принятые от монтажёра ролики появятся здесь со своим часом.</p>
        </div>
      ) : (
        <div className="list pubq">
          {upcoming.map((item) => (
            <ScheduleRow key={item.propertyId} item={item} autoPublishEnabled={data.autoPublishEnabled} />
          ))}
          {freeUpcoming.map((item) => (
            <FreeScheduleRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </>
  );
}

/** Свободный («Промо») ролик в очереди: без кнопок — управлять им можно на странице «Ролики в соцсети». */
export function FreeScheduleRow({ item }: { item: PublishScheduleFreeItem }) {
  return (
    <div className="row">
      <div className="t">
        <b>
          <Link className="lk" to={`/social-videos?open=${item.id}`}>
            {item.title}
          </Link>
        </b>
        <span>
          {item.at ? (
            <>
              {dushanbeDayLabel(item.at)}, {dushanbeTime(item.at)}
            </>
          ) : (
            "час не назначен"
          )}
        </span>
        <span className="chips">
          <span className="chip">Промо</span>
          {(item.channels.length > 0 ? item.channels : ["—"]).map((c) => (
            <span className="chip" key={c}>
              {c === "—" ? "площадок нет" : channelMeta(c).label}
            </span>
          ))}
          {item.overdue && <span className="chip crit">час прошёл, ролик не ушёл</span>}
        </span>
      </div>
    </div>
  );
}

/**
 * СТРОКА ОЧЕРЕДИ С КНОПКАМИ (24.09.2026, владелец: «хочу нажать из очереди
 * кнопку, чтобы этот пост пошёл сейчас», и «разные виды нужных кнопок»).
 *
 * Кнопки только двигают уже стоящую публикацию (сервер: publishHandoffNow,
 * rescheduleHandoffPublish) — сами ничего не публикуют, поэтому пост не может
 * уйти дважды. Ответ сервера показывается словами под строкой: «поставлено»
 * или честная причина, почему нет.
 */
export function ScheduleRow({ item, autoPublishEnabled }: { item: PublishScheduleItem; autoPublishEnabled: boolean }) {
  const publishNow = usePublishNow();
  const publishAt = usePublishAt();
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(() => (item.at ? isoToDushanbeLocal(item.at) : ""));
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const busy = publishNow.isPending || publishAt.isPending;
  const publishing = item.jobState === "publishing";
  const stuck = item.jobState === "stuck" || item.overdue;

  const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Не получилось. Попробуйте ещё раз.");

  function onPublishNow() {
    setNote(null);
    publishNow.mutate(item.propertyId, {
      onSuccess: () => setNote({ ok: true, text: "Поставлено: ролик уйдёт в ближайшую минуту-две." }),
      onError: (err) => setNote({ ok: false, text: errorText(err) }),
    });
  }

  function onSaveTime() {
    const at = dushanbeLocalToIso(when);
    if (!at) {
      setNote({ ok: false, text: "Выберите день и время." });
      return;
    }
    setNote(null);
    publishAt.mutate(
      { propertyId: item.propertyId, at },
      {
        onSuccess: () => {
          setEditing(false);
          setNote({ ok: true, text: "Время выхода перенесено." });
        },
        onError: (err) => setNote({ ok: false, text: errorText(err) }),
      }
    );
  }

  return (
    <div className="row">
      <div className="t">
        <b>
          <Link className="lk" to={`/properties/${item.shortId}`}>
            {formatPropertyCode(item.shortId)} · {item.title}
          </Link>
        </b>
        <span>
          {item.at ? (
            <>
              {dushanbeDayLabel(item.at)}, {dushanbeTime(item.at)}
            </>
          ) : (
            "час не назначен"
          )}
          {item.reason ? ` — ${item.reason}` : ""}
        </span>
        <span className="chips">
          {(item.channels.length > 0 ? item.channels : ["—"]).map((c) => (
            <span className="chip" key={c}>
              {c === "—" ? "площадок нет" : channelMeta(c).label}
            </span>
          ))}
          {/* Слот прошёл, а ролик всё ещё здесь — значит фоновая задача
              публикации не отработала. Молча показывать такую строку как
              обычную очередь нельзя: снаружи это выглядит как «просто ещё
              не время», а на деле публикация застряла. */}
          {publishing ? (
            <span className="chip ok">публикуется сейчас</span>
          ) : (
            stuck && <span className="chip crit">час прошёл, ролик не ушёл</span>
          )}
        </span>

        {!publishing && (
          <div className="pubq-acts">
            <button className="pill" type="button" disabled={busy || !autoPublishEnabled} onClick={onPublishNow}>
              {publishNow.isPending ? "Ставим…" : "Опубликовать сейчас"}
            </button>
            {!stuck && !editing && (
              <button className="pill ghost" type="button" disabled={busy} onClick={() => setEditing(true)}>
                Перенести
              </button>
            )}
          </div>
        )}

        {editing && !publishing && (
          <div className="pubq-acts">
            <label className="pubq-when">
              <span>Новое время (Душанбе)</span>
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
            <button className="pill" type="button" disabled={busy} onClick={onSaveTime}>
              {publishAt.isPending ? "Сохраняем…" : "Сохранить"}
            </button>
            <button className="pill ghost" type="button" disabled={busy} onClick={() => setEditing(false)}>
              Отмена
            </button>
          </div>
        )}

        {note && <span className={note.ok ? "pubq-note" : "pubq-note crit"}>{note.text}</span>}
      </div>
    </div>
  );
}
