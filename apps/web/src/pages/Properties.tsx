import { useEffect, useMemo, useState } from "react";
import type { PropertyRemovalInput } from "@royal-home/shared";
import { PropertyRemovalDialog } from "../components/PropertyRemovalDialog";
import { ChevronDown, Plus, SlidersHorizontal } from "lucide-react";
import { useCleanShell } from "../hooks/useCleanShell";
import { CButton } from "../components/clean/ui";
import { PropertyDraftShortcut } from "../components/PropertyDraftShortcut";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  useBulkTrashProperties,
  useHandoverPendingProperties,
  useProperties,
  usePropertiesSummary,
  usePropertyScopeToggle,
  useSyncToSite,
  type BulkAction,
  type PropertyFilters,
} from "../hooks/useProperties";
import { useDistricts } from "../hooks/useDistricts";
import { useCan, useCanCreateProperty } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useSyncFiltersToUrl } from "../hooks/useUrlFilters";
import { PropertyRow } from "../components/PropertyRow";
import { PropertyHealthDot } from "../components/PropertyHealthDot";
import { usePropertiesHealth } from "../hooks/usePropertiesHealth";
import type { PropertyHealthBrief } from "@royal-home/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";

import { Pagination } from "../components/Pagination";
import { formatMoney, PROPERTY_TYPE_LABELS, pluralizeRu } from "../lib/format";
import { STAGE_SEGMENTS } from "../lib/theme2026";
import { siteSyncFailureText } from "../lib/siteSyncFeedback";
import { useMobileUx } from "../hooks/useMobileUx";
import { MobilePropertiesList } from "../components/mobile/MobilePropertiesList";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import type { Property } from "../types";
import { useSiteNotifications } from "../hooks/useSiteNotifications";
import { ObjectsTabs } from "../components/SectionTabs";

/** Тексты подтверждения — один источник на десктоп и мобильный (окно там одно и то же). */
const BULK_CONFIRM: Record<BulkAction, { title: string; confirmLabel: string; danger: boolean; describe: (n: number) => string }> = {
  publish: {
    title: "Опубликовать на сайт?",
    confirmLabel: "Опубликовать",
    danger: false,
    describe: (n) => `${n} объект(ов) появятся на сайте royalhome.tj сразу после подтверждения.`,
  },
  unpublish: {
    title: "Снять с публикации?",
    confirmLabel: "Снять с публикации",
    danger: true,
    describe: (n) => `${n} объект(ов) исчезнут с сайта royalhome.tj сразу после подтверждения.`,
  },
  trash: {
    title: "Удалить объекты в Корзину?",
    confirmLabel: "Удалить",
    danger: true,
    describe: (n) =>
      `${n} объект(ов) уйдут в Корзину и пропадут с сайта. Вернуть их можно оттуда же. ` +
      "Объекты со сделками останутся на месте — о них скажет отдельная строка.",
  },
};

