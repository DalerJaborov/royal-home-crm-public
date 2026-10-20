import { useState, type ReactNode } from "react";
import { ArrowRight, Camera, CalendarClock, CheckCheck, Clapperboard, LayoutDashboard, List, Radio, Rocket, Search } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import {
  useMarketingQueue,
  useMarketingSummary,
  useEditorsLoad,
  useChannelsStatus,
  useRecentlyPublished,
  usePublishSchedule,
  useTikTokInsights,
  useSocialDigests,
  useRunDigestNow,
  type MarketingQueueRow,
  type EditorRef,
  type RecentlyPublished,
  type RecentlyPublishedItem,
  type DigestListItem,
} from "../hooks/useMarketing";
import { Pagination } from "../components/Pagination";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import { StatusBadge } from "../components/StatusBadge";
import { initials } from "../lib/theme2026";
import { rh2AvatarTone } from "../lib/rh2Avatar";
import { SOCIAL_VIDEO_STATUS_LABELS, type SocialVideoStatus } from "@royal-home/shared";
import { pluralizeRu, exactDateTime } from "../lib/format";
import { formatPropertyCode } from "../lib/clientFormat";
import { channelMeta } from "../lib/channelMeta";
import { ChannelsStatusPanel } from "../components/marketing/ChannelsStatusPanel";
import { TikTokInsightsPanel } from "../components/marketing/TikTokInsightsPanel";
import { PublishSchedulePanel } from "../components/marketing/PublishSchedulePanel";
import { MarketingOverview } from "../components/marketing/MarketingOverview";
import { SearchPanel } from "../components/marketing/SearchPanel";
import { MarketingTabs } from "../components/SectionTabs";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";

export type MarketingTab = "overview" | "queue" | "editors" | "schedule" | "channels" | "search";

const MARKETING_TABS: readonly MarketingTab[] = ["overview", "queue", "editors", "schedule", "channels", "search"];

/** Стадия конвейера — та же лента `.stg`, что в эталоне. */
type QueueStage = "PENDING_REVIEW" | "AWAITING_PHOTOS" | "AWAITING_VIDEO" | "EDITING" | "PUBLISH";

/**
 * Кабинет маркетинга — и он же кабинет монтажёра.
 *
 * Задача владельца 05.08.2026, не входила в исходную письменную спецификацию —
 * добавлена по прямой просьбе («кабинет маркетинга тоже готово?»). Построен по
 * тому же паттерну, что и SecurityCenter.tsx: вкладки, счётчики сверху, доступ
 * ограничен ролью (проверяется и на бэкенде, в routes/marketing.ts).
 *
 * EDITOR добавлен 06.08.2026 (аудит ролевого гейтинга), но НЕ на весь кабинет —
 * только на вкладку «Нагрузка по монтажёрам» (/marketing/editors-load на
 * бэкенде). «Очередь подготовки» (/queue, /summary) остаётся маркетингу,
 * директору и администратору: это чужой этап конвейера для монтажёра, и тест
 * marketing-center.test.ts прямо фиксирует это решение («монтажёру — тоже
 * 403» на /queue). Монтажёр поэтому видит только свою вкладку без
 * переключателя — переключать ему не на что.
 *
 * ADMIN добавлен 22.08.2026 (решение владельца: администрация видит все
 * разделы, включая чужие по смыслу) — с обеими вкладками сразу, как у
 * директора: у руководства «чужого этапа» не бывает.
 *
 * ОБЛИК — тема «Royal Home 2026», эталон `screens/marketing.html`: обёртка
 * `.rh2 > .scr`, шапка `.pg-h`, цифры конвейера — плитки `.tiles`/`.tile`,
 * просрочка — тихой строкой `.quiet.crit`, вкладки — `.seg` в `.hscroll`,
 * очередь — строки `.prow`, каналы — сетка `.chn-grid`/`.chn`, состояния —
 * `.empty`/`.state`. Подсказка о конвейере из закрываемой стала подписью
 * `.sub`, как в макете.
 */

/**
 * Строка очереди подготовки: `.prow` эталона, имя объекта ссылкой `.lk`.
 *
 * НА ПРОВЕРКЕ (`PENDING_REVIEW`) в эталоне у строки — кнопки «Одобрить фото» /
 * «Одобрить видео» / «Вернуть с причиной». Решение НЕ дублировать их здесь:
 * какой из двух материалов уже одобрен, список очереди не знает (эндпоинт
 * `/marketing/queue` отдаёт только счётчик фото — не `photosApprovedAt` /
 * `videoApprovedAt` и не число видео). Рабочая кнопка, угадывающая состояние,
 * хуже честной ссылки — а сам компонент решения уже есть и живёт на карточке
 * объекта (`MaterialsModerationCard` в `PropertyDetail.tsx`), с той же
 * проверкой прав `properties.moderate`. Тянуть его сюда — значило бы грузить
 * полную карточку на каждую строку списка (N+1 запросов к API).
 */
