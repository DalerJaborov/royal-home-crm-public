import { useState } from "react";
import { Link } from "react-router-dom";
import type { ClientSource } from "@royal-home/shared";
import { useCan } from "../lib/permissions";
import {
  useSourcesReport,
  useMarketingFunnel,
  useLostByChannel,
  useWaitingNow,
  useMarketingInsights,
  type LostByChannel,
  type MarketingFunnelChannel,
  type WaitingNowChannel,
} from "../hooks/useReports";
import { useDashboardHeatmap, useDashboardHeatmapChannels, type HeatmapChannel, type HeatmapSignal } from "../hooks/useCharts";
import { CLIENT_SOURCE_LABELS } from "../lib/clientFormat";
import { dushanbeDayKey, dushanbeFirstDayOfMonthKey, dushanbeTodayKey } from "../lib/date";
import { Rh2Money } from "../components/rh2/Rh2Money";
import { Rh2Bars } from "../components/rh2/Rh2Bars";
import { Rh2Donut } from "../components/rh2/Rh2Donut";
import { Rh2Chart } from "../components/rh2/Rh2Chart";
import { Rh2Heatmap } from "../components/rh2/Rh2Heatmap";
import { Rh2ChannelActivity } from "../components/rh2/Rh2ChannelActivity";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import { MoneyTabs } from "../components/SectionTabs";
import { scrollableRegion } from "../lib/a11y";
import { StatTile } from "../components/ui/StatTile";
import { ResponseSpeedSection } from "../components/ResponseSpeedSection";
import { useCleanShell } from "../hooks/useCleanShell";

/**
 * ИСТОЧНИКИ ЛИДОВ — экран /sources темы «Royal Home 2026», перенесённый из
 * прототипа (`docs/pult/theme-2026/screens/sources.html`) дословно: разметка,
 * имена классов, порядок блоков и подписи из макета.
 *
 * Один экран на компьютер и телефон: раскладку ≤820 px даёт сам прототип
 * (`.only-wide` / `.only-narrow`, `.heat-wrap`, `.donut`), поэтому отдельного
 * `MobileSources.tsx` больше нет.
 *
 * Сверх прототипа сохранены функции, которые экран уже умел: разбор маркетинга,
 * быстрые ссылки на соседние разделы, пресеты периода, «Обращения и сделки по
 * каналам» и «Сейчас ждут ответа». Все они одеты прототипными классами.
 *
 * Колонки таблицы «Сколько стоит сделка по каналам» взяты те, что сервер
 * действительно отдаёт (GET /reports/marketing-funnel): «Обращений» и «Сомони за
 * сделку» из макета здесь нет, эти два числа считаются на «Деньгах».
 */

const PRESETS = [
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
  { key: "quarter", label: "Квартал" },
] as const;
type PresetKey = (typeof PRESETS)[number]["key"];

const DAY = 24 * 60 * 60 * 1000;

/** Границы периода — днями ПО ДУШАНБЕ (границы суток только через lib/date). */
function presetRange(preset: PresetKey): { from: string; to: string } {
  const to = dushanbeTodayKey();
  if (preset === "week") return { from: dushanbeDayKey(Date.now() - 6 * DAY), to };
  if (preset === "month") return { from: dushanbeFirstDayOfMonthKey(), to };
  return { from: dushanbeDayKey(Date.now() - 89 * DAY), to };
}

function nums(value: number): string {
  return Math.round(value).toLocaleString("ru-RU");
}

function label(source: string): string {
  return CLIENT_SOURCE_LABELS[source as ClientSource] ?? source;
}

/** Плитка ведёт не по маршруту, а к разделу этого же экрана (владелец, 15.09.2026). */
function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Сколько строк видно до нажатия «Показать ещё» (правило владельца 8). */
const PAGE = 6;

/** Срезы тепловой карты. Сами данные считает сервер (lib/audienceHeatmap.ts) —
 *  здесь только человеческие названия и подпись, объясняющая, ЧТО посчитано:
 *  без неё «всё вместе» выглядит как охваты, а это не они. */
