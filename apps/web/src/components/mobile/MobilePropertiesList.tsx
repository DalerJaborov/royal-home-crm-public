import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { Search, X, SlidersHorizontal, Plus } from "lucide-react";
import { Pagination } from "../Pagination";
import { useCan, useCanCreateProperty } from "../../lib/permissions";
import { useAuthStore } from "../../store/auth";
import { useSiteNotifications } from "../../hooks/useSiteNotifications";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { formatMoney, formatPricePerSqm, PROPERTY_TYPE_LABELS, STAGE_OWNER_LABELS } from "../../lib/format";
import { formatPropertyCode } from "../../lib/clientFormat";
import { STAGE_SEGMENTS, statusChipLabel } from "../../lib/theme2026";
import {
  useHandoverPendingProperties,
  usePropertyScopeToggle,
  type BulkAction,
  type PropertiesSummary,
  type PropertyFilters,
} from "../../hooks/useProperties";
import { pluralizeRu } from "../../lib/format";
import { MhLane, MhListScreen, type MhLaneChip } from "./mh/MhList";
import type { District, Paginated, Property } from "../../types";
import { ObjectsTabs } from "../SectionTabs";
import { PropertyHealthDot } from "../PropertyHealthDot";
import { propertyFloorsLabel, type PropertyHealthBrief } from "@royal-home/shared";

/**
 * «ОБЪЕКТЫ» НА ТЕЛЕФОНЕ — переодето 15.09.2026 из облика пульта (`.rh2 .scr`,
 * тот же CSS, что и на компьютере) в облик мобильного макета владельца
 * (`.rh2 .mh`, docs/pult/theme-2026/artifact-c99db05f-mobile-nav.html):
 * своя шапка `.top`, лента срезов `.lane`, список `.list`+`.row`. Раньше
 * файл лишь подставлял узкие модификаторы прототипа (`.prow`, `.gal`) поверх
 * той же карточки-панели — здесь это была уже не подача, а другой облик
 * целиком, и владелец прямо сказал: «ничего из ПК я не хочу».
 *
 * Данные и состояние — те же самые пропсы из Properties.tsx (filters, data,
 * selectedIds, districts…), ни одного своего запроса не заведено.
 *
 * ФОТО В СТРОКЕ. У клиента в списке — круглый инициал; у объекта смысл несёт
 * фотография, а не буква, поэтому та же ячейка `.av` тут не круг, а
 * прямоугольник (borderRadius переопределён инлайном, сама ячейка и её
 * отступы — из `.av`, ничего своего не заведено).
 *
 * ПАГИНАЦИЮ НЕ ТРОГАЛ — «Показаны с N по M» переводит на «Показать ещё»
 * другой агент параллельно; при слиянии здесь выставлен variant="loadMore",
 * как и на остальных списках.
 */

type ListView = "table" | "cards";

