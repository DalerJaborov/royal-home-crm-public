import { useCan } from "../../../../lib/permissions";
import { formatMoney, formatMoneyExact, PROPERTY_STATUS_LABELS, pluralizeRu } from "../../../../lib/format";
import { pipelineEmptyText } from "../../../../lib/marketingFocus";
import { useMarketingQueue, useMarketingSummary, type MarketingQueueRow } from "../../../../hooks/useMarketing";
import { useAdsBoard } from "../../../../hooks/useAds";
import { useAiInsights } from "../../../../hooks/useAi";
import type { RoyalIconName } from "../../royalIconData";
import { RhBlockState, RhCircle, RhGroup, RhRow, RhSection, RhTile } from "../../ui";
import { firstPhoto, HomeMore, HomeQuick, PropertyLead, useExpandable, type HomeQuickItem } from "../parts";

/**
 * БЛОКИ ГЛАВНОЙ МАРКЕТИНГА (ядро главной, пачка home, 20.11.2026).
 *
 * Те же запросы, что у прежних MarketingHome (ПК) и MobileMarketingHome (телефон):
 * `useMarketingSummary`, `useMarketingQueue(1)`, `useAiInsights().staleProperties`
 * и недельная сводка рекламы `useAdsBoard("7d")` (прежде только на телефоне).
 */
const STATUS_ICON: Partial<Record<string, RoyalIconName>> = {
  PENDING_REVIEW: "eye",
  AWAITING_PHOTOS: "image",
  AWAITING_VIDEO: "clapperboard",
};
const objects = (count: number) => pluralizeRu(count, ["объект", "объекта", "объектов"]);
const canSeePipeline = (can: ReturnType<typeof useCan>) => can("properties.moderate") || can("properties.aiListing");

/**
 * «Что горит» — одно правило на два блока («Горит сейчас» и «Далее по приоритету»):
 * просроченный объект, иначе ждущий проверки; остальное — очередь дальше.
 */
function useMarketingFocus() {
  const summary = useMarketingSummary();
  const queue = useMarketingQueue(1);
  const s = summary.data;
  const items = queue.data?.items ?? [];
  const overdueItem = s && s.overdue > 0 ? items.find((it) => it.pipeline.overdue) ?? items[0] : undefined;
  const reviewItem = !overdueItem && s && s.awaitingReview > 0 ? items.find((it) => it.status === "PENDING_REVIEW") ?? items[0] : undefined;
  const focus = overdueItem ?? reviewItem;
  return {
    summary, queue, s, focus, overdue: !!overdueItem,
    rest: items.filter((it) => it.id !== focus?.id),
    loading: summary.isLoading || queue.isLoading,
    retry: () => { void summary.refetch(); void queue.refetch(); },
  };
}

export function MarketingTiles() {
  const { data: s, isError } = useMarketingSummary();
  const n = (value: number | undefined) => (s ? value ?? 0 : "—");
  return (
    <div className="ry-strip ry-strip-tiles" data-tiles="5">
      <RhTile variant="brand" icon="eye" label="Ждут проверки" value={n(s?.awaitingReview)} to="/properties?status=PENDING_REVIEW" alert={isError} />
      <RhTile variant="ink" icon="hourglass" label="Просрочено" value={n(s?.overdue)} to="#ry-home-focus" />
      <RhTile variant="plain" icon="image" label="Ждут фото" value={n(s?.awaitingPhotos)} to="/properties?status=AWAITING_PHOTOS" />
      <RhTile variant="plain" icon="clapperboard" label="Ждут видео" value={n(s?.awaitingVideo)} to="/properties?status=AWAITING_VIDEO" />
      <RhTile variant="plain" icon="building-2" label="Всего объектов" value={n(s?.total)} to="/properties" />
    </div>
  );
}

export function MarketingQuick() {
  const can = useCan();
  const queue = useMarketingQueue(1);
  const items: HomeQuickItem[] = [
    { key: "objects", label: "Объекты", icon: "building-2", to: "/properties", tone: "a1" },
    ...(can("reports.view") ? [{ key: "reports", label: "Отчёты", icon: "chart-no-axes-column" as const, to: "/reports", tone: "a4" as const }] : []),
    // Пункт «Реклама» открыт маркетингу по роли (navigation.ts), право не нужно.
    { key: "ads", label: "Реклама", icon: "megaphone", to: "/ads", tone: "a2" },
    ...(canSeePipeline(can) ? [{ key: "queue", label: "Очередь", icon: "stack" as const, to: "/pipeline", tone: "a0" as const, count: queue.data?.total }] : []),
  ];
  return <HomeQuick items={items} />;
}