function QueueRow({ row: r }: { row: MarketingQueueRow }) {
  // На узком экране `.prow .t span` по умолчанию однострочный, с обрезкой
  // многоточием — на 375 px это резало ровно самый важный хвост строки:
  // причину возврата (`возврат: …`) или просрочку, приписанные последними.
  // `wrapt` (тот же приём, что в AdsBoard/PropertySpendTable/EditorDashboard) —
  // строка переносится, ничего не пропадает. Просрочка и так продублирована
  // бейджем `StatusBadge` в `.act` справа, поэтому в самой строке её не
  // повторяем — короче строка, меньше причин переноситься зря.
  return (
    <div className="prow wrapt">
      <span className="ph" aria-hidden="true">
        <i className="n">{r.photoCount}</i>
      </span>
      <div className="t">
        <b>
          <Link className="lk" to={`/properties/${r.shortId}`}>
            {r.title}
          </Link>
        </b>
        <span>
          {r.responsibleAgent?.fullName ?? "агент не назначен"} · {r.photoCount} фото
          {r.reviewRejectionReason ? ` · возврат: ${r.reviewRejectionReason}` : ""}
        </span>
      </div>
      <div className="act" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
        <StatusBadge status={r.status} stage={r.pipeline} />
        {r.status === "PENDING_REVIEW" && (
          <Link className="pill ghost sm" to={`/properties/${r.shortId}`}>
            Открыть и решить
          </Link>
        )}
      </div>
    </div>
  );
}

const STAGES: { key: QueueStage; label: string }[] = [
  { key: "PENDING_REVIEW", label: "На проверке" },
  { key: "AWAITING_PHOTOS", label: "Ждут фото" },
  { key: "AWAITING_VIDEO", label: "Ждут видео" },
  { key: "EDITING", label: "Монтаж" },
  { key: "PUBLISH", label: "Ждут публикации" },
];

/**
 * Стадии конвейера — сегмент `.stg` эталона. Счётчики первых четырёх стадий —
 * настоящие («Раздел 1» `/marketing/summary`), строки — `/marketing/queue?status=`
 * с фильтром НА СЕРВЕРЕ (02.10.2026). Раньше страница из 40 строк всего
 * конвейера фильтровалась здесь, а «Показать ещё» листал весь конвейер:
 * стадия могла выглядеть пустой, хотя её объекты лежали на третьей странице.
 *
 * Пятая стадия эталона («Ждут публикации» / «Вышло сегодня») — из конвейера
 * подготовки правда не берётся (`PROPERTY_PIPELINE_STATUSES` заканчивается на
 * `EDITING`), но момент выхода из конвейера фиксирует AuditLog
 * (PROPERTY_EDITING_DONE) и каналы, в которые ушла публикация, — реальное поле
 * Property.publishedChannels. GET /marketing/recently-published (шаг 5
 * переноса, 10.09.2026) собирает то и другое за 7 дней — см. recentlyPublished.
 */
