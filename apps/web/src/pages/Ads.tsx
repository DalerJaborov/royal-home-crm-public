import { useState } from "react";
import { RefreshCw, Volume2 } from "lucide-react";
import {
  useAdCreatives,
  useAdLeaderboard,
  useAdPacing,
  useAdOwnership,
  useAdSpendReport,
  useAdTrend,
  useAdsBoard,
  useForeignAds,
  useSyncAds,
  useUnmatchedAds,
  type AdPeriodPreset,
} from "../hooks/useAds";
import { useMarketingFunnel } from "../hooks/useReports";
import { PERIODS, agoRu, canWriteAds, formatLeadCount } from "../lib/adsView";
import { describeForecast, describeRatio } from "../lib/adsCreativesPacingView";
import { useCan } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import { Pagination } from "../components/Pagination";
import { UnmatchedGallery } from "../components/ads/UnmatchedGallery";
import { AdsBoard, adTargetFromRow } from "../components/ads/AdsBoard";
import type { AdBoardRow } from "../hooks/useAds";
import { AdPropertiesSheet, type AdSheetTarget } from "../components/ads/AdPropertiesSheet";
import { AdsReconcileBanner } from "../components/ads/AdsReconcileBanner";
import { AdsTrendChart } from "../components/ads/AdsTrendChart";
import { AdsLeaderboard } from "../components/ads/AdsLeaderboard";
import { AdsCreatives } from "../components/ads/AdsCreatives";
import { AdsPacing } from "../components/ads/AdsPacing";
import { PropertySpendTable } from "../components/ads/PropertySpendTable";
import { formatMoneyExact, pluralizeRu } from "../lib/format";
import { AdsSourcesTable, AiDigest, ForeignList, type Tab } from "../components/ads/AdsShared";
import { MarketingTabs } from "../components/SectionTabs";

/**
 * РЕКЛАМА — куда уходят деньги и что они приносят.
 *
 * ПЕРЕСОБРАНО 03.09.2026 (владелец: «много реклам давно отключены, а там пишет,
 * что идёт; сделай супер удобно и легко, меньше лишней информации»). Что было и
 * почему это не работало:
 *
 *  1. ВРАЛО ГЛАВНОЕ СЛОВО. «Идёт сейчас» ставилось по статусу Meta, а у неё
 *     завершённое объявление навсегда остаётся ACTIVE: 33 строки из 41 горели
 *     зелёным при шести реально тративших. Теперь состояние считает сервер по
 *     факту трат (api: lib/ads/adDelivery.ts), и зелёная точка означает ровно
 *     то, что написано.
 *  2. ПЯТЬ ВКЛАДОК И ДВА ПЕРИОДА. Месяц стрелками в шапке жил своей жизнью, а
 *     семь кнопок-пресетов внутри списка — своей: сверху «август», снизу
 *     «последние 30 дней», и цифры на одном экране считались за разные отрезки.
 *     Период стал один на весь раздел, вкладок осталось столько, сколько разной
 *     работы: смотреть объявления, смотреть объекты, привязывать, разбирать чужое.
 *  3. ВОСЕМЬ ПЛИТОК ПОДРЯД. Четыре в шапке и четыре внутри списка, часть об одном
 *     и том же. Осталась одна строка чисел, которую читают, и один ряд плиток,
 *     на которые нажимают, — смешивать читаемое с нажимаемым нельзя (тот же
 *     разбор, что в «Вакансиях» 03.09).
 *  4. «Сейчас в работе» — вкладка живых кампаний из кабинета — убрана целиком:
 *     она показывала тот же статус Meta, то есть ту же неправду, а честный ответ
 *     на её вопрос теперь стоит первой строкой списка объявлений.
 *
 * ОБЛИК — тема «Royal Home 2026», эталон `screens/ads.html`: обёртка
 * `.rh2 > .scr`, шапка `.pg-h` с выбором периода `.field > .inp` и кнопкой
 * «Сверить с кабинетом» `.pill.ghost`, строка чисел в `.card.tight > .wrap`,
 * срезы — сегмент `.seg` в `.hscroll`, состояния — `.empty`, `.state`,
 * `.quiet.crit`. Подсказка о привязке из закрываемой стала постоянной строкой
 * `.state`, как в макете.
 */
