import { useState } from "react";
import { pluralizeRu } from "../../../../lib/format";
import { useMobileUx } from "../../../../hooks/useMobileUx";
import { useEditorQueue, type MarketingQueueRow } from "../../../../hooks/useMarketing";
import { useAccumulatedPages } from "../../../../hooks/useAccumulatedPages";
import { RhCircle, RhGroup, RhRow, RhSection, RhTile, blockState } from "../../ui";
import { firstPhoto, HomeHint, HomeMore, HomeQuick, PropertyLead, PropertyState, useExpandable } from "../parts";

/**
 * БЛОКИ ГЛАВНОЙ МОНТАЖЁРА (ядро главной, пачка home, 20.11.2026).
 *
 * Тот же `useEditorQueue`, что у прежних EditorDashboard (ПК) и MobileEditorHome
 * (телефон). У каждого списка своя страница («Показать ещё» догружает следующую);
 * плитки берут первую страницу — тот же ключ кэша, второго похода нет.
 */
export function EditorTiles() {
  const { data, isError } = useEditorQueue(true, { editingPage: 1, upcomingPage: 1 });
  const count = (value: number | undefined) => (data ? value ?? 0 : "—");
  return (
    <div className="ry-strip ry-strip-tiles" data-tiles="3">
      <RhTile variant="brand" icon="clapperboard" label="На монтаже" value={count(data?.counts.inEditing)} to="/properties?status=EDITING" alert={isError} />
      {/* Срочная (чёрная) — только при просрочке, как прежнее critical={overdue > 0}. */}
      <RhTile variant={(data?.counts.overdue ?? 0) > 0 ? "ink" : "plain"} icon="hourglass" label="Просрочено" value={count(data?.counts.overdue)} to="/properties?status=EDITING&overdue=1" />
      <RhTile variant="plain" icon="image" label="Скоро придёт" value={count(data?.counts.upcoming)} to="/properties?status=AWAITING_VIDEO" />
    </div>
  );
}

export function EditorQuick() {
  const { data } = useEditorQueue(true, { editingPage: 1, upcomingPage: 1 });
  return (
    <HomeQuick items={[
      { key: "objects", label: "Объекты", icon: "building-2", to: "/properties", tone: "a5" },
      { key: "editing", label: "Монтаж", icon: "clapperboard", to: "/marketing", tone: "a1", count: data?.counts.inEditing },
      { key: "soon", label: "Сроки", icon: "clock", to: "/properties?status=AWAITING_VIDEO", tone: "a3", count: data?.counts.upcoming },
    ]} />
  );
}

/** Подсказка — те же id и тексты, что у прежних главных ПК и телефона (закрытие уже сохранено у людей). */
export function EditorHint() {
  const mobile = useMobileUx();
  return mobile ? (
    <HomeHint id="editor-dashboard-intro-mobile">
      Объект попадает в «На монтаже» сам, как только маркетинг одобрил фото и видео, и уходит отсюда, когда вы
      вставите в карточку ссылку на опубликованный обзор. «Скоро на монтаж» — объекты, для которых агент ещё
      снимает видео.
    </HomeHint>
  ) : (
    <HomeHint id="editor-dashboard-intro">
      Это ваша очередь. Объект попадает в «На монтаже» сам, как только маркетинг одобрил фото и видео, и уходит
      отсюда, когда вы вставите в карточку ссылку на опубликованный обзор в Instagram. «Скоро на монтаж» это
      объекты, для которых агент ещё снимает видео: работой они станут через день-два. Сроки этапов и просрочка
      берутся из Настроек CRM.
    </HomeHint>
  );
}

