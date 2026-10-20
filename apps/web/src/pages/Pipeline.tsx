import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ChevronsUp, Workflow } from "lucide-react";
import { useAuthStore } from "../store/auth";
import { useCan } from "../lib/permissions";
import {
  useCancelVideoHandoff,
  useEditorQueue,
  useHoldVideoHandoff,
  useUnholdVideoHandoff,
  useMarketingQueue,
  useMoveVideoHandoff,
  useSetVideoHandoffQueuePaused,
  useVideoHandoffQueueState,
  type MarketingQueueRow,
} from "../hooks/useMarketing";
import { CancelHolderDialog, useHandoffMutationBusy, errorText } from "../components/handoff/CancelHolderDialog";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PROPERTY_STATUS_LABELS, pluralizeRu } from "../lib/format";
import { dushanbeTime } from "../lib/date";
import { PropertyRow } from "../components/PropertyRow";
import { Pagination } from "../components/Pagination";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import { MarketingTabs } from "../components/SectionTabs";
import { useCleanShell } from "../hooks/useCleanShell";

/**
 * «Подготовка объектов» (до 25.09.2026 — «Конвейер объектов», переименовано
 * владельцем: «имя непрофессиональное») — отдельный экран (перенос мобильного макета 14.09.2026,
 * функция `renderPipeline` в `docs/pult/theme-2026/artifact-c99db05f-mobile-nav-
 * 14-09.html`). Раньше попасть в конвейер можно было только фильтром в общем
 * списке объектов (`/properties?status=...`), счётчика «ждёт меня» не было
 * вообще.
 *
 * Данные — те же хуки, что уже кормят `MarketingCenter.tsx` (`useMarketingQueue`,
 * все 4 стадии PENDING_REVIEW/AWAITING_PHOTOS/AWAITING_VIDEO/EDITING) и
 * `EditorDashboard.tsx` (`useEditorQueue`, только своя часть — AWAITING_VIDEO/
 * EDITING, сервер монтажёру остальные стадии и не отдаёт, 403 на /marketing/queue).
 * Новых эндпоинтов нет.
 *
 * ЧИП «Ждёт меня» — НЕ «назначено мне»: в MarketingQueueRow нет такого признака
 * (ответственный — это агент объекта, не маркетолог/монтажёр), и выдумывать его
 * запрещено правилом проекта. Чип честно значит «моя стадия конвейера прямо
 * сейчас» — то же самое считает и сам макет (`p.stage==='PENDING_REVIEW'` для
 * маркетинга/директора/админа, `AWAITING_VIDEO|EDITING` для монтажёра).
 */
export function Pipeline() {
  const clean = useCleanShell();
  const can = useCan();
  const role = useAuthStore((s) => s.agent?.role);
  const isEditor = role === "EDITOR";
  const allowed = can("properties.moderate") || can("properties.aiListing");

  if (!allowed) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Подготовка объектов к продаже</h1>
            </div>
          </div>
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <Workflow className="i" aria-hidden />
              </span>
              <p>Этот раздел доступен только маркетингу, монтажу и руководству.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return isEditor ? <EditorPipeline clean={clean} /> : <MarketingPipeline clean={clean} />;
}

type Filter = "mine" | "all";

/**
 * СЧЁТЧИКИ И СПИСОК — НЕ С ПЕРВОЙ СТРАНИЦЫ (02.10.2026, класс «Пагинация»).
 * Раньше экран брал одну страницу очереди (40 строк) и считал «Ждёт меня» и
 * «Все объекты» её длиной: при 60 объектах в конвейере чип показывал 40, а
 * остальные двадцать увидеть было нельзя. Теперь чип «Ждёт меня» — фильтр
 * стадии на сервере (`status=PENDING_REVIEW`), числа — `total` с сервера, лента
 * растёт кнопкой «Показать ещё».
 */
