import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Camera, ClipboardCheck, Clapperboard, ChevronRight, BarChart3, Home, Megaphone, Workflow } from "lucide-react";
import { useAuthStore } from "../../../store/auth";
import { useCan } from "../../../lib/permissions";
import { useMarketingQueue, useMarketingSummary, type MarketingQueueRow } from "../../../hooks/useMarketing";
import { useAdsBoard } from "../../../hooks/useAds";
import { useAiInsights } from "../../../hooks/useAi";
import { formatMoney, formatMoneyExact, PROPERTY_STATUS_LABELS, pluralizeRu } from "../../../lib/format";
import { pipelineEmptyText } from "../../../lib/marketingFocus";
import { MhNoData, MhQuick, MhScreen, MhSection, type MhQuickItem } from "./MhScreen";
import type { PropertyStatus } from "@royal-home/shared";

/**
 * ГЛАВНАЯ МАРКЕТИНГА НА ТЕЛЕФОНЕ — обёртка `MhScreen` вокруг тех же данных,
 * что у `components/home/MarketingHome.tsx` (десктоп): `useMarketingSummary`,
 * `useMarketingQueue`, `useAiInsights().staleProperties`. Права и запросы не
 * менялись, поменялась только разметка — с разметки пульта (`.rh2 screens`,
 * `.card aib`, `.tiles` без `.v`/`.l`) на разметку мобильного артефакта
 * (`.rh2 .mh`, `.sec`, `.card-s`, `.tile .v .l`), которой держатся Агент/
 * Директор/Менеджер (раздел 3, п.1 плана переноса 14.09.2026).
 *
 * Классы двух тем не взаимозаменяемы: `.card aib`/`.tiles .tile .hd` живут
 * только в `.rh2 .screens` (theme-2026-proto.css), а `.mh .tile .v`/`.mh .row`
 * только в `.rh2 .mh` (theme-2026-mobile-home.css) — раньше на этом же месте
 * уже ловили баг «класс верный, а стиля нет» (`.hidden` vs `.flex`,
 * CLAUDE.md → «Ловушки репозитория»), поэтому тело переписано под вторую
 * тему, а не просто обёрнуто как есть.
 */