export function MobilePropertiesList({
  view: _view,
  onViewChange: _onViewChange,
  draftBanner,
  filters,
  setFilters,
  canModerate,
  pendingReviewTotal,
  summary,
  data,
  health,
  isLoading,
  error,
  onRetry,
  districts,
  canPublish,
  canBulkDelete,
  canSelect,
  selectedIds,
  onToggleSelect,
  onBulkAction,
  onClearSelection,
  bulkError,
  isBusy,
}: {
  view: ListView;
  onViewChange: (view: ListView) => void;
  /** Баннер незаконченного черновика объекта (владелец 21.09.2026) — готовый
   *  узел из Properties.tsx (там же usePropertyDraft), а не свой запрос: файл
   *  и так уже ни одного запроса не заводит, см. докблок выше. */
  draftBanner?: ReactNode;
  filters: PropertyFilters;
  setFilters: Dispatch<SetStateAction<PropertyFilters>>;
  /** Право видеть «N ждут вашей проверки» в подзаголовке (properties.moderate). */
  canModerate: boolean;
  /** Честный счёт объектов на проверке (properties?status=PENDING_REVIEW), либо
   *  ничего, пока запрос не отвечает или право не выдано (см. Properties.tsx). */
  pendingReviewTotal: number | undefined;
  /** Сводная плашка (показы за 30 дней, просрочка этапа по всему каталогу) —
   *  тот же GET /properties/summary, что и на широком экране. */
  summary: PropertiesSummary | undefined;
  data: Paginated<Property> | undefined;
  /** Светофор объектов ленты — считает Properties.tsx одним хуком на обе ветки. */
  health?: Map<string, PropertyHealthBrief>;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  districts: District[];
  canPublish: boolean;
  /** Право на массовое удаление в Корзину (properties.delete) — своя кнопка. */
  canBulkDelete: boolean;
  /** Показывать ли галочки: нужны и публикации, и удалению. */
  canSelect: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onBulkAction: (action: BulkAction) => void;
  onClearSelection: () => void;
  bulkError: string | null;
  /** Идёт массовое действие (публикация или удаление) — кнопки гаснут. */
  isBusy: boolean;
}) {
  // Переключатель «Список / Галерея» макет не рисует вовсе (там один вид —
  // строки с фото), поэтому на телефоне он снят: `view`/`onViewChange` приняты
  // пропсом ради общего интерфейса с широким экраном, но не используются —
  // сама галерея (`.gal`) была узкой раскладкой панели, а не макета.
  // Шторка фильтров — общий корпус `Rh2Sheet`, а не своя разметка: у ручной не
  // было ловушки фокуса. Подачу корпус выбирает сам, и на телефоне это нижняя
  // шторка (`.sheet.bottom`) — как у всех остальных окон CRM; жёсткий
  // `sheet right` был здесь единственным исключением.
  // Вкладка «Изменения на сайте» (перенос меню 15.09.2026) — тот же счётчик и
  // право, что в lib/navigation.ts / pages/Properties.tsx.
  const can = useCan();
  // A12 (владелец 02.10.2026): СБ объекты не заводит — «+» в шапке ей не рисуем.
  const canCreateProperty = useCanCreateProperty();
  const myId = useAuthStore((s) => s.agent?.id);
  const { data: siteNotifications } = useSiteNotifications({ enabled: can("siteChanges.view") });
  // Объекты переданы мне и ждут «Принять» — тот же запрос и та же сводка, что
  // на широком экране (Properties.tsx), см. PropertyOwnerCard.tsx на карточке.
  const { data: handoverPending } = useHandoverPendingProperties();
  const handoverPendingCount = handoverPending?.length ?? 0;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(!!filters.q);
  // «Мои объекты» / «Все объекты» (владелец 21.08.2026) — та же логика, что и у
  // широкой раскладки, общая ради одного места правды о том, чей это id.
  const scope = usePropertyScopeToggle(filters, setFilters);

  const activeExtraFilters = [
    filters.type,
    filters.districtIds?.length ? "1" : undefined,
    filters.areaMin != null ? "1" : undefined,
    filters.areaMax != null ? "1" : undefined,
    filters.sort,
    filters.noVideo,
    filters.overdue,
  ].filter(Boolean).length;

  const chips: MhLaneChip[] = [
    // «В подготовке» сворачивает четыре этапа конвейера в одну пилюлю
    // (см. STAGE_SEGMENTS). У неё пустое `value`, поэтому выбранность считается
    // по паре (status, inPrep): иначе «Все» подсвечивалась бы вместе с ней.
    ...STAGE_SEGMENTS.map(
      (s): MhLaneChip => ({
        key: s.inPrep ? "in-prep" : s.value || "all",
        label: s.label,
        active: (filters.status ?? "") === s.value && !!filters.inPrep === !!s.inPrep,
        onSelect: () =>
          setFilters((f) => ({ ...f, status: s.value || undefined, inPrep: s.inPrep ? "1" : undefined, page: 1 })),
      })
    ),
    {
      key: "mine",
      label: "Мои объекты",
      active: scope.isMine,
      onSelect: () => (scope.isMine ? scope.showAll() : scope.showMine()),
    },
    {
      key: "novideo",
      label: "Без видео",
      active: !!filters.noVideo,
      onSelect: () => setFilters((f) => ({ ...f, noVideo: f.noVideo ? undefined : "1", page: 1 })),
    },
    // «Просрочено» — как ссылка «Этап просрочен у N» на ПК (F15, 02.10.2026).
    // Чип есть, пока есть просроченные или фильтр уже включён: пришедший по
    // ссылке ?overdue=1 фильтр иначе был невидим и не снимался.
    ...((summary?.overduePipelineCount ?? 0) > 0 || filters.overdue
      ? [
          {
            key: "overdue",
            label: "Просрочено",
            active: !!filters.overdue,
            onSelect: () => setFilters((f) => ({ ...f, overdue: f.overdue ? undefined : "1", page: 1 })),
          } satisfies MhLaneChip,
        ]
      : []),
  ];

  return (
    <MhListScreen
      title="Объекты"
      count={data?.total ?? null}
      actions={
        <>
          {/* «Новый объект» — как кнопка «Объект» в шапке на ПК (23.09.2026).
              Здесь стоял значок карты, повторявший вкладку «Карта» ниже, а
              создать объект из списка было нельзя: только через «+» в нижней
              полосе, о котором из этого экрана не догадаться. */}
          {canCreateProperty && (
            <Link to="/properties/new" className="ico card" aria-label="Новый объект">
              <Plus className="i" aria-hidden />
            </Link>
          )}
          <button
            type="button"
            className="ico card"
            aria-label={searchOpen ? "Закрыть поиск" : "Поиск по объектам"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((v) => !v);
              if (searchOpen) setFilters((f) => ({ ...f, q: undefined, page: 1 }));
            }}
          >
            {searchOpen ? <X className="i" aria-hidden /> : <Search className="i" aria-hidden />}
          </button>
          <button
            type="button"
            className="ico card"
            aria-label="Фильтры объектов"
            onClick={() => setFiltersOpen(true)}
            style={{ position: "relative" }}
          >
            <SlidersHorizontal className="i" aria-hidden />
            {activeExtraFilters > 0 && (
              <span className="dot" style={{ background: "var(--accent)" }} aria-hidden />
            )}
          </button>
        </>
      }
    >
      {searchOpen && (
        <div className="srch" style={{ padding: "10px 0 0" }}>
          <div className="field">
            <Search className="i" aria-hidden />
            <input
              type="search"
              autoFocus
              value={filters.q ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value || undefined, page: 1 }))}
              placeholder="Номер, название, адрес"
              aria-label="Поиск по объектам"
            />
          </div>
        </div>
      )}

      {draftBanner}

      {handoverPendingCount > 0 && (
        <div className="sec" style={{ marginTop: 14 }}>
          <div className="list">
            <div className="quiet">
              <div className="ln">
                <i className="w" aria-hidden />
                <span>
                  Вам передано объектов: {handoverPendingCount} —{" "}
                  <Link
                    to={`/properties/${handoverPending?.[0]?.shortId}`}
                    className="mh-hit"
                    style={{ color: "var(--ink)", fontWeight: 600, textDecoration: "underline" }}
                  >
                    примите их в карточках
                  </Link>
                  .
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* СВОДНАЯ СТРОКА УБРАНА, ОСТАЛОСЬ ТО, ПО ЧЕМУ ЕСТЬ ДЕЙСТВИЕ
          (21.09.2026, тот же разбор, что в pages/Properties.tsx). Владелец:
          «убрать подсказку — за 30 дней по каталогу 8 показов и так далее».
          Число показов по каталогу не подсказывает следующий шаг и занимало
          верх экрана всегда. Просрочка и очередь проверки остаются: по ним есть
          что нажать, и появляются они только когда есть о чём говорить. */}
      {((!!summary && summary.overduePipelineCount > 0) || (canModerate && !!pendingReviewTotal)) && (
        <div className="sec" style={{ marginTop: 14 }}>
          <div className="list">
            <div className="quiet">
              {!!summary && summary.overduePipelineCount > 0 && (
                <div className="ln">
                  <i className="c" aria-hidden />
                  <span>
                    Этап просрочен у {summary.overduePipelineCount}{" "}
                    {pluralizeRu(summary.overduePipelineCount, ["объекта", "объектов", "объектов"])} — отмечены ниже.
                  </span>
                </div>
              )}
              {canModerate && !!pendingReviewTotal && (
                <div className="ln">
                  <i className="w" aria-hidden />
                  <span>
                    <button
                      type="button"
                      className="mh-hit"
                      style={{ color: "var(--ink)", fontWeight: 600, textDecoration: "underline" }}
                      onClick={() => setFilters((f) => ({ ...f, status: "PENDING_REVIEW", inPrep: undefined, page: 1 }))}
                    >
                      {pendingReviewTotal} объект(ов) ждут вашей проверки
                    </button>
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Лента вкладок разделов — перенос пунктов из меню (вторая сессия,
          15.09.2026). При слиянии с переодеванием экрана встала над лентой
          срезов: в облике макета её место там же. */}
      <ObjectsTabs />

      <MhLane label="Стадии и срезы объектов" chips={chips} sticky />

      {canSelect && selectedIds.size > 0 && (
        <div className="sec" style={{ marginTop: 14 }}>
          <div className="list">
            <div className="quiet">
              <div className="ln" style={{ flexWrap: "wrap", rowGap: 8 }}>
                <span>Выбрано {selectedIds.size}.</span>
                {canPublish && (
                  <>
                    <button type="button" className="lnk mh-hit" disabled={isBusy} onClick={() => onBulkAction("publish")}>
                      Опубликовать
                    </button>
                    <button type="button" className="lnk mh-hit" disabled={isBusy} onClick={() => onBulkAction("unpublish")}>
                      Снять с публикации
                    </button>
                  </>
                )}
                {canBulkDelete && (
                  <button type="button" className="lnk mh-hit" disabled={isBusy} onClick={() => onBulkAction("trash")}>
                    В корзину
                  </button>
                )}
                <button type="button" className="lnk mh-hit" onClick={onClearSelection}>
                  Снять выбор
                </button>
              </div>
              {bulkError && (
                <div className="ln">
                  <i className="c" aria-hidden />
                  <span>{bulkError}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="sec" style={{ marginTop: 14 }}>
        <div className="list">
          {error ? (
            <div className="state err">
              Каталог не загрузился.
              <button type="button" className="lnk mh-hit" onClick={onRetry}>
                Повторить
              </button>
            </div>
          ) : isLoading ? (
            <div className="state">Загружаем каталог</div>
          ) : data && data.items.length === 0 ? (
            <div className="state">
              {filters.q ? "Под этот запрос объектов нет." : "Под этот фильтр объектов нет."}
            </div>
          ) : (
            data?.items.map((p) => (
              <MhPropertyRow
                key={p.id}
                property={p}
                myId={myId}
                health={health?.get(p.id)}
                canSelect={canSelect}
                selected={selectedIds.has(p.id)}
                onToggleSelect={onToggleSelect}
              />
            ))
          )}
        </div>
      </div>

      {/* Без обёртки «total > pageSize» (02.10.2026): Pagination сама прячется
          на одной странице и сама возвращает страницу за краем выдачи; условие
          ниже только не рисует пустой отступ, а со второй страницы держит её на месте. */}
      {data && (data.total > data.pageSize || data.page > 1) && (
        <div className="sec">
          {/* Мягкая подгрузка вместо страниц — решение владельца 15.09.2026,
              то же, что на остальных списках. */}
          <Pagination
            variant="loadMore"
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
          />
        </div>
      )}

      {/* ================= Шторка фильтров ================= */}
      <Rh2Sheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Фильтры"
        ariaLabel="Фильтры объектов"
        footer={
          <>
            <button
              className="pill ghost"
              type="button"
              onClick={() => setFilters((f) => ({ status: f.status, agentId: f.agentId, q: f.q, page: 1 }))}
            >
              Сбросить
            </button>
            <button className="pill" type="button" onClick={() => setFiltersOpen(false)}>
              Показать {data?.total ?? 0}
            </button>
          </>
        }
      >
        <div className="fgrid" style={{ gridTemplateColumns: "1fr" }}>
          <label className="fld">
            <span className="lab">Тип объекта</span>
            <select
              value={filters.type ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value || undefined, page: 1 }))}
            >
              <option value="">Все типы</option>
              {Object.entries(PROPERTY_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <div className="fld">
            <span className="lab">Район</span>
            <div className="wrap">
              {districts.map((d) => {
                const on = !!filters.districtIds?.includes(d.id);
                return (
                  <label className="chk" key={d.id}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setFilters((f) => {
                          const next = on
                            ? (f.districtIds ?? []).filter((x) => x !== d.id)
                            : [...(f.districtIds ?? []), d.id];
                          return { ...f, districtIds: next.length > 0 ? next : undefined, page: 1 };
                        })
                      }
                    />
                    {d.name}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="fld">
            <span className="lab">Площадь, м²</span>
            <div className="pair">
              <input
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="от"
                aria-label="Площадь от, м²"
                value={filters.areaMin ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    areaMin: e.target.value ? Number(e.target.value) : undefined,
                    page: 1,
                  }))
                }
              />
              <input
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="до"
                aria-label="Площадь до, м²"
                value={filters.areaMax ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    areaMax: e.target.value ? Number(e.target.value) : undefined,
                    page: 1,
                  }))
                }
              />
            </div>
            <span className="msg">Цену фильтром пока не сужаем: на сервере она хранится без валюты.</span>
          </div>
          <label className="fld">
            <span className="lab">Порядок</span>
            <select
              value={filters.sort ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value || undefined, page: 1 }))}
            >
              <option value="">Сначала новые</option>
              <option value="price_asc">Сначала дешёвые</option>
              <option value="price_desc">Сначала дорогие</option>
            </select>
          </label>
        </div>
      </Rh2Sheet>
    </MhListScreen>
  );
}

