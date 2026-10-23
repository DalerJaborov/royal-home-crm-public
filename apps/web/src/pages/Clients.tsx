import { useLegacyAgentMobile } from "../hooks/useLegacyAgentMobile";
import { useClientRowActions } from "../hooks/useClientRowActions";
import { useCleanShell } from "../hooks/useCleanShell";
import { CleanClientRow, cleanClientColumns } from "../components/clean/CleanClientRow";
import { CButton, cn } from "../components/clean/ui";
import { lazyWithReload } from "../lib/lazyWithReload";
const MobileClientsList = lazyWithReload(() => import("../components/mobile/MobileClientsList").then((m) => ({ default: m.MobileClientsList })));
const MobileInquiries = lazyWithReload(() => import("../components/mobile/MobileInquiries").then((m) => ({ default: m.MobileInquiries })));
import { useCallback, useEffect, useState } from "react";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  useClients,
  useClientsSummary,
  type ClientFilters,
} from "../hooks/useClients";
import { Check, Plus, RotateCcw, Search, SlidersHorizontal, UserRound } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  Filters,
  List,
  PageHeader,
  Rh2EmptyState,
  Rh2Screen,
  Rh2Sheet,
  Row,
  Segment,
  Skeleton,
  Tabs,
  type TabOption,
} from "../components/rh2";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";
import { useAgents } from "../hooks/useAgents";
import { useTransferClient } from "../hooks/useMissionControl";
import type { ClientSort } from "@royal-home/shared";
import { CallClientButton } from "../components/CallClientButton";
import { SwipeRow } from "../components/SwipeRow";
import { useMarkSectionSeen } from "../hooks/useCounters";
import { useMobileUx } from "../hooks/useMobileUx";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import { Pagination } from "../components/Pagination";
import { useDistricts } from "../hooks/useDistricts";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useSyncFiltersToUrl } from "../hooks/useUrlFilters";
import { useDuplicates } from "../hooks/useDuplicates";
import { useAuthStore } from "../store/auth";
import { DuplicatesModal } from "../components/DuplicatesModal";
import { ClientAvatar } from "../components/ClientAvatar";
import { isRecentlyReturned } from "../components/ReturnedBadge";
import { INACTIVE_LEVEL_LABELS } from "../components/InactiveLevelBadge";
import { ClientStateBadge } from "../components/ClientStateBadge";
import { clientPrimaryState } from "../lib/clientPrimaryState";
import { ClientFormModal } from "../components/ClientFormModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MutationError } from "../components/MutationError";
import { formatWait, relativeTime } from "../lib/format";
import { readKindParam } from "../lib/clientsKindParam";
import { clientAction } from "../lib/clientAction";
import {
  CLIENT_KIND_LABELS,
  CLIENT_SOURCE_LABELS,
  CLIENT_STATUS_LABELS,
  DEFAULT_CLIENT_SORT,
  clientSortOptionsFor,
  formatClientCode,
  formatClientName,
} from "../lib/clientFormat";
import type { Client } from "../types";

/*
 * ЭКРАН «КЛИЕНТЫ» — ОДИН АДАПТИВНЫЙ ЭКРАН НА КОМПЬЮТЕР И ТЕЛЕФОН (контракт
 * оболочки 06.10.2026, раздел 5; задание E2).
 *
 * Было шесть входов в один список (Покупатели, Продавцы, Неактивные, Потерянные,
 * Горячие, Новые) плюс два мобильных файла со своей копией списка. Стало:
 *   · переключатель «Продавцы · Покупатели» (`Segment`);
 *   · вкладки «В работе · Неактивные», у руководителя ещё «Потерянные» (право
 *     `clients.assign`, как и было); «Отложенные» и «Воронка» живут своими
 *     маршрутами в меню «Ещё»;
 *   · «Горячие» и «Новые» — значения фильтра «Статус» в шторке «Фильтры»;
 *   · строка списка: аватар 44, имя, «3 комн · Сино · $55–70 тыс. · Instagram»,
 *     ОДИН чип-действие (lib/clientAction.ts) и трубка справа.
 *
 * Для AGENT на телефоне сохранены списки frozen main 4edafe6dc; остальным раскладку
 * телефона даёт тот же набор `components/rh2` и пара медиа-запросов темы.
 * `useMobileUx()` здесь выбирает только раскладку (где стоит переключатель,
 * короткая подпись чипа, кнопки в шапке оболочки), не отдельное дерево.
 *
 * Данные, запросы, права, фильтры и маршруты не тронуты: те же хуки, те же
 * мутации, те же ключи react-query. Маршруты `/clients`, `/sellers`,
 * `/inactive-clients`, `/clients/all-mine`, `/other-inquiries` рендерят этот же
 * компонент (App.tsx).
 */

type TabId = "work" | "inactive" | "lost";

/** Одна цифра после запятой, без хвоста «,0»: 1,7 млн, но 2 млн. */
const oneDecimal = (x: number) => (Math.round(x * 10) / 10).toLocaleString("ru-RU");

/**
 * Бюджет для второй строки: «$55–70 тыс.», «до $45 тыс.», «от 1,2 млн с.».
 * Единица берётся по большему краю, чтобы «55–70» не превращалось в «55–70 000».
 */
function budgetShort(c: Pick<Client, "budgetMin" | "budgetMax" | "currency">): string | null {
  const min = c.budgetMin ? Number(c.budgetMin) : null;
  const max = c.budgetMax ? Number(c.budgetMax) : null;
  if (!min && !max) return null;
  const ref = (max || min) as number;
  const div = ref >= 1_000_000 ? 1_000_000 : ref >= 1_000 ? 1_000 : 1;
  const unit = div === 1_000_000 ? " млн" : div === 1_000 ? " тыс." : "";
  const sym = c.currency === "USD" ? "$" : "";
  const tail = c.currency === "USD" ? "" : " с.";
  if (min && max) return `${sym}${oneDecimal(min / div)}–${oneDecimal(max / div)}${unit}${tail}`;
  if (max) return `до ${sym}${oneDecimal(max / div)}${unit}${tail}`;
  return `от ${sym}${oneDecimal((min as number) / div)}${unit}${tail}`;
}

const num = (n: number) => n.toLocaleString("ru-RU");

