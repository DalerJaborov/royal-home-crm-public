import { todayLabel } from "../../lib/format";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Camera, ClipboardCheck, Clapperboard } from "lucide-react";
import { useAuthStore } from "../../store/auth";
import { useMarketingQueue, useMarketingSummary, type MarketingQueueRow } from "../../hooks/useMarketing";
import { useAiInsights } from "../../hooks/useAi";
import { HomeAppHeader, HomePageHead } from "./HomeHead";
import { HomeAsk } from "./HomeAsk";
import { formatMoney, PROPERTY_STATUS_LABELS, pluralizeRu } from "../../lib/format";
import { pipelineEmptyText } from "../../lib/marketingFocus";
import type { PropertyStatus } from "@royal-home/shared";

/**
 * Мобильная Главная — маркетинг. Разметка перенесена дословно из прототипа
 * темы «Royal Home 2026» (`docs/pult/theme-2026/screens/home-marketing.html`):
 * `.sec-t` + `.tiles` (4 плитки конвейера), `section.card.aib` с «Горит сейчас»,
 * дальше короткие карточки `.card.tight` с `.sec-h` и списком `.list`/`.row`,
 * по 5 строк и «Показать ещё».
 *
 * Данные и права не менялись: `useMarketingSummary`/`useMarketingQueue` и
 * `useAiInsights().staleProperties`. Кнопки звонка здесь нет: у пресета
 * MARKETING нет ни клиентов, ни телефонии.
 *
 * Шапка `MobileHomeHeader` остаётся выше области `.rh2` — это рамка приложения
 * (договор §4), поэтому `.pg-h` эталона здесь не повторяется.
 */