export function MobileMarketingHome() {
  const agent = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  const can = useCan();
  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    error: summaryErrorObj,
    refetch: refetchSummary,
  } = useMarketingSummary();
  const {
    data: queue,
    isLoading: queueLoading,
    isError: queueError,
    refetch: refetchQueue,
  } = useMarketingQueue(1);
  const { data: insights } = useAiInsights();
  const staleProperties = insights?.staleProperties ?? [];
  // Блок «Реклама» из макета (renderHomeMarketing, две-три плитки): тот же
  // период "7d" и тот же ресурс, что использует страница pages/Ads.tsx —
  // новых эндпоинтов нет. Сервер отдаёт «обращения» (Meta conversations), а
  // не заявки CRM с источником «реклама», поэтому подпись честная — как на
  // самой странице «Реклама» (Ads.tsx), а не выдуманное «лидов».
  const adsBoard = useAdsBoard("7d");
  const adsTotals = adsBoard.data?.totals;
  const perConversation = adsTotals && adsTotals.conversations > 0 ? adsTotals.periodTjs / adsTotals.conversations : null;
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const [restExpanded, setRestExpanded] = useState(false);
  const [staleExpanded, setStaleExpanded] = useState(false);

  const items = queue?.items ?? [];
  const isLoading = summaryLoading || queueLoading;
  const isError = summaryError || queueError;

  const overdueItem = summary && summary.overdue > 0 ? items.find((it) => it.pipeline.overdue) ?? items[0] : undefined;
  const reviewItem =
    !overdueItem && summary && summary.awaitingReview > 0
      ? items.find((it) => it.status === "PENDING_REVIEW") ?? items[0]
      : undefined;
  const focus = overdueItem ?? reviewItem;
  const focusReason: "overdue" | "review" | null = overdueItem ? "overdue" : reviewItem ? "review" : null;

  const rest = items.filter((it) => it.id !== focus?.id);
  const visibleRest = restExpanded ? rest : rest.slice(0, 5);
  const visibleStale = staleExpanded ? staleProperties : staleProperties.slice(0, 5);

  // Ряд быстрых кнопок макета — «Объекты, Отчёты, Реклама, Очередь». «Очередь»
  // ведёт в «Подготовку объектов» (/pipeline, до 25.09.2026 — «Конвейер»; тот
  // же раздел, что открывает пункт меню «Подготовка объектов» этой роли,
  // navigation.ts) — счётчик честный: длина уже загруженной этой же страницей
  // очереди подготовки.
  const marketingVisible = can("properties.moderate") || can("properties.aiListing");
  const rawQuickActions: (MhQuickItem | false)[] = [
    { key: "объекты", tone: "aqua", label: "Объекты", icon: Home, href: "/properties" },
    can("reports.view") && { key: "отчёты", tone: "lav", label: "Отчёты", icon: BarChart3, href: "/reports" },
    // Пункт меню «Реклама» доступен маркетингу по роли безусловно
    // (navigation.ts: `can("finance.view") || role === "MARKETING"`) — этот
    // экран рендерится только для роли MARKETING, право проверять незачем.
    { key: "реклама", tone: "lime", label: "Реклама", icon: Megaphone, href: "/ads" },
    marketingVisible && { key: "очередь", label: "Очередь", icon: Workflow, href: "/pipeline", tone: "aqua", count: queue ? queue.total : undefined },
  ];
  const quickItems = rawQuickActions.filter((x): x is MhQuickItem => Boolean(x));

  return (
    <MhScreen greeting={`Салом${firstName ? `, ${firstName}` : ""}`}>
      <MhQuick items={quickItems} />
      {summary && (
        <section className="sec" style={{ marginTop: 6 }}>
          <div className="sec-t">
            <h2>Подготовка объектов</h2>
          </div>
          <div className="tiles">
            <PipelineTile
              icon={ClipboardCheck}
              label="Ждут проверки"
              value={summary.awaitingReview}
              line="без проверки карточка не публикуется"
              crit={summary.awaitingReview > 0}
              onOpen={() => navigate("/properties?status=PENDING_REVIEW")}
            />
            <PipelineTile
              icon={Camera}
              label="Ждут фото"
              value={summary.awaitingPhotos}
              line="съёмка ещё не сдана"
              onOpen={() => navigate("/properties?status=AWAITING_PHOTOS")}
            />
            <PipelineTile
              icon={Clapperboard}
              label="Ждут видео"
              value={summary.awaitingVideo}
              line="уйдут монтажёру после фото"
              onOpen={() => navigate("/properties?status=AWAITING_VIDEO")}
            />
            <PipelineTile
              icon={Building2}
              label="Всего объектов"
              value={summary.total}
              line={`просрочено ${summary.overdue}`}
              crit={summary.overdue > 0}
              onOpen={() => navigate("/properties")}
            />
          </div>
        </section>
      )}

      <MhSection title="Горит сейчас" note="одна кнопка на строку">
        {isLoading ? (
          <MhNoData>Загружаем конвейер подготовки…</MhNoData>
        ) : isError ? (
          <MhNoData tone="crit">
            {summaryErrorObj instanceof Error ? summaryErrorObj.message : "Очередь не загрузилась, проверьте соединение."}{" "}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                refetchSummary();
                refetchQueue();
              }}
            >
              Повторить
            </button>
          </MhNoData>
        ) : focus && summary && focusReason ? (
          <div className="card-s">
            <button type="button" className="row" onClick={() => navigate(`/properties/${focus.shortId}`)}>
              <span
                className="av"
                style={focusReason === "overdue" ? { background: "var(--pink)", color: "var(--pink-ink)" } : { background: "var(--sky)", color: "var(--sky-ink)" }}
                aria-hidden="true"
              >
                {focusReason === "overdue" ? "!!" : "ПР"}
              </span>
              <span className="t" style={{ textAlign: "left" }}>
                <span className="n">{focus.title}</span>
                <span className="s warn">
                  {focusReason === "overdue"
                    ? `ещё ${summary.overdue} ${pluralizeRu(summary.overdue, ["объект", "объекта", "объектов"])} просрочены в подготовке`
                    : `${summary.awaitingReview} ${pluralizeRu(summary.awaitingReview, ["объект", "объекта", "объектов"])} ждут проверки`}
                </span>
              </span>
              <ChevronRight className="i" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <MhNoData tone="ok">{pipelineEmptyText(summary?.total)}</MhNoData>
        )}
      </MhSection>

      <MhSection title="Далее по приоритету" note={rest.length || undefined}>
        {rest.length === 0 ? (
          <MhNoData tone="ok">Очередь пуста.</MhNoData>
        ) : (
          <div className="card-s">
            {visibleRest.map((item) => (
              <PriorityRow key={item.id} item={item} onOpen={() => navigate(`/properties/${item.shortId}`)} />
            ))}
            {rest.length > visibleRest.length && (
              <button type="button" className="row morerow" onClick={() => setRestExpanded(true)}>
                <span className="t">
                  <span className="n">Показать ещё ({rest.length - visibleRest.length})</span>
                </span>
              </button>
            )}
          </div>
        )}
      </MhSection>

      {staleProperties.length > 0 && (
        <MhSection title="Объекты простаивают" note={staleProperties.length}>
          <div className="card-s">
            {visibleStale.map((p) => (
              <button
                key={p.id}
                type="button"
                className="row"
                onClick={() => navigate(`/properties/${p.shortId}`)}
              >
                <span className="av" style={{ background: "var(--pink)", color: "var(--pink-ink)" }} aria-hidden="true">
                  {p.daysSinceCreated}
                </span>
                <span className="t" style={{ textAlign: "left" }}>
                  <span className="n">
                    {p.title}, {formatMoney(p.price, p.currency)}
                  </span>
                  <span className="s">
                    {p.daysSinceCreated} {pluralizeRu(p.daysSinceCreated, ["день", "дня", "дней"])} без показов
                    {p.diffPercent != null &&
                      `, цена ${p.diffPercent > 0 ? "выше" : "ниже"} медианы на ${Math.abs(p.diffPercent)} %`}
                  </span>
                </span>
                <ChevronRight className="i" aria-hidden="true" />
              </button>
            ))}
            {staleProperties.length > visibleStale.length && (
              <button type="button" className="row morerow" onClick={() => setStaleExpanded(true)}>
                <span className="t">
                  <span className="n">Показать ещё ({staleProperties.length - visibleStale.length})</span>
                </span>
              </button>
            )}
          </div>
        </MhSection>
      )}

      <MhSection title="Реклама" note="за неделю">
        {adsBoard.isLoading ? (
          <MhNoData>Загружаем расход на рекламу…</MhNoData>
        ) : adsBoard.isError ? (
          <MhNoData tone="crit">Реклама не загрузилась, проверьте соединение.</MhNoData>
        ) : !adsTotals || adsBoard.data?.enabled === false ? (
          <MhNoData>Нет данных: рекламный кабинет не подключён</MhNoData>
        ) : (
          <div className="tiles">
            <div className="tile">
              <div className="v">{formatMoneyExact(adsTotals.periodTjs, "TJS")}</div>
              <div className="l">расход за неделю</div>
            </div>
            <div className="tile">
              <div className="v">{adsTotals.conversations}</div>
              <div className="l">обращений с рекламы</div>
            </div>
            {perConversation !== null && (
              <div className="tile">
                <div className="v">{formatMoneyExact(perConversation, "TJS")}</div>
                <div className="l">цена обращения</div>
              </div>
            )}
          </div>
        )}
      </MhSection>
    </MhScreen>
  );
}