const sectionPath = (k: "SELLER" | "BUYER") => (k === "SELLER" ? "/sellers" : "/clients");

export function Clients({ kind = "BUYER" }: { kind?: "BUYER" | "SELLER" | "OTHER" } = {}) {
  /**
   * САМОЗАЩИТА РОЛИ ДО ВСЕГО ОСТАЛЬНОГО (11.09.2026). Маркетинг с монтажёром по
   * прямому адресу видели пустой список вместо честного «раздел не ваш»: данных им
   * сервер и так не отдаёт, но экран врал, будто клиентов просто нет.
   */
  const gateRole = useAuthStore((s) => s.agent?.role);
  const legacyAgentMobile = useLegacyAgentMobile();
  if (kind !== "OTHER" && (gateRole === "MARKETING" || gateRole === "EDITOR")) {
    return <RoleGate title="Клиенты" text="Раздел недоступен этой роли." />;
  }
  if (legacyAgentMobile) return kind === "OTHER" ? <MobileInquiries /> : <MobileClientsList kind={kind} />;
  return <ClientsList kind={kind} />;
}

/** Экран роли без доступа — тихой строкой прототипа (договор §6.12), а не пустотой. */
function RoleGate({ title, text }: { title: string; text: string }) {
  return (
    <Rh2Screen title={title}>
      <PageHeader title={title} />
      <Card tight>
        <div className="state">{text}</div>
      </Card>
    </Rh2Screen>
  );
}