export function MarketingHome() {
  const agent = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useMarketingSummary();
  const {
    data: queue,
    isLoading: queueLoading,
    isError: queueError,
    error: queueErrorObj,
    refetch: refetchQueue,
  } = useMarketingQueue(1);
  // Инсайт «Объект простаивает» (Dashboard.tsx::buildInsightItems) — из восьми
  // категорий /ai/insights маркетологу релевантна только эта.
  const { data: insights } = useAiInsights();
  const staleProperties = insights?.staleProperties ?? [];
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const [restExpanded, setRestExpanded] = useState(false);
  const [staleExpanded, setStaleExpanded] = useState(false);

  const items = queue?.items ?? [];
  const isLoading = summaryLoading || queueLoading;
  // Карточка «Горит сейчас» строится из ОБОИХ запросов (что делать — из очереди,
  // почему это важно — из сводки), поэтому отказ любого из них означает, что
  // фокус посчитать не из чего.
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

  return (
    <>
      <HomeAppHeader firstName={firstName} />
      <div className="rh2 screens">
        <div className="scr" data-stagger>
          <HomePageHead title="Главная" sub={`${agent?.fullName ?? ""}, маркетинг. ${todayLabel()}.${summary ? ` В конвейере ${summary.total} ${pluralizeRu(summary.total, ["объект", "объекта", "объектов"])}, ${summary.awaitingReview} ${pluralizeRu(summary.awaitingReview, ["ждёт", "ждут", "ждут"])} вашей проверки.` : ""}`} />
          {summary && (
            <>
              <div className="sec-t">Подготовка объектов</div>
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
            </>
          )}

          <section className="card aib" aria-labelledby="aib-hi">
            <div className="aib-now">
              <i aria-hidden="true" />
              <span className="tx">слежу за рекламой и заявками с неё</span>
            </div>
            <div className="aib-hd">
              <h2 className="aib-hi" id="aib-hi">
                Салом{firstName ? `, ${firstName}` : ""}. Сначала это:
              </h2>
            </div>

            <div className="aib-fire">
              <div className="aib-fh">
                <h3>Горит сейчас</h3>
                <span className="note">одна кнопка на строку</span>
              </div>
              {isLoading ? (
                <div className="state">
                  <span className="sk w40" /> Загружаем конвейер подготовки
                </div>
              ) : isError ? (
                /* «В конвейере подготовки пусто» при отказе — обещание свободного дня:
                   объекты стоят в проверке/фото/видео и продолжают просрочиваться,
                   просто их список не доехал до экрана. */
                <div className="state err">
                  <span className="dot crit" />
                  {queueErrorObj instanceof Error ? queueErrorObj.message : "Очередь не загрузилась, проверьте соединение."}
                  <button
                    type="button"
                    className="lnk"
                    onClick={() => {
                      refetchSummary();
                      refetchQueue();
                    }}
                  >
                    Повторить
                  </button>
                </div>
              ) : focus && summary && focusReason ? (
                <div className="list">
                  <div className="row wrapt">
                    <span
                      className="av"
                      style={
                        focusReason === "overdue"
                          ? { background: "var(--pink)", color: "var(--pink-ink)" }
                          : { background: "var(--sky)", color: "var(--sky-ink)" }
                      }
                      aria-hidden="true"
                    >
                      {focusReason === "overdue" ? "!!" : "ПР"}
                    </span>
                    <div className="t">
                      <b>{focus.title}</b>
                      <span>
                        {focusReason === "overdue"
                          ? `ещё ${summary.overdue} ${pluralizeRu(summary.overdue, ["объект", "объекта", "объектов"])} просрочены в подготовке, чем дольше висят, тем позже уйдут на сайт`
                          : `${summary.awaitingReview} ${pluralizeRu(summary.awaitingReview, ["объект", "объекта", "объектов"])} ждут проверки, без неё карточка не публикуется`}
                      </span>
                    </div>
                    <div className="act">
                      <button
                        className="pill sm"
                        type="button"
                        data-endpoint="GET /api/v1/properties"
                        onClick={() => navigate(`/properties/${focus.shortId}`)}
                      >
                        Открыть
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="quiet">
                  <span className="dot ok" />
                  <span className="txt">{pipelineEmptyText(summary?.total)}</span>
                </p>
              )}
            </div>

            {/* Доклад одной фразой — из сводки конвейера, без выдуманных чисел. */}
            {summary && (
              <p className="aib-rep">
                В конвейере{" "}
                <button className="lk" type="button" onClick={() => navigate("/marketing")}>
                  {summary.total} {pluralizeRu(summary.total, ["объект", "объекта", "объектов"])}
                </button>
                : {summary.awaitingReview} {pluralizeRu(summary.awaitingReview, ["ждёт", "ждут", "ждут"])} вашей проверки,{" "}
                {summary.awaitingPhotos} без фото, {summary.awaitingVideo} без видео, {summary.editing} на монтаже.
                {summary.overdue > 0 ? (
                  <>
                    {" "}
                    <b>Просрочено {summary.overdue}</b>: чем дольше висят, тем позже уйдут на сайт.
                  </>
                ) : (
                  " Просроченных нет."
                )}
              </p>
            )}
            <HomeAsk
              ariaLabel="Вопрос про конвейер и рекламу"
              placeholder="Спросить: какие объекты застряли в подготовке?"
              suggestions={["Какие объекты просрочены в подготовке?", "Что ждёт моей проверки?"]}
            />
          </section>

          {rest.length > 0 && (
            <div className="card tight">
              <div className="sec-h">
                <h2>Далее по приоритету</h2>
                <span className="note">{rest.length} в очереди</span>
              </div>
              <div className="list">
                {visibleRest.map((item) => (
                  <PriorityRow key={item.id} item={item} onOpen={() => navigate(`/properties/${item.shortId}`)} />
                ))}
              </div>
              {!restExpanded && rest.length > visibleRest.length && (
                <button type="button" className="lnk" onClick={() => setRestExpanded(true)}>
                  Показать ещё ({rest.length - visibleRest.length})
                </button>
              )}
            </div>
          )}

          {staleProperties.length > 0 && (
            <div className="card tight">
              <div className="sec-h">
                <h2>Объекты простаивают</h2>
                <span className="note">{staleProperties.length} без показов</span>
              </div>
              <div className="list">
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
                    <div className="t">
                      <b>
                        {p.title}, {formatMoney(p.price, p.currency)}
                      </b>
                      <span>
                        {p.daysSinceCreated} {pluralizeRu(p.daysSinceCreated, ["день", "дня", "дней"])} без показов
                        {p.diffPercent != null &&
                          `, цена ${p.diffPercent > 0 ? "выше" : "ниже"} медианы на ${Math.abs(p.diffPercent)} %`}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              {!staleExpanded && staleProperties.length > visibleStale.length && (
                <button type="button" className="lnk" onClick={() => setStaleExpanded(true)}>
                  Показать ещё ({staleProperties.length - visibleStale.length})
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
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
      <div className="hd">
        <span className="ic" aria-hidden="true">
          <Icon className="i" strokeWidth={1.5} />
        </span>
        {label}
        <span className={crit ? "dot crit" : "dot ok"} aria-hidden="true" />
      </div>
      <b>{value}</b>
      <small className={crit ? "crit" : undefined}>{line}</small>
    </button>
  );
}

function PriorityRow({ item, onOpen }: { item: MarketingQueueRow; onOpen: () => void }) {
  const Icon = STATUS_ICONS[item.status] ?? Building2;
  return (
    <button type="button" className="row" onClick={onOpen}>
      <span
        className="av"
        style={item.pipeline.overdue ? { background: "var(--pink)", color: "var(--pink-ink)" } : undefined}
        aria-hidden="true"
      >
        <Icon className="i" />
      </span>
      <div className="t">
        <b>{item.title}</b>
        <span>
          {PROPERTY_STATUS_LABELS[item.status]}
          {item.pipeline.inPipeline ? `, ${item.pipeline.daysInStage} дн` : ""}
          {item.reviewRejectionReason ? `, ${item.reviewRejectionReason}` : ""}
        </span>
      </div>
      <span className="meta">{item.photoCount} фото</span>
    </button>
  );
}

const STATUS_ICONS: Partial<Record<PropertyStatus, typeof Building2>> = {
  PENDING_REVIEW: ClipboardCheck,
  AWAITING_PHOTOS: Camera,
  AWAITING_VIDEO: Clapperboard,
};