function PipelineTile({
  icon: Icon,
  label,
  value,
  line,
  crit = false,
  onOpen,
}: {
  icon: typeof Building2;
  label: string;
  value: number;
  line: string;
  crit?: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="tile" onClick={onOpen}>
      <Icon className="i" strokeWidth={1.5} aria-hidden="true" />
      <div className={crit ? "v crit" : "v"}>{value}</div>
      <div className={crit ? "l crit" : "l"}>
        {label} · {line}
      </div>
    </button>
  );
}

function PriorityRow({ item, onOpen }: { item: MarketingQueueRow; onOpen: () => void }) {
  const Icon = STATUS_ICONS[item.status] ?? Building2;
  return (
    <button type="button" className="row" onClick={onOpen}>
      <span
        className="plate soft"
        style={item.pipeline.overdue ? { background: "var(--pink)", color: "var(--pink-ink)" } : undefined}
        aria-hidden="true"
      >
        <Icon className="i" />
      </span>
      <span className="t" style={{ textAlign: "left" }}>
        <span className="n">{item.title}</span>
        <span className="s">
          {PROPERTY_STATUS_LABELS[item.status]}
          {item.pipeline.inPipeline ? `, ${item.pipeline.daysInStage} дн` : ""}
          {item.reviewRejectionReason ? `, ${item.reviewRejectionReason}` : ""}
        </span>
      </span>
      <ChevronRight className="i" aria-hidden="true" />
    </button>
  );
}

const STATUS_ICONS: Partial<Record<PropertyStatus, typeof Building2>> = {
  PENDING_REVIEW: ClipboardCheck,
  AWAITING_PHOTOS: Camera,
  AWAITING_VIDEO: Clapperboard,
};