const HEATMAP_SIGNAL_TABS: [HeatmapSignal, string][] = [
  ["all", "Всё вместе"],
  ["chats", "Переписка"],
  ["calls", "Звонки"],
  ["comments", "Комментарии"],
  ["contacts", "Первое обращение"],
  ["followers", "Подписчики Instagram"],
  ["site", "Посетители сайта"],
];

const HEATMAP_SIGNAL_NOTES: Record<HeatmapSignal, string> = {
  all: "Считаются звонки, комментарии под постами и каждое сообщение переписки вместе.",
  chats:
    "Считается каждое сообщение клиента. До 23.09.2026 такого счёта не было — за то время посчитаны начало разговора и последнее сообщение в нём.",
  calls: "Считаются входящие звонки, кроме помеченных как не по делу.",
  comments: "Считаются комментарии под нашими постами в Instagram и на странице Facebook.",
  contacts: "Считается момент, когда клиент обратился ВПЕРВЫЕ, — по одному событию на клиента.",
  followers:
    "Сколько наших подписчиков Instagram в среднем в сети в этот час — это считает сам Instagram, сервер забирает данные раз в сутки.",
  site: "Сколько разных людей заходило на сайт royalhome.tj в этот час — считает сам сайт, CRM забирает данные раз в час.",
};

/** Как назвать число в строке «Каналы рядом» для каждого среза. */
const HEATMAP_SIGNAL_UNITS: Record<HeatmapSignal, string> = {
  all: "событий",
  calls: "звонков",
  comments: "комментариев",
  chats: "сообщений",
  contacts: "новых клиентов",
  followers: "в сети",
  site: "посетителей",
};

const HEATMAP_CHANNEL_LABELS: Record<HeatmapChannel, string> = {
  ALL: "Все каналы",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  WHATSAPP: "WhatsApp",
  TELEGRAM: "Telegram",
  WEBSITE: "Чат на сайте",
  PHONE: "Телефон",
};