/**
 * Пилюля стадии для этой области стилей (`.rh2 .mh`). Не переиспользует
 * `statusChipClass` (lib/theme2026.ts): те имена — `chip hot`/`chip mute` из
 * theme-2026-proto.css, области пульта `.rh2 .scr`. В `.rh2 .mh` определены
 * только пять тонов (crit/warn/ok/lav/sky, theme-2026-mobile-home.css +
 * theme-2026-mobile-lists.css) — свой класс не заводим, раскладываем восемь
 * состояний по ним же.
 */
function mhStageChipClass(status: Property["status"], overdue: boolean | undefined): string | null {
  if (overdue) return "chip crit xs";
  switch (status) {
    case "AVAILABLE":
      return "chip ok xs";
    case "PENDING_REVIEW":
    case "EDITING":
      return "chip warn xs";
    case "AWAITING_PHOTOS":
    case "AWAITING_VIDEO":
      return "chip sky xs";
    case "RESERVED":
      return "chip lav xs";
    default:
      // SOLD/WITHDRAWN — вышли из оборота, отдельный цвет им в макете не
      // назначен, поэтому просто текст без пилюли.
      return null;
  }
}

/**
 * Строка объекта макета: фото прямоугольником (та же ячейка `.av`, что у
 * аватара, borderRadius переопределён на прямую — приём владельца для «не
 * круглой» сущности), имя объекта и суть в `.s`, пилюля стадии рядом с именем
 * (как чип статуса у клиента), просрочка этапа — тихой строкой под объектом,
 * как и на широком экране.
 */