/** Одна из двух очередей с собственной догрузкой страниц. */
function useEditorList(kind: "editing" | "upcoming") {
  const mobile = useMobileUx();
  const [page, setPage] = useState(1);
  const pages = kind === "editing" ? { editingPage: page, upcomingPage: 1 } : { editingPage: 1, upcomingPage: page };
  const query = useEditorQueue(true, pages);
  const head = useEditorQueue(page > 1, { editingPage: 1, upcomingPage: 1 });
  const pick = (q: typeof query.data) => (kind === "editing" ? q?.inEditing : q?.upcoming);
  const rows = useAccumulatedPages(pick(query.data), page, kind, pick(head.data));
  const data = query.data ?? head.data;
  const total = (kind === "editing" ? data?.counts.inEditing : data?.counts.upcoming) ?? rows.length;
  const sorted = kind === "editing" ? [...rows].sort((a, b) => Number(b.pipeline.overdue) - Number(a.pipeline.overdue)) : rows;
  // ПК — как прежний EditorDashboard: весь пришедший список и одно нажатие = следующая страница.
  // Телефон — как прежняя MobileEditorHome: сначала пять, «Показать ещё» раскрывает, потом догружает.
  const list = useExpandable(sorted, total, () => setPage((p) => p + 1), mobile ? 5 : Number.POSITIVE_INFINITY);
  return {
    list, rows: sorted, fetching: query.isFetching,
    // Данных нет: серые плашки, «нет связи» или «не загрузилось»; есть — не прячем при фоновой ошибке.
    state: blockState({ data, isError: query.isError, fetchStatus: query.fetchStatus, refetch: query.refetch }),
  };
}

export function EditorEditing() {
  const { list, rows, fetching, state } = useEditorList("editing");
  return (
    <RhSection title="На монтаже" to="/properties?status=EDITING" linkLabel="Все объекты" className="ry-col-a">
      {state ? state
        : rows.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Ничего не ждёт монтажа" /></RhGroup>
        : <RhGroup>
          {list.visible.map((row) => <EditingRow key={row.id} row={row} />)}
          <HomeMore rest={list.rest} onClick={list.more} disabled={fetching} />
        </RhGroup>}
    </RhSection>
  );
}

export function EditorUpcoming() {
  const { list, rows, fetching, state } = useEditorList("upcoming");
  return (
    <RhSection title="Скоро на монтаж" className="ry-col-b">
      {state ? state
        : rows.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Пока ничего не снимают" /></RhGroup>
        : <RhGroup>
          {list.visible.map((row) => (
            <RhRow key={row.id} to={`/properties/${row.shortId}`}
              lead={<PropertyLead photo={firstPhoto(row)} icon="image" tone={row.pipeline.overdue ? "crit" : "a5"} />}
              title={row.title}
              sub={`${row.pipeline.overdue ? "видео просрочено у агента" : `снимают ${row.pipeline.daysInStage} дн`}${row.responsibleAgent ? `, ${row.responsibleAgent.fullName}` : ""}`}
              subTone={row.pipeline.overdue ? "crit" : undefined} />
          ))}
          <HomeMore rest={list.rest} onClick={list.more} disabled={fetching} />
        </RhGroup>}
    </RhSection>
  );
}

/** Строка очереди монтажа: вся строка — переход в карточку объекта. */
function EditingRow({ row }: { row: MarketingQueueRow }) {
  const details = [
    `${row.photoCount} ${pluralizeRu(row.photoCount, ["фото", "фото", "фото"])}`,
    row.responsibleAgent ? `агент ${row.responsibleAgent.fullName}` : null,
    row.instagramUrl ? "ссылка на Reels есть" : null,
  ].filter(Boolean).join(", ");
  return (
    <RhRow to={`/properties/${row.shortId}`} label={`Открыть объект: ${row.title}`}
      lead={<PropertyLead photo={firstPhoto(row)} icon="clapperboard" tone={row.pipeline.overdue ? "crit" : "a1"} />}
      title={row.title}
      sub={<>
        <span>{details}{row.reviewRejectionReason ? `. Возвращали: ${row.reviewRejectionReason}` : ""}</span>
        <PropertyState status={row.status} stage={row.pipeline} />
      </>} />
  );
}