export function Ads() {
  const [period, setPeriod] = useState<AdPeriodPreset>("30d");
  const [tab, setTab] = useState<Tab>("ads");
  const [unmatchedPage, setUnmatchedPage] = useState(1);
  const [foreignPage, setForeignPage] = useState(1);
  /** Объявление, у которого сейчас открыто окно «Привязать объекты». Окно одно на все вкладки и плашку сверки. */
  const [editing, setEditing] = useState<AdSheetTarget | null>(null);

  const board = useAdsBoard(period);
  const trend = useAdTrend(period);
  const leaderboard = useAdLeaderboard(period);
  const creatives = useAdCreatives(period);
  const pacing = useAdPacing();
  const report = useAdSpendReport(period, tab === "properties");
  const unmatched = useUnmatchedAds(unmatchedPage, tab === "unmatched");
  const foreign = useForeignAds(foreignPage, tab === "foreign");
  const sync = useSyncAds();
  const ownership = useAdOwnership();
  const funnel = useMarketingFunnel(true);
  const can = useCan();
  const role = useAuthStore((s) => s.agent?.role);
  const canSync = canWriteAds(role, can);

  const totals = board.data?.totals;
  // Свежесть данных читаем с дашборда: он грузится на любой вкладке, а отчёт по
  // объектам — только на своей.
  const syncedAt = board.data?.syncedAt ?? null;
  /** Месяц для ИИ-разбора — тот, в который упирается выбранный период. */
  const digestMonth = board.data?.to?.slice(0, 7);
  const perConversation =
    totals && totals.conversations > 0 ? totals.periodTjs / totals.conversations : null;

  /**
   * «Исправить» из плашки сверки: объявление ищем сперва в доске, затем среди
   * непривязанных; не нашли (другая страница списка) — ведём на вкладку
   * «Привязать», а не молчим.
   */
  const fixAd = (adId: string) => {
    const row = board.data?.rows.find((r) => r.id === adId);
    if (row) return setEditing(adTargetFromRow(row));
    const raw = unmatched.data?.items.find((a) => a.id === adId);
    if (raw) {
      return setEditing({
        id: raw.id,
        title: raw.campaignName ?? raw.name,
        assetCount: null,
        properties: [],
        candidates: raw.candidates,
      });
    }
    setTab("unmatched");
  };

  const tabs: [Tab, string, number | null][] = [
    ["ads", "Объявления", totals?.total ?? null],
    ["properties", "По объектам", null],
    // Именно «ждут привязки», без рекламы самого агентства: у неё объекта нет и
    // не будет, и в очереди работы ей не место.
    ["unmatched", "Привязать", totals?.pending ?? null],
    ["foreign", "Чужая реклама", totals?.foreign ?? null],
  ];

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Реклама</h1>
            <p className="sub">
              Куда ушли деньги и что они принесли. Состояние объявления считается по факту трат, а не по слову
              рекламного кабинета.
            </p>
          </div>
          <div className="acts">
            <label className="field">
              <span className="vh">Период</span>
              <select
                className="inp"
                id="ads-period"
                value={period}
                onChange={(e) => setPeriod(e.target.value as AdPeriodPreset)}
              >
                {PERIODS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {canSync && (
              <button className="pill ghost" type="button" onClick={() => sync.mutate(false)} disabled={sync.isPending}>
                <RefreshCw className="i" aria-hidden />
                Сверить с кабинетом
              </button>
            )}
          </div>
        </div>

        <MarketingTabs />

        {/* ОДНА СТРОКА ЧИСЕЛ вместо четырёх плиток: столько денег ушло, столько
            обращений пришло, столько стоило одно. Всё остальное — в списке. */}
        {/* Ошибка запроса — не нули (F10, 02.10.2026): «потрачено 0,00 TJS ·
            0 обращений» при упавшем сервере читалось как «реклама стоит». */}
        {board.isError && !board.data ? (
          <div className="card tight">
            <div className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">Не удалось загрузить расходы на рекламу — цифр за период сейчас нет.</span>
              <button className="pill ghost sm" type="button" onClick={() => void board.refetch()}>
                Повторить
              </button>
            </div>
          </div>
        ) : (
        /* ПЯТЬ ПЛИТОК (компактная версия по макету владельца, 13.10.2026): деньги за период,
           обращения Meta, клиенты CRM, сегодня против обычного дня и прогноз месяца — всё, что
           раньше было строкой чисел и отдельной карточкой «Темп расхода». */
        <div className="tiles" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))" }}>
          <KpiTile
            label={`Потрачено за ${board.data?.label ?? "период"}`}
            value={formatMoneyExact(totals?.periodTjs ?? 0, "TJS")}
            sub={syncedAt ? `сверено ${agoRu(syncedAt, Date.now())}` : "ещё не сверялись"}
          />
          <KpiTile
            label="Обращений Meta"
            value={String(totals?.conversations ?? 0)}
            sub={perConversation !== null ? `по ${formatMoneyExact(perConversation, "TJS")}` : "обращений нет"}
          />
          <KpiTile
            label="Клиентов в CRM"
            value={totals?.leadStats ? formatLeadCount(totals.leadStats.leads) : "нет данных"}
            sub={
              totals?.leadStats?.costPerLeadTjs != null
                ? `по ${formatMoneyExact(totals.leadStats.costPerLeadTjs, "TJS")} за клиента`
                : "клиентов с рекламы нет"
            }
          />
          <KpiTile
            label="Сегодня"
            value={pacing.data ? formatMoneyExact(pacing.data.todayTjs, "TJS") : "…"}
            sub={
              pacing.data
                ? `${describeRatio(pacing.data.ratioToUsual) ?? "обычного дня пока нет"} (обычный день ${formatMoneyExact(pacing.data.usualDayTjs, "TJS")})`
                : ""
            }
          />
          <KpiTile
            label="Прогноз на месяц"
            value={pacing.data ? describeForecast(pacing.data.forecastState, pacing.data.forecast).headline : "…"}
            sub={pacing.data ? (describeForecast(pacing.data.forecastState, pacing.data.forecast).range ?? "") : ""}
          />
        </div>
        )}

        {/* Сверка денег CRM с кабинетом Meta — на виду над всем остальным: если
            цифры разошлись, остальной экран читать бессмысленно. */}
        {!(board.data && !board.data.enabled) && (
          <AdsReconcileBanner preset={period} onFixAd={fixAd} onGoUnmatched={() => setTab("unmatched")} />
        )}

        {board.data && !board.data.enabled && (
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <Volume2 className="i" aria-hidden />
              </span>
              <p>
                Рекламный кабинет не подключён, поэтому расходов здесь нет. Подключается в Настройках, в разделе
                «Каналы связи».
              </p>
            </div>
          </div>
        )}

        {/* «Сверить» во время идущей сверки раньше молча ничего не делал (13.10.2026). */}
        {sync.data?.skipped && (
          <div className="card tight">
            <div className="quiet">
              <span className="dot" />
              <span className="txt">Сверка с кабинетом уже идёт — цифры обновятся сами через минуту-две.</span>
            </div>
          </div>
        )}

        {sync.isError && (
          <div className="card tight">
            <div className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">
                {sync.error instanceof Error ? sync.error.message : "Кабинет не ответил"}
              </span>
              <button className="lnk" type="button" onClick={() => sync.mutate(false)}>
                Повторить
              </button>
            </div>
          </div>
        )}

        {/* Тихие предупреждения над списком: включённая, но простаивающая реклама
            и деньги без объекта — то же, что владелец в эталоне держит на виду
            перед разбором, а не прячет в общем списке. */}
        {totals && (totals.stalled > 0 || totals.pending > 0) && (
          <div className="card tight">
            {totals.stalled > 0 && (
              <div className="quiet crit">
                <span className="dot crit" />
                <span className="txt">
                  {totals.stalled} {pluralizeRu(totals.stalled, ["объявление", "объявления", "объявлений"])}{" "}
                  {totals.stalled === 1 ? "включено, но деньги не тратит." : "включены, но деньги не тратят."} Показов нет, а бюджет стоит зарезервированным.
                </span>
                <button className="lnk" type="button" onClick={() => setTab("ads")}>
                  Посмотреть
                </button>
              </div>
            )}
            {totals.pending > 0 && (
              <div className="quiet warn">
                <span className="dot warn" />
                <span className="txt">
                  {totals.pending} {pluralizeRu(totals.pending, ["объявление", "объявления", "объявлений"])} без
                  объекта: деньги по ним лежат отдельной строкой и не попадают в стоимость квартиры.
                </span>
                <button className="lnk" type="button" onClick={() => setTab("unmatched")}>
                  Сопоставить
                </button>
              </div>
            )}
          </div>
        )}

        {!(board.data && !board.data.enabled) && (
          <>
            {/* ИДУТ СЕЙЧАС (13.10.2026, владелец: «объявления, которые идут в данный момент, первыми,
                в реальном времени»). Состояние — по факту трат (adDelivery.ts); экран сам
                перечитывает доску раз в минуту, пока есть идущие объявления (useAdsBoard). */}
            <LiveAds rows={board.data?.rows ?? []} syncedAt={syncedAt} onEdit={setEditing} />

            {/* КРЕАТИВЫ слева, источники и объекты справа — одна строка вместо четырёх карточек подряд. */}
            <div className="adsx-cols" style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
              <div className="adsx-main" style={{ flex: "999 1 760px", minWidth: 0 }}>
                <div className="card">
                  <div className="sec-h stack">
                    <h2>Креативы: что работает</h2>
                    <span className="note">по объявлениям за период</span>
                  </div>
                  <AdsCreatives query={creatives} />
                </div>
              </div>
              <div className="adsx-side" style={{ flex: "1 1 320px", minWidth: 0, display: "grid", gap: 16 }}>
                {funnel.data && <AdsSourcesTable month={funnel.data.month} channels={funnel.data.channels} compact />}
                <div className="card">
                  <div className="sec-h stack">
                    <h2>Объекты</h2>
                    <span className="note">цена обращения за период</span>
                  </div>
                  <AdsLeaderboard query={leaderboard} />
                </div>
              </div>
            </div>

            {/* ТЕМП И ГРАФИК — подробности под раскрытием: цифры «сегодня» и «прогноз» уже стоят
                плитками наверху, а долг, флаги и график по дням нужны реже. */}
            <details className="card adsx-more">
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Расход по дням, темп и прогноз — подробно</summary>
              <div style={{ marginTop: 16, display: "grid", gap: 24 }}>
                <AdsPacing query={pacing} />
                <AdsTrendChart query={trend} />
              </div>
            </details>
          </>
        )}

        <AiDigest month={digestMonth} />

        <div className="sec-h">
          <h2>Объявления кабинета</h2>
          {totals && (
            <span className="note">
              {totals.total} всего, ждут привязки {totals.pending}
            </span>
          )}
        </div>

        <div className="card">
          {/* Вкладки — по видам работы, с числами: видно заранее, есть ли там что-то. */}
          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Срезы объявлений">
              {tabs.map(([key, label, count]) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
                  {label}
                  {count != null && count > 0 && <span className="n"> {count}</span>}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            {tab === "ads" && <AdsBoard query={board} onEditProperties={setEditing} />}

            {tab === "properties" && <PropertySpendTable query={report} />}

            {tab === "unmatched" && (
              <>
                <p className="state" style={{ paddingTop: 0 }}>
                  Объявление привязывается к объекту само: по ссылке из карточки, по номеру «№1042» в подписи
                  поста или в названии кампании. Здесь остались те, где зацепиться не за что, — деньги по ним
                  видны отдельной строкой, а не растворяются в общей сумме.
                </p>
                {/* Отказ запроса и честная пустота — разные экраны: «всё привязано»
                    печаталось и по упавшему запросу (аудит 22.08.2026, раунд 6). */}
                {unmatched.isError ? (
                  <div className="state err">
                    <span className="dot crit" /> Не удалось загрузить — это не значит, что непривязанных
                    объявлений нет.{" "}
                    <button
                      className="lk"
                      type="button"
                      style={{ color: "inherit", textDecoration: "underline" }}
                      onClick={() => unmatched.refetch()}
                    >
                      Повторить
                    </button>
                  </div>
                ) : unmatched.isLoading ? (
                  <div className="state">
                    <span className="sk w40" />
                    <span className="sk w22" /> Загружаем объявления
                  </div>
                ) : (
                  <UnmatchedGallery items={unmatched.data?.items ?? []} onEditProperties={setEditing} />
                )}
                {/* Без условия «больше страницы»: после привязки на последней странице
                    выдача ужимается, и только сам Pagination вернёт на последнюю
                    живую страницу — спрятанный, он оставлял человека на пустой. */}
                {unmatched.data && (
                  <Pagination
                    page={unmatched.data.page}
                    pageSize={unmatched.data.pageSize}
                    total={unmatched.data.total}
                    onPageChange={setUnmatchedPage}
                  />
                )}
              </>
            )}

            {tab === "foreign" && (
              <>
                <p className="state" style={{ paddingTop: 0 }}>
                  Реклама других клиентов из общего кабинета подрядчика. В расходы агентства не входит — но лежит
                  на виду, чтобы разницу с суммой в Ads Manager можно было объяснить, а ошибку исправить.
                </p>
                {/* До 03.09.2026 у этого списка не было ни загрузки, ни отказа: по
                    упавшему запросу он писал «чужой рекламы не нашлось» — тот же
                    класс вранья, что чинили на трёх соседних вкладках. */}
                {foreign.isError ? (
                  <div className="state err">
                    <span className="dot crit" />{" "}
                    {foreign.error instanceof Error ? foreign.error.message : "Не удалось загрузить список"}{" "}
                    <button
                      className="lk"
                      type="button"
                      style={{ color: "inherit", textDecoration: "underline" }}
                      onClick={() => foreign.refetch()}
                    >
                      Повторить
                    </button>
                  </div>
                ) : foreign.isLoading ? (
                  <div className="state">
                    <span className="sk w40" />
                    <span className="sk w22" /> Загружаем список
                  </div>
                ) : (
                  <ForeignList
                    rows={foreign.data?.items ?? []}
                    onReclaim={(id) => ownership.mutate({ id, ours: true })}
                    busy={ownership.isPending}
                  />
                )}
                {/* Без условия «больше страницы»: после «Вернуть» на последней странице
                    выдача ужимается, и только сам Pagination вернёт на последнюю
                    живую страницу — спрятанный, он оставлял человека на пустой. */}
                {foreign.data && (
                  <Pagination
                    page={foreign.data.page}
                    pageSize={foreign.data.pageSize}
                    total={foreign.data.total}
                    onPageChange={setForeignPage}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Окно привязки: key по объявлению — у каждого объявления своё состояние
          выбора, и после «Отмена» оно не липнет к следующему. */}
      {editing && <AdPropertiesSheet key={editing.id} target={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Плитка одной цифры шапки: подпись сверху, число, пояснение мелко. */
function KpiTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <div className="hd">{label}</div>
      <b className="money" style={{ fontSize: "var(--fs-23)" }}>
        {value}
      </b>
      {sub && <span style={{ fontSize: "var(--fs-13)", color: "var(--muted)" }}>{sub}</span>}
    </div>
  );
}

/**
 * «ИДУТ СЕЙЧАС» — объявления, которые тратят деньги по факту трат (adDelivery.ts), первым блоком
 * страницы. Сегодняшняя трата — поле todayTjs с сервера (сутки по Душанбе, всё объявление).
 * Пусто — блок честно говорит «ничего не крутится», а не исчезает.
 */
function LiveAds({
  rows,
  syncedAt,
  onEdit,
}: {
  rows: AdBoardRow[];
  syncedAt: string | null;
  onEdit: (target: AdSheetTarget) => void;
}) {
  const live = rows.filter((r) => r.delivery === "RUNNING");
  return (
    <div className="card">
      <div className="sec-h stack">
        <h2>
          <span className={live.length ? "dot ok" : "dot"} aria-hidden /> Идут сейчас{live.length ? ` · ${live.length}` : ""}
        </h2>
        <span className="note">
          {syncedAt ? `обновлено ${agoRu(syncedAt, Date.now())}` : "ещё не сверялись"} · обновляется само раз в минуту
        </span>
      </div>
      {live.length === 0 ? (
        <p className="state">Сейчас ни одно объявление не тратит деньги.</p>
      ) : (
        <>
        {/* Телефон — списком: таблица в семь колонок на узком экране сжималась и уезжала вбок. */}
        <div className="list only-narrow">
          {live.map((r) => (
            <div className="row" key={r.id}>
              <div className="t">
                <b>{r.headline ?? r.campaignName ?? r.name}</b>
                <span>
                  {r.property ? `№${r.property.shortId} · ${r.property.title}` : r.brand ? "реклама агентства" : "без объекта"}
                </span>
                <span>
                  сегодня {r.todayTjs != null ? formatMoneyExact(r.todayTjs, "TJS") : "—"} · за период{" "}
                  {formatMoneyExact(r.period.spendTjs, "TJS")} · обращений {r.period.conversations} · клиентов{" "}
                  {r.leadStats ? formatLeadCount(r.leadStats.leads) : "—"}
                </span>
              </div>
              {r.postUrl && (
                <a className="lk" href={r.postUrl} target="_blank" rel="noreferrer">
                  Пост
                </a>
              )}
            </div>
          ))}
        </div>
        <div className="tbl-wrap only-wide">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Объявление и объект</th>
                <th scope="col" className="num">Сегодня</th>
                <th scope="col" className="num">За период</th>
                <th scope="col" className="num">Обращений</th>
                <th scope="col" className="num">Клиентов</th>
                <th scope="col" className="num">Цена клиента</th>
                <th scope="col"><span className="vh">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {live.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.headline ?? r.campaignName ?? r.name}</b>
                    <div style={{ fontSize: "var(--fs-13)", color: "var(--muted)" }}>
                      {r.property ? (
                        <a className="lk" href={`/properties/${r.property.shortId}`}>
                          №{r.property.shortId} · {r.property.title}
                        </a>
                      ) : r.brand ? (
                        "реклама агентства"
                      ) : (
                        <button className="lk" type="button" onClick={() => onEdit(adTargetFromRow(r))}>
                          без объекта — привязать
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="num">
                    <b>{r.todayTjs != null ? formatMoneyExact(r.todayTjs, "TJS") : "—"}</b>
                  </td>
                  <td className="num">{formatMoneyExact(r.period.spendTjs, "TJS")}</td>
                  <td className="num">{r.period.conversations}</td>
                  <td className="num">{r.leadStats ? formatLeadCount(r.leadStats.leads) : "—"}</td>
                  <td className="num">
                    {r.leadStats?.costPerLeadTjs != null ? formatMoneyExact(r.leadStats.costPerLeadTjs, "TJS") : "клиентов нет"}
                  </td>
                  <td>
                    {r.postUrl && (
                      <a className="lk" href={r.postUrl} target="_blank" rel="noreferrer">
                        Пост
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