/** «13:00, 19:00 и 20:00» — часы читаются вслух, а не перечнем через запятую. */
function formatHours(hours: number[]): string {
  const parts = hours.map((h) => `${h}:00`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}`;
}

/** «за час», «за 2 часа», «за 5 часов» — запас из Настроек → Публикации. */
function leadHoursText(n: number): string {
  if (n === 1) return "за час";
  const mod10 = n % 10;
  const word = mod10 >= 2 && mod10 <= 4 && (n < 12 || n > 14) ? "часа" : "часов";
  return `за ${n} ${word}`;
}

export function Sources() {
  const can = useCan();

  if (!can("reports.view")) {
    return (
      <Rh2Screen>
          <div className="pg-h">
            <div>
              <h1>Источники лидов</h1>
              <p className="sub">Раздел доступен администратору и менеджеру.</p>
            </div>
          </div>
      </Rh2Screen>
    );
  }

  return <SourcesScreen />;
}

function SourcesScreen() {
  const can = useCan();
  const clean = useCleanShell();
  const [preset, setPreset] = useState<PresetKey | "custom">("month");
  const [from, setFrom] = useState(dushanbeFirstDayOfMonthKey());
  const [to, setTo] = useState(dushanbeTodayKey());
  const [channelsShown, setChannelsShown] = useState(PAGE);

  const { data, isLoading, error, refetch } = useSourcesReport({ from, to }, true);
  // Тепловая карта живёт под двумя правами: «руководящее» dashboard.analytics
  // и reports.view, которым гейтится весь этот экран (сервер проверяет ту же
  // пару, см. GET /dashboard/heatmap). Раньше здесь стояло только первое, и
  // маркетолог — тот, для кого «часы обращений» в плане «Логики 2.0» и
  // написаны, — видел экран без единственного блока про часы.
  const canHeatmap = can("dashboard.analytics") || can("reports.view");
  const [heatSignal, setHeatSignal] = useState<HeatmapSignal>("all");
  const [heatChannel, setHeatChannel] = useState<HeatmapChannel>("ALL");
  const { data: heatmap } = useDashboardHeatmap(canHeatmap, heatSignal, heatChannel);
  // Каналы рядом — только у срезов, где каналов больше одного (у звонков и
  // подписчиков Instagram и посетителей сайта сравнивать нечего).
  const heatHasChannels = heatSignal !== "calls" && heatSignal !== "followers" && heatSignal !== "site";
  const { data: heatChannels } = useDashboardHeatmapChannels(canHeatmap && heatHasChannels, heatSignal);
  const { data: funnel } = useMarketingFunnel(true);
  const { data: lostByChannel } = useLostByChannel(true);
  const { data: waitingNow } = useWaitingNow(true);
  const insights = useMarketingInsights(true);

  function applyPreset(key: PresetKey) {
    const r = presetRange(key);
    setPreset(key);
    setFrom(r.from);
    setTo(r.to);
  }

  // Порядок — как и был: сверху каналы, куда БОЛЬШЕ ВСЕГО ПИШУТ (чинить надо
  // канал с сотней обращений и десятью заявками, а не наоборот).
  const sources = (data?.sources ?? [])
    .slice()
    .sort((a, b) => (b.wrote ?? 0) - (a.wrote ?? 0) || b.total - a.total);
  const reachTotal = sources.reduce((s, x) => s + (x.wrote || x.total), 0);
  const leadsTotal = sources.reduce((s, x) => s + x.total, 0);
  const dealsTotal = sources.reduce((s, x) => s + x.closed, 0);
  // Imported/demo chronology can place a closed deal before the client's CRM
  // creation. Do not present a negative duration as a useful KPI or invent zero.
  const invalidLeadDuration = data?.avgDaysNewToClosed != null
    && (!Number.isFinite(data.avgDaysNewToClosed) || data.avgDaysNewToClosed < 0);

  const donutRows = sources.filter((s) => s.total > 0).sort((a, b) => b.total - a.total);

  return (
    <Rh2Screen>
        <div className="pg-h">
          <div>
            <h1>Источники лидов</h1>
            <p className="sub">
              Откуда приходят клиенты, во что превращаются и сколько стоит сделка по каждому каналу.
            </p>
          </div>
          <div className="acts">
            <button
              className="pill ghost"
              type="button"
              disabled={insights.refresh.isPending}
              onClick={() => insights.refresh.mutate()}
            >
              Пересобрать разбор
            </button>
          </div>
        </div>

        <MoneyTabs />

        <MarketingInsights insights={insights} />

        {/* Быстрые ссылки на соседние маркетинговые экраны: маркетологу не бегать
            по пяти разделам меню. Цифры на каждом остаются там же. */}
        <div className="sec">
          <div className="sec-h">
            <h2>Куда идти дальше</h2>
            <span className="note">соседние разделы маркетинга</span>
          </div>
          <div className="card tight">
            <div className="wrap">
              <Link className="pill ghost" to="/ads">
                Реклама
              </Link>
              <Link className="pill ghost" to="/marketing">
                Обзор
              </Link>
              <Link className="pill ghost" to="/comments">
                Комментарии
              </Link>
              <Link className="pill ghost" to="/hall-of-fame">
                Топ агентов
              </Link>
            </div>
          </div>
        </div>

        <div className="card tight">
          <div className="filters">
            <div className="hscroll">
              <div className="seg" role="tablist" aria-label="Период">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    role="tab"
                    aria-selected={preset === p.key}
                    onClick={() => applyPreset(p.key)}
                  >
                    {p.label}
                  </button>
                ))}
                <button type="button" role="tab" aria-selected={preset === "custom"} onClick={() => setPreset("custom")}>
                  Свой период
                </button>
              </div>
            </div>
            <label className="field">
              <span className="lab">С какого дня</span>
              <input
                className="inp"
                type="date"
                value={from}
                style={{ maxWidth: 180 }}
                onChange={(e) => {
                  setPreset("custom");
                  setFrom(e.target.value);
                }}
              />
            </label>
            <label className="field">
              <span className="lab">По какой день</span>
              <input
                className="inp"
                type="date"
                value={to}
                style={{ maxWidth: 180 }}
                onChange={(e) => {
                  setPreset("custom");
                  setTo(e.target.value);
                }}
              />
            </label>
            <button className="pill" type="button" onClick={() => refetch()}>
              Показать
            </button>
          </div>
        </div>

        {isLoading && (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w28" /> Считаем источники
          </div>
        )}

        {/* Иначе при отказе сервера на экране остаются только заголовок и поля
            дат: ни таблицы, ни объяснения — выглядит как «источников нет». */}
        {error && !isLoading && (
          <div className="state err">
            <span className="dot crit" />{" "}
            {error instanceof Error ? error.message : "Источники не загрузились"}. Это сбой связи, а не нулевой период.
            <button
              className="lk"
              type="button"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={() => refetch()}
            >
              Повторить
            </button>
          </div>
        )}

        {data && sources.length === 0 && !isLoading && (
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="m15 9-4 4-2-2" />
                </svg>
              </span>
              <p>
                За этот период обращений не было. Здесь видно, откуда приходят клиенты: с сайта, из Instagram, по
                звонку.
              </p>
              <button className="pill ghost" type="button" onClick={() => applyPreset("quarter")}>
                Показать квартал
              </button>
            </div>
          </div>
        )}

        {data && sources.length > 0 && (
          <>
            <div className="tiles">
              <StatTile
                label="Обращений"
                value={nums(reachTotal)}
                line="за период, все каналы"
                title="Обращения и сделки по каналам — таблица ниже"
                onClick={() => scrollToSection("channels-table-section")}
              />
              <StatTile
                label="Стали лидами"
                value={nums(leadsTotal)}
                line="дошли до карточки"
                title="Откуда приходят — кольцо каналов ниже"
                onClick={() => scrollToSection("donut-section")}
              />
              <StatTile
                label="Сделок"
                value={nums(dealsTotal)}
                line="закрыто за период"
                title="Обращения и сделки по каналам — таблица ниже"
                onClick={() => scrollToSection("channels-table-section")}
              />
              <StatTile
                label="Срок до сделки"
                value={invalidLeadDuration ? "—" : data.avgDaysNewToClosed != null ? nums(data.avgDaysNewToClosed) : "нет"}
                line={invalidLeadDuration ? "Проверьте даты клиента и сделки" : "дня в среднем от нового лида"}
                critical={invalidLeadDuration}
                title="Обращения и сделки по каналам — таблица ниже"
                onClick={() => scrollToSection("channels-table-section")}
              />
            </div>

            {/* Кольцо: доли каналов */}
            <div className="sec" id="donut-section">
              <div className="sec-h">
                <h2>Откуда приходят</h2>
                <span className="note">{nums(leadsTotal)} лидов за период</span>
              </div>
              <div className="card tight">
                {donutRows.length === 0 ? (
                  <p className="state">За этот период до карточки не дошёл ни один канал.</p>
                ) : (
                  <Rh2Donut
                    total={leadsTotal}
                    middleLabel="лидов"
                    ariaLabel={`Доли каналов: ${donutRows
                      .map((s) => `${label(s.source)} ${Math.round((s.total / leadsTotal) * 100)} процентов`)
                      .join(", ")}`}
                    slices={donutRows.map((s) => ({
                      key: s.source,
                      label: label(s.source),
                      value: s.total,
                      quantity: `${s.total} лидов, ${Math.round((s.total / leadsTotal) * 100)} %`,
                    }))}
                  />
                )}
              </div>
            </div>

            {/* Обращения, лиды и сделки по каждому каналу — колонки, которые экран
                показывал и раньше: канал, куда сто человек написали и ушли, не
                должен выглядеть каналом, куда не пишет никто. */}
            <div className="sec" id="channels-table-section">
              <div className="sec-h">
                <h2>Обращения и сделки по каналам</h2>
                <span className="note">за выбранный период</span>
              </div>
              <div className="card tight">
                <div className="tbl-wrap only-wide" {...scrollableRegion("Каналы за период")}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th scope="col">Канал</th>
                        <th scope="col" className="num">Обращений</th>
                        <th scope="col" className="num">Лидов</th>
                        <th scope="col" className="num">Сделок</th>
                        <th scope="col" className="num">Доходимость</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources.map((s) => (
                        <tr key={s.source}>
                          <td>{label(s.source)}</td>
                          <td className="num">{s.wrote ? nums(s.wrote) : "нет"}</td>
                          <td className="num">{nums(s.total)}</td>
                          <td className="num">{nums(s.closed)}</td>
                          <td className="num">
                            {s.total > 0 ? `${Math.round((s.closed / s.total) * 100)} %` : "нет"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="only-narrow">
                  <div className="list">
                    {sources.map((s) => (
                      <div className="row" key={s.source}>
                        <div className="t">
                          <b>{label(s.source)}</b>
                          <span>
                            {s.wrote ? `${s.wrote} обращений` : "обращений не считаем"}, {s.total} лидов, {s.closed}{" "}
                            сделок
                          </span>
                        </div>
                        <span className="chip mute">
                          {s.total > 0 ? `${Math.round((s.closed / s.total) * 100)} %` : "нет"}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="state">Правая цифра это доля лидов канала, дошедших до сделки.</p>
                </div>
              </div>
            </div>

            {funnel && funnel.channels.length > 0 && (
              <ChannelCostSection
                funnel={funnel}
                shown={channelsShown}
                onMore={() => setChannelsShown((c) => c + PAGE)}
              />
            )}

            {lostByChannel && lostByChannel.channels.length > 0 && (
              <LostSection report={lostByChannel} waitingNow={waitingNow} />
            )}

            {canHeatmap && heatmap && (
              <div className="sec">
                <div className="sec-h">
                  <h2>Когда аудитория активна</h2>
                  <span className="note">{heatmap.days} дней, время Душанбе</span>
                </div>
                <div className="card tight">
                  <div className="hscroll">
                    <div className="seg" role="tablist" aria-label="Что считаем">
                      {HEATMAP_SIGNAL_TABS.map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          role="tab"
                          aria-selected={heatSignal === key}
                          onClick={() => {
                            setHeatSignal(key);
                            // Канал сбрасываем всегда: у нового сигнала его может не
                            // быть вовсе («комментарии по телефону»), и тогда первый
                            // же ответ пришёл бы пустым и выглядел поломкой. Какие
                            // каналы осмысленны — знает сервер, второй копии тут нет.
                            setHeatChannel("ALL");
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {heatmap.channels.length > 1 && (
                    <div className="hscroll" style={{ marginTop: 8 }}>
                      <div className="seg" role="tablist" aria-label="Канал">
                        {heatmap.channels.map((key) => (
                          <button
                            key={key}
                            type="button"
                            role="tab"
                            aria-selected={heatChannel === key}
                            onClick={() => setHeatChannel(key)}
                          >
                            {HEATMAP_CHANNEL_LABELS[key]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <Rh2Chart>
                    <Rh2Heatmap
                      cells={heatmap.cells}
                      days={heatmap.days}
                      kind={heatmap.signal === "followers" ? "online" : "events"}
                    />
                  </Rh2Chart>
                  {heatmap.publishHours.length > 0 && (
                    <p className="heat-note">
                      <b>Живее всего в {formatHours(heatmap.liveliestHours)}.</b> Публиковать лучше в{" "}
                      {formatHours(heatmap.publishHours)}
                      {heatmap.leadHours > 0
                        ? ` — ${leadHoursText(heatmap.leadHours)} до всплеска, чтобы пост успел разойтись.`
                        : " — в самый час всплеска."}
                    </p>
                  )}
                  <p className="heat-note">
                    {heatSignal === "followers"
                      ? `Чем темнее клетка, тем больше подписчиков в сети. ${HEATMAP_SIGNAL_NOTES[heatSignal]}`
                      : heatSignal === "site"
                      ? `Чем темнее клетка, тем больше людей на сайте. ${HEATMAP_SIGNAL_NOTES[heatSignal]}`
                      : `Чем темнее клетка, тем больше событий в этот час. ${HEATMAP_SIGNAL_NOTES[heatSignal]} Это активность аудитории, а не отклик на сами посты.`}
                  </p>
                </div>
              </div>
            )}

            {/* «Чем быстрее ответ, тем чаще показ» (03.10.2026) — рядом с картой часов: та
                отвечает «когда пишут», эта — «насколько быстро мы им отвечаем». Данные
                отчётные (GET /reports/response-speed), поэтому право reports.view. */}
            {can("reports.view") && <ResponseSpeedSection />}

            {canHeatmap && heatHasChannels && heatChannels && heatChannels.channels.length > 0 && (
              <div className="sec">
                <div className="sec-h">
                  <h2>Каналы рядом</h2>
                  <span className="note">
                    {heatChannels.days} дней против {heatChannels.days} дней до них
                  </span>
                </div>
                <div className="card tight">
                  <Rh2ChannelActivity
                    channels={heatChannels.channels}
                    days={heatChannels.days}
                    labels={HEATMAP_CHANNEL_LABELS}
                    unit={HEATMAP_SIGNAL_UNITS[heatSignal]}
                  />
                  <p className="heat-note">
                    Срез тот же, что выбран на карте выше. Синие столбики — три самых живых часа канала.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
    </Rh2Screen>
  );
}

/**
 * Разбор маркетинга — headline и наблюдения по воронке, потерям, очереди и
 * дословным возражениям из разборов звонков. Кэш на сервере 6 часов, кнопка
 * «Пересобрать разбор» в шапке правда пересобирает, а не притворяется.
 */
function MarketingInsights({ insights }: { insights: ReturnType<typeof useMarketingInsights> }) {
  const { data, isLoading } = insights;
  if (isLoading) {
    return (
      <div className="state">
        <span className="sk w40" />
        <span className="sk w28" /> Собираем разбор
      </div>
    );
  }
  if (!data || !data.headline) return null;
  return (
    <div className="sec">
      <div className="sec-h">
        <h2>Что видно по каналам</h2>
        <span className="note">пересобирается раз в шесть часов</span>
      </div>
      <div className="card tight">
        <div className="quiet">
          <span className="txt">
            <b>{data.headline}</b>
          </span>
        </div>
        {data.insights.map((line, i) => (
          <div className="quiet" key={i}>
            <span className="txt">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** «Сколько стоит сделка по каналам» — полная воронка расход → лиды → сделки. */
function ChannelCostSection({
  funnel,
  shown,
  onMore,
}: {
  funnel: { month: string; channels: MarketingFunnelChannel[] };
  shown: number;
  onMore: () => void;
}) {
  // Деньги приходят только тем, у кого есть finance.view: иначе колонок денег нет.
  const seesMoney = funnel.channels.some((c) => c.spendMonthTjs != null);
  const rows = funnel.channels.slice(0, shown);

  return (
    <div className="sec">
      <div className="sec-h">
        <h2>Сколько стоит сделка по каналам</h2>
        <span className="note">расход канала за {funnel.month}</span>
      </div>
      <div className="card tight">
        <div className="tbl-wrap only-wide" {...scrollableRegion("Расход по каналам")}>
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Канал</th>
                <th scope="col" className="num">Лидов</th>
                <th scope="col" className="num">Показы</th>
                <th scope="col" className="num">Сделок</th>
                {seesMoney && <th scope="col" className="num">Расход</th>}
                {seesMoney && <th scope="col" className="num">Цена лида</th>}
                {seesMoney && <th scope="col" className="num">Комиссия</th>}
                <th scope="col" className="num">Сегодня к 7 дням</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.source}>
                  <td>{c.label}</td>
                  <td className="num">{c.leadsMonth}</td>
                  <td className="num">{c.showingsMonth}</td>
                  <td className="num">{c.dealsClosedMonth}</td>
                  {seesMoney && <td className="num">{c.spendMonthTjs != null ? nums(c.spendMonthTjs) : "нет"}</td>}
                  {seesMoney && (
                    <td className="num">
                      {c.costPerLeadTjs != null ? <b>{nums(c.costPerLeadTjs)}</b> : "нет"}
                    </td>
                  )}
                  {seesMoney && (
                    <td className="num">{c.commissionMonthTjs != null ? nums(c.commissionMonthTjs) : "нет"}</td>
                  )}
                  <td className="num">
                    {c.anomalyLeadsDown ? (
                      <span
                        className="chip warn"
                        title={`Сегодня ${c.leadsToday} лид. при среднем ${c.leadsTrailing7Avg} в день за 7 дней, заметное падение`}
                      >
                        {c.leadsToday} к {c.leadsTrailing7Avg}
                      </span>
                    ) : (
                      `${c.leadsToday} к ${c.leadsTrailing7Avg}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="only-narrow">
          <div className="list">
            {rows.map((c) => (
              <div className="row" key={c.source}>
                <div className="t">
                  <b>{c.label}</b>
                  <span>
                    {c.leadsMonth} лидов, {c.showingsMonth} показов, {c.dealsClosedMonth} сделок
                    {seesMoney && c.spendMonthTjs != null ? `, расход ${nums(c.spendMonthTjs)}` : ""}
                  </span>
                </div>
                {c.anomalyLeadsDown && <span className="chip warn">просадка</span>}
                {seesMoney && c.costPerLeadTjs != null && (
                  <Rh2Money value={c.costPerLeadTjs} style={{ fontSize: "var(--fs-14)" }} />
                )}
              </div>
            ))}
          </div>
          <p className="state">Правая цифра это цена одного лида канала. Чем меньше, тем канал выгоднее.</p>
        </div>

        <p className="state">
          Показаны {rows.length} из {funnel.channels.length} каналов.{" "}
          {funnel.channels.length > rows.length && (
            <button className="lk" type="button" onClick={onMore}>
              Показать ещё ({funnel.channels.length - rows.length})
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

/** «Где теряем клиентов» плюс тихие строки про причину потерь и очередь ответа. */
function LostSection({
  report,
  waitingNow,
}: {
  report: { days: number; channels: LostByChannel[] };
  waitingNow: { channels: WaitingNowChannel[]; totalWaiting: number } | undefined;
}) {
  const rows = report.channels.filter((c) => c.lostShare != null).slice(0, 6);
  const worst = rows.find((c) => c.topReason);

  return (
    <div className="sec">
      <div className="sec-h">
        <h2>Где теряем клиентов</h2>
        <span className="note">за {report.days} дней, доля потерянных лидов канала</span>
      </div>
      <div className="card tight">
        {rows.length === 0 ? (
          <p className="state">За этот срок потерянных лидов не было.</p>
        ) : (
          <Rh2Bars
            items={rows.map((c) => ({
              key: c.source,
              name: c.label,
              share: (c.lostShare ?? 0) / 100,
              value: `${c.lostShare} %`,
            }))}
          />
        )}

        {worst?.topReason && (
          <div className="quiet warn" style={{ marginTop: 12 }}>
            <span className="txt">
              В канале «{worst.label}» чаще всего теряем по причине «{worst.topReason}»: {worst.lost} лидов из{" "}
              {worst.totalLeads}.
            </span>
          </div>
        )}

        {waitingNow && waitingNow.totalWaiting > 0 && (
          <div className="quiet">
            <span className="txt">
              Сейчас ждут ответа:{" "}
              {waitingNow.channels
                .map((c) => `${c.label} ${c.waiting}, дольше всех ${c.longestMinutes} минут`)
                .join("; ")}
              .
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