export function MarketingFocus() {
  const { summary, queue, s, focus, overdue, loading, retry } = useMarketingFocus();
  return (
    <RhSection id="ry-home-focus" title="Горит сейчас" className="ry-col-a">
      {loading ? <RhBlockState kind="loading" />
        // Отказ любого из двух запросов — фокус считать не из чего, и это не «всё спокойно».
        : summary.isError || queue.isError ? <RhBlockState kind="error" onRetry={retry} />
        : <RhGroup>
          {focus && s ? (
            <RhRow to={`/properties/${focus.shortId}`}
              lead={<PropertyLead photo={firstPhoto(focus)} icon={overdue ? "flame" : "eye"} tone={overdue ? "crit" : "warn"} />}
              title={focus.title}
              sub={overdue
                ? `ещё ${s.overdue} ${objects(s.overdue)} просрочены в подготовке, чем дольше висят, тем позже уйдут на сайт`
                : `${s.awaitingReview} ${objects(s.awaitingReview)} ждут проверки, без неё карточка не публикуется`}
              subTone={overdue ? "crit" : "warn"} />
          ) : <RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title={pipelineEmptyText(s?.total)} />}
          {s && (
            <RhRow to="/marketing" lead={<RhCircle icon="stack" tone="a0" />} title="Весь конвейер"
              sub={`${s.awaitingReview} ждут проверки, ${s.awaitingPhotos} без фото, ${s.awaitingVideo} без видео, ${s.editing} на монтаже${s.overdue > 0 ? `, просрочено ${s.overdue}` : ", просроченных нет"}`}
              right={<b className="ry-num ry-count">{s.total}</b>} />
          )}
        </RhGroup>}
    </RhSection>
  );
}

export function MarketingQueue() {
  const can = useCan();
  const { queue, rest, loading, retry } = useMarketingFocus();
  const list = useExpandable(rest, rest.length);
  return (
    <RhSection title="Далее по приоритету" to={canSeePipeline(can) ? "/pipeline" : undefined} className="ry-col-a">
      {loading ? <RhBlockState kind="loading" />
        : queue.isError ? <RhBlockState kind="error" onRetry={retry} />
        : rest.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Очередь пуста" /></RhGroup>
        : <RhGroup>
          {list.visible.map((item) => <PriorityRow key={item.id} item={item} />)}
          <HomeMore rest={list.rest} onClick={list.more} />
        </RhGroup>}
    </RhSection>
  );
}

export function MarketingAds() {
  const ads = useAdsBoard("7d");
  const totals = ads.data?.totals;
  // Сервер отдаёт обращения из кабинета Meta, а не заявки CRM — подпись честная, как на «Рекламе».
  const perConversation = totals && totals.conversations > 0 ? totals.periodTjs / totals.conversations : null;
  return (
    <RhSection title="Реклама за неделю" to="/ads" className="ry-col-b">
      {ads.isLoading ? <RhBlockState kind="loading" />
        : ads.isError ? <RhBlockState kind="error" onRetry={() => void ads.refetch()} />
        : !totals || ads.data?.enabled === false ? <RhGroup><RhRow lead={<RhCircle icon="megaphone" tone="a0" />} title="Рекламный кабинет не подключён" /></RhGroup>
        : <RhGroup>
          <RhRow lead={<RhCircle icon="banknote" tone="a2" />} title="Расход за неделю" right={<b className="ry-num ry-home-value">{formatMoneyExact(totals.periodTjs, "TJS")}</b>} />
          <RhRow lead={<RhCircle icon="message-circle" tone="a0" />} title="Обращений с рекламы" right={<b className="ry-num ry-count">{totals.conversations}</b>} />
          {perConversation !== null && (
            <RhRow lead={<RhCircle icon="target" tone="a4" />} title="Цена обращения" right={<b className="ry-num ry-home-value">{formatMoneyExact(perConversation, "TJS")}</b>} />
          )}
        </RhGroup>}
    </RhSection>
  );
}

export function MarketingStale() {
  const { data } = useAiInsights();
  const stale = data?.staleProperties ?? [];
  const list = useExpandable(stale, stale.length);
  if (!stale.length) return null;
  return (
    <RhSection title="Объекты простаивают" className="ry-col-b">
      <RhGroup>
        {list.visible.map((p) => (
          <RhRow key={p.id} to={`/properties/${p.shortId}`}
            lead={<RhCircle icon="hourglass" tone="warn" />}
            title={`${p.title}, ${formatMoney(p.price, p.currency)}`}
            sub={`${p.daysSinceCreated} ${pluralizeRu(p.daysSinceCreated, ["день", "дня", "дней"])} без показов${p.diffPercent != null ? `, цена ${p.diffPercent > 0 ? "выше" : "ниже"} медианы на ${Math.abs(p.diffPercent)} %` : ""}`}
            subTone="warn" />
        ))}
        <HomeMore rest={list.rest} onClick={list.more} />
      </RhGroup>
    </RhSection>
  );
}

function PriorityRow({ item }: { item: MarketingQueueRow }) {
  const overdue = item.pipeline.overdue;
  return (
    <RhRow to={`/properties/${item.shortId}`}
      lead={<PropertyLead photo={firstPhoto(item)} icon={STATUS_ICON[item.status] ?? "building-2"} tone={overdue ? "crit" : "a0"} />}
      title={item.title}
      sub={`${PROPERTY_STATUS_LABELS[item.status]}${item.pipeline.inPipeline ? `, ${item.pipeline.daysInStage} дн` : ""}${overdue ? ", просрочено" : ""}${item.reviewRejectionReason ? `, ${item.reviewRejectionReason}` : ""}`}
      subTone={overdue ? "crit" : undefined}
      right={<span className="ry-row-time">{item.photoCount} фото</span>} />
  );
}
