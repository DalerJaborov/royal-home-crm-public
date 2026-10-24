import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { INTERACTION_TYPES } from "@royal-home/shared";
import { useCan } from "../lib/permissions";
import { useActivityFeed, useActivitySummary } from "../hooks/useInteractions";
import { useAgents } from "../hooks/useAgents";
import { INTERACTION_TYPE_LABELS } from "../lib/clientFormat";
import { dushanbeDate, dushanbeDayKey, dushanbeDayLabel, dushanbeTime } from "../lib/date";
import { AVATAR_TONES, initials } from "../lib/theme2026Person";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";
import { StatTile } from "../components/ui/StatTile";
import type { Interaction } from "../types";
import { useCounters } from "../hooks/useCounters";
import { useOversightSummary } from "../hooks/useOversight";
import { TeamTabs } from "../components/SectionTabs";
import { Pagination } from "../components/Pagination";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";

/**
 * «Активность команды» — лента звонков, сообщений, показов и встреч.
 *
 * ОБЛИК: дословный перенос утверждённого прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/activity.html). Классы прототипные (`.scr`,
 * `.pg-h`, `.filters`/`.hscroll`/`.seg`, `.tiles`/`.tile`, `.sec`,
 * `.card.tight`, `.grp`/`.ev-l`, `.pager`), экран включает эталон обёрткой
 * `<div className="rh2 screens">`, стили из apps/web/src/theme-2026-proto.css.
 *
 * ОДИН ЭКРАН НА ОБЕ ШИРИНЫ. Прежде рядом жил `components/mobile/MobileActivity.tsx`
 * — те же хуки, те же данные, только другая вёрстка; своей логики (жестов,
 * своих списков) у него не было. Прототип сам умеет узкую раскладку: `.tiles`
 * становится 2×2, `.grp .ev-l` переносит строки, `.hscroll` прокручивает
 * капсулы. Файл удалён, разметка живёт здесь.
 *
 * ГРУППИРОВКА. В коде лента плоская, в прототипе подряд идущие действия одного
 * человека собраны в одну запись — «данные те же, добавлена только
 * группировка» (комментарий прототипа). Группируем на клиенте, второго запроса
 * не делаем.
 */

const PERIODS = [
  { key: "7d", label: "7 дней", days: 7 },
  { key: "30d", label: "30 дней", days: 30 },
  { key: "90d", label: "90 дней", days: 90 },
  { key: "all", label: "Всё время", days: null },
] as const;