export function Properties() {
  const clean = useCleanShell();
  const can = useCan();
  // A12 (владелец 02.10.2026): СБ объекты не заводит — кнопки «Объект» у неё нет.
  const canCreateProperty = useCanCreateProperty();
  const canPublish = can("properties.publish");
  // Вкладка «Изменения на сайте» (перенос меню 15.09.2026) — тот же счётчик и
  // право, что в lib/navigation.ts.
  const { data: siteNotifications } = useSiteNotifications({ enabled: can("siteChanges.view") });
  // Удаление партией — то же право, что у одиночной корзины на карточке
  // (properties.delete). Галочки в списке нужны обеим кнопкам, поэтому выбор
  // показывается тому, у кого есть хотя бы одна из них.
  const canBulkDelete = can("properties.delete");
  const canSelect = canPublish || canBulkDelete;
  // «N ждут вашей проверки» в подзаголовке (эталон, tpl-properties) — только у
  // модератора: он же видит кнопку «Проверить» в строке. Отдельный лёгкий запрос
  // тем же эндпоинтом (properties?status=PENDING_REVIEW), не новым: total даёт
  // честное число без выдумывания, а enabled=canModerate не гоняет его зря.
  const canModerate = can("properties.moderate");
  const { data: pendingReview } = useProperties({ status: "PENDING_REVIEW" }, canModerate);
  // Сводная плашка (показы за 30 дней, просрочка этапа по всему каталогу) —
  // отдельный лёгкий запрос, не завязан на текущий фильтр списка.
  const { data: summary } = usePropertiesSummary();
  // Объекты, переданные мне и ещё не принятые (PropertyOwnerCard.tsx на карточке
  // объекта показывает то же самое, здесь — сводкой над списком и чипом на строке).
  const { data: handoverPending } = useHandoverPendingProperties();
  const handoverPendingCount = handoverPending?.length ?? 0;
  // Телефон/планшет с пальцем получает экран прототипа design_handoff
  // (mobile-06-objects), десктоп остаётся на таблице — раскладки принципиально
  // разные, одна разметка с responsive-классами дала бы ничей интерфейс
  // (тот же довод, что у MobileHome против Dashboard).
  const mobileUx = useMobileUx();
  const [catalogToolsOpen, setCatalogToolsOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // Режим просмотра тоже в адресе: человек выбрал «Галерею», открыл объект,
  // вернулся — и снова оказывался в таблице.
  const [view, setView] = useState<"table" | "cards">(() => {
    const fromUrl = searchParams.get("view");
    return fromUrl === "cards" ? fromUrl : "table";
  });
  // Ссылкой принимаются только те фильтры, у которых на этом экране есть свой
  // видимый переключатель: район и статус. Комнаты принимались тоже — и резали
  // список молча, показать или снять их было нечем; подбор по требованиям клиента
  // теперь живёт в панели «Подбор» (components/match/MatchPanel.tsx), где фильтр
  // комнат есть.
  // Цену не принимаем: серверный фильтр сравнивает price без учёта валюты
  // (см. routes/properties.ts), бюджет в долларах отсеял бы объекты в сомони.
  // Текущий сотрудник — нужен для умолчания «Мои объекты» ниже; читаем один раз
  // здесь, а не заново в каждом месте, где спрашивают роль/id.
  // «Просрочено на монтаже» (плитка EditorDashboard/MarketingCenter, владелец:
  // один клик от красного числа до списка). Фильтр серверный — см. `overdue` в
  // propertyQuerySchema и ветки по этапам в routes/properties/list.ts: клиентский
  // отбор по текущей странице из двадцати врал бы именно на длинной очереди, то
  // есть там, где этот список только и нужен.
  const currentAgent = useAuthStore((s) => s.agent);
  const [filters, setFilters] = useState<PropertyFilters>(() => {
    const initial: PropertyFilters = {};
    const status = searchParams.get("status");
    if (status) initial.status = status;
    /**
     * КАТАЛОГ ОТКРЫВАЕТСЯ ЦЕЛИКОМ — У ВСЕХ, включая рядового агента (владелец
     * 19.09.2026: «у агентов пропало то, что они раньше видели — все объекты, а
     * сейчас только свои, а у кого нет объектов — пусто, срочно реши»).
     *
     * БЫЛО: у роли AGENT список по умолчанию сужался до `agentId = я`, что на
     * сервере превращается в `intakeAgentId = я` (routes/properties/list.ts).
     * Умолчание завели 21.08.2026 (`c6751337`) вместе с переключателем
     * «Мои/Все», и тогда оно выглядело удобством. На деле оно отдаёт агенту
     * почти всегда ПУСТОЙ экран, причём по двум независимым причинам:
     *
     *  - `intakeAgentId` — это фиксация того, кто принял объект у продавца, для
     *    расчёта доли комиссии. Заполнен он у 1 объекта из 63 (docs/TASKS.md);
     *  - `lib/agentHandover.ts` намеренно НЕ переносит `intakeAgentId` при
     *    передаче дел — это денежная запись, её не перепишешь задним числом.
     *    То есть после любой раздачи объекты по этому фильтру «ничьи».
     *
     * Агент, который сам ни одного объекта не принимал, видел пустой каталог
     * при полной базе — и никакого намёка, что данные на месте, а это фильтр:
     * кнопка «Все объекты» рядом, но искать её незачем, если экран выглядит как
     * «объектов нет вообще». Доступ тут ни при чём — агент и так видит весь
     * каталог (hint у properties.viewAll), сужал именно фильтр на клиенте.
     *
     * ТЕПЕРЬ: умолчание одно для всех — весь каталог. Переключатель
     * «Мои объекты» (usePropertyScopeToggle) на месте, им пользуется тот, кому
     * это правда нужно, — по своему выбору, а не по роли.
     *
     * Ссылка по-прежнему побеждает умолчание: агент, открывший чужую ссылку с
     * ?agentId=, видит ровно то, чем с ним поделились.
     */
    const agentId = searchParams.get("agentId");
    if (agentId) initial.agentId = agentId;
    // Ссылка несёт один район (дашборд, карта, окно подбора) — внутри он живёт
    // в общем массиве districtIds, чтобы человек мог дощёлкать к нему ещё районы.
    // `districtIds` (через запятую) — то, что пишет сам этот экран; `districtId`
    // остаётся ради старых ссылок, которые уже разосланы.
    const districtIds = searchParams.get("districtIds");
    const districtId = searchParams.get("districtId");
    if (districtIds) initial.districtIds = districtIds.split(",").filter(Boolean);
    else if (districtId) initial.districtIds = [districtId];
    const q = searchParams.get("q");
    if (q) initial.q = q;
    // Остальные фильтры экрана — чтобы возврат из карточки отдавал тот же список,
    // а не начинал подбор заново. Числа читаем через Number.isFinite: «?areaMin=abc»
    // из чужой ссылки не должен превращаться в NaN и уносить выдачу в пустоту.
    const type = searchParams.get("type");
    if (type) initial.type = type;
    const areaMin = Number(searchParams.get("areaMin"));
    if (Number.isFinite(areaMin) && searchParams.get("areaMin")) initial.areaMin = areaMin;
    const areaMax = Number(searchParams.get("areaMax"));
    if (Number.isFinite(areaMax) && searchParams.get("areaMax")) initial.areaMax = areaMax;
    const sort = searchParams.get("sort");
    if (sort) initial.sort = sort;
    if (searchParams.get("noVideo") === "1") initial.noVideo = "1";
    if (searchParams.get("overdue") === "1") initial.overdue = "1";
    // Номер страницы из адреса НЕ берём (02.10.2026): лента копится «Показать
    // ещё», и ссылка или «назад» с ?page=4 давали четвёртую страницу плюс
    // первую — вторая и третья пропадали молча. Фильтры восстанавливаются,
    // лента начинается с начала.
    return initial;
  });
  // Шторка фильтров — общий корпус `Rh2Sheet`, а не своя разметка. У ручной
  // шторки (`.sheet-back` + `<aside class="sheet right">` со своим слушателем
  // Esc) нет ловушки фокуса: Tab уходил в список под подложкой, а после
  // закрытия фокус не возвращался на кнопку «Фильтры».
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [confirmBulkAction, setConfirmBulkAction] = useState<BulkAction | null>(null);
  // Строка поиска дебаунсится: без этого q попадал в queryKey на КАЖДУЮ букву —
  // отдельный запрос на нажатие, а список исчезал и заменялся скелетонами, потому
  // что у новой пары ключей ещё нет данных. На мобильном интернете это был самый
  // заметный тормоз в CRM. Хук useDebouncedValue в проекте уже есть (см. Messages).
  const debouncedQuery = useDebouncedValue(filters.q, 350);
  // Площадь набирают цифра за цифрой: без задержки «120» уходило бы тремя запросами,
  // и список успевал дважды опустеть до «нет объектов» на промежуточных «1» и «12».
  const debouncedAreaMin = useDebouncedValue(filters.areaMin, 350);
  const debouncedAreaMax = useDebouncedValue(filters.areaMax, 350);
  const { data, isLoading, error, refetch } = useProperties({
    ...filters,
    q: debouncedQuery,
    areaMin: debouncedAreaMin,
    areaMax: debouncedAreaMax,
  });
  // Мягкая подгрузка вместо страниц (решение владельца 15.09.2026): копим
  // выданные страницы в ленту, сбрасываем при смене любого условия выдачи
  // кроме самой страницы. Один `data` на обе ветки — мобильную и широкую —
  // они делят один и тот же запрос строкой выше.
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const { data: headPage } = useProperties(
    { ...filters, page: 1, q: debouncedQuery, areaMin: debouncedAreaMin, areaMax: debouncedAreaMax },
    (filters.page ?? 1) > 1
  );
  /**
   * Удалённые в Корзину — прячем из ленты сразу (02.10.2026). После удаления
   * перечитываются только открытая страница и первая; средние накопленные
   * страницы остаются прежними, и удалённые объекты на них висели бы до смены
   * фильтра. Список держится на месте, а не сбрасывается к началу: не удалившиеся
   * строки остаются отмеченными, и человек должен их видеть.
   */
  const [trashedIds, setTrashedIds] = useState<ReadonlySet<string>>(() => new Set());
  const accumulated = useAccumulatedPages(
    data?.items,
    filters.page ?? 1,
    JSON.stringify({ ...filters, page: undefined, q: debouncedQuery, areaMin: debouncedAreaMin, areaMax: debouncedAreaMax }),
    headPage?.items
  );
  const feedItems = useMemo(
    () => (trashedIds.size ? accumulated.filter((p) => !trashedIds.has(p.id)) : accumulated),
    [accumulated, trashedIds]
  );
  const feedData = data ? { ...data, items: feedItems } : data;
  // Светофор у каждого объекта ленты — пачками, не по строке (24.09.2026).
  const health = usePropertiesHealth(feedItems.map((p) => p.id));
  const { data: districts } = useDistricts();
  const syncToSite = useSyncToSite();
  const bulkTrash = useBulkTrashProperties();
  const navigate = useNavigate();
  // «Мои объекты» / «Все объекты» — переключатель над списком (владелец 21.08.2026).
  const scope = usePropertyScopeToggle(filters, setFilters);

  // Обратная совместимость: старые ссылки ?new=1 ведут на полноэкранную форму.
  useEffect(() => {
    if (searchParams.get("new") === "1") navigate("/properties/new", { replace: true });
  }, [searchParams, navigate]);

  /**
   * Фильтры уезжают обратно в адрес.
   *
   * До этого они читались из ссылки ОДИН раз и больше туда не возвращались:
   * отфильтрованным списком нельзя было поделиться («вот эти три варианта по
   * Сино»), нельзя было сохранить его в закладки и нельзя было вернуться к нему
   * кнопкой «назад» — она уводила со страницы целиком.
   *
   * replace, а не push: иначе каждый щелчок по району оставлял бы отдельную
   * запись в истории браузера, и «назад» пришлось бы жать десять раз. Поиск
   * берётся уже отложенным (debouncedQuery) — иначе адрес переписывался бы на
   * каждую букву. Запись идёт только при реальном отличии, иначе effect будит
   * сам себя по кругу.
   */
  useSyncFiltersToUrl(
    searchParams,
    setSearchParams,
    {
      status: filters.status,
      districtIds: filters.districtIds?.length ? filters.districtIds.join(",") : undefined,
      q: debouncedQuery?.trim() || undefined,
      // В адрес уезжали только эти трое из восьми. Остальные терялись при возврате
      // из карточки: агент отбирал двушки 60–80 м² без видео, открывал объект,
      // возвращался — и получал весь список заново, с первой страницы.
      type: filters.type,
      areaMin: debouncedAreaMin != null ? String(debouncedAreaMin) : undefined,
      areaMax: debouncedAreaMax != null ? String(debouncedAreaMax) : undefined,
      sort: filters.sort,
      // «Мои»/«Все» — тоже в адресе: ссылку с чужим ?agentId= можно переслать
      // коллеге и он увидит ровно тот же срез, а не свой список поверх неё.
      agentId: filters.agentId,
      noVideo: filters.noVideo,
      overdue: filters.overdue,
      view: view !== "table" ? view : undefined,
    },
    // Старый одиночный ключ уже прочитан в начальное состояние — дальше живём на
    // districtIds, чтобы в ссылке не было двух источников правды о районе.
    // `page` — вычищаем из старых ссылок и закладок (см. начальное состояние).
    ["districtId", "page"]
  );

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function syncIds(ids: string[], action: "publish" | "unpublish") {
    setBulkError(null);
    try {
      const result = await syncToSite.mutateAsync({ ids, action });
      const failure = siteSyncFailureText(result.results);
      if (failure) {
        setBulkError(failure);
      } else {
        setSelectedIds(new Set());
      }
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Не удалось синхронизировать с сайтом");
    }
  }

  /**
   * Массовое удаление в Корзину. Партия не всё-или-ничего: сервер отвечает
   * строкой на каждый объект, и отказ по одному (есть сделки) не отменяет
   * остальные. Неудавшиеся ОСТАЮТСЯ отмеченными — человек видит ровно те строки,
   * с которыми ещё предстоит разобраться, а не ищет их заново среди пятидесяти.
   */
  async function trashSelected(body: PropertyRemovalInput) {
    setBulkError(null);
    try {
      const result = await bulkTrash.mutateAsync({ ids: [...selectedIds], ...body });
      const failed = result.results.filter((r) => !r.ok);
      const trashed = result.results.filter((r) => r.ok).map((r) => r.id);
      if (trashed.length > 0) setTrashedIds((prev) => new Set([...prev, ...trashed]));
      if (failed.length > 0) {
        const first = failed[0];
        setBulkError(
          `Удалено ${result.trashed}, не удалось ${failed.length}: ` +
            `${first.shortId ? `№${first.shortId} — ` : ""}${first.error ?? "неизвестная причина"}`
        );
        setSelectedIds(new Set(failed.map((r) => r.id)));
      } else {
        setSelectedIds(new Set());
      }
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Не удалось удалить объекты");
    }
  }

  const handleRowPublishToggle = (id: string, action: "publish" | "unpublish") => syncIds([id], action);

  const allOnPageSelected = !!feedData && feedData.items.length > 0 && feedData.items.every((p) => selectedIds.has(p.id));
  function toggleSelectAllOnPage() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        feedData!.items.forEach((p) => next.delete(p.id));
      } else {
        feedData!.items.forEach((p) => next.add(p.id));
      }
      return next;
    });
  }

  // Окно подтверждения одно на обе раскладки — раньше две одинаковые копии
  // расходились при каждой правке текста.
  const bulkBusy = syncToSite.isPending || bulkTrash.isPending;

  const bulkConfirmDialog = confirmBulkAction === "trash" ? <PropertyRemovalDialog propertyIds={[...selectedIds]}
    title={BULK_CONFIRM.trash.title} description={`${BULK_CONFIRM.trash.describe(selectedIds.size)} Указанная причина относится ко всем выбранным объектам.`}
    confirmLabel={BULK_CONFIRM.trash.confirmLabel} onClose={() => setConfirmBulkAction(null)} onConfirm={trashSelected}
  /> : confirmBulkAction && (
    <ConfirmDialog
      title={BULK_CONFIRM[confirmBulkAction].title}
      description={BULK_CONFIRM[confirmBulkAction].describe(selectedIds.size)}
      confirmLabel={BULK_CONFIRM[confirmBulkAction].confirmLabel}
      danger={BULK_CONFIRM[confirmBulkAction].danger}
      onCancel={() => setConfirmBulkAction(null)}
      onConfirm={() => {
        void syncIds([...selectedIds], confirmBulkAction);
        setConfirmBulkAction(null);
      }}
    />
  );

  if (mobileUx && !clean) {
    return (
      <>
        <MobilePropertiesList
          draftBanner={canCreateProperty ? <PropertyDraftShortcut /> : null}
          view={view}
          onViewChange={setView}
          filters={filters}
          setFilters={setFilters}
          canModerate={canModerate}
          pendingReviewTotal={pendingReview?.total}
          summary={summary}
          data={feedData}
          health={health}
          isLoading={isLoading}
          error={error}
          onRetry={() => refetch()}
          districts={districts ?? []}
          canPublish={canPublish}
          canBulkDelete={canBulkDelete}
          canSelect={canSelect}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onBulkAction={setConfirmBulkAction}
          onClearSelection={() => setSelectedIds(new Set())}
          bulkError={bulkError}
          isBusy={syncToSite.isPending || bulkTrash.isPending}
        />
        {/* Подтверждение массового действия — узел общий с десктопом: под
            data-mobile-ux любой [role="dialog"] сам становится шторкой (index.css). */}
        {bulkConfirmDialog}
      </>
    );
  }


  /* =========================================================================
     Ниже — облик эталона темы «Royal Home 2026», перенесённый из прототипа
     docs/pult/theme-2026/screens/properties.html дословно: `.scr` → `.pg-h` →
     тихие строки `.quiet` → `.card` с сегментами стадий `.seg` в `.hscroll`,
     строкой `.filters`, панелью `.bulk`, лентой `.list` и `.pager`; отдельная
     карточка `.empty` для пустого ответа и шторка фильтров `.sheet.right`.
     Имена классов — только те, что есть в theme-2026-proto.css; данные,
     запросы, права и фильтры не тронуты.
     ========================================================================= */
  const shown = feedData?.items.length ?? 0;
  const activeExtraFilters = [
    filters.type,
    filters.districtIds?.length ? "1" : undefined,
    filters.areaMin != null ? "1" : undefined,
    filters.areaMax != null ? "1" : undefined,
    filters.sort,
    filters.noVideo,
    filters.overdue,
  ].filter(Boolean).length;

  const searchField = <input
      className="inp"
      type="search"
      placeholder="Номер, название, адрес"
      aria-label="Поиск по объектам"
      value={filters.q ?? ""}
      onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value || undefined, page: 1 }))}
    />;
  // Both layouts keep the same controls and controller state. On touch Clean,
  // less frequent scope/view/filter tools live in an ordinary native disclosure.
  const catalogTools = <>
    {/* «Мои объекты» / «Все объекты» (владелец 21.08.2026). В эталоне
        этот срез лежит в строке фильтров внутри карточки, а не в шапке
        (screens/properties.html: `.filters` → пилюля «Мои объекты»).
        Пока он стоял в `.acts`, шапка не помещалась в одну строку и
        действия уезжали на второй ряд — 136px против 57 у эталона. */}
    {currentAgent && (
      <div className="seg" role="tablist" aria-label="Чьи объекты показывать">
        <button type="button" role="tab" aria-selected={scope.isMine} onClick={scope.showMine}>
          Мои объекты
        </button>
        <button type="button" role="tab" aria-selected={!scope.isMine} onClick={scope.showAll}>
          Все объекты
        </button>
      </div>
    )}
    {!clean && searchField}
    {clean && <>
      <CButton variant="outline" aria-haspopup="dialog" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={18} aria-hidden />Фильтры{activeExtraFilters > 0 ? ` · ${activeExtraFilters}` : ""}</CButton>
      <div className="flex gap-1" role="group" aria-label="Вид списка">{(["table", "cards"] as const).map((mode) => <CButton key={mode} variant={view === mode ? "primary" : "soft"} size="sm" aria-pressed={view === mode} onClick={() => setView(mode)}>{mode === "table" ? "Строками" : "Плиткой"}</CButton>)}</div>
    </>}
    {/* Очередь монтажёра: объекты без ссылки на обзор. Кнопкой-пилюлей
        эталона, состояние — aria-pressed, как у «Мои объекты» в макете. */}
    <button
      className="pill soft"
      type="button"
      aria-pressed={!!filters.noVideo}
      onClick={() => setFilters((f) => ({ ...f, noVideo: f.noVideo ? undefined : "1", page: 1 }))}
    >
      {filters.noVideo && (
        <svg className="i" viewBox="0 0 24 24">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
      Без видео
    </button>
    <span className="spacer" />
    <span style={{ fontSize: "var(--fs-13)", color: "var(--faint)" }}>
      {data ? `Показаны ${shown} объектов из ${data.total}` : "Загрузка…"}
    </span>

  </>;

  return (
    <div className={clean ? "rh2 screens clean-properties-page" : "rh2 screens"}>
      <div className="scr">
        {clean ? <div className="clean-property-catalog-header mb-5 flex flex-wrap items-center justify-between gap-4">
          <div><h1 className="text-[28px] font-semibold tracking-tight text-ink">Объекты</h1><p className="mt-2 text-[16px] text-gray-500">{data ? `Найдено: ${data.total}` : "Каталог агентства"}<span className="clean-property-catalog-hint"> · фотографии, цена и состояние работы</span></p>{canModerate && !!pendingReview?.total && <button type="button" className="mt-2 text-[14px] text-blue" onClick={() => setFilters((f) => ({ ...f, status: "PENDING_REVIEW", page: 1 }))}>Ждут вашей проверки: {pendingReview.total}</button>}</div>
          {canCreateProperty && <div className="flex flex-wrap items-center gap-2"><PropertyDraftShortcut /><CButton aria-label="Добавить объект" onClick={() => navigate("/properties/new")}><Plus size={18} aria-hidden /><span>Добавить объект</span></CButton></div>}
        </div> : <div className="pg-h">
          <div>
            <h1>Объекты</h1>
            <p className="sub">
              Каталог агентства: что в продаже, что в резерве, что уже опубликовано на сайте.
              {data && <> Всего: <b>{data.total}</b>.</>}
              {canModerate && !!pendingReview?.total && (
                <>
                  {" "}
                  Первым делом:{" "}
                  <button
                    className="lk"
                    type="button"
                    onClick={() => setFilters((f) => ({ ...f, status: "PENDING_REVIEW", page: 1 }))}
                  >
                    {pendingReview.total} объект(ов) ждут вашей проверки
                  </button>
                  .
                </>
              )}
            </p>
          </div>
          <div className="acts">
            <div className="seg" role="tablist" aria-label="Вид списка">
              {(["table", "cards"] as const).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}>
                  {/* «Строками/Плиткой», а не «Список/Галерея» (23.09.2026): ниже
                      стоит вкладка раздела «Список | Карта», и два «Списка» подряд
                      читались как одна и та же кнопка дважды. */}
                  {v === "table" ? "Строками" : "Плиткой"}
                </button>
              ))}
            </div>
            <button className="pill ghost" type="button" onClick={() => setFiltersOpen(true)}>
              <svg className="i" viewBox="0 0 24 24">
                <path d="M3 6h18M7 12h10M10 18h4" />
              </svg>
              Фильтры
              {activeExtraFilters > 0 && (
                <span className="chip mute" style={{ height: 22 }}>
                  {activeExtraFilters}
                </span>
              )}
            </button>
            {canCreateProperty && <PropertyDraftShortcut />}
            {canCreateProperty && (
              <button className="pill ghost" type="button" onClick={() => navigate("/properties/new")}>
                <svg className="i" viewBox="0 0 24 24">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Объект
              </button>
            )}
          </div>
        </div>}

        <ObjectsTabs />


        {/* Объекты переданы мне и ждут «Принять» (PropertyOwnerCard.tsx на самой
            карточке) — сводка одной строкой над списком, а не на каждой карточке,
            плюс чип «Передан вам» на самой строке объекта ниже. */}
        {handoverPendingCount > 0 && (
          <div className="card tight">
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">
                Вам передано объектов: {handoverPendingCount} —{" "}
                <Link to={`/properties/${handoverPending?.[0]?.shortId}`} className="lk">
                  примите их в карточках
                </Link>
                .
              </span>
            </div>
          </div>
        )}

        {/* СВОДНАЯ ПЛАШКА УБРАНА, ОСТАЛАСЬ ТОЛЬКО ПРОСРОЧКА (21.09.2026).
            Владелец: «убрать подсказку — за 30 дней по каталогу 8 показов и так
            далее». Число показов по всему каталогу ничего не говорит о том, что
            делать дальше: оно стояло над списком каждый раз и в спокойный день
            читалось как «Просроченных этапов сейчас нет» — строка ради строки.
            Просрочка остаётся: по ней есть действие (ссылка открывает именно
            этих виновников, требование владельца 15.09.2026), и плашка
            появляется ТОЛЬКО когда просроченные есть. */}
        {!!summary && summary.overduePipelineCount > 0 && (
          <div className={clean ? "clean-catalog-overdue" : "card tight"}>
            <div className="quiet">
              <span className="dot crit" />
              <span className="txt">
                Этап просрочен у{" "}
                <Link to="/properties?overdue=1" className="lk">
                  {summary.overduePipelineCount}{" "}
                  {pluralizeRu(summary.overduePipelineCount, ["объекта", "объектов", "объектов"])}
                </Link>{" "}
                {!clean && "— отмечены тихой строкой в списке ниже."}
              </span>
            </div>
          </div>
        )}

        <div className={clean ? "card clean-property-catalog" : "card"}>
          {/* Сегменты по стадиям. Ключи и подписи — из enums.ts и format.ts,
              порядок тот же, что в эталоне. Счётчиков `.n` нет: ответ списка
              отдаёт только total текущего среза, выдуманных цифр не рисуем. */}
          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Стадии объектов">
              {/* «В подготовке» — тот же список, что и на телефоне: у сегмента
                  пустое `value` и признак `inPrep`, поэтому выбранность
                  считается по паре (status, inPrep), а не по одному status —
                  иначе «Все» и «В подготовке» подсвечивались бы вместе. */}
              {STAGE_SEGMENTS.map((s) => (
                <button
                  key={s.inPrep ? "in-prep" : s.value || "all"}
                  type="button"
                  role="tab"
                  aria-selected={(filters.status ?? "") === s.value && !!filters.inPrep === !!s.inPrep}
                  onClick={() =>
                    setFilters((f) => ({
                      ...f,
                      status: s.value || undefined,
                      inPrep: s.inPrep ? "1" : undefined,
                      page: 1,
                    }))
                  }
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className={clean ? "clean-catalog-toolbar" : "filters"} style={clean ? undefined : { marginTop: 16 }}>
            {clean ? <>
              {searchField}
              <details className="clean-catalog-tools" open={!mobileUx || catalogToolsOpen} onToggle={(event) => { if (mobileUx) setCatalogToolsOpen(event.currentTarget.open); }}>
                <summary aria-label={`Фильтры и вид списка, активно: ${activeExtraFilters + (scope.isMine ? 1 : 0)}`}>
                  <SlidersHorizontal size={18} aria-hidden="true" />
                  <span>Фильтры и вид</span>
                  {!!(activeExtraFilters + (scope.isMine ? 1 : 0)) && <b className="clean-catalog-filter-count">{activeExtraFilters + (scope.isMine ? 1 : 0)}</b>}
                  <span className="clean-catalog-view-label">{scope.isMine ? "Мои" : "Все"} · {view === "table" ? "Строками" : "Плиткой"}</span>
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <div className="clean-catalog-tool-content">{catalogTools}</div>
              </details>
            </> : catalogTools}
          </div>

          {canSelect && selectedIds.size > 0 && (
            <div className="bulk" style={{ marginTop: 16 }}>
              <span className="cnt">Выбрано {selectedIds.size}</span>
              {canPublish && (
                <>
                  <button
                    className="pill sm"
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => setConfirmBulkAction("publish")}
                  >
                    Опубликовать на сайт
                  </button>
                  <button
                    className="pill ghost sm"
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => setConfirmBulkAction("unpublish")}
                  >
                    Снять с публикации
                  </button>
                </>
              )}
              {canBulkDelete && (
                <button
                  className="pill ghost sm"
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => setConfirmBulkAction("trash")}
                >
                  В корзину
                </button>
              )}
              <span className="spacer" />
              <button className="lnk" type="button" onClick={() => setSelectedIds(new Set())}>
                Снять выбор
              </button>
            </div>
          )}

          {/* Отказ публикации/удаления показывается и без отмеченных галочек: кнопка
              «Опубликовать» на самой строке ничего не отмечает (WEB-PAGES20). */}
          {bulkError && (
            <div className="quiet crit" role="alert" style={{ marginTop: 16 }}>
              <span className="dot crit" />
              <span className="txt">{bulkError}</span>
            </div>
          )}

          {isLoading && !error && (
            <div className="list">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="prow row">
                  <span className="ph" />
                  <div className="t">
                    <span className="sk w40" />
                    <span className="sk w28" style={{ marginTop: 8 }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="empty">
              <span className="ic">
                <svg className="i" viewBox="0 0 24 24">
                  <path d="M3 11 12 3l9 8v10H3z" />
                  <path d="M9 21v-6h6v6" />
                </svg>
              </span>
              <p>Не удалось загрузить каталог.</p>
              <p className="sub">Проверьте соединение и попробуйте ещё раз.</p>
              <button className="pill ghost" type="button" onClick={() => refetch()}>
                Повторить
              </button>
            </div>
          )}

          {data && view === "table" && feedItems.length > 0 && (
            <div className="list">
              {canSelect && (
                <label className={clean ? "chk !min-h-11 cursor-pointer" : "chk"}>
                  <input type="checkbox" checked={allOnPageSelected} onChange={toggleSelectAllOnPage} />
                  Выбрать все на странице
                </label>
              )}
              {feedItems.map((p) => (
                <PropertyRow
                  key={p.id}
                  property={p}
                  clean={clean}
                  myId={currentAgent?.id}
                  selected={selectedIds.has(p.id)}
                  onToggleSelect={canSelect ? toggleSelect : undefined}
                  onTogglePublish={canPublish ? handleRowPublishToggle : undefined}
                  health={health.get(p.id)}
                />
              ))}
            </div>
          )}

          {data && view === "cards" && feedItems.length > 0 && (
            <div className={clean ? "grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3" : "pgrid"}>
              {clean && canSelect && <label className="col-span-full mb-1 flex min-h-11 cursor-pointer items-center gap-2 text-[14px] text-gray-500"><input type="checkbox" checked={allOnPageSelected} onChange={toggleSelectAllOnPage} className="size-5 accent-blue" />Выбрать все на странице</label>}
              {feedItems.map((p) => (
                clean ? <PropertyRow key={p.id} property={p} clean cleanVariant="card" myId={currentAgent?.id} selected={selectedIds.has(p.id)} onToggleSelect={canSelect ? toggleSelect : undefined} onTogglePublish={canPublish ? handleRowPublishToggle : undefined} health={health.get(p.id)} /> : <PropertyCard
                  key={p.id}
                  property={p}
                  health={health.get(p.id)}
                  onClick={() => navigate(`/properties/${p.shortId}`)}
                />
              ))}
            </div>
          )}

          {/* Пусто — отдельный вид эталона, когда фильтр ничего не нашёл. */}
          {data && feedItems.length === 0 && (
            <div className="empty">
              <span className="ic">
                <svg className="i" viewBox="0 0 24 24">
                  <path d="M3 11 12 3l9 8v10H3z" />
                  <path d="M9 21v-6h6v6" />
                </svg>
              </span>
              <p>Под этот фильтр объектов нет.</p>
              <p className="sub">Попробуйте убрать район или расширить площадь.</p>
              <button
                className="pill ghost"
                type="button"
                onClick={() => setFilters(() => ({}))}
              >
                Сбросить фильтры
              </button>
            </div>
          )}

          {data && (
            <div style={{ marginTop: 16 }}>
              <Pagination
                variant="loadMore"
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
              />
            </div>
          )}
        </div>
      </div>

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
              onClick={() =>
                setFilters((f) => ({
                  status: f.status,
                  agentId: f.agentId,
                  q: f.q,
                  page: 1,
                }))
              }
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
          {/* Район в CRM выбирается несколькими сразу (сервер принимает
              districtIds списком) — поэтому не `select` эталона, а его же
              `.chk`: язык прототипа сохранён, множественный выбор не отнят. */}
          <div className="fld">
            <span className="lab">Район</span>
            <div className="wrap">
              {(districts ?? []).map((d) => {
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
            <span className="msg">
              Цену фильтром пока не сужаем: на сервере она хранится без валюты.
            </span>
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
          <label className="chk">
            <input
              type="checkbox"
              checked={!!filters.noVideo}
              onChange={() => setFilters((f) => ({ ...f, noVideo: f.noVideo ? undefined : "1", page: 1 }))}
            />
            Только без видео
          </label>
        </div>
      </Rh2Sheet>

      {bulkConfirmDialog}
    </div>
  );
}

/**
 * Плитка галереи. Вида «галерея» в прототипе нет (там только список), поэтому
 * плитка собрана из его же частей: ячейка `.pgrid .cell` со снимком, цена
 * `.money` и пилюля состояния под ней.
 */
function PropertyCard({
  property: p,
  health,
  onClick,
}: {
  property: Property;
  health: PropertyHealthBrief | undefined;
  onClick: () => void;
}) {
  return (
    <div className="cell" onClick={onClick} data-property-row="" role="button" tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {p.photos[0] ? (
        <img
          src={p.photos[0].thumbUrl}
          alt=""
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <svg className="i" viewBox="0 0 24 24">
          <path d="M3 11 12 3l9 8v10H3z" />
          <path d="M9 21v-6h6v6" />
        </svg>
      )}
      <PropertyHealthDot health={health} />
      <span className="lead">{formatMoney(p.price, p.currency)}</span>
    </div>
  );
}