function MhPropertyRow({
  property: p,
  myId,
  health,
  canSelect,
  selected,
  onToggleSelect,
}: {
  property: Property;
  /** Текущий сотрудник — чип «передан вам», как в десктопной строке (PropertyRow.tsx). */
  myId?: string;
  health: PropertyHealthBrief | undefined;
  canSelect: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const stage = p.pipeline;
  const chipClass = mhStageChipClass(p.status, stage?.overdue);
  const meta = [
    formatPropertyCode(p.shortId),
    p.district?.name ?? "Район не указан",
    `${p.areaSqm} м²`,
    // У дома — этажность, у участка — ничего (propertyTypeFields.ts).
    propertyFloorsLabel(p)?.value ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      {/* data-property-row/data-list-row — крючки проверок экранов. На десктопной
          строке (components/PropertyRow.tsx) они есть с самого начала, здесь их не
          было: ровно то расхождение десктопа и телефона, про которое предупреждает
          CLAUDE.md. Из-за этого критическая проверка «список → карточка» на телефоне
          не находила ни одной строки при полном каталоге. 19.09.2026. */}
      <Link
        className="row"
        data-property-row=""
        data-list-row
        to={`/properties/${p.shortId}`}
        aria-label={`Открыть объект: ${p.title}`}
      >
        {canSelect && (
          <input
            type="checkbox"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(p.id)}
            aria-label={`Выбрать объект: ${p.title}`}
            className="mh-pick"
          />
        )}
        <span className="av" aria-hidden="true" style={{ borderRadius: 10, overflow: "hidden", background: "var(--hover)" }}>
          {p.photos[0] ? (
            <img src={p.photos[0].thumbUrl} alt="" loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ fontSize: 13, color: "var(--muted)" }}>Фото</span>
          )}
        </span>
        <span className="b">
          <span className="n">
            <PropertyHealthDot health={health} />
            {/* Название без номера, метка этапа строкой ниже (23.09.2026): на
                390 px номер «ОБ-000019» и длинная метка «На монтаже, 3 дн.»
                съедали строку, и от названия оставалось «ОБ…». */}
            <span className="nm">{p.title}</span>
            {p.publishedOnSite && <span className="chip ok xs">на сайте</span>}
            {!!p.handoverPendingSince && !!myId && p.intakeAgent?.id === myId && (
              <span className="chip warn xs">передан вам</span>
            )}
          </span>
          <span className="s mh-prop-s">
            {chipClass && <span className={chipClass}>{statusChipLabel(p.status, p.pipeline)}</span>}
            <span className="tx">{meta}</span>
          </span>
        </span>
        <span className="r">
          <span className="tm">{formatMoney(p.price, p.currency)}</span>
          <span className="tm">{formatPricePerSqm(p.price, p.areaSqm, p.currency)}</span>
        </span>
      </Link>
      {stage?.overdue && (
        <div className="sec" style={{ marginTop: 0 }}>
          <div className="quiet">
            <div className="ln">
              <i className="c" aria-hidden />
              <span>
                {STAGE_OWNER_LABELS[stage.owner ?? ""] ?? stage.owner ?? "Этап"} задерживает объект:{" "}
                {stage.daysInStage} дн. при сроке {stage.limitDays ?? "—"}.
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