function MarketingPipeline({ clean }: { clean: boolean }) {
  const [filter, setFilter] = useState<Filter>("mine");
  const [page, setPage] = useState(1);
  const status = filter === "mine" ? "PENDING_REVIEW" : undefined;
  const { data, isLoading, isError, refetch } = useMarketingQueue(page, true, status);
  // Первые страницы обоих срезов — ради честных чисел на чипах и свежей головы
  // ленты (при page = 1 это тот же запрос, что выше, лишнего похода нет).
  const mineHead = useMarketingQueue(1, true, "PENDING_REVIEW");
  const allHead = useMarketingQueue(1, true);
  const items = useAccumulatedPages(data?.items, page, filter, (filter === "mine" ? mineHead : allHead).data?.items);

  const changeFilter = (next: Filter) => {
    setFilter(next);
    setPage(1);
  };

  return (
    <PipelineShell
      title="Подготовка объектов к продаже"
      mineLabel="Ждёт меня"
      mineCount={mineHead.data?.total ?? 0}
      allCount={allHead.data?.total ?? 0}
      filter={filter}
      onFilter={changeFilter}
      isLoading={isLoading && items.length === 0}
      isError={isError}
      onRetry={() => refetch()}
      emptyText={filter === "mine" ? "Никто не ждёт вашей проверки." : "Список пуст."}
      footer={
        data && (
          <Pagination variant="loadMore" page={page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        )
      }
    >
      {items.map((p) => (
        <PipelineRow key={p.id} row={p} clean={clean} />
      ))}
    </PipelineShell>
  );
}

/**
 * Монтажёр: два списка с независимыми страницами (/marketing/editor-queue,
 * по 50 на страницу). Числа на чипах — `counts` с сервера, а не длина списка:
 * раньше после 50 объектов на монтаже чип замирал на 50 (02.10.2026). В срезе
 * «Все объекты» «Скоро придут» дописываются только когда «На монтаже» показан
 * целиком — иначе новые строки монтажа вставали бы в середину ленты.
 */
function EditorPipeline({ clean }: { clean: boolean }) {
  const [filter, setFilter] = useState<Filter>("mine");
  const [editingPage, setEditingPage] = useState(1);
  const [upcomingPage, setUpcomingPage] = useState(1);
  const { data, isLoading, isError, refetch } = useEditorQueue(true, { editingPage, upcomingPage });
  const head = useEditorQueue(editingPage > 1 || upcomingPage > 1, { editingPage: 1, upcomingPage: 1 });

  const inEditing = useAccumulatedPages(data?.inEditing, editingPage, "editing", head.data?.inEditing);
  const upcoming = useAccumulatedPages(data?.upcoming, upcomingPage, "upcoming", head.data?.upcoming);
  const counts = data?.counts ?? head.data?.counts;
  const pageSize = data?.pageSize ?? 50;
  // «Весь конвейер» монтажёра — только то, что ему вообще отдаёт сервер
  // (/marketing/editor-queue): AWAITING_VIDEO и EDITING. Остальные стадии
  // (PENDING_REVIEW/AWAITING_PHOTOS) не его работа, показывать их честно нечем.
  const editingDone = !counts || inEditing.length >= counts.inEditing;
  const all = useMemo(() => (editingDone ? [...inEditing, ...upcoming] : inEditing), [editingDone, inEditing, upcoming]);

  const visible = filter === "mine" ? inEditing : all;
  const changeFilter = (next: Filter) => {
    setFilter(next);
    setEditingPage(1);
    setUpcomingPage(1);
  };

  return (
    <PipelineShell
      title="Монтаж"
      mineLabel="Ждёт меня"
      mineCount={counts?.inEditing ?? 0}
      allCount={counts ? counts.inEditing + counts.upcoming : 0}
      filter={filter}
      onFilter={changeFilter}
      isLoading={isLoading && visible.length === 0}
      isError={isError}
      onRetry={() => refetch()}
      emptyText={filter === "mine" ? "На монтаже пусто." : "Список пуст."}
      footer={
        counts &&
        (filter === "mine" || !editingDone ? (
          <Pagination
            variant="loadMore"
            page={editingPage}
            pageSize={pageSize}
            total={counts.inEditing}
            onPageChange={setEditingPage}
          />
        ) : (
          <Pagination
            variant="loadMore"
            page={upcomingPage}
            pageSize={pageSize}
            total={counts.upcoming}
            onPageChange={setUpcomingPage}
          />
        ))
      }
    >
      {visible.map((p) => (
        <PipelineRow key={p.id} row={p} clean={clean} />
      ))}
    </PipelineShell>
  );
}

function PipelineShell({
  title,
  mineLabel,
  mineCount,
  allCount,
  filter,
  onFilter,
  isLoading,
  isError,
  onRetry,
  emptyText,
  footer,
  children,
}: {
  title: string;
  mineLabel: string;
  mineCount: number;
  allCount: number;
  filter: Filter;
  onFilter: (f: Filter) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  emptyText: string;
  /** «Показать ещё» под лентой. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  const role = useAuthStore((s) => s.agent?.role);
  const isEditor = role === "EDITOR";
  return (
    <div className="rh2 screens">
      <div className="scr" data-stagger>
        <div className="pg-h">
          <div>
            <h1>{title}</h1>
          </div>
        </div>

        <MarketingTabs />

        <div className="card tight">
          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Фильтр конвейера">
              <button type="button" role="tab" aria-selected={filter === "mine"} onClick={() => onFilter("mine")}>
                {mineLabel} <span className="n">{mineCount}</span>
              </button>
              <button type="button" role="tab" aria-selected={filter === "all"} onClick={() => onFilter("all")}>
                Все объекты <span className="n">{allCount}</span>
              </button>
            </div>
          </div>

          <HandoffQueueBar />

          {isError && (
            <div className="state err">
              <span className="dot crit" />
              Список не загрузился. Это сбой связи, а не пустая очередь.{" "}
              <button
                className="lk"
                type="button"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={onRetry}
              >
                Повторить
              </button>
            </div>
          )}

          {isLoading && !isError && (
            <div className="state">
              <span className="sk av" />
              <span className="sk w28" />
              <span className="sk w22" />
              Загружаем конвейер
            </div>
          )}

          {!isLoading && !isError && !hasRows && (
            <div className="empty">
              <span className="ic">
                <Workflow className="i" aria-hidden />
              </span>
              <p>{emptyText}</p>
            </div>
          )}

          {!isLoading && !isError && hasRows && (
            <>
              <div className="list" style={{ marginTop: 8 }}>
                {children}
              </div>
              {footer}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ОЧЕРЕДЬ МОНТАЖЁРА НАД СПИСКОМ (24.09.2026). На паузе — строка «очередь на
 * паузе» и «Возобновить»; без паузы, пока в очереди кто-то есть, — «Придержать
 * очередь»: освободившееся место тогда не уйдёт следующему само. Нет прав на
 * очередь (сервер ответил 403) или очередь пуста — строки нет вовсе.
 */
function HandoffQueueBar() {
  const { data, isError } = useVideoHandoffQueueState();
  const setPaused = useSetVideoHandoffQueuePaused();
  const busy = useHandoffMutationBusy();
  // Причина паузы (25.09.2026, А4) — спрашиваем ДО отправки, простым полем,
  // а не отдельным модальным окном (образец — поле причины у «Снять и
  // придержать очередь» выше).
  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState("");
  if (isError || !data) return null;
  if (!data.paused && !data.holder && data.queuedCount === 0) return null;

  const waiting = data.queuedCount > 0 ? ` В очереди: ${data.queuedCount}.` : "";
  // Баннер паузы (владелец: видеть, кто и почему придержал) — время, автор,
  // причина, каждое необязательно (старая пауза без них — просто «на паузе»).
  const pausedMeta = data.paused
    ? ` Поставлена на паузу${data.pausedAt ? ` в ${dushanbeTime(data.pausedAt)}` : ""}${data.pausedBy ? ` (${data.pausedBy.fullName})` : ""}${data.pauseReason ? `: ${data.pauseReason}.` : "."}`
    : "";

  const confirmPause = () =>
    setPaused.mutate(
      { paused: true, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setPausing(false);
          setReason("");
        },
      }
    );

  return (
    <div className="state" role="status" style={{ flexWrap: "wrap", gap: 8, marginTop: 8 }}>
      <span className={data.paused ? "dot warn" : "dot"} aria-hidden="true" />
      <span style={{ flex: "1 1 220px" }}>
        {data.paused
          ? `Очередь монтажёра на паузе — следующий объект не уйдёт монтажёру, пока не возобновите.${pausedMeta}${waiting}`
          : `Очередь монтажёра: ${data.holder ? `у монтажёра №${data.holder.shortId}.` : "место свободно."}${waiting}`}
      </span>
      {data.paused ? (
        <button type="button" className="pill sm" disabled={busy} onClick={() => setPaused.mutate({ paused: false })}>
          Возобновить
        </button>
      ) : pausing ? (
        <>
          <input
            className="inp sm"
            style={{ maxWidth: 220 }}
            placeholder="Причина (необязательно)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            aria-label="Причина придержки очереди"
          />
          <button type="button" className="pill sm" disabled={busy} onClick={confirmPause}>
            Придержать
          </button>
          <button
            type="button"
            className="pill ghost sm"
            disabled={busy}
            onClick={() => {
              setPausing(false);
              setReason("");
            }}
          >
            Отмена
          </button>
        </>
      ) : (
        <button type="button" className="pill ghost sm" disabled={busy} onClick={() => setPausing(true)}>
          Придержать очередь
        </button>
      )}
      {setPaused.isError && <span className="quiet">{errorText(setPaused.error)}</span>}
    </div>
  );
}

/** «На монтаже · 3 дня» — стадийная подпись под карточкой. Просрочку PropertyRow
 *  пишет своей строкой («Монтаж задерживает объект…»), здесь её не повторяем. */
function stageCaption(row: MarketingQueueRow): string {
  const days = row.pipeline.daysInStage;
  // Готовый ролик ждёт проверки модератора (25.09.2026, lib/clipReview.ts) —
  // та же подпись, что чип в списке объектов: иначе объект без слота выглядел
  // бы просто «на монтаже» и казался застрявшим.
  const label =
    row.videoHandoffBrief?.state === "clip_review" ? `${PROPERTY_STATUS_LABELS[row.status]} · Ролик на проверке` : PROPERTY_STATUS_LABELS[row.status];
  return days > 0 ? `${label} · ${days} ${pluralizeRu(days, ["день", "дня", "дней"])}` : label;
}

/**
 * СТРОКА КОНВЕЙЕРА = ПОЛНАЯ КАРТОЧКА ОБЪЕКТА (24.09.2026, владелец: «добавь
 * карточку объекта полностью со всей информацией, как и везде») — тот же
 * PropertyRow, что в списке объектов, а не своя разметка. Поверх — очередь
 * монтажёра: чип места, «В начало/Выше/Ниже» у ждущих (владелец: «кнопку, чтобы
 * передвигать очередь») и «Снять с монтажа». Держателя места не двигают — его
 * снимают. Все кнопки гаснут, пока идёт любое снятие, пауза или ход.
 */
function PipelineRow({ row, clean }: { row: MarketingQueueRow; clean: boolean }) {
  const overdue = row.pipeline.overdue;
  const cancelHandoff = useCancelVideoHandoff();
  const move = useMoveVideoHandoff();
  const hold = useHoldVideoHandoff();
  const unhold = useUnholdVideoHandoff();
  const { data: queueState } = useVideoHandoffQueueState();
  const busy = useHandoffMutationBusy();
  const [confirming, setConfirming] = useState(false);
  const [holding, setHolding] = useState(false);
  const position = row.videoHandoffQueuePosition;
  const isHolder = position === 1;
  // Место среди ждущих: позиции ждущих начинаются с 2 (1 — держатель места),
  // см. lib/videoHandoff.ts::videoHandoffQueuePositions.
  const waitingPlace = position != null && !isHolder ? position - 1 : null;
  const isFirst = waitingPlace === 1;
  const isLast = waitingPlace != null && waitingPlace >= (queueState?.queuedCount ?? waitingPlace);
  const runMove = (to: "front" | "up" | "down") => move.mutate({ propertyId: row.id, to });
  // Отложен ли ЭТОТ объект (25.09.2026, «Отложить») — из того же queueState,
  // что и остальная очередь: он уже загружен для окна снятия, второго запроса
  // не заводим. Отложенный остаётся в очереди на своём месте (position не
  // меняется), просто помечен — см. lib/videoHandoff.ts::orderedQueue.
  const heldEntry = waitingPlace != null ? queueState?.queue.find((p) => p.id === row.id) : undefined;
  const isHeld = !!heldEntry?.heldAt;
  const runUnhold = () => unhold.mutate({ propertyId: row.id });

  /* Очередь передачи видео монтажёру через бота (lib/videoHandoff.ts) — видно
     всем, кто видит сам конвейер: маркетингу/админу/директору (/marketing/queue)
     и монтажёру (/marketing/editor-queue). Найдено 19.09.2026: очередь «строго
     по одному» умела зависать НАВСЕГДА молча — этот чип и есть та видимость. */
  const queueChip =
    position != null ? (
      <span className={isHolder ? "chip warn" : isHeld ? "chip mute" : "chip mute"}>
        {isHolder ? "У монтажёра" : isHeld ? `Отложен${heldEntry?.holdReason ? `: ${heldEntry.holdReason}` : ""}` : `В очереди боту, ${position}-й`}
      </span>
    ) : null;

  const queueBand =
    position != null ? (
      <>
        {queueChip}
        {waitingPlace != null && (
          <>
            <button
              className="pill ghost sm icon"
              type="button"
              aria-label={`№${row.shortId} — в начало очереди`}
              title="В начало очереди"
              disabled={busy || isFirst}
              onClick={() => runMove("front")}
            >
              <ChevronsUp className="i" aria-hidden="true" />
            </button>
            <button
              className="pill ghost sm icon"
              type="button"
              aria-label={`№${row.shortId} — выше в очереди`}
              title="Выше"
              disabled={busy || isFirst}
              onClick={() => runMove("up")}
            >
              <ChevronUp className="i" aria-hidden="true" />
            </button>
            <button
              className="pill ghost sm icon"
              type="button"
              aria-label={`№${row.shortId} — ниже в очереди`}
              title="Ниже"
              disabled={busy || isLast}
              onClick={() => runMove("down")}
            >
              <ChevronDown className="i" aria-hidden="true" />
            </button>
          </>
        )}
        {waitingPlace != null &&
          (isHeld ? (
            <button className="pill ghost sm" type="button" disabled={busy} onClick={runUnhold}>
              Вернуть в очередь
            </button>
          ) : (
            <button className="pill ghost sm" type="button" disabled={busy} onClick={() => setHolding(true)}>
              Отложить
            </button>
          ))}
        <button className="pill ghost sm" type="button" disabled={busy} onClick={() => setConfirming(true)}>
          Снять с монтажа
        </button>
        {move.isError && (
          <span role="alert" style={{ color: "var(--crit)", fontSize: "var(--fs-13)" }}>
            {errorText(move.error)}
          </span>
        )}
        {unhold.isError && (
          <span role="alert" style={{ color: "var(--crit)", fontSize: "var(--fs-13)" }}>
            {errorText(unhold.error)}
          </span>
        )}
      </>
    ) : null;

  return (
    <>
      <PropertyRow
        clean={clean}
        property={row}
        hideHandoffBrief
        subline={
          // Стадия — строкой внутри карточки, под адресом: отдельной строкой ПОСЛЕ
          // карточки она читалась как заголовок следующей.
          <span style={overdue ? { color: "var(--crit)" } : undefined}>{stageCaption(row)}</span>
        }
        band={queueBand}
      />
      {/* Окна — соседями строки, а не внутри неё: клик в портале всплывает по
          дереву React и иначе открывал бы карточку объекта. */}
      {confirming && isHolder && <CancelHolderDialog id={row.id} shortId={row.shortId} onClose={() => setConfirming(false)} />}
      {confirming && !isHolder && (
        <ConfirmDialog
          title={`Снять №${row.shortId} с очереди?`}
          description="Монтажёр этот объект ещё не получал — уведомлять его не о чем."
          confirmLabel="Снять с очереди"
          confirmDisabled={busy}
          confirmHint={cancelHandoff.isError ? errorText(cancelHandoff.error) : undefined}
          onCancel={() => setConfirming(false)}
          onConfirm={() => cancelHandoff.mutate({ propertyId: row.id }, { onSuccess: () => setConfirming(false) })}
        />
      )}
      {holding && (
        <HoldDialog
          row={row}
          onClose={() => setHolding(false)}
          onConfirm={(reason) => hold.mutate({ propertyId: row.id, reason }, { onSuccess: () => setHolding(false) })}
          busy={busy}
          error={hold.isError ? errorText(hold.error) : undefined}
        />
      )}
    </>
  );
}

/** «Отложить №N» — причина необязательна, тем же приёмом ввода, что и у
 *  причины придержки очереди в CancelHolderDialog (25.09.2026, «Отложить»). */
function HoldDialog({
  row,
  onClose,
  onConfirm,
  busy,
  error,
}: {
  row: MarketingQueueRow;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
  busy: boolean;
  error?: string;
}) {
  const [reason, setReason] = useState("");
  return (
    <Rh2Sheet
      open
      onClose={onClose}
      dismissible={!busy}
      title={`Отложить №${row.shortId}?`}
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="button" className="pill" disabled={busy} onClick={() => onConfirm(reason.trim() || undefined)}>
            Отложить
          </button>
        </>
      }
    >
      <p className="state">Объект останется на своём месте в очереди, но место монтажёра ему пока не уйдёт — до «Вернуть в очередь».</p>
      <p className="state">
        <input
          className="inp sm"
          style={{ width: "100%" }}
          placeholder="Причина (необязательно)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          aria-label="Причина придержки объекта"
        />
      </p>
      {error && (
        <p className="state err" role="alert">
          <span className="dot crit" />
          {error}
        </p>
      )}
    </Rh2Sheet>
  );
}