export function QueueStages({
  items,
  listState,
  pager,
  summary,
  stage,
  onStage,
  queueEmpty,
  recentlyPublished,
  publishedItems,
  publishedPager,
}: {
  items: MarketingQueueRow[];
  /** Загрузка/отказ списка стадии — рисуется ВМЕСТО списка, а не вместо
   *  вкладок стадий: смена стадии теперь новый запрос, и вкладки не должны
   *  мигать скелетоном на каждый клик. */
  listState: ReactNode;
  pager: ReactNode;
  summary: { awaitingReview: number; awaitingPhotos: number; awaitingVideo: number; editing: number } | undefined;
  stage: QueueStage;
  onStage: (s: QueueStage) => void;
  /** Во всём конвейере, не только на выбранной стадии, — рисуем честный `.empty` эталона.
   *  Только когда сводка РЕАЛЬНО пришла и total = 0: пока она грузится или упала,
   *  пустоты никто не знает (WEB-PAGES18). */
  queueEmpty: boolean;
  recentlyPublished: RecentlyPublished | undefined;
  publishedItems: RecentlyPublishedItem[];
  publishedPager: ReactNode;
}) {
  const counts: Record<QueueStage, number | null> = {
    PENDING_REVIEW: summary?.awaitingReview ?? null,
    AWAITING_PHOTOS: summary?.awaitingPhotos ?? null,
    AWAITING_VIDEO: summary?.awaitingVideo ?? null,
    EDITING: summary?.editing ?? null,
    PUBLISH: recentlyPublished?.total ?? null,
  };
  // Сервер уже отдал только эту стадию; фильтр здесь — страховка на кадр, пока
  // после смены стадии ещё не пришёл новый ответ.
  const rows = items.filter((r) => r.status === stage);

  return (
    <>
      <div className="hscroll">
        <div className="stg" role="tablist" aria-label="Стадии конвейера">
          {STAGES.map((s) => (
            <button key={s.key} type="button" role="tab" aria-selected={stage === s.key} onClick={() => onStage(s.key)}>
              <b>{counts[s.key] ?? "—"}</b>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {stage === "PENDING_REVIEW" && (
          <p className="state" style={{ paddingTop: 0 }}>
            Фото и видео одобряются по отдельности на карточке объекта: одобренное фото не пропадёт, если видео
            вернули агенту.
          </p>
        )}
        {stage === "PUBLISH" ? (
          <>
            <RecentlyPublishedList data={recentlyPublished} items={publishedItems} />
            {publishedPager}
          </>
        ) : (
          listState ??
          // «Очередь пуста» — вместо списка выбранной стадии, а не вместо вкладок:
          // «Ждут публикации» — независимые данные (AuditLog + publishedChannels) и
          // обязаны оставаться доступными на опустевшем конвейере (WEB-PAGES18).
          (queueEmpty ? (
            <div className="empty">
              <span className="ic">
                <Clapperboard className="i" aria-hidden />
              </span>
              <p>Очередь пуста: все объекты прошли подготовку и вышли в продажу.</p>
              <Link className="pill ghost" to="/properties">
                Открыть каталог
              </Link>
            </div>
          ) : (
            <>
              <QueueList rows={rows} />
              {pager}
            </>
          ))
        )}
      </div>
    </>
  );
}

/** «Ждут публикации» эталона — за 7 дней, а не только «сегодня»: дневной срез
 *  без своего джоба-снимка на границе суток то и дело показывал бы пустую
 *  секцию сразу после полуночи. */
function RecentlyPublishedList({ data, items }: { data: RecentlyPublished | undefined; items: RecentlyPublishedItem[] }) {
  if (!data) {
    return (
      <div className="state" style={{ paddingTop: 0 }}>
        <span className="sk av" />
        <span className="sk w40" />
        <span className="sk w22" /> Загружаем список
      </div>
    );
  }
  const freeVideos = data.freeVideos ?? [];
  if (items.length === 0 && freeVideos.length === 0) {
    return (
      <div className="empty">
        <span className="ic">
          <CheckCheck className="i" aria-hidden />
        </span>
        <p>За {data.windowDays} дней конвейер не выпускал новых объектов в продажу.</p>
        <Link className="pill ghost" to="/properties?status=AVAILABLE">
          Открыть каталог
        </Link>
      </div>
    );
  }
  return (
    <>
    {items.length > 0 && (
    <div className="list">
      {items.map((r) => (
        // wrapt — та же причина, что в QueueRow ниже: список каналов и
        // пояснение «в каналы CRM пока не публиковала…» на 375 px глушились
        // многоточием ровно на самом объясняющем месте.
        <div className="prow wrapt" key={r.id}>
          <div className="t">
            <b>
              <Link className="lk" to={`/properties/${r.shortId}`}>
                {formatPropertyCode(r.shortId)} · {r.title}
              </Link>
            </b>
            <span>
              вышел в продажу {exactDateTime(r.publishedAt)} ·{" "}
              {r.publishedChannels.length > 0
                ? r.publishedChannels.map((c) => channelMeta(c).label).join(", ")
                : "в каналы CRM пока не публиковала (ручной путь или очередь)"}
            </span>
          </div>
          <span className={r.publishedChannels.length > 0 ? "chip ok" : "chip mute"}>
            {r.publishedChannels.length > 0 ? "Опубликован" : "Без публикации"}
          </span>
          <div className="act">
            <Link className="pill ghost sm" to={`/properties/${r.shortId}`}>
              Открыть
            </Link>
          </div>
        </div>
      ))}
    </div>
    )}
    {freeVideos.length > 0 && (
      <>
        <div className="sec-h stack">
          <h3 className="sec-t">Промо-ролики</h3>
          <span className="note">без объекта, из раздела «Ролики в соцсети»</span>
        </div>
        <div className="list">
          {freeVideos.map((v) => (
            <div className="prow wrapt" key={v.id}>
              <div className="t">
                <b>
                  <Link className="lk" to={`/social-videos?open=${v.id}`}>
                    {v.title}
                  </Link>
                </b>
                <span>
                  {v.publishedAt ? `вышел ${exactDateTime(v.publishedAt)} · ` : ""}
                  {v.publishedChannels.map((c) => channelMeta(c).label).join(", ")}
                </span>
              </div>
              <span className={v.status === "DONE" ? "chip ok" : "chip warn"}>
                {SOCIAL_VIDEO_STATUS_LABELS[v.status as SocialVideoStatus] ?? v.status}
              </span>
              <div className="act">
                <Link className="pill ghost sm" to={`/social-videos?open=${v.id}`}>
                  Открыть
                </Link>
              </div>
            </div>
          ))}
        </div>
      </>
    )}
    </>
  );
}

function QueueList({ rows }: { rows: MarketingQueueRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <span className="ic">
          <Clapperboard className="i" aria-hidden />
        </span>
        <p>На этой стадии сейчас пусто.</p>
      </div>
    );
  }
  return (
    <div className="list">
      {rows.map((r) => (
        <QueueRow key={r.id} row={r} />
      ))}
    </div>
  );
}

/**
 * Список монтажёров: строки `.row` эталона с аватаром `.av.ring` и точкой
 * присутствия `.pres`. «На связи» / «доступ отключён» — это `isActive`
 * (доступ в CRM включён/выключен рубильником), а не факт онлайна: своего
 * поля реального присутствия у монтажёра нет, и рисовать его выдумкой нельзя.
 */
function EditorsList({ editors }: { editors: EditorRef[] }) {
  if (editors.length === 0) {
    return (
      <div className="empty">
        <p>Монтажёров пока нет.</p>
      </div>
    );
  }
  return (
    <div className="list">
      {editors.map((e) => (
        <div className="row" key={e.id}>
          <span className={e.isActive ? "av ring" : "av ring off"} aria-hidden="true" style={rh2AvatarTone(e.fullName)}>
            {e.avatarUrl ? <img src={e.avatarUrl} alt="" /> : initials(e.fullName)}
            <span className={e.isActive ? "pres on" : "pres"} />
          </span>
          <div className="t">
            <b>{e.fullName}</b>
            <span>{e.isActive ? "монтажёр, на связи" : "монтажёр, доступ отключён"}</span>
          </div>
          <span className={e.isActive ? "chip ok" : "chip mute"}>{e.isActive ? "Активен" : "Отключён"}</span>
        </div>
      ))}
    </div>
  );
}

export function MarketingCenter() {
  const role = useAuthStore((s) => s.agent?.role);
  const isEditor = role === "EDITOR";
  // Две разные группы прав — совпадают с requireMarketingRole/requireEditorsLoadRole
  // на сервере (routes/marketing.ts). Монтажёр НЕ входит в canViewQueue: у него
  // нет доступа к /queue и /summary, только к /editors-load. ADMIN — в обеих,
  // как DIRECTOR (решение владельца 22.08.2026, полная видимость).
  const canViewQueue = role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN";
  const canViewEditorsLoad =
    role === "MARKETING" || role === "EDITOR" || role === "DIRECTOR" || role === "ADMIN";
  const canView = canViewQueue || canViewEditorsLoad;
  // Монтажёр открывается сразу на своей единственной вкладке — переключателя
  // на «Очередь подготовки» у него нет вовсе (см. рендер вкладок ниже).
  // «Обзор» — первая вкладка для маркетинга (24.09.2026, владелец: «одним
  // взглядом всё понять, не прыгать туда-сюда»). Монтажёру его не видно.
  // ?tab=search — сюда возвращает Google после подключения Search Console
  // (routes/searchConsole.ts), с ?sc=ok или ?sc=error&reason=….
  const search = new URLSearchParams(useLocation().search);
  const urlTab = search.get("tab") as MarketingTab | null;
  const [tab, setTab] = useState<MarketingTab>(
    urlTab && MARKETING_TABS.includes(urlTab) && canViewQueue ? urlTab : isEditor ? "editors" : canViewQueue ? "overview" : "queue"
  );
  const searchReturn = { sc: search.get("sc"), reason: search.get("reason"), engine: search.get("engine") };
  const [queuePage, setQueuePage] = useState(1);
  const [publishedPage, setPublishedPage] = useState(1);
  const [stage, setStage] = useState<QueueStage>("PENDING_REVIEW");
  // Смена стадии — новый список с первой страницы (02.10.2026): иначе номер
  // страницы прошлой стадии переносился бы на новую.
  const changeStage = (next: QueueStage) => {
    setStage(next);
    setQueuePage(1);
  };
  const queueStatus = stage === "PUBLISH" ? undefined : stage;
  const queueEnabled = canViewQueue && tab === "queue" && stage !== "PUBLISH";

  const summaryQuery = useMarketingSummary(canViewQueue);
  const queueQuery = useMarketingQueue(queuePage, queueEnabled, queueStatus);
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const queueHead = useMarketingQueue(1, queueEnabled && queuePage > 1, queueStatus);
  const queueRows = useAccumulatedPages(queueQuery.data?.items, queuePage, stage, queueHead.data?.items);
  const editorsQuery = useEditorsLoad(canViewEditorsLoad && tab === "editors");
  // «Каналы» — та же аудитория, что «Очередь подготовки» (requireMarketingRole
  // на сервере: MARKETING/DIRECTOR/ADMIN), монтажёру сюда хода нет.
  const channelsStatusQuery = useChannelsStatus(canViewQueue && tab === "channels");
  // «Расписание» — та же аудитория, что «Каналы» (requireMarketingRole).
  const publishScheduleQuery = usePublishSchedule(canViewQueue && tab === "schedule");
  // Тот же охват, что у summaryQuery: счётчик под вкладкой «Ждут публикации»
  // должен быть виден сразу, не только после клика на саму стадию.
  const recentlyPublishedQuery = useRecentlyPublished(canViewQueue && tab === "queue", publishedPage);
  const recentlyPublishedHead = useRecentlyPublished(canViewQueue && tab === "queue" && publishedPage > 1, 1);
  const publishedItems = useAccumulatedPages(
    recentlyPublishedQuery.data?.items,
    publishedPage,
    "published",
    recentlyPublishedHead.data?.items
  );
  // Счётчик на вкладке стадии и «за N дней» — с первой страницы, она всегда свежая.
  const recentlyPublishedFirst = publishedPage > 1 ? recentlyPublishedHead.data : recentlyPublishedQuery.data;
  // «Статистика TikTok» — та же аудитория, что «Каналы» (requireMarketingRole на
  // сервере, см. routes/tiktok.ts GET /insights).
  const tiktokInsightsQuery = useTikTokInsights(canViewQueue && tab === "channels");
  // «Подборки» — та же аудитория, что «Каналы» (requireMarketingRole на сервере).
  const digestsQuery = useSocialDigests(canViewQueue && tab === "channels");
  const runDigestNow = useRunDigestNow();

  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Маркетинг</h1>
            </div>
          </div>
          <div className="card tight">
            <div className="empty">
              <p>Раздел доступен маркетингу и монтажёрам.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const s = canViewQueue ? summaryQuery.data : undefined;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>{isEditor ? "Монтаж" : "Маркетинг"}</h1>
            <p className="sub">
              Подготовка объекта: проверка, фото, видео, монтаж, публикация. Объект приходит сюда сам и уходит
              сам, когда этап закрыт. Просрочка считается по срокам из Настроек — теми же правилами, что красят
              статус объекта на карточке и штрафуют Royal Score агента.
            </p>
          </div>
          {canViewQueue && (
            <div className="acts">
              <button className="pill ghost" type="button" onClick={() => setTab("channels")}>
                <Radio className="i" aria-hidden />
                Состояние каналов
              </button>
            </div>
          )}
        </div>

        <MarketingTabs />

        {/* Вход в «Ролики в соцсети» (12.10.2026, владелец: «функцию не прятать
            глубоко — на видном месте»): маркетинг заходит сюда каждый день.
            Ссылка целиком, а не кнопка в углу, — попасть можно с любого места карточки. */}
        {canViewQueue && (
          <Link
            to="/social-videos"
            aria-label="Опубликовать промо-ролик во все соцсети"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
              padding: "16px 20px",
              marginBottom: 16,
              borderRadius: "var(--r-lg, 20px)",
              background: "var(--pill)",
              color: "var(--pill-ink)",
            }}
          >
            <Rocket className="i" aria-hidden />
            <span style={{ flex: "1 1 260px", minWidth: 0 }}>
              <b style={{ display: "block", fontSize: 17 }}>Опубликовать промо-ролик во все соцсети</b>
              <span style={{ display: "block", fontSize: 14, opacity: 0.9 }}>
                Загрузите ролик, ИИ напишет подписи — выберите сети и время, остальное сделает CRM.
              </span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
              Открыть
              <ArrowRight className="i" aria-hidden />
            </span>
          </Link>
        )}

        {s && (
          <>
            <div className="tiles">
              <div className="tile">
                <div className="hd">
                  <span className="ic" style={{ ["--c" as string]: "var(--lav)" }}>
                    <List className="i" aria-hidden />
                  </span>
                  Всего в конвейере
                </div>
                <b>{s.total}</b>
                <small>объектов готовятся к продаже</small>
              </div>
              <div className="tile">
                <div className="hd">
                  <span className="ic" style={{ ["--c" as string]: "var(--sky)" }}>
                    <CheckCheck className="i" aria-hidden />
                  </span>
                  Ждут вашего решения
                  {s.awaitingReview > 0 && <span className="dot warn" />}
                </div>
                <b>{s.awaitingReview}</b>
                <small>фото и видео на проверке</small>
              </div>
              <div className="tile">
                <div className="hd">
                  <span className="ic" style={{ ["--c" as string]: "var(--aqua)" }}>
                    <Camera className="i" aria-hidden />
                  </span>
                  Ждут фото
                </div>
                <b>{s.awaitingPhotos}</b>
                <small>агент ещё снимает</small>
              </div>
              <div className="tile">
                <div className="hd">
                  <span className="ic" style={{ ["--c" as string]: "var(--lime)" }}>
                    <Clapperboard className="i" aria-hidden />
                  </span>
                  Ждут видео
                </div>
                <b>{s.awaitingVideo}</b>
                <small>снято, но ещё не смонтировано</small>
              </div>
            </div>

            {/* Просрочка не плиткой, а тихой строкой — как в макете. */}
            {s.overdue > 0 && (
              <div className="card tight">
                <div className="quiet crit">
                  <span className="dot crit" />
                  <span className="txt">
                    {/* Имена — из уже загруженной очереди (страница отсортирована по
                        давности этапа, просроченные почти всегда на первой странице);
                        точное число — из /marketing/summary. Если страница ещё не
                        загружена (открыт «Монтаж»/«Каналы»), показываем только число. */}
                    Просрочено этапов: <b>{s.overdue}</b>
                    {(() => {
                      const named = (queueQuery.data?.items ?? []).filter((r) => r.pipeline.overdue).slice(0, 3);
                      if (named.length === 0) return ".";
                      return (
                        <>
                          :{" "}
                          {named.map((r, i) => (
                            <span key={r.id}>
                              {i > 0 && (i === named.length - 1 ? " и " : ", ")}
                              <Link className="lk" to={`/properties/${r.shortId}`}>
                                №{r.shortId}
                              </Link>{" "}
                              {r.status === "AWAITING_PHOTOS"
                                ? "ждёт фото"
                                : r.status === "AWAITING_VIDEO"
                                  ? "ждёт видео"
                                  : r.status === "EDITING"
                                    ? "на монтаже"
                                    : "на проверке"}{" "}
                              {r.pipeline.daysInStage} дн.
                            </span>
                          ))}
                          {/* «дн.» уже кончается точкой — предложение второй точкой не закрываем (№269). */}
                          {s.overdue > named.length ? `, и ещё ${s.overdue - named.length}.` : ""}
                        </>
                      );
                    })()}
                  </span>
                </div>
              </div>
            )}
          </>
        )}

        {/* Переключатель — только если у роли есть обе вкладки. Монтажёру «Очередь
            подготовки» недоступна (403 на сервере), поэтому кнопки нет вовсе —
            не прятать наполовину рабочую кнопку, а не показывать её вообще. */}
        {canViewQueue && canViewEditorsLoad && (
          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Что показывать">
              <button type="button" role="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>
                <LayoutDashboard className="i" aria-hidden /> Обзор
              </button>
              <button type="button" role="tab" aria-selected={tab === "queue"} onClick={() => setTab("queue")}>
                Очередь подготовки
              </button>
              <button type="button" role="tab" aria-selected={tab === "editors"} onClick={() => setTab("editors")}>
                Нагрузка по монтажёрам
              </button>
              <button type="button" role="tab" aria-selected={tab === "schedule"} onClick={() => setTab("schedule")}>
                <CalendarClock className="i" aria-hidden /> Расписание
              </button>
              <button type="button" role="tab" aria-selected={tab === "channels"} onClick={() => setTab("channels")}>
                <Radio className="i" aria-hidden /> Каналы
              </button>
              <button type="button" role="tab" aria-selected={tab === "search"} onClick={() => setTab("search")}>
                <Search className="i" aria-hidden /> Сайт и поиск
              </button>
            </div>
          </div>
        )}

        {tab === "overview" && canViewQueue && <MarketingOverview onOpenTab={setTab} />}

        {tab === "search" && canViewQueue && <SearchPanel returnStatus={searchReturn} />}

        {tab === "queue" && canViewQueue && (
          <section className="card" data-tabs-scope>
            <div className="sec-h stack">
              <h2>Очередь конвейера</h2>
              <span className="note">объект уходит из очереди сам, когда этап закрыт</span>
            </div>
            {/* Пока грузим или упали — НЕ утверждаем «очередь пуста, все объекты
                готовы»: пустой массив при отказе сервера превращался в бодрый отчёт
                о том, что работы нет, и монтажёр спокойно уходил домой. */}
            <QueueStages
              items={queueRows}
              listState={
                queueQuery.isLoading ? (
                  <div className="state">
                    <span className="sk av" />
                    <span className="sk w40" />
                    <span className="sk w22" /> Загружаем очередь
                  </div>
                ) : queueQuery.error ? (
                  <Rh2ErrorState
                    message="Не удалось загрузить очередь. Попробуйте ещё раз."
                    onRetry={() => queueQuery.refetch()}
                  />
                ) : null
              }
              pager={
                queueQuery.data && (
                  <Pagination
                    variant="loadMore"
                    page={queuePage}
                    pageSize={queueQuery.data.pageSize}
                    total={queueQuery.data.total}
                    onPageChange={setQueuePage}
                  />
                )
              }
              summary={s}
              stage={stage}
              onStage={changeStage}
              queueEmpty={summaryQuery.isSuccess && (s?.total ?? 0) === 0}
              recentlyPublished={recentlyPublishedFirst}
              publishedItems={publishedItems}
              publishedPager={
                recentlyPublishedQuery.data && (
                  <Pagination
                    variant="loadMore"
                    page={publishedPage}
                    pageSize={recentlyPublishedQuery.data.pageSize}
                    total={recentlyPublishedQuery.data.total}
                    onPageChange={setPublishedPage}
                  />
                )
              }
            />
          </section>
        )}

        {tab === "editors" && canViewEditorsLoad && (
          <section className="card">
            <div className="sec-h stack">
              <h2>Монтаж</h2>
              <span className="note">объект ни за кем не закреплён, очередь общая</span>
            </div>
            <p className="state" style={{ paddingTop: 0 }}>
              У объектов на монтаже нет персонального закрепления за монтажёром — этап EDITING ведёт роль
              «Монтажёр» целиком, любой из них может забрать объект в работу. Поэтому ниже общая очередь монтажа
              и список активных монтажёров, а не разбивка по конкретным людям.
            </p>
            {editorsQuery.data && (
              <div className="trio">
                {/* `.trio .n` — не эталонная `.tile` из StatTile (своя раскладка,
                    свой CSS в theme-2026-proto.css), поэтому переход добавлен той
                    же разметкой (`<Link className="n">`), а не заменой на StatTile
                    — иначе плитка потеряла бы стиль `.trio .n`. */}
                <Link className="n" to="/properties?status=EDITING" title="Объекты на монтаже">
                  <b>{editorsQuery.data.sharedQueue.inEditing}</b>
                  <span>на монтаже сейчас</span>
                </Link>
                <Link
                  className="n"
                  to="/properties?status=EDITING&overdue=1"
                  title="Просроченные объекты на монтаже"
                >
                  <b>{editorsQuery.data.sharedQueue.overdue}</b>
                  <span>из них просрочен</span>
                </Link>
                <Link className="n" to="/team?role=EDITOR" title="Монтажёры">
                  <b>{editorsQuery.data.editors.filter((e) => e.isActive).length}</b>
                  <span>монтажёра в работе</span>
                </Link>
              </div>
            )}
            {/* Соседняя вкладка «Очередь» уже различает загрузку/отказ/честную
                пустоту — эта вкладка молча отдавала список пустым массивом
                в обоих неудачных случаях («Монтажёров пока нет.» вместо честного
                «грузится»/«не удалось») — найдено аудитом 22.08.2026. */}
            {editorsQuery.isLoading ? (
              <div className="state">
                <span className="sk av" />
                <span className="sk w40" />
                <span className="sk w22" /> Загружаем монтажёров
              </div>
            ) : editorsQuery.error ? (
              <Rh2ErrorState
                message="Не удалось загрузить монтажёров. Попробуйте ещё раз."
                onRetry={() => editorsQuery.refetch()}
              />
            ) : (
              <EditorsList editors={editorsQuery.data?.editors ?? []} />
            )}
          </section>
        )}

        {tab === "schedule" && canViewQueue && (
          <section className="card">
            <div className="sec-h stack">
              <h2>Расписание публикаций</h2>
              <span className="note">когда выйдет каждый ролик и почему именно тогда</span>
            </div>
            {/* Тот же разбор трёх состояний, что и у соседних вкладок: пустой
                ответ при отказе сервера читался бы как «очередь пуста». */}
            {publishScheduleQuery.isLoading ? (
              <div className="state">
                <span className="sk w40" />
                <span className="sk w22" /> Загружаем расписание
              </div>
            ) : publishScheduleQuery.error ? (
              <Rh2ErrorState
                message="Не удалось загрузить расписание. Попробуйте ещё раз."
                onRetry={() => publishScheduleQuery.refetch()}
              />
            ) : (
              <PublishSchedulePanel data={publishScheduleQuery.data} />
            )}
          </section>
        )}

        {tab === "channels" && canViewQueue && (
          <section className="card">
            <div className="sec-h stack">
              <h2>Каналы публикации</h2>
              {channelsStatusQuery.data && (
                <span className="note">
                  опубликовано объектов {channelsStatusQuery.data.publishedCount}, открытых ошибок{" "}
                  {channelsStatusQuery.data.openErrors}
                </span>
              )}
            </div>
            <ChannelsStatusPanel data={channelsStatusQuery.data} />
          </section>
        )}

        {tab === "channels" && canViewQueue && (
          <section className="card">
            <div className="sec-h stack">
              <h2>Статистика TikTok</h2>
              <span className="note">аккаунт и ролики из открытой статистики TikTok</span>
            </div>
            <TikTokInsightsPanel data={tiktokInsightsQuery.data} />
          </section>
        )}

        {/* ПОДБОРКИ ОБЪЕКТОВ (28.09.2026, agent-brief.md reposts-digests) —
            «5 квартир до X в районе» раз в неделю, одним постом на канал. */}
        {tab === "channels" && canViewQueue && (
          <section className="card">
            <div className="sec-h stack">
              <h2>Подборки объектов</h2>
              <span className="note">«5 квартир до 400 000 сомони в Сино» — раз в неделю, по кругу видов</span>
            </div>
            <DigestsPanel
              data={digestsQuery.data}
              onRunNow={() => runDigestNow.mutate()}
              running={runDigestNow.isPending}
              runError={runDigestNow.isError ? "Не удалось собрать подборку" : runDigestNow.data && !runDigestNow.data.ran ? runDigestNow.data.reason ?? null : null}
            />
          </section>
        )}
      </div>
    </div>
  );
}