function periodFrom(days: number | null): string | undefined {
  if (days === null) return undefined;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/** Группа прототипа: подряд идущие события одного человека за один день. */
interface Group {
  key: string;
  agentId: string | null;
  agentName: string;
  avatarUrl: string | null;
  items: Interaction[];
}

/** Раскладка дня: заголовок «Сегодня» + дата и группы внутри. */
interface DaySection {
  key: string;
  title: string;
  note: string;
  groups: Group[];
}

function groupFeed(items: Interaction[]): DaySection[] {
  const days: DaySection[] = [];
  for (const item of items) {
    const dayKey = dushanbeDayKey(item.createdAt);
    let day = days[days.length - 1];
    if (!day || day.key !== dayKey) {
      day = {
        key: dayKey,
        title: dushanbeDayLabel(item.createdAt),
        note: dushanbeDate(item.createdAt, { day: "numeric", month: "long" }),
        groups: [],
      };
      days.push(day);
    }
    const agentId = item.agent?.id ?? null;
    const last = day.groups[day.groups.length - 1];
    if (last && last.agentId === agentId) last.items.push(item);
    else
      day.groups.push({
        key: `${dayKey}-${agentId ?? "system"}-${item.id}`,
        agentId,
        agentName: item.agent?.fullName ?? "Система",
        avatarUrl: item.agent?.avatarUrl ?? null,
        items: [item],
      });
  }
  return days;
}

export function Activity() {
  const can = useCan();
  /**
   * ДВА РАЗНЫХ РАЗДЕЛА ПОД ОДНИМ АДРЕСОМ — тот же приём, что в pages/Calls.tsx
   * («Звонки» руководству, «Мои звонки» агенту).
   *
   * API отдаёт общекомандную ленту только при clients.viewAll: в
   * routes/interactions.ts рядовому агенту `scopeToOwnAgent` жёстко ставит
   * where.agentId в его собственный id. Заголовок «Активность команды» обещал
   * агенту ровно то, чего ему никогда не покажут: он открывал раздел, видел
   * ленту из одного себя и делал вывод, что команда не работает.
   */
  const teamWide = can("clients.viewAll");
  // Вкладки раздела «Команда» (перенос меню 15.09.2026) — тот же набор и та же
  // логика подписи, что в pages/Team.tsx / lib/navigation.ts.
  const { data: sectionCounters } = useCounters();
  const { data: oversightSummary } = useOversightSummary(can("dashboard.analytics"));
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("30d");
  const [agentId, setAgentId] = useState("");
  // Фильтр по типу действия (шторка «Фильтры», routes/interactions.ts ?type=).
  // Плитки сводки ниже НЕ сужаются этим фильтром намеренно: они держат разбивку
  // по всем типам за период, список под ними — уже суженный.
  const [type, setType] = useState<(typeof INTERACTION_TYPES)[number] | "">("");
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { data: agents } = useAgents({ enabled: teamWide });
  // Мемоизируем строку «от какой даты»: periodFrom(new Date()) на каждый рендер
  // даёт новую строку с миллисекундами, а она попадает в queryKey — без memo это
  // гоняло бесконечный цикл перезапросов.
  const from = useMemo(() => periodFrom(PERIODS.find((p) => p.key === period)?.days ?? null), [period]);
  const { data, isLoading, isFetching, isError, error, refetch } = useActivityFeed({
    page,
    from,
    agentId: agentId || undefined,
    type: type || undefined,
  });
  /**
   * Плитки считаются СВОДКОЙ С СЕРВЕРА за выбранный период, а не по загруженной
   * странице ленты (решение владельца 09.09.2026, docs/theme-2026-missing.md §8).
   * Прежний счёт по `data.items` менялся от того, докрутил ли человек список:
   * цифра выглядела фактом за период, не будучи им, и под ней стояла честная
   * оговорка «по загруженным событиям». Теперь оговорка не нужна — число и
   * подпись говорят об одном и том же.
   *
   * Сводка не зависит от страницы, поэтому `page` в её фильтры не попадает и
   * листание ленты её не перезапрашивает.
   */
  const { data: summary } = useActivitySummary({ from, agentId: agentId || undefined });

  // «Показать ещё» лентой вместо «Назад/Дальше» (решение владельца 15.09.2026,
  // аудит 02.10.2026): страницы копятся общим useAccumulatedPages, смена
  // периода, сотрудника или типа сбрасывает ленту. Свежая первая страница —
  // вторым вызовом того же хука (при page = 1 это тот же запрос).
  const { data: head } = useActivityFeed({
    page: 1,
    from,
    agentId: agentId || undefined,
    type: type || undefined,
  });
  const feed = useAccumulatedPages(data?.items, page, `${from}:${agentId}:${type}`, head?.items);
  const days = useMemo(() => groupFeed(feed), [feed]);
  const counts = summary?.byType;
  const periodNote = PERIODS.find((p) => p.key === period)?.label.toLowerCase() ?? "";
  // Пока сводка не пришла, плитка показывает прочерк, а не ноль: ноль — это
  // утверждение «событий нет», и оно бы мигало при каждой смене периода.
  const tileValue = (value: number | undefined) => (value === undefined ? "—" : value);

  // Плитки сводки ведут в ленту ниже: переключают фильтр «тип» (шторка «Фильтры»)
  // и прокручивают к списку — второго запроса не делают, список уже на экране.
  const focusType = (t: (typeof INTERACTION_TYPES)[number]) => {
    setType(t);
    setPage(1);
    document.getElementById("activity-feed")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };


  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>{teamWide ? "Активность команды" : "Моя активность"}</h1>
            <p className="sub">
              {teamWide
                ? "Звонки, сообщения, показы и встречи. Подряд идущие действия одного человека собраны в одну запись, чтобы лента читалась."
                : "Ваши звонки, сообщения, показы и встречи. Действия коллег видит только администрация."}
            </p>
          </div>
          <div className="acts">
            <button className="pill ghost" type="button" onClick={() => setFiltersOpen(true)}>
              Фильтры
            </button>
          </div>
        </div>

        <TeamTabs />

        <div className="filters">
          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Период">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="tab"
                  aria-selected={period === p.key}
                  onClick={() => {
                    setPeriod(p.key);
                    setPage(1);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {teamWide && (agents?.length ?? 0) > 0 && (
            <div className="hscroll">
              <div className="seg" role="tablist" aria-label="Агент">
                <button
                  type="button"
                  role="tab"
                  aria-selected={agentId === ""}
                  onClick={() => {
                    setAgentId("");
                    setPage(1);
                  }}
                >
                  Все агенты <span className="n">{agents?.length ?? 0}</span>
                </button>
                {agents?.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="tab"
                    aria-selected={agentId === a.id}
                    onClick={() => {
                      setAgentId(a.id);
                      setPage(1);
                    }}
                  >
                    {a.fullName}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Сводка за период — отдельный запрос к серверу, группировка по типу события. */}
        <div className="tiles">
          <StatTile
            label="Звонков"
            value={tileValue(counts?.CALL)}
            line={periodNote}
            onClick={() => focusType("CALL")}
            title="Показать только звонки в ленте ниже"
          />
          <StatTile
            label="Сообщений"
            value={tileValue(counts?.MESSAGE)}
            line={periodNote}
            onClick={() => focusType("MESSAGE")}
            title="Показать только сообщения в ленте ниже"
          />
          <StatTile
            label="Показов"
            value={tileValue(counts?.SHOWING)}
            line={periodNote}
            onClick={() => focusType("SHOWING")}
            title="Показать только показы в ленте ниже"
          />
          <StatTile
            label="Встреч"
            value={tileValue(counts?.MEETING)}
            line={periodNote}
            onClick={() => focusType("MEETING")}
            title="Показать только встречи в ленте ниже"
          />
        </div>

        <div id="activity-feed" />

        {isLoading && feed.length === 0 && (
          <div className="card tight">
            <div className="state">
              <span className="sk av" />
              <span className="sk w40" />
              <span className="sk w22" /> Загружаем активность
            </div>
          </div>
        )}

        {/* Отказ загрузки раньше не проверялся вовсе — карточка оставалась пустой
            без единого объяснения. Найдено аудитом 22.08.2026. */}
        {isError && (
          <div className="card tight">
            <div className="state err">
              <span className="dot crit" />
              {error instanceof Error ? error.message : "Лента не загрузилась."} Записи не пропали, оборвалась связь.{" "}
              <button
                className="lk"
                type="button"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => refetch()}
              >
                Повторить
              </button>
            </div>
          </div>
        )}

        {!isLoading && !isError && data && feed.length === 0 && (
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12h4l3 8 4-16 3 8h4" />
                </svg>
              </span>
              <p>
                {teamWide
                  ? "За этот период активности нет. Выберите период пошире или снимите фильтр по агенту."
                  : "За этот период активности нет. Здесь появляются ваши звонки, сообщения, показы и встречи."}
              </p>
              <button
                className="pill ghost"
                type="button"
                onClick={() => {
                  setPeriod("all");
                  setAgentId("");
                  setType("");
                  setPage(1);
                }}
              >
                Показать всё время
              </button>
            </div>
          </div>
        )}

        {days.map((day) => (
          <div className="sec" key={day.key}>
            <div className="sec-h">
              <h2>{day.title}</h2>
              <span className="note">{day.note}</span>
            </div>
            <div className="card tight">
              {day.groups.map((g, gi) => (
                <article className="grp" key={g.key}>
                  <div className="side">
                    <span className="av" style={AVATAR_TONES[gi % AVATAR_TONES.length]}>
                      {g.avatarUrl ? (
                        <img
                          src={g.avatarUrl}
                          alt=""
                          style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
                        />
                      ) : (
                        initials(g.agentName)
                      )}
                    </span>
                    <span className="ln" />
                  </div>
                  <div className="body">
                    <div className="hd">
                      <span className="who">
                        {g.agentId ? (
                          <Link className="lk" to={`/team?agent=${g.agentId}`}>
                            {g.agentName}
                          </Link>
                        ) : (
                          g.agentName
                        )}
                      </span>
                      {g.items.length > 1 && <span className="chip mute">{g.items.length} действия подряд</span>}
                      <span className="when">{dushanbeTime(g.items[0].createdAt)}</span>
                    </div>
                    {g.items.map((a) => (
                      <div className="ev-l" key={a.id}>
                        <span className="kind">{INTERACTION_TYPE_LABELS[a.type] ?? a.type}</span>
                        <span className="txt">
                          {a.notes}
                          {a.client?.shortId && (
                            <>
                              {" "}
                              <Link className="lk" to={`/clients/${a.client.shortId}`}>
                                {a.client.fullName}
                              </Link>
                            </>
                          )}
                          {a.property?.shortId && (
                            <>
                              {" "}
                              <Link className="lk mut" to={`/properties/${a.property.shortId}`}>
                                {a.property.title}
                              </Link>
                            </>
                          )}
                        </span>
                        <span className="tm">{dushanbeTime(a.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}

        {data && (
          <Pagination
            loading={isFetching}
            variant="loadMore"
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={setPage}
          />
        )}
      </div>

      <Rh2Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Фильтры" ariaLabel="Фильтры активности">
        <div className="sec-t" style={{ marginTop: 0 }}>
          Период
        </div>
        <div className="seg">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-selected={period === p.key}
              onClick={() => {
                setPeriod(p.key);
                setPage(1);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="sec-t">Тип действия</div>
        <div className="seg">
          <button
            type="button"
            aria-selected={type === ""}
            onClick={() => {
              setType("");
              setPage(1);
            }}
          >
            Все типы
          </button>
          {INTERACTION_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              aria-selected={type === t}
              onClick={() => {
                setType(t);
                setPage(1);
              }}
            >
              {INTERACTION_TYPE_LABELS[t] ?? t}
            </button>
          ))}
        </div>
        {teamWide && (agents?.length ?? 0) > 0 && (
          <>
            <div className="sec-t">Агент</div>
            <div className="seg">
              <button
                type="button"
                aria-selected={agentId === ""}
                onClick={() => {
                  setAgentId("");
                  setPage(1);
                }}
              >
                Все агенты
              </button>
              {agents?.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-selected={agentId === a.id}
                  onClick={() => {
                    setAgentId(a.id);
                    setPage(1);
                  }}
                >
                  {a.fullName}
                </button>
              ))}
            </div>
          </>
        )}
      </Rh2Sheet>
    </div>
  );
}
