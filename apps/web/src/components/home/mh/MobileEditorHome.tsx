import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clapperboard, ChevronRight, Clock, Film, Home } from "lucide-react";
import { useAuthStore } from "../../../store/auth";
import { useEditorQueue, type MarketingQueueRow } from "../../../hooks/useMarketing";
import { useAccumulatedPages } from "../../../hooks/useAccumulatedPages";
import { StatusBadge } from "../../StatusBadge";
import { DismissibleHint } from "../../ui/DismissibleHint";
import { pluralizeRu } from "../../../lib/format";
import { MhNoData, MhQuick, MhScreen, MhSection, type MhQuickItem } from "./MhScreen";

/**
 * ГЛАВНАЯ МОНТАЖЁРА НА ТЕЛЕФОНЕ — обёртка `MhScreen` вокруг тех же данных,
 * что у `components/EditorDashboard.tsx` (десктоп): `useEditorQueue`, те же
 * счётчики и очередь. Права и данные не менялись — см.
 * `MobileMarketingHome.tsx` про две несовместимые CSS-темы (`.rh2 .screens`
 * vs `.rh2 .mh`), почему тело переписано, а не обёрнуто как есть.
 */
export function MobileEditorHome() {
  const agent = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  // Те же две независимые страницы, что на десктопе (EditorDashboard.tsx,
  // 02.10.2026): «Показать ещё» сначала раскрывает уже пришедшее, потом
  // догружает следующую страницу с сервера — раньше список упирался в 50.
  const [editingPage, setEditingPage] = useState(1);
  const [upcomingPage, setUpcomingPage] = useState(1);
  const query = useEditorQueue(true, { editingPage, upcomingPage });
  const head = useEditorQueue(editingPage > 1 || upcomingPage > 1, { editingPage: 1, upcomingPage: 1 });
  const editingRows = useAccumulatedPages(query.data?.inEditing, editingPage, "editing", head.data?.inEditing);
  const upcomingRows = useAccumulatedPages(query.data?.upcoming, upcomingPage, "upcoming", head.data?.upcoming);
  const data = query.data ?? head.data;
  const error = query.error;
  const isLoading = query.isLoading && editingRows.length === 0 && upcomingRows.length === 0;
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const [inEditingExpanded, setInEditingExpanded] = useState(false);
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);

  // Ряд быстрых кнопок макета — «Объекты, Монтаж, Сроки, Архив». Без «Архива»:
  // у роли EDITOR нет права `archive.view` (packages/shared/src/permissions.ts,
  // пресет EDITOR — только editForeign/aiListing/viewOrigin), раздел ей и в
  // меню не показывается (navigation.ts гейтит `/archive` этим же правом) —
  // ставить плитку в раздел, куда роль не пускают, нельзя (договор, п.4).
  const quickItems: MhQuickItem[] = [
    { key: "объекты", label: "Объекты", icon: Home, href: "/properties", tone: "sky" },
    { key: "монтаж", label: "Монтаж", icon: Clapperboard, href: "/marketing", tone: "aqua", count: data ? data.counts.inEditing : undefined },
    { key: "сроки", label: "Сроки", icon: Clock, href: "/properties?status=AWAITING_VIDEO", tone: "lav", count: data ? data.counts.upcoming : undefined },
  ];

  const inEditing = [...editingRows].sort(
    (a, b) => Number(b.pipeline.overdue) - Number(a.pipeline.overdue)
  );
  const upcoming = upcomingRows;
  const inEditingTotal = data?.counts.inEditing ?? inEditing.length;
  const upcomingTotal = data?.counts.upcoming ?? upcoming.length;
  const moreInEditing = () => (inEditingExpanded ? setEditingPage((p) => p + 1) : setInEditingExpanded(true));
  const moreUpcoming = () => (upcomingExpanded ? setUpcomingPage((p) => p + 1) : setUpcomingExpanded(true));
  const visibleInEditing = inEditingExpanded ? inEditing : inEditing.slice(0, 5);
  const visibleUpcoming = upcomingExpanded ? upcoming : upcoming.slice(0, 5);

  return (
    <MhScreen greeting={`Салом${firstName ? `, ${firstName}` : ""}`}>
      <MhQuick items={quickItems} />
      <section className="sec" style={{ marginTop: 6 }}>
        <DismissibleHint id="editor-dashboard-intro-mobile">
          Объект попадает в «На монтаже» сам, как только маркетинг одобрил фото и видео, и уходит отсюда, когда вы
          вставите в карточку ссылку на опубликованный обзор. «Скоро на монтаж» — объекты, для которых агент ещё
          снимает видео.
        </DismissibleHint>
      </section>

      <section className="sec">
        <div className="sec-t">
          <h2>Показатели</h2>
        </div>
        <div className="tiles">
          <button type="button" className="tile" onClick={() => navigate("/properties?status=EDITING")}>
            <Clapperboard className="i" strokeWidth={1.5} aria-hidden="true" />
            <div className="v">{data?.counts.inEditing ?? 0}</div>
            <div className="l">На монтаже сейчас</div>
          </button>
          <button type="button" className="tile" onClick={() => navigate("/properties?status=EDITING")}>
            <Clock className="i" strokeWidth={1.5} aria-hidden="true" />
            <div className={(data?.counts.overdue ?? 0) > 0 ? "v crit" : "v"}>{data?.counts.overdue ?? 0}</div>
            <div className={(data?.counts.overdue ?? 0) > 0 ? "l crit" : "l"}>Из них просрочено</div>
          </button>
          <button type="button" className="tile" onClick={() => navigate("/properties?status=AWAITING_VIDEO")}>
            <Film className="i" strokeWidth={1.5} aria-hidden="true" />
            <div className="v">{data?.counts.upcoming ?? 0}</div>
            <div className="l">Скоро придёт</div>
          </button>
        </div>
      </section>

      <MhSection title="На монтаже" note={data ? `${data.counts.inEditing}, просроченные сверху` : undefined}>
        {isLoading ? (
          <MhNoData>Загружаем очередь монтажа…</MhNoData>
        ) : error ? (
          <MhNoData tone="crit">
            {error instanceof Error ? error.message : "Очередь недоступна, обновите страницу"}
          </MhNoData>
        ) : inEditing.length === 0 ? (
          <MhNoData tone="ok">Ничего не ждёт монтажа.</MhNoData>
        ) : (
          <div className="card-s">
            {visibleInEditing.map((row) => (
              <QueueRow key={row.id} row={row} onOpen={() => navigate(`/properties/${row.shortId}`)} />
            ))}
            {inEditingTotal > visibleInEditing.length && (
              <button type="button" className="row morerow" onClick={moreInEditing} disabled={query.isFetching}>
                <span className="t">
                  <span className="n">Показать ещё ({inEditingTotal - visibleInEditing.length})</span>
                </span>
              </button>
            )}
          </div>
        )}
      </MhSection>

      <MhSection title="Скоро на монтаж" note={upcomingTotal ? `${upcomingTotal} ждут видео` : undefined}>
        {isLoading ? (
          <MhNoData>Загружаем список…</MhNoData>
        ) : error ? (
          <MhNoData tone="crit">Список недоступен</MhNoData>
        ) : upcoming.length === 0 ? (
          <MhNoData tone="ok">Пока ничего не снимают.</MhNoData>
        ) : (
          <div className="card-s">
            {visibleUpcoming.map((row) => (
              <button
                type="button"
                className="row"
                key={row.id}
                onClick={() => navigate(`/properties/${row.shortId}`)}
              >
                <span className="av" style={row.pipeline.overdue ? { background: "var(--pink)", color: "var(--pink-ink)" } : undefined} aria-hidden="true">
                  <Film className="i" style={{ width: 18, height: 18 }} />
                </span>
                <span className="t" style={{ textAlign: "left" }}>
                  <span className="n">{row.title}</span>
                  <span className={row.pipeline.overdue ? "s crit" : "s"}>
                    {row.pipeline.overdue ? "видео просрочено у агента" : `снимают ${row.pipeline.daysInStage} дн`}
                    {row.responsibleAgent ? `, ${row.responsibleAgent.fullName}` : ""}
                  </span>
                </span>
                <ChevronRight className="i" aria-hidden="true" />
              </button>
            ))}
            {upcomingTotal > visibleUpcoming.length && (
              <button type="button" className="row morerow" onClick={moreUpcoming} disabled={query.isFetching}>
                <span className="t">
                  <span className="n">Показать ещё ({upcomingTotal - visibleUpcoming.length})</span>
                </span>
              </button>
            )}
          </div>
        )}
      </MhSection>
    </MhScreen>
  );
}

function QueueRow({ row, onOpen }: { row: MarketingQueueRow; onOpen: () => void }) {
  return (
    <button type="button" className="row" onClick={onOpen} aria-label={`Открыть объект: ${row.title}`}>
      <span className="av" style={row.pipeline.overdue ? { background: "var(--pink)", color: "var(--pink-ink)" } : undefined} aria-hidden="true">
        {row.photoCount}
      </span>
      <span className="t" style={{ textAlign: "left" }}>
        <span className="n">{row.title}</span>
        <span className="s">
          {row.photoCount} {pluralizeRu(row.photoCount, ["фото", "фото", "фото"])}
          {row.responsibleAgent ? `, агент ${row.responsibleAgent.fullName}` : ""}
          {row.instagramUrl ? ", ссылка на Reels есть" : ""}
          {row.reviewRejectionReason ? `. Возвращали: ${row.reviewRejectionReason}` : ""}
        </span>
      </span>
      <StatusBadge status={row.status} stage={row.pipeline} />
    </button>
  );
}