/** Заголовок вида подборки для человека — kind хранится по-английски в базе
 *  (SocialDigestPost.kind), экран показывает русское название. */
const DIGEST_KIND_LABELS: Record<string, string> = {
  DISTRICT_BUDGET: "квартиры до бюджета в районе",
  NEW_THIS_WEEK: "новое за неделю",
  ROOMS: "N-комнатные в районе",
};

function DigestsPanel({
  data,
  onRunNow,
  running,
  runError,
}: {
  data: DigestListItem[] | undefined;
  onRunNow: () => void;
  running: boolean;
  runError: string | null;
}) {
  return (
    <div className="mod solve">
      <div className="acts" style={{ marginBottom: "var(--s2)" }}>
        <button className="pill sm" type="button" disabled={running} onClick={onRunNow}>
          {running ? "Собираем…" : "Собрать подборку сейчас"}
        </button>
      </div>
      {runError && (
        <p className="state err">
          <span className="dot crit" />
          {runError}
        </p>
      )}
      {!data ? (
        <div className="state" style={{ paddingTop: 0 }}>
          <span className="sk av" />
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем список
        </div>
      ) : data.length === 0 ? (
        <div className="empty">
          <span className="ic">
            <CheckCheck className="i" aria-hidden />
          </span>
          <p>Подборок пока не было.</p>
        </div>
      ) : (
        <div className="list">
          {data.map((d, i) => (
            <div className="prow wrapt" key={`${d.createdAt}-${i}`}>
              <div className="t">
                <b>{d.title}</b>
                <span>
                  {DIGEST_KIND_LABELS[d.kind] ?? d.kind} · {d.propertyCount} объектов · {exactDateTime(d.createdAt)}
                </span>
              </div>
              <div className="acts" style={{ flexWrap: "wrap" }}>
                {d.channels.map((c) => {
                  const label = channelMeta(c.channel).label;
                  if (c.status === "PUBLISHED" && c.permalink) {
                    return (
                      <a key={c.channel} className="chip ok" href={c.permalink} target="_blank" rel="noreferrer">
                        {label}
                      </a>
                    );
                  }
                  return (
                    <span key={c.channel} className={c.status === "PUBLISHED" ? "chip ok" : c.status === "FAILED" ? "chip crit" : "chip mute"}>
                      {label}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