function ClientsList({ kind = "BUYER" }: { kind?: "BUYER" | "SELLER" | "OTHER" } = {}) {
  const clean = useCleanShell();
  const isSeller = kind === "SELLER";
  const isOther = kind === "OTHER";
  const role = useAuthStore((s) => s.agent?.role);
  const mobile = useMobileUx();
  const navigate = useNavigate();
  const can = useCan();
  const readOnly = useIsReadOnly();
  // Открытие раздела гасит красный счётчик в сайдбаре (у текущего агента).
  useMarkSectionSeen(kind === "BUYER" ? "clients" : isSeller ? "sellers" : "otherInquiries");
  const [searchParams, setSearchParams] = useSearchParams();
  /**
   * `/inactive-clients` — настоящий маршрут (владелец 17.09.2026), не срез
   * query-параметром поверх `/clients`: так подсветка вкладки указывает на верную
   * вкладку, а адрес годится для закладки. kind у этого маршрута не важен:
   * покупатели и продавцы идут вместе, пока не задан `?kind=`.
   */
  const location = useLocation();
  const isInactiveRoute = location.pathname === "/inactive-clients";
  /**
   * «НЕ НА ВИДУ» — тоже настоящий маршрут (18.09.2026, задание В §f п.1,
   * `/clients/all-mine`): всё, что назначено держателю, включая карточки в корзине
   * и переданные. Сервер сам снимает kind-срез при `scope=allMine`.
   */
  const isAllMineRoute = location.pathname === "/clients/all-mine";
  /**
   * ИЗ КАКОГО РАЗДЕЛА ПРИШЛИ (21.09.2026). «Неактивные» — общий маршрут для
   * продавцов и покупателей; значение из адреса сильнее пропа маршрута, у
   * `/inactive-clients` проп стоит заглушкой (BUYER), см. App.tsx.
   */
  const kindParam = searchParams.get("kind");
  const { sectionKind, allKinds } = readKindParam(kindParam);
  const section: "SELLER" | "BUYER" = sectionKind ?? (isSeller ? "SELLER" : "BUYER");
  /**
   * Фильтры читаются из адреса и туда же возвращаются: «назад» из карточки
   * возвращает тот же срез, ссылку на срез можно отправить коллеге.
   */
  const [filters, setFilters] = useState<ClientFilters>(() => {
    const initial: ClientFilters = {};
    const status = searchParams.get("status");
    if (status) initial.status = status;
    const districtId = searchParams.get("districtId");
    if (districtId) initial.districtId = districtId;
    const source = searchParams.get("source");
    if (source) initial.source = source;
    const agentId = searchParams.get("agentId");
    if (agentId) initial.agentId = agentId;
    const q = searchParams.get("q");
    if (q) initial.q = q;
    const sort = searchParams.get("sort");
    if (sort) initial.sort = sort as ClientSort;
    /**
     * НОМЕР СТРАНИЦЫ ИЗ АДРЕСА НЕ БЕРЁМ (02.10.2026). Список растёт лентой
     * («Показать ещё»), и ссылка с ?page=4 открывала четвёртую страницу плюс
     * первую — со второй по третью строки пропадали молча.
     *
     * Пришли из «Контроль руководителя» → «Светофор неактивных» — три фильтра
     * одним заходом: agentId, workStatus, inactiveLevel.
     */
    const workStatus = isInactiveRoute ? "INACTIVE" : searchParams.get("workStatus");
    if (workStatus === "ACTIVE" || workStatus === "INACTIVE") initial.workStatus = workStatus;
    const inactiveLevel = searchParams.get("inactiveLevel");
    if (inactiveLevel === "GREEN" || inactiveLevel === "YELLOW" || inactiveLevel === "RED") {
      initial.inactiveLevel = inactiveLevel;
    }
    return initial;
  });
  /**
   * ПЕРЕХОД МЕЖДУ «В РАБОТЕ» И «НЕАКТИВНЫМИ» БЕЗ ПЕРЕЗАГРУЗКИ (17.09.2026).
   * `filters` читает адрес один раз, при монтировании; при переходе внутри
   * приложения React переиспользует смонтированный компонент, и инициализатор
   * второй раз не срабатывает. Эффект держит `workStatus`/`inactiveLevel` в
   * синхроне с адресом при каждом его изменении.
   */
  useEffect(() => {
    const workStatus = isInactiveRoute ? "INACTIVE" : searchParams.get("workStatus");
    const inactiveLevel = searchParams.get("inactiveLevel");
    setFilters((f) => {
      const nextWorkStatus = workStatus === "ACTIVE" || workStatus === "INACTIVE" ? workStatus : undefined;
      const nextInactiveLevel =
        inactiveLevel === "GREEN" || inactiveLevel === "YELLOW" || inactiveLevel === "RED" ? inactiveLevel : undefined;
      if (f.workStatus === nextWorkStatus && f.inactiveLevel === nextInactiveLevel) return f;
      return { ...f, workStatus: nextWorkStatus, inactiveLevel: nextInactiveLevel, page: 1 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInactiveRoute, searchParams.get("workStatus"), searchParams.get("inactiveLevel")]);
  /**
   * `?new=1` открывает форму сразу — этим адресом пользуются ярлык «Клиент» в меню
   * установленного приложения и «+» → «Новый клиент» (FabMenu). Читаем один раз и
   * тут же убираем ключ из адреса (в `drop` ниже): иначе он останется в закладке.
   */
  const [showForm, setShowForm] = useState(() => !isOther && searchParams.get("new") === "1");
  /** `?phone=` вместе с `?new=1` — из наборщика: набранного номера нет в базе. */
  const [newClientPhone] = useState(() => searchParams.get("phone") ?? undefined);
  const [showDuplicates, setShowDuplicates] = useState(false);
  /** Шторка «Фильтры»: срез, статус, источник, район, агент, порядок. */
  const [showFilters, setShowFilters] = useState(false);
  /** Шторка «Не на виду»: карточки в корзине и переданные другому. */
  const [showHidden, setShowHidden] = useState(false);
  /** Поле поиска на телефоне открывается значком в шапке; на компьютере стоит всегда. */
  const [searchOpen, setSearchOpen] = useState(false);
  /**
   * Срез «Ждут принятия» — серверный фильтр `pendingAcceptance` (acceptedAt IS
   * NULL, routes/clients/list.ts): число в шторке то же, что у `awaitingAgent`.
   * Приходит и по ссылке (`?slice=pending`).
   */
  const [pendingSlice, setPendingSlice] = useState(() => searchParams.get("slice") === "pending");
  /**
   * «Вчера остались без ответа» (плитка директора) — серверный срез
   * `noFirstContactYesterday`; тем же правилом считается число на плитке, поэтому
   * список и число сходятся. Неизвестному значению `slice` экран не верит.
   */
  const [noResponseYesterday, setNoResponseYesterday] = useState(() => searchParams.get("slice") === "noResponseYesterday");
  // Дебаунс строки поиска — см. тот же комментарий в Properties.tsx.
  const debouncedQuery = useDebouncedValue(filters.q, 350);
  useSyncFiltersToUrl(
    searchParams,
    setSearchParams,
    {
      status: filters.status,
      districtId: filters.districtId,
      source: filters.source,
      agentId: filters.agentId,
      workStatus: filters.workStatus,
      inactiveLevel: filters.inactiveLevel,
      q: debouncedQuery?.trim() || undefined,
      sort: filters.sort,
      slice: pendingSlice ? "pending" : noResponseYesterday ? "noResponseYesterday" : undefined,
    },
    // `page` — вычищаем из старых ссылок и закладок (см. начальное состояние выше).
    ["new", "phone", "page"]
  );
  /**
   * Смена раздела внутри «Неактивных» (`?kind=` в том же адресе) — компонент тот
   * же, а лента обязана начаться заново: иначе накопленная страница N приезжала
   * бы без страниц 2..N-1 нового раздела.
   */
  useEffect(() => {
    setFilters((f) => (f.page && f.page > 1 ? { ...f, page: 1 } : f));
  }, [sectionKind]);
  const { data: districts } = useDistricts();
  /**
   * ПОИСК ИЩЕТ ПО ВСЕМ РАЗДЕЛАМ, А НЕ ВНУТРИ ВКЛАДКИ (владелец 09.09.2026): как
   * только в поле есть текст, `kind` из запроса уходит совсем, а в строке
   * результата называется раздел. Граница прав не двигается: роль без права
   * `otherInquiries.view` ищет внутри вкладки, иначе запрос без `kind` вернул бы ей
   * «прочие обращения». Агента это не касается: сервер и без `kind` отдаёт ему
   * только его покупателей и продавцов.
   */
  const searching = !!debouncedQuery?.trim();
  const searchAcrossKinds = searching && (role === "AGENT" || can("otherInquiries.view"));
  /**
   * «Светофор неактивных» из «Контроль руководителя» приходит БЕЗ раздела и
   * показывает оба вида сразу. Когда в «Неактивные» вошли из раздела (`?kind=`),
   * срез по виду обязан остаться: иначе у продавцов лежали бы покупатели.
   */
  const trafficLightDrilldown = !isOther && filters.workStatus === "INACTIVE" && !sectionKind;
  const kindForQuery =
    searchAcrossKinds || trafficLightDrilldown || isAllMineRoute || allKinds || pendingSlice ? undefined : sectionKind ?? kind;
  const clientQuery: ClientFilters = {
    ...filters,
    q: debouncedQuery,
    // «Ждут принятия» — и покупатели, и продавцы разом: так считает число в шторке
    // (useClientsSummary.awaitingAgent), и срез по разделу давал список короче числа.
    kind: kindForQuery,
    ...(isAllMineRoute ? { scope: "allMine" as const } : {}),
    ...(pendingSlice ? { pendingAcceptance: true } : {}),
    ...(noResponseYesterday ? { noFirstContactYesterday: true, sort: "created_desc" as const } : {}),
    // «Прочие обращения»: свежие сверху (серверный порядок по умолчанию и есть рабочий).
    ...(isOther && !filters.sort && !noResponseYesterday ? { sort: DEFAULT_CLIENT_SORT } : {}),
  };
  // «Прочие обращения» — управленческий раздел: без права сервер ответил бы 403.
  const otherBlocked = isOther && !can("otherInquiries.view");
  const { data, isLoading, isFetching, error, refetch } = useClients(clientQuery, !otherBlocked);
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const { data: headPage } = useClients({ ...clientQuery, page: 1 }, (filters.page ?? 1) > 1 && !otherBlocked);
  // Мягкая подгрузка вместо страниц (решение владельца 15.09.2026): строки копятся,
  // сброс — при смене любого условия выдачи, кроме самой страницы.
  const visibleItems = useAccumulatedPages(
    data?.items,
    filters.page ?? 1,
    JSON.stringify({
      ...filters,
      page: undefined,
      q: debouncedQuery,
      kind: searchAcrossKinds || trafficLightDrilldown || isAllMineRoute || allKinds ? undefined : sectionKind ?? kind,
      pendingSlice,
      noResponseYesterday,
      isAllMineRoute,
    }),
    headPage?.items
  );
  // Ссылка постоянная: Pagination держит её в зависимостях своего эффекта.
  const setPage = useCallback((page: number) => setFilters((f) => ({ ...f, page })), []);
  // Дубликаты видит только руководство — объединение затрагивает клиентов разных агентов.
  const { data: duplicates } = useDuplicates(can("clients.merge"));
  /** Сводка экрана: счётчики срезов, «ждёт агента», «не на виду». Один запрос. */
  const { data: summary } = useClientsSummary(!isOther);
  // Список агентов — только для шторки фильтров руководителя (агент видит своих и так).
  const { data: agents } = useAgents({ enabled: can("clients.viewAll") });
  const assign = useTransferClient();
  const oldest = summary?.awaitingAgent.oldest ?? null;
  const freeAgent = summary?.freeAgents?.[0] ?? null;
  const waitLabel = oldest ? formatWait(oldest.waitingMinutes) : "";
  // «Не на виду»: список грузится только когда шторка открыта.
  const hiddenQuery = useClients({ scope: "allMine" }, showHidden);

  // «Прочие обращения» — управленческий раздел, агентам сюда доступа нет (API и так
  // не вернёт им ни одной записи, но сообщение понятнее пустого списка).
  if (otherBlocked) {
    return <RoleGate title="Прочие обращения" text="Раздел доступен руководству." />;
  }

  // Клиенты, продавцы и горячие клиенты — не работа маркетинга и монтажёра: сама
  // самозащита стоит в обёртке `Clients`, здесь на случай прямого перехода по `kind`.
  if (!isOther && (role === "MARKETING" || role === "EDITOR")) {
    return <RoleGate title="Клиенты" text="Раздел недоступен этой роли." />;
  }

  const inactiveView = isInactiveRoute || trafficLightDrilldown;
  const title = trafficLightDrilldown
    ? filters.inactiveLevel
      ? `Неактивные · ${INACTIVE_LEVEL_LABELS[filters.inactiveLevel]}`
      : "Неактивные"
    : isOther
      ? "Прочие обращения"
      : isAllMineRoute
        ? "Не на виду"
        : "Клиенты";
  const kindWord = section === "SELLER" ? "Продавцы" : "Покупатели";
  const inWorkCount = summary ? (section === "SELLER" ? summary.sellers : summary.buyers) : null;
  const plainView = !filters.status && !filters.source && !filters.districtId && !filters.agentId && !searching;
  // Подзаголовок описывает то, что НА ЭКРАНЕ: при поиске по всем разделам одного
  // «Покупатели · в работе N» было бы враньём, поэтому там говорится о поиске.
  const sub = searchAcrossKinds
    ? "Поиск идёт по всем разделам сразу"
    : isOther
      ? `Не покупатель и не продавец${data ? ` · ${num(data.total)}` : ""}`
      : isAllMineRoute
        ? "Всё, что назначено вам, включая карточки в корзине и переданные"
        : trafficLightDrilldown
          ? "Покупатели и продавцы вместе"
          : isInactiveRoute
            ? `${kindWord}${data && plainView ? ` · неактивных ${num(data.total)}` : ""}`
            : `${kindWord}${inWorkCount != null ? ` · в работе ${num(inWorkCount)}` : ""}`;

  const currentSort = filters.sort ?? DEFAULT_CLIENT_SORT;
  const slice: "all" | "pending" | "yesterday" = pendingSlice ? "pending" : noResponseYesterday ? "yesterday" : "all";
  const activeFilterCount =
    [filters.status, filters.source, filters.districtId, filters.agentId].filter(Boolean).length + (slice !== "all" ? 1 : 0);
  const showSwitches = !isOther && !isAllMineRoute && !trafficLightDrilldown;
  const showSearch = !mobile || searchOpen || !!filters.q;

  const resetFilters = () => {
    setFilters((f) => ({ q: f.q, sort: f.sort, workStatus: f.workStatus, inactiveLevel: f.inactiveLevel, page: 1 }));
    setPendingSlice(false);
    setNoResponseYesterday(false);
  };
  const patchFilters = (patch: Partial<ClientFilters>) => setFilters((f) => ({ ...f, ...patch, page: 1 }));

  const tabOptions: TabOption<TabId>[] = [
    { id: "work", label: "В работе", count: !trafficLightDrilldown && inWorkCount != null ? inWorkCount : undefined },
    { id: "inactive", label: "Неактивные" },
    // «Потерянные» — управленческий раздел: вкладка по тому же праву, что и сам маршрут.
    ...(can("clients.assign") ? [{ id: "lost" as const, label: "Потерянные" }] : []),
  ];
  const goTab = (id: TabId) => {
    if (id === "work") navigate(sectionPath(section));
    else if (id === "inactive") navigate(`/inactive-clients?kind=${section}`);
    else navigate(`/lost-clients?kind=${section}`);
  };
  const goSection = (k: "SELLER" | "BUYER") => navigate(isInactiveRoute ? `/inactive-clients?kind=${k}` : sectionPath(k));

  const segment = showSwitches ? (
    <Segment
      aria-label="Продавцы или покупатели"
      value={section}
      onChange={goSection}
      options={[
        { id: "SELLER", label: "Продавцы" },
        { id: "BUYER", label: "Покупатели" },
      ]}
    />
  ) : null;

  /**
   * ТЕЛЕФОН: два круглых значка в шапке оболочки — поиск и фильтры (контракт). Шапка
   * живёт вне области `.rh2 .scr`, поэтому кнопки в её стиле (`.sh-btn`, как у
   * поиска и аватара самой шапки), а не `Button` набора. «+» в шапке нет: есть FAB.
   */
  const shellActions = mobile ? (
    <>
      <button
        type="button"
        className="sh-btn flex items-center justify-center"
        aria-label={searchOpen ? "Закрыть поиск по клиентам" : "Поиск по клиентам"}
        aria-pressed={searchOpen}
        onClick={() => {
          if (searchOpen && filters.q) patchFilters({ q: undefined });
          setSearchOpen((v) => !v);
        }}
      >
        <Search className="w-[19px] h-[19px]" strokeWidth={1.8} aria-hidden />
      </button>
      <button
        type="button"
        className="sh-btn flex items-center justify-center"
        aria-label={activeFilterCount > 0 ? `Фильтры клиентов, включено ${activeFilterCount}` : "Фильтры клиентов"}
        aria-haspopup="dialog"
        onClick={() => setShowFilters(true)}
      >
        <SlidersHorizontal className="w-[19px] h-[19px]" strokeWidth={1.8} aria-hidden />
      </button>
    </>
  ) : undefined;

  return (
    <Rh2Screen title={title} back={isAllMineRoute ? sectionPath(section) : undefined} actions={shellActions} className={clean ? "clean-clients-page" : undefined}>
      {mobile ? (
        // Заголовок на телефоне стоит в шапке оболочки; для скринридера он остаётся.
        clean && !isOther && !readOnly ? <div className="flex justify-end"><h1 className="sr-only">{title}</h1><CButton onClick={() => setShowForm(true)}><Plus size={18} aria-hidden />Добавить клиента</CButton></div> : <h1 className="sr-only">{title}</h1>
      ) : clean ? (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div><h1 className="text-[28px] font-semibold tracking-tight text-ink">{title}</h1><p className="mt-2 text-[16px] text-gray-500">{sub}</p></div>
          <div className="flex flex-wrap items-center gap-3">{segment}{!isOther && !readOnly && <CButton onClick={() => setShowForm(true)}><Plus size={18} aria-hidden />Добавить клиента</CButton>}</div>
        </div>
      ) : (
        <PageHeader
          title={title}
          sub={sub}
          actions={
            <>
              {segment}
              <Button
                variant="ghost"
                icon={<SlidersHorizontal size={18} aria-hidden />}
                aria-haspopup="dialog"
                onClick={() => setShowFilters(true)}
              >
                Фильтры{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
              </Button>
              {/* «Прочие обращения» приходят извне — вручную такая карточка не заводится.
                  Единственная синяя кнопка экрана. */}
              {!isOther && !readOnly && (
                <Button icon={<Plus size={18} aria-hidden />} onClick={() => setShowForm(true)}>
                  Клиент
                </Button>
              )}
            </>
          }
        />
      )}

      {mobile && segment}

      {showSwitches && (
        <Tabs
          aria-label="Состояние клиентов раздела"
          options={tabOptions}
          value={inactiveView ? "inactive" : "work"}
          onChange={goTab}
        />
      )}

      {/* Тихие строки вместо карточек-уведомлений (договор §6.1): ждёт агента, похожие карточки */}
      {!isOther && ((oldest && summary) || (duplicates && duplicates.length > 0)) && (
        <Card tight className={clean ? "clean-client-notices" : undefined}>
          {oldest && summary && (
            <div className="quiet crit">
              <span className="dot crit" />
              <span className="txt">
                {oldest.fullName} ждёт агента {waitLabel}.
                {summary.freeAgents && summary.freeAgents.length > 0
                  ? ` Свободны: ${summary.freeAgents.map((a) => a.fullName.split(" ")[0]).join(", ")}.`
                  : summary.freeAgents
                    ? " Свободных агентов нет."
                    : ""}
              </span>
              {freeAgent && can("clients.assign") && (
                <Button
                  variant="soft"
                  size="sm"
                  loading={assign.isPending}
                  data-endpoint={`POST /api/v1/clients/${oldest.id}/assign`}
                  onClick={() => assign.mutate({ clientId: oldest.id, toAgentId: freeAgent.id })}
                >
                  {assign.isPending ? "Передаём" : `Передать: ${freeAgent.fullName.split(" ")[0]}`}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => navigate(`/clients/${oldest.shortId}`)}>
                Открыть
              </Button>
            </div>
          )}
          {section === "BUYER" && duplicates && duplicates.length > 0 && (
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">Похожих карточек: {duplicates.length}. Возможно, это один и тот же человек.</span>
              <Button variant="ghost" size="sm" onClick={() => setShowDuplicates(true)}>
                Сравнить
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card tight id="clients-list">
        {showSearch && (
          <div className={clean ? "mb-4 flex items-center gap-3" : "filters"}>
            <input
              className="inp"
              type="search"
              placeholder="Имя, номер карточки, объект"
              aria-label="Поиск по клиентам"
              autoFocus={mobile && searchOpen}
              value={filters.q ?? ""}
              onChange={(e) => patchFilters({ q: e.target.value || undefined })}
            />
            {clean && <CButton variant="outline" aria-haspopup="dialog" onClick={() => setShowFilters(true)}><SlidersHorizontal size={18} aria-hidden />Фильтры{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</CButton>}
          </div>
        )}

        {activeFilterCount > 0 && (
          <div className="quiet">
            <span className="dot" />
            <span className="txt">Включено фильтров: {activeFilterCount}</span>
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Сбросить
            </Button>
          </div>
        )}

        {/* Поиск вышел за пределы вкладки — говорим об этом тихой строкой, а не
            карточкой-уведомлением (договор §6.1): иначе «Продавец в списке покупателей»
            читается как ошибка выборки. */}
        {searchAcrossKinds && (
          <div className="quiet">
            <span className="dot" />
            <span className="txt">Ищем по всем разделам: в строке написано, из какого раздела карточка.</span>
          </div>
        )}

        {/* Состояния блока: загрузка, ошибка, пусто */}
        {isLoading && !error && (
          <div role="status" aria-label="Загружаем клиентов">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} kind="row" />
            ))}
          </div>
        )}
        {error && <Rh2ErrorState message="Список не загрузился." onRetry={() => refetch()} />}

        {data && visibleItems.length > 0 && (
          <List aria-label="Клиенты">
            {clean && <div aria-hidden className={cn("hidden items-center gap-4 px-4 pb-2 pt-3 text-[14px] text-gray-500 lg:grid", cleanClientColumns(can("clients.viewAll")))}><span>Клиент</span><span>Запрос</span><span>Следующее действие</span>{can("clients.viewAll") && <span>Ответственный</span>}<span>Действия</span></div>}
            {visibleItems.map((c) => (
              <ClientRow
                key={c.id}
                client={c}
                mobile={mobile}
                clean={clean}
                showKind={searchAcrossKinds || trafficLightDrilldown || allKinds}
                showAgent={can("clients.viewAll")}
              />
            ))}
          </List>
        )}

        {data && visibleItems.length === 0 && (
          <Rh2EmptyState
            icon={UserRound}
            title={
              pendingSlice
                ? "Никто не ждёт принятия."
                : searching
                  ? "По этому запросу ничего не нашлось."
                  : isOther
                    ? "Прочих обращений пока нет."
                    : inactiveView
                      ? "Неактивных клиентов нет."
                      : section === "SELLER"
                        ? "Продавцов пока нет."
                        : "Под этот фильтр клиентов нет."
            }
            hint={
              pendingSlice
                ? "Новые появятся здесь, как только кому-то назначат лид."
                : searching
                  ? searchAcrossKinds
                    ? "Искали по всем разделам сразу: попробуйте другое написание или снимите часть условий."
                    : "Попробуйте другое написание или снимите часть условий."
                  : isOther
                    ? "Сюда попадают входящие, которые бот не отнёс ни к покупке, ни к продаже."
                    : inactiveView
                      ? "Сюда попадают клиенты, которых вы перевели в «Неактивные»."
                      : section === "SELLER"
                        ? "Продавец появится здесь, как только вы заведёте его карточку или бот примет заявку на продажу."
                        : "Попробуйте снять часть условий или очистить поиск."
            }
            action={
              !isOther && !readOnly && !pendingSlice && !inactiveView ? (
                <Button variant="ghost" onClick={() => setShowForm(true)}>
                  Завести карточку
                </Button>
              ) : undefined
            }
          />
        )}

        {/* «Показать ещё» вместо «Назад/Вперёд» (решение владельца 15.09.2026): строки
            уже накоплены выше (visibleItems), кнопка только просит следующую страницу и
            прячется, когда показано всё. */}
        {data && (
          <Pagination
            loading={isFetching}
            variant="loadMore"
            page={filters.page ?? 1}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={setPage}
          />
        )}

        {/* Карточки, ушедшие из поля зрения держателя, — одной тихой строкой внизу.
            Число даёт сводка (`trashedMine`: свои карточки в корзине; руководству null).
            Переданных другому сводка не считает, поэтому в строке они не названы. */}
        {!isOther && !isAllMineRoute && !!summary?.trashedMine && (
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              Не на виду: {num(summary.trashedMine)} {summary.trashedMine === 1 ? "карточка" : "карточек"} в корзине
            </span>
            <Button variant="ghost" size="sm" aria-haspopup="dialog" onClick={() => setShowHidden(true)}>
              Показать
            </Button>
          </div>
        )}
      </Card>

      {showFilters && (
        <Rh2Sheet
          title="Фильтры"
          onClose={() => setShowFilters(false)}
          ariaLabel="Фильтры клиентов"
          footer={
            <>
              <Button variant="ghost" onClick={resetFilters}>
                Сбросить
              </Button>
              <Button onClick={() => setShowFilters(false)}>Показать{data ? ` ${num(data.total)}` : ""}</Button>
            </>
          }
        >
          {/* Бюджета «от/до» нет: сервер такой фильтр не умеет, поле без запроса
              выдумывать нельзя. «Горячие» и «Новые» — значения статуса. */}
          {!isOther && (
            <>
              <div className="sec-t" style={{ marginTop: 0 }}>
                Срез
              </div>
              <Filters
                aria-label="Срез"
                value={slice}
                onChange={(id) => {
                  setPendingSlice(id === "pending");
                  setNoResponseYesterday(id === "yesterday");
                  setFilters((f) => ({ ...f, page: 1 }));
                }}
                options={[
                  { id: "all", label: "Все" },
                  { id: "pending", label: "Ждут принятия", count: summary?.awaitingAgent.count },
                  ...(slice === "yesterday" ? [{ id: "yesterday" as const, label: "Вчера без ответа" }] : []),
                ]}
              />
            </>
          )}
          <div className="sec-t" style={isOther ? { marginTop: 0 } : undefined}>
            Статус
          </div>
          <Filters
            aria-label="Статус"
            value={filters.status ?? ""}
            onChange={(id) => patchFilters({ status: id || undefined })}
            options={[
              { id: "", label: "Любой" },
              ...Object.entries(CLIENT_STATUS_LABELS).map(([value, label]) => ({ id: value, label })),
            ]}
          />
          {!isOther && (
            <>
              <div className="sec-t">Источник</div>
              <Filters
                aria-label="Источник"
                value={filters.source ?? ""}
                onChange={(id) => patchFilters({ source: id || undefined })}
                options={[
                  { id: "", label: "Любой" },
                  ...Object.entries(CLIENT_SOURCE_LABELS).map(([value, label]) => ({ id: value, label })),
                ]}
              />
              <div className="sec-t">Район</div>
              <label className="field">
                <span className="lab">Район</span>
                <span className="fld">
                  <select
                    value={filters.districtId ?? ""}
                    onChange={(e) => patchFilters({ districtId: e.target.value || undefined })}
                    aria-label="Фильтр по району"
                  >
                    <option value="">Любой</option>
                    {districts?.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              {agents && can("clients.viewAll") && (
                <>
                  <div className="sec-t">Агент</div>
                  <label className="field">
                    <span className="lab">Кому назначен</span>
                    <span className="fld">
                      <select
                        value={filters.agentId ?? ""}
                        onChange={(e) => patchFilters({ agentId: e.target.value || undefined })}
                        aria-label="Фильтр по агенту"
                      >
                        <option value="">Все агенты</option>
                        {agents
                          .filter((a) => a.isActive)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.fullName}
                            </option>
                          ))}
                      </select>
                    </span>
                  </label>
                </>
              )}
              <div className="sec-t">Порядок</div>
              <label className="field">
                <span className="lab">Сначала</span>
                <span className="fld">
                  <select
                    value={currentSort}
                    onChange={(e) => patchFilters({ sort: e.target.value as ClientSort })}
                    aria-label="Порядок списка"
                  >
                    {clientSortOptionsFor(currentSort).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
            </>
          )}
        </Rh2Sheet>
      )}
      {showHidden && (
        <Rh2Sheet
          title="Не на виду"
          onClose={() => setShowHidden(false)}
          ariaLabel="Карточки не на виду"
          footer={
            <Button
              variant="ghost"
              onClick={() => {
                setShowHidden(false);
                navigate("/clients/all-mine");
              }}
            >
              Весь список
            </Button>
          }
        >
          {hiddenQuery.isLoading && (
            <div role="status" aria-label="Загружаем карточки">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} kind="row" />
              ))}
            </div>
          )}
          {hiddenQuery.error && <Rh2ErrorState message="Список не загрузился." onRetry={() => hiddenQuery.refetch()} />}
          {hiddenQuery.data && (
            <List aria-label="Карточки не на виду">
              {hiddenQuery.data.items
                .filter((c) => c.deletedAt || c.hiddenReason)
                .map((c) => (
                  <ClientRow key={c.id} client={c} mobile={mobile} showKind showAgent={false} inSheet />
                ))}
            </List>
          )}
          {hiddenQuery.data && !hiddenQuery.data.items.some((c) => c.deletedAt || c.hiddenReason) && (
            <Rh2EmptyState icon={UserRound} title="На первой странице таких карточек нет." hint="Остальные смотрите в полном списке." />
          )}
        </Rh2Sheet>
      )}
      {showForm && !readOnly && (
        <ClientFormModal kind={section} initialPhone={newClientPhone} onClose={() => setShowForm(false)} />
      )}
      {showDuplicates && <DuplicatesModal onClose={() => setShowDuplicates(false)} />}
    </Rh2Screen>
  );
}

// ReturnedBadge переехал в components/ReturnedBadge.tsx (аудит циклов 03.09.2026,
// разрыв циклов импорта) — реэкспорт ниже, чтобы прежние импорты жили.
export { ReturnedBadge } from "../components/ReturnedBadge";

/**
 * Строка списка клиентов на `Row` набора: аватар 44, имя (ссылка на всю строку),
 * вторая строка «3 комн · Сино · $55–70 тыс. · Instagram», один чип-действие и
 * справа трубка. Строка целиком ведёт в карточку; кнопки справа лежат поверх
 * растянутой ссылки и не открывают её.
 *
 * ВТОРАЯ СТРОКА, а не россыпь плашек. Раздел (при поиске по всем разделам),
 * «неактивный» и «вернулся» стали словами в строке описания: это факты о клиенте,
 * а не дела, и чипом они не бывают (review-statuses.md, один чип на строку).
 * Нет дела — на месте чипа стоит давность контакта; красная, если прошло больше
 * 14 дней. Следующий шаг из хронологии в строку не выведен: просроченный уже
 * говорит чипом «позвонить сейчас», остальное видно в карточке.
 */
function ClientRow({
  client: c,
  mobile,
  showKind = false,
  showAgent = false,
  inSheet = false,
  clean = false,
}: {
  client: Client;
  mobile: boolean;
  showKind?: boolean;
  showAgent?: boolean;
  /** Строка внутри шторки «Не на виду»: смахивание там конфликтует со смахиванием шторки. */
  inSheet?: boolean;
  clean?: boolean;
}) {
  const daysSinceContact = Math.floor((Date.now() - new Date(c.lastContactAt).getTime()) / 86400000);
  const stale = daysSinceContact > 14;
  // OTHER не назначается агенту вообще — acceptedAt для него всегда null, но это не
  // «ждёт принятия», а норма: руководство видит и работает с контактом сразу.
  const { isOther, isTrashed, pending, canRestore, canAcceptRow, canCall, restoreClient, requestRestore, acceptLead, declineLead, restoreRequested, confirmDecline, setConfirmDecline, acceptClient, restore, requestRestoration, confirmRejection } = useClientRowActions(c);

  /**
   * КАРТОЧКА В КОРЗИНЕ (04.09.2026) — поиск находит её (тому, кому видна Корзина), но
   * GET /clients/:id отвечает 404 удалённой карточке: обычная ссылка привела бы на
   * пустой экран. Вместо неё — прямое восстановление тут же в списке.
   */

  /**
   * Принять/отклонить ПРЯМО В СПИСКЕ, не заходя в карточку (владелец 17.08.2026:
   * агенты не находили эти кнопки внутри карточки). Тот же `canAccept`, что и на
   * самой карточке (ClientDetail.tsx). Эскалированный лид (никто не принял за N
   * кругов) кнопок не получает: руководитель уже получил пуш (18.09.2026, §f п.4).
   */
  const navigate = useNavigate();
  const busy = acceptLead.isPending || declineLead.isPending;
  const busyProps = busy ? ({ disabled: true, disabledReason: "Идёт обработка" } as const) : ({ disabled: false } as const);


  /**
   * СМАХИВАНИЕ СТРОКИ (артефакт c99db05f): вправо — позвонить, влево — открыть
   * карточку. Жест не звонит сам, а нажимает настоящую CallClientButton внутри
   * строки: правило «сначала через CRM» остаётся в одном месте. Вправо строка едет
   * только когда звонок возможен: непринятому лиду и карточке в корзине кнопки
   * звонка в разметке нет. Маска «•» в номере звонку не мешает: CRM звонит по
   * карточке, номер берёт сервер (аудит 23.09.2026, №54).
   */

  const action = clientAction(c, Date.now(), canAcceptRow);
  const primaryState = clientPrimaryState(c);
  const chip = primaryState.id !== "status" && primaryState.id !== "pending" ? (
    <ClientStateBadge client={c} />
  ) : action && action.id !== "accept" ? (
    <Chip tone={action.tone}>{mobile ? action.short : action.label}</Chip>
  ) : null;

  const name = c.displayName ?? formatClientName(c);
  const daysInWork = Math.max(0, Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86400000));
  const parts = (
    isOther
      ? [
          formatClientCode(c.shortId, c.kind),
          CLIENT_SOURCE_LABELS[c.source] ?? c.source,
          // Номер показываем, только когда он не маска: маску набирать нечем.
          c.phone && !c.phone.includes("•") ? c.phone : null,
          `в работе ${daysInWork} дн.`,
        ]
      : [
          showKind && c.kind ? CLIENT_KIND_LABELS[c.kind] : null,
          c.desiredRooms ? `${c.desiredRooms} комн` : null,
          c.desiredDistrict?.name ?? null,
          budgetShort(c),
          CLIENT_SOURCE_LABELS[c.source],
          showAgent && c.assignedAgent?.fullName ? `Агент ${c.assignedAgent.fullName}` : null,
          isRecentlyReturned(c.returnedAt) ? "вернулся" : null,
        ]
  ).filter(Boolean);

  const actions = isTrashed ? (
    canRestore ? (
      <Button
        variant="ghost"
        size="sm"
        icon={<RotateCcw size={16} aria-hidden />}
        loading={restoreClient.isPending}
        onClick={restore}
      >
        {restoreClient.isPending ? "Восстанавливаем" : "Восстановить"}
      </Button>
    ) : (
      // Держатель без clients.delete видит свою карточку в «Не на виду», но восстановить
      // сам не может — зеркало «Попросить удалить» (18.09.2026, задание В §f п.1).
      <Button
        variant="ghost"
        size="sm"
        icon={<RotateCcw size={16} aria-hidden />}
        loading={requestRestore.isPending}
        {...(restoreRequested
          ? ({ disabled: true, disabledReason: "Просьба уже отправлена" } as const)
          : ({ disabled: false } as const))}
        onClick={requestRestoration}
      >
        {restoreRequested ? "Просьба отправлена" : requestRestore.isPending ? "Отправляем" : "Попросить восстановить"}
      </Button>
    )
  ) : canAcceptRow ? (
    <>
      <Button
        variant="soft"
        size="sm"
        icon={<Check size={16} aria-hidden />}
        loading={acceptLead.isPending}
        {...busyProps}
        onClick={acceptClient}
      >
        {acceptLead.isPending ? "Принятие" : "Принять"}
      </Button>
      <Button variant="ghost" size="sm" {...busyProps} onClick={() => setConfirmDecline(true)}>
        Отклонить
      </Button>
      {(acceptLead.isError || declineLead.isError) && (
        <div className="basis-full">
          <MutationError
            mutation={acceptLead.isError ? acceptLead : declineLead}
            fallback={acceptLead.isError ? "Не удалось принять лид" : "Не удалось отклонить лид"}
          />
        </div>
      )}
    </>
  ) : pending ? undefined : (
    // Звонок прямо из списка. Непринятому лиду кнопки нет: номер у него замаскирован, а
    // звонить по чужому ещё не принятому лиду нельзя. Вид — «трубка» набора.
    <CallClientButton
      clientId={c.id}
      phone={c.phone}
      variant="icon"
      title="Позвонить через CRM"
      className="pill rh-btn icon btn-call rh-btn-round"
    />
  );

  const row = clean && !inSheet ? (
    <CleanClientRow
      id={c.id}
      name={name}
      href={isTrashed ? undefined : `/clients/${c.shortId}`}
      avatar={<ClientAvatar fullName={c.fullName} avatarUrl={c.avatarUrl} size={44} palette="tokens" />}
      identity={[formatClientCode(c.shortId, c.kind), showKind && c.kind ? CLIENT_KIND_LABELS[c.kind] : null, isRecentlyReturned(c.returnedAt) ? "вернулся" : null].filter(Boolean).join(" · ")}
      request={isOther ? [c.phone && !c.phone.includes("•") ? c.phone : null, `в работе ${daysInWork} дн.`].filter(Boolean).join(" · ") : [c.desiredRooms ? `${c.desiredRooms} комн` : null, c.desiredDistrict?.name, budgetShort(c)].filter(Boolean).join(" · ") || "Запрос пока не заполнен"}
      source={CLIENT_SOURCE_LABELS[c.source] ?? c.source}
      nextAction={canAcceptRow ? <Chip tone="warn">Нужно принять лид</Chip> : chip || (!isTrashed && !c.hiddenReason && !pending && (!c.workStatus || c.workStatus === "ACTIVE") && c.nextStep?.nextAction ? <span className="text-[14px] text-ink">{c.nextStep.nextAction}</span> : null)}
      lastContact={relativeTime(c.lastContactAt)}
      staleContact={stale && !chip && !canAcceptRow}
      showAgent={showAgent}
      agentName={c.assignedAgent?.fullName}
      agentAssigned={!!c.assignedAgentId}
      actions={actions}
      deleted={isTrashed}
    />
  ) : (
    <Row
      className={canAcceptRow ? "rh-row-wrap" : undefined}
      avatar={{
        label: name.slice(0, 1),
        node: <ClientAvatar fullName={c.fullName} avatarUrl={c.avatarUrl} size={44} palette="tokens" />,
      }}
      title={name}
      line={parts.length > 0 ? parts.join(" · ") : "—"}
      chip={chip}
      meta={
        chip || canAcceptRow ? undefined : (
          <span className={stale ? "is-stale" : undefined}>{relativeTime(c.lastContactAt)}</span>
        )
      }
      actions={actions}
      // Корзина: GET /clients/:id 404-ит удалённой карточке, открывать нечего.
      href={isTrashed ? undefined : `/clients/${c.shortId}`}
      linkLabel={`Открыть карточку: ${c.fullName}`}
      done={isTrashed}
      data-client-row={c.id}
    />
  );

  return (
    <>
      {inSheet ? (
        row
      ) : (
        <SwipeRow
          // Карточка в Корзине: свайп открывать нечего.
          onOpen={isTrashed ? () => {} : () => navigate(`/clients/${c.shortId}`)}
          onCall={
            canCall
              ? () => document.querySelector<HTMLButtonElement>(`[data-client-row="${c.id}"] [data-call-button]`)?.click()
              : null
          }
        >
          {row}
        </SwipeRow>
      )}
      {confirmDecline && (
        <ConfirmDialog
          title="Отклонить лид?"
          description="Первый отказ подряд ничего не стоит Royal Score, второй и следующие подряд снижают счёт. Лид сразу уйдёт следующему свободному агенту, а если отдать некому или лид по вашему объекту — руководителю. Эту карточку вы больше не увидите."
          confirmLabel="Отклонить"
          onConfirm={confirmRejection}
          onCancel={() => setConfirmDecline(false)}
        />
      )}
    </>
  );
}
