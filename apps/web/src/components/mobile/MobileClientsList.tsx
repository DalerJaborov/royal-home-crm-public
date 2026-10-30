import { useEffect, useState } from "react";
import { useClientRowActions } from "../../hooks/useClientRowActions";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { ClientSort } from "@royal-home/shared";
import { Plus, Search, SlidersHorizontal, X, Check } from "lucide-react";
import {
  useClients,
  useClientsSummary,
  type ClientFilters,
} from "../../hooks/useClients";
import { useCan } from "../../lib/permissions";
import { clientListScope } from "../../lib/clientListScope";
import { useAccumulatedPages } from "../../hooks/useAccumulatedPages";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useMarkSectionSeen } from "../../hooks/useCounters";
import { useAuthStore } from "../../store/auth";
import { useAgents } from "../../hooks/useAgents";
import { useDistricts } from "../../hooks/useDistricts";
import { useDuplicates } from "../../hooks/useDuplicates";
import { useTransferClient } from "../../hooks/useMissionControl";
import { avatarInitial, avatarToneClass } from "../../lib/avatarTone";
import { ChannelIcon, hasChannelGlyph, sourceChannel } from "../ChannelIcon";
import { ConfirmDialog } from "../ConfirmDialog";
import { DuplicatesModal } from "../DuplicatesModal";
import { MutationError } from "../MutationError";
import { CallClientButton } from "../CallClientButton";
import { Pagination } from "../Pagination";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { MhLane, MhListScreen, sinceLabel, type MhLaneChip } from "./mh/MhList";
import { useClientSectionChips } from "./mh/MhClientSections";
import {
  CLIENT_KIND_LABELS,
  CLIENT_SORT_OPTIONS,
  CLIENT_SOURCE_LABELS,
  CLIENT_STATUS_LABELS,
  formatClientCode,
  formatClientName,
} from "../../lib/clientFormat";
import { formatWait } from "../../lib/format";
import type { Client } from "../../types";

const num = (n: number) => n.toLocaleString("ru-RU");

/**
 * «КЛИЕНТЫ» НА ТЕЛЕФОНЕ — переодето 15.09.2026 в облик макета владельца
 * (docs/pult/theme-2026/artifact-c99db05f-mobile-nav.html, `renderSecond`):
 * шапка `.top` с заголовком-счётчиком и круглыми кнопками поиска/добавления,
 * лента фильтров `.lane`, список `.list`+`.row` (та же идиома, что у
 * MobileChatsList.tsx — общий модуль MhList.tsx). Кадр владельца («ничего из
 * ПК я не хочу») был снят с прежней версии, которая жила в области `.rh2
 * .scr` (эталон пульта) — теперь область `.rh2 .mh`, как у остальных списков
 * телефона.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. pages/Clients.tsx — экран пульта (`.rh2 .scr`
 * на компьютере): плитки сводки, тихие строки «ждёт агента», шторка фильтров,
 * дубликаты, сортировка, вкладки срезов — компьютеру всё это остаётся без
 * единой правки. Ветвление — одной строкой в pages/Clients.tsx, там же, где
 * уже ветвятся «Прочие обращения» (MobileInquiries).
 *
 * ЧТО ВЗЯТО У ПК И НЕ ПОВТОРЯЕТСЯ. Данные те же самые: `useClients` и
 * `useClientsSummary`, те же фильтры, та же пагинация, та же форма нового
 * клиента (`ClientFormModal`). Ни одного своего запроса и ни одного своего
 * счётчика — иначе телефон и компьютер начнут показывать разные числа.
 *
 * ЧИПЫ. Макет рисует одну ленту без счётчика «Мои»/«Новые» — здесь оставлены
 * прежние срезы («Мои», «Горячие», «Новые»), под каждым реальное поле
 * (`agentId`, `status: HOT`, `status: NEW`): договор «не выдумывай чипов»
 * запрещает подделывать, а не убирать то, что уже подтверждено данными.
 * Переходы в соседние разделы (Продавцы/Покупатели, Прочие, Потерянные) —
 * вторая лента ниже: это навигация, а не срез текущего списка, смешивать с
 * `role="tablist"` нельзя (aria-selected подразумевает, что клик остаётся на
 * этом экране).
 *
 * Счётчиков «Горячие»/«Новые», которых нет в сводке (`GET /clients/summary`),
 * — тем же списком (`pageSize:1`, читается только `total`): существующий
 * эндпоинт и настоящее число, а не украшение. Счётчика непрочитанных сообщений
 * у клиента нет вовсе (в API булево `unread`), поэтому вместо цифры — точка,
 * тем же классом `.unread.dot`, что и в списке чатов.
 *
 * ПАГИНАЦИЮ НЕ ТРОГАЛ — переводит на «Показать ещё» другой агент этой же
 * пачки; она осталась `<Pagination variant="rh2">`, только перенесена в
 * `.sec`-обёртку, как в MobileChatsList.tsx.
 *
 * ДОБАВЛЕНО 22.09.2026 (баг класса «desktop и mobile ship together», CLAUDE.md:
 * директор не видел на телефоне то, что видит на компьютере). Идиома прототипа
 * (`.sec`/`.sec-t`, `.tiles`+`.tile .v/.l`, `.quiet .ln`) сохранена — своей
 * разметки не заводилось, только новые блоки в уже принятом стиле мобильных
 * списков (см. MobileCalls.tsx, MobileDirectorHome.tsx):
 *  — тихая строка «ждёт агента N» + «Передать: …» (useTransferClient), видна
 *    только тем, у кого `clients.assign`;
 *  — тихая строка «Похожих карточек: N» + «Сравнить» (useDuplicates,
 *    только `clients.merge`, только вкладка «Покупатели» — как на ПК);
 *  — четыре плитки сводки (Новые/Без агента/Без контакта/Показы), те же данные
 *    `useClientsSummary`, что и плитки ПК, но в мобильной раскладке `.v`/`.l`
 *    (`.mh .tile` — другая CSS, чем эталонный `StatTile`, см. докблок в
 *    MobileCalls.tsx);
 *  — «Принять»/«Отклонить» прямо в строке (владелец 17.08.2026) и звонок
 *    (`CallClientButton`) — строка стала `<div>` со растянутой ссылкой-подложкой
 *    вместо самого `<Link>`, ровно как в ClientRow на ПК (pages/Clients.tsx),
 *    иначе кнопки внутри `<Link>` не нажимались бы;
 *  — шторка «Фильтры» (`Rh2Sheet`, портал уносит её в `.rh2 .scr` независимо от
 *    хозяина, поэтому подойдёт та же разметка `.seg`/`.fld`, что у ПК и у
 *    MobilePropertiesList.tsx) — статус, источник, район, агент, порядок.
 */
export function MobileClientsList({ kind, onAddClient }: { kind: "BUYER" | "SELLER"; onAddClient: () => void }) {
  const me = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  const can = useCan();
  const canViewAll = can("clients.viewAll");
  useMarkSectionSeen(kind === "BUYER" ? "clients" : "sellers");

  /**
   * «НЕАКТИВНЫЕ» — НАСТОЯЩИЙ МАРШРУТ, ОБА ВИДА СРАЗУ (владелец 17.09.2026).
   * `/inactive-clients` рендерит этот же компонент (App.tsx), kind у него не
   * важен: срез мимо него, workStatus=INACTIVE берёт и покупателей, и
   * продавцов. Тот же приём, что и в десктопном ClientsList.tsx.
   */
  const location = useLocation();
  const isInactiveRoute = location.pathname === "/inactive-clients";
  /**
   * «ВСЕ МОИ КЛИЕНТЫ» — тот же настоящий маршрут, что и на компьютере
   * (18.09.2026, задание В §f п.1, pages/Clients.tsx, isAllMineRoute).
   * `scope=allMine` снимает Корзину/kind/status-срезы у своего агента —
   * см. серверный комментарий routes/clients/list.ts.
   */
  const isAllMineRoute = location.pathname === "/clients/all-mine";
  /**
   * ИЗ КАКОГО РАЗДЕЛА ВОШЛИ (21.09.2026). Верхний уровень теперь только
   * «Продавцы» и «Покупатели», а «Неактивные» — состояние ВНУТРИ раздела
   * (components/ClientsSectionLane.tsx). Маршрут `/inactive-clients` один на
   * оба вида, поэтому вид едет параметром адреса; без него, уйдя от продавцов,
   * человек возвращался бы к покупателям. Старая ссылка без параметра
   * работает как раньше — оба вида сразу.
   */
  const sectionParam = new URLSearchParams(location.search).get("kind");
  const sectionKind: "SELLER" | "BUYER" | null =
    sectionParam === "SELLER" ? "SELLER" : sectionParam === "BUYER" ? "BUYER" : null;
  const section: "SELLER" | "BUYER" = sectionKind ?? kind;

  /**
   * ОСТАЛЬНОЙ АДРЕС ЭКРАНА ТОЖЕ ЧИТАЕТСЯ (19.09.2026, перенесено 03.10.2026).
   *
   * Параметр `kind` выше компонент разбирал, а все прочие `/clients?…` молча
   * пропадали, и ломались от этого главные действия:
   *   · «+» → «Новый клиент» (components/FabMenu.tsx) и ярлык «Клиент» в меню
   *     установленного приложения ведут на `/clients?new=1` — на телефоне
   *     форма не открывалась, человек просто попадал в список;
   *   · наборщик (components/DialPad.tsx) передаёт туда же `&phone=` только
   *     что набранного номера — номер терялся;
   *   · плитка «вчера без ответа» мобильной главной директора ведёт на
   *     `?slice=noResponseYesterday`, светофор — на `?workStatus=INACTIVE`,
   *     карточка сотрудника — на `?agentId=…`: тап по числу открывал обычный
   *     список, то есть число и список расходились.
   * Значения читаются ОДИН раз, теми же полями фильтра, что и на компьютере
   * (pages/Clients.tsx) — второго правила «что значит slice» не заводим.
   */
  const [urlParams] = useState(() => new URLSearchParams(location.search));
  const [urlWorkStatus] = useState(() =>
    !isInactiveRoute && urlParams.get("workStatus") === "INACTIVE" ? ("INACTIVE" as const) : undefined
  );
  const [noResponseYesterday, setNoResponseYesterday] = useState(
    () => urlParams.get("slice") === "noResponseYesterday"
  );

  const [slice, setSlice] = useState<"all" | "mine">("all");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState(() => urlParams.get("q") ?? "");
  const [searchOpen, setSearchOpen] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  /** Шторка «Фильтры» — статус, источник, район, агент, порядок (та же шторка,
   *  что на ПК, тот же корпус Rh2Sheet). */
  const [showFilters, setShowFilters] = useState(false);
  const [extraFilters, setExtraFilters] = useState<{
    status?: string;
    source?: string;
    districtId?: string;
    agentId?: string;
    sort?: ClientSort;
  }>(() => {
    const pick = (k: string) => urlParams.get(k) ?? undefined;
    const f = {
      status: pick("status"),
      source: pick("source"),
      districtId: pick("districtId"),
      agentId: isAllMineRoute ? undefined : pick("agentId"),
      sort: pick("sort") as ClientSort | undefined,
    };
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
  });
  /** Срез «Ждут принятия» — плитка «Без агента» ниже; тот же честный серверный
   *  фильтр (`pendingAcceptance`), что у ПК (pages/Clients.tsx). */
  const [pendingSlice, setPendingSlice] = useState(() => urlParams.get("slice") === "pending");
  /**
   * `new` и `phone` — одноразовые: без уборки возврат «назад» к этому экрану
   * снова открывал бы форму с уже набранным номером. Остальные параметры
   * описывают сам список и остаются в адресе, чтобы ссылку можно было переслать.
   */
  useEffect(() => {
    if (!urlParams.has("new") && !urlParams.has("phone")) return;
    const next = new URLSearchParams(location.search);
    next.delete("new");
    next.delete("phone");
    const qs = next.toString();
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : "" }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /**
   * Смена раздела внутри «Неактивных» (`?kind=` в том же адресе) не
   * пересоздаёт компонент — лента обязана начаться заново, иначе страница N
   * нового раздела приезжала бы без страниц 2..N-1. Переход между маршрутами
   * пересоздаёт его сам (`key` у маршрутов в App.tsx).
   */
  useEffect(() => {
    setPage(1);
  }, [sectionKind]);
  const debouncedQ = useDebouncedValue(q, 350);
  const searching = !!debouncedQ.trim();
  const searchAcrossKinds = searching && (me?.role === "AGENT" || can("otherInquiries.view"));

  const filters: ClientFilters = {
    ...(isAllMineRoute
      ? { scope: "allMine" as const }
      : isInactiveRoute
        ? // Раздел задан — сужаем и по виду: иначе у продавцов лежат покупатели.
          { workStatus: "INACTIVE" as const, ...(sectionKind ? { kind: sectionKind } : {}) }
        : { kind: pendingSlice || searchAcrossKinds ? undefined : sectionKind ?? kind }),
    page,
    q: debouncedQ?.trim() || undefined,
    ...(slice === "mine" && me && !isAllMineRoute ? { agentId: me.id } : {}),
    ...extraFilters,
    // Страницы у среза обычные (02.10.2026): прежний потолок `pageSize: 100`
    // без «Показать ещё» молча обрезал список на сотом клиенте.
    ...(pendingSlice ? { pendingAcceptance: true } : {}),
    ...(noResponseYesterday ? { noFirstContactYesterday: true, sort: "created_desc" as const } : {}),
    ...(urlWorkStatus ? { workStatus: urlWorkStatus } : {}),
    scope: clientListScope({ allMine: isAllMineRoute, other: false, searching,
      status: extraFilters.status, workStatus: isInactiveRoute ? "INACTIVE" : urlWorkStatus,
      pending: pendingSlice, noResponseYesterday }),
  };
  const { data, isLoading, error, refetch } = useClients(filters);
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const { data: headPage } = useClients({ ...filters, page: 1 }, page > 1);
  const { data: summary } = useClientsSummary();
  // Дубликаты — только руководству (объединение задевает чужих клиентов) и
  // только у покупателей, тот же разбор, что в pages/Clients.tsx (ClientsList).
  const { data: duplicates } = useDuplicates(can("clients.merge") && kind === "BUYER");
  const { data: districts } = useDistricts();
  const { data: agents } = useAgents({ enabled: canViewAll });
  const assign = useTransferClient();
  const oldest = summary?.awaitingAgent.oldest ?? null;
  const freeAgent = summary?.freeAgents?.[0] ?? null;
  const waitLabel = oldest ? formatWait(oldest.waitingMinutes) : "";
  const activeExtraFilters = [extraFilters.status, extraFilters.source, extraFilters.districtId, extraFilters.agentId].filter(
    Boolean
  ).length;

  const focusList = () => {
    document.getElementById("mobile-clients-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  /** Меняет шторочный фильтр и сбрасывает страницу/срез «Ждут принятия» —
   *  та же дисциплина, что у ПК (setFilters(f => ({...f, page:1})) в
   *  pages/Clients.tsx): без сброса страницы новый фильтр мог бы запросить
   *  сразу третью страницу пустого среза. */
  function updateExtraFilters(patch: Partial<typeof extraFilters>) {
    setExtraFilters((f) => ({ ...f, ...patch }));
    setPendingSlice(false);
    setNoResponseYesterday(false);
    setPage(1);
  }
  // Счётчиков «Горячие»/«Новые» больше нет — вместе с самими срезами
  // (21.09.2026). Это были два лишних запроса на каждое открытие списка.

  // Мягкая подгрузка вместо страниц (решение владельца 15.09.2026): «Показать
  // ещё» дописывает строки в хвост, накопленное сбрасывается сменой среза/
  // поиска — то же, что уже меняет `page` на 1 чуть выше.
  const items = useAccumulatedPages(
    data?.items,
    page,
    `${kind}:${section}:${isInactiveRoute}:${isAllMineRoute}:${slice}:${debouncedQ}:${JSON.stringify(extraFilters)}:${pendingSlice}:${noResponseYesterday}`,
    headPage?.items
  );
  const title = isAllMineRoute
    ? "Не на виду"
    : isInactiveRoute
      ? section === "SELLER"
        ? "Неактивные продавцы"
        : "Неактивные покупатели"
      : kind === "SELLER"
        ? "Продавцы"
        : "Покупатели";

  function pick(next: typeof slice) {
    setSlice((prev) => (prev === next ? "all" : next));
    setPage(1);
  }

  /**
   * СРЕЗЫ «ГОРЯЧИЕ» И «НОВЫЕ» УБРАНЫ (21.09.2026). Владелец: «горячие мы же
   * удалили, и новые удали… откуда столько разделов, всё перепутано?».
   * «Горячесть» определяет ИИ, и она уже видна плашкой прямо в строке списка —
   * вкладку под неё убрали ещё 09.09.2026, а чип на телефоне остался и жил
   * отдельной жизнью. «Новые» — то же самое: статус NEW стоит плашкой в строке.
   * Два чипа-статуса рядом с разделами читались как ещё два раздела.
   *
   * «Мои» остаётся, но только у руководства: агенту список и так свой, и чип
   * ничего не срезал. Из-за этого у агента лента срезов исчезает целиком — и
   * это правильно, одна пилюля «Мои» на весь ряд была подписью, а не выбором.
   */
  const sliceChips: MhLaneChip[] = isAllMineRoute
    ? []
    : me && canViewAll && summary?.mine != null
      ? [
          {
            key: "mine",
            label: "Мои",
            count: summary.mine,
            active: slice === "mine",
            onSelect: () => pick("mine"),
          },
        ]
      : [];

  /**
   * СОСЕДНИЕ РАЗДЕЛЫ — общая лента mh/MhClientSections.tsx (17.09.2026): тот
   * же состав и те же числа теперь и на «Потерянных», и на «Отложенных», где
   * раньше стояли десктопные вкладки. Здесь ничего не изменилось по виду:
   * набор ровно тот же, что жил в этом файле (Продавцы, Покупатели,
   * Неактивные, Потерянные, без текущего раздела).
   */
  const crossChips = useClientSectionChips(
    isAllMineRoute ? "allMine" : isInactiveRoute ? "inactive" : kind === "SELLER" ? "sellers" : "buyers"
  );

  /**
   * ЛЕНТА ВИДА — «Продавцы · Покупатели» (21.09.2026). На телефоне верхних
   * вкладок нет вовсе, и после того, как состояния уехали во вторую ленту,
   * переключаться между продавцами и покупателями стало нечем. Это и есть те
   * самые «всего 2 раздела» владельца; всё остальное — состояние внутри них.
   */
  const kindChips: MhLaneChip[] = [
    {
      key: "sellers",
      label: "Продавцы",
      count: summary?.sellers ?? null,
      active: !isAllMineRoute && section === "SELLER",
      onSelect: () => navigate("/sellers"),
    },
    {
      key: "buyers",
      label: "Покупатели",
      count: summary?.buyers ?? null,
      active: !isAllMineRoute && section === "BUYER",
      onSelect: () => navigate("/clients"),
    },
  ];

  return (
    <MhListScreen
      title={title}
      count={data?.total ?? null}
      actions={
        <>
          <button
            type="button"
            className="ico card"
            aria-label={searchOpen ? "Закрыть поиск" : "Поиск по клиентам"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((v) => !v);
              if (searchOpen) {
                setQ("");
                setPage(1);
              }
            }}
          >
            {searchOpen ? <X className="i" aria-hidden /> : <Search className="i" aria-hidden />}
          </button>
          {!isAllMineRoute && !isInactiveRoute && (
            <button
              type="button"
              className="ico card"
              aria-label="Фильтры клиентов"
              aria-haspopup="dialog"
              onClick={() => setShowFilters(true)}
              style={{ position: "relative" }}
            >
              <SlidersHorizontal className="i" aria-hidden />
              {activeExtraFilters > 0 && <span className="dot" style={{ background: "var(--accent)" }} aria-hidden />}
            </button>
          )}
          <button
            type="button"
            className="ico card"
            aria-label={kind === "SELLER" ? "Новый продавец" : "Новый клиент"}
            onClick={onAddClient}
          >
            <Plus className="i" aria-hidden />
          </button>
        </>
      }
    >
      {/* Поле поиска появляется по нажатию на лупу и занимает строку, только
          пока им пользуются — постоянное поле отнимало бы у списка место без
          нужды (тот же приём, что в MobileChatsList.tsx). */}
      {searchOpen && (
        <div className="srch" style={{ padding: "10px 0 0" }}>
          <div className="field">
            <Search className="i" aria-hidden />
            <input
              type="search"
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Имя, телефон, номер карточки"
              aria-label="Поиск по клиентам"
            />
          </div>
        </div>
      )}

      {/* Тихие строки вместо карточек-уведомлений (договор §6.1): ждёт агента,
          похожие карточки — те же данные, что в pages/Clients.tsx (ClientsList),
          в идиоме мобильных списков (`.sec`/`.quiet .ln`, см. MobileCalls.tsx). */}
      {((oldest && summary) || (duplicates && duplicates.length > 0)) && (
        <div className="sec" style={{ marginTop: 14 }}>
          <div className="list">
            <div className="quiet">
              {oldest && summary && (
                <div className="ln">
                  <i className="c" aria-hidden />
                  <span>
                    {oldest.fullName} ждёт агента {waitLabel}.
                    {summary.freeAgents && summary.freeAgents.length > 0
                      ? ` Свободны: ${summary.freeAgents.map((a) => a.fullName.split(" ")[0]).join(", ")}.`
                      : summary.freeAgents
                        ? " Свободных агентов нет."
                        : ""}{" "}
                    {freeAgent && can("clients.assign") && (
                      <button
                        type="button"
                        className="lnk"
                        disabled={assign.isPending}
                        onClick={() => assign.mutate({ clientId: oldest.id, toAgentId: freeAgent.id })}
                      >
                        {assign.isPending ? "Передаём" : `Передать: ${freeAgent.fullName.split(" ")[0]}`}
                      </button>
                    )}{" "}
                    <Link className="lnk" to={`/clients/${oldest.shortId}`} style={{ marginLeft: 12, textDecoration: "underline" }}>
                      Открыть
                    </Link>
                  </span>
                </div>
              )}
              {duplicates && duplicates.length > 0 && (
                <div className="ln">
                  <i className="w" aria-hidden />
                  <span>
                    Похожих карточек: {duplicates.length}. Возможно, это один и тот же человек.{" "}
                    <button type="button" className="lnk" onClick={() => setShowDuplicates(true)}>
                      Сравнить
                    </button>
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Четыре плитки сводки — те же данные, что StatTile на ПК, но в
          мобильной раскладке `.v`/`.l` (не эталонный `.tile` из StatTile,
          см. докблок MobileCalls.tsx). «Горячие» удалены из CRM владельцем,
          поэтому четвёртая плитка ПК — «Без контакта», как здесь. */}
      {summary && (
        <div className="sec" style={{ marginTop: 14 }}>
          <div className="tiles">
            <button
              type="button"
              className="tile"
              onClick={() => {
                updateExtraFilters({ sort: "created_desc" });
                focusList();
              }}
              title="Список, сначала новые"
            >
              <div className="v">{num(summary.newToday)}</div>
              <div className="l">
                новых ·{" "}
                {summary.newYesterday === summary.newToday
                  ? "как вчера"
                  : summary.newToday > summary.newYesterday
                    ? `вчера ${num(summary.newYesterday)}, лучше`
                    : `вчера ${num(summary.newYesterday)}, меньше`}
              </div>
            </button>
            <button
              type="button"
              className="tile"
              onClick={() => {
                setPendingSlice(true);
                setNoResponseYesterday(false);
                setPage(1);
                focusList();
              }}
              title="Срез «Ждут принятия»"
            >
              <div className={summary.awaitingAgent.count > 0 ? "v crit" : "v"}>{num(summary.awaitingAgent.count)}</div>
              <div className={summary.awaitingAgent.count > 0 ? "l crit" : "l"}>
                ждут принятия · {oldest ? `дольше всех ${oldest.fullName}` : "все приняты"}
              </div>
            </button>
            <button
              type="button"
              className="tile"
              onClick={() => {
                updateExtraFilters({ sort: "contact_asc" });
                focusList();
              }}
              title="Список: давно не общались"
            >
              <div className={summary.noContactOverDay > 0 ? "v crit" : "v"}>{num(summary.noContactOverDay)}</div>
              <div className={summary.noContactOverDay > 0 ? "l crit" : "l"}>без контакта · больше суток без разговора</div>
            </button>
            <Link className="tile" to="/calendar?type=SHOWING&date=today" title="Календарь показов">
              <div className="v">{num(summary.showings.today)}</div>
              <div className="l">показов сегодня · {num(summary.showings.tomorrow)} на завтра</div>
            </Link>
          </div>
        </div>
      )}

      <MhLane label="Продавцы или покупатели" chips={kindChips} sticky />
      {crossChips.length > 0 && <MhLane label="Состояние клиентов раздела" chips={crossChips} />}
      {sliceChips.length > 0 && <MhLane label="Срезы клиентов" chips={sliceChips} />}

      <div className="sec" id="mobile-clients-list" style={{ marginTop: 14 }}>
        <div className="list">
          {error ? (
            <div className="state err">
              Список не загрузился.
              <button type="button" className="lnk" onClick={() => refetch()}>
                Повторить
              </button>
            </div>
          ) : isLoading ? (
            <div className="state">Загружаем {title.toLowerCase()}</div>
          ) : items.length === 0 ? (
            <div className="state">
              {pendingSlice
                ? "Никто не ждёт принятия."
                : q
                  ? "Никого не нашли, проверьте написание."
                  : "В этом срезе пока пусто."}
            </div>
          ) : (
            items.map((c) => <ClientListRow key={c.id} client={c} showKind={isInactiveRoute} />)
          )}
        </div>
      </div>

      {/* Одна кнопка мягкой подгрузки вместо страниц (владелец 15.09: «лучше
          "посмотреть дальше", чтобы мягко открылось, а не такие страницы»).
          Стоит ниже карточки списка, а не внутри неё: внутри она читалась бы
          как ещё одна строка клиента. */}
      {/* Без обёртки «total > pageSize»: Pagination сама прячется на одной
          странице. Обёртка-условие снаружи срезала у неё сброс страницы за
          краем выдачи. */}
      {data && (data.total > data.pageSize || data.page > 1) && (
        <div className="sec">
          <Pagination page={page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} variant="loadMore" />
        </div>
      )}

      {showDuplicates && <DuplicatesModal onClose={() => setShowDuplicates(false)} />}

      {/* Шторка «Фильтры» — статус, источник, район, агент, порядок. Тот же
          корпус Rh2Sheet, что и на ПК; портал открывает область `.rh2 .scr`
          независимо от того, что хозяин экрана — `.mh` (см. Rh2Scope.tsx),
          поэтому разметка `.seg`/`.fld` та же, что в pages/Clients.tsx и в
          MobilePropertiesList.tsx. */}
      <Rh2Sheet
        open={showFilters}
        onClose={() => setShowFilters(false)}
        title="Фильтры"
        ariaLabel="Фильтры клиентов"
        footer={
          <>
            <button
              className="pill ghost"
              type="button"
              onClick={() => {
                setExtraFilters({});
                setPage(1);
              }}
            >
              Сбросить
            </button>
            <button className="pill" type="button" onClick={() => setShowFilters(false)}>
              Показать{data ? ` ${data.total}` : ""}
            </button>
          </>
        }
      >
        <div className="sec-t" style={{ marginTop: 0 }}>
          Статус
        </div>
        <div className="seg" role="group" aria-label="Статус">
          <button type="button" aria-selected={!extraFilters.status} onClick={() => updateExtraFilters({ status: undefined })}>
            Любой
          </button>
          {Object.entries(CLIENT_STATUS_LABELS).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-selected={extraFilters.status === value}
              onClick={() => updateExtraFilters({ status: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="sec-t">Источник</div>
        <div className="seg" role="group" aria-label="Источник">
          <button type="button" aria-selected={!extraFilters.source} onClick={() => updateExtraFilters({ source: undefined })}>
            Любой
          </button>
          {Object.entries(CLIENT_SOURCE_LABELS).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-selected={extraFilters.source === value}
              onClick={() => updateExtraFilters({ source: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="sec-t">Район</div>
        <label className="field">
          <span className="lab">Район</span>
          <span className="fld">
            <select
              value={extraFilters.districtId ?? ""}
              onChange={(e) => updateExtraFilters({ districtId: e.target.value || undefined })}
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
        {agents && canViewAll && (
          <>
            <div className="sec-t">Агент</div>
            <label className="field">
              <span className="lab">Кому назначен</span>
              <span className="fld">
                <select
                  value={extraFilters.agentId ?? ""}
                  onChange={(e) => updateExtraFilters({ agentId: e.target.value || undefined })}
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
              value={extraFilters.sort ?? "created_desc"}
              onChange={(e) => updateExtraFilters({ sort: e.target.value as ClientSort })}
              aria-label="Порядок списка"
            >
              {CLIENT_SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </span>
        </label>
      </Rh2Sheet>
    </MhListScreen>
  );
}

/**
 * Строка клиента макета: аватар-инициал пастельного тона с уголком канала,
 * имя (с чипом статуса, если статус есть), одна строка сути, справа давность
 * и признак непрочитанного. Разметка — та же, что у MhChatRow в
 * MobileChatsList.tsx (`.row` > `.av` + `.b`(`.n`/`.s`) + `.r`).
 *
 * Тон аватара детерминирован именем (lib/avatarTone.ts) — один человек всегда
 * одного цвета, в списке клиентов и в списке чатов.
 */
function ClientListRow({ client: c, showKind = false }: { client: Client; showKind?: boolean }) {
  /**
   * КАРТОЧКА В КОРЗИНЕ (18.09.2026, задание В §f п.1) — встречается только во
   * вкладке «Все мои»: GET /clients/:id 404-ит удалённой карточке, обычная
   * ссылка строки вела бы в пустой экран (тот же класс бага, что чинили на
   * ПК, pages/Clients.tsx ClientRow). Восстановление — прямо в строке, тем же
   * приёмом (свой хук с правом и без него), что и в ClientRow.
   */
  const { isTrashed, isOther, pending, canRestore, canAcceptRow, canCall, restoreClient, requestRestore, acceptLead, declineLead, restoreRequested, confirmDecline, setConfirmDecline, acceptClient, restore, requestRestoration, confirmRejection } = useClientRowActions(c);
  /**
   * «Принять»/«Отклонить» и звонок ниже — их хуки заведены здесь же, ДО
   * ветвления по `isTrashed`: правило хуков запрещает вызывать их после
   * условного `return` (react-hooks/rules-of-hooks, поймано сборкой). Для
   * карточки в Корзине они просто не пригодятся — `canAcceptRow`/`canCall`
   * там не проверяются.
   */
  if (isTrashed) {
    const name = c.displayName ?? (c.fullName.trim() || formatClientName(c));
    const tone = avatarToneClass(name);
    return (
      <div className="row" aria-label={`${name} — в Корзине`}>
        <span className={`av ${tone}`} aria-hidden="true">
          {avatarInitial(name)}
        </span>
        <span className="b">
          <span className="n">
            <span className="nm quiet">{name}</span>
            <span className="chip mute xs">{c.hiddenReason?.kind === "securityReview" ? "В корзине" : c.hiddenReason?.label ?? "В корзине"}</span>
          </span>
          <span className="s">
            <span className="tx">{c.hiddenReason?.kind === "securityReview" ? "Карточка удалена" : c.hiddenReason?.detail ?? "Карточка удалена"}</span>
          </span>
        </span>
        <span className="r">
          {canRestore ? (
            <button
              type="button"
              className="pill ghost sm"
              disabled={restoreClient.isPending}
              onClick={restore}
            >
              {restoreClient.isPending ? "Восстанавливаем" : "Восстановить"}
            </button>
          ) : (
            <button
              type="button"
              className="pill ghost sm"
              disabled={requestRestore.isPending || restoreRequested}
              onClick={requestRestoration}
            >
              {restoreRequested ? "Отправлено" : requestRestore.isPending ? "Отправляем" : "Попросить восстановить"}
            </button>
          )}
        </span>
      </div>
    );
  }
  /**
   * В строке — ИМЯ ЧЕЛОВЕКА, без приставки роли. `formatClientName` (общий,
   * packages/shared) возвращает «Покупатель Зарина Холова»: на ПК это нужно,
   * там один список показывает и покупателей, и продавцов при поиске по всем
   * разделам. Здесь срез назван в самом заголовке экрана («Покупатели · N»),
   * поэтому приставка повторяла бы его в каждой строке.
   *
   * ИСКЛЮЧЕНИЕ — «Неактивные» (владелец 17.09.2026): оба вида в одном списке,
   * заголовок экрана уже не называет вид, поэтому здесь `showKind=true` и
   * приставка нужна — иначе не отличить продавца от покупателя.
   */
  const name = c.displayName ?? (c.fullName.trim() || formatClientName(c));
  const tone = avatarToneClass(name);
  const channel = sourceChannel(c.source);
  const hot = c.status === "HOT";

  const wants = [c.desiredRooms ? `${c.desiredRooms}-комн` : null, c.desiredDistrict?.name ?? null]
    .filter(Boolean)
    .join(", ");
  const step = c.nextStep?.nextAction?.trim();
  const parts = [
    showKind && c.kind ? CLIENT_KIND_LABELS[c.kind] : null,
    wants || null,
    CLIENT_SOURCE_LABELS[c.source],
    step || null,
  ].filter(Boolean) as string[];

  const chip =
    c.status === "HOT"
      ? { cls: "crit", text: CLIENT_STATUS_LABELS.HOT.toLowerCase() }
      : c.status === "NEW"
        ? { cls: "sky", text: CLIENT_STATUS_LABELS.NEW.toLowerCase() }
        : c.status === "CONTACTED"
          ? { cls: "ok", text: CLIENT_STATUS_LABELS.CONTACTED.toLowerCase() }
          : null;

  /**
   * «ПРИНЯТЬ»/«ОТКЛОНИТЬ» ПРЯМО В СТРОКЕ (владелец 17.08.2026) — тот же разбор,
   * что в ClientRow на ПК (pages/Clients.tsx): агенты не находили эти кнопки
   * внутри карточки, пока до неё доходили. Эскалированный лид (никто не принял,
   * крон больше не крутит) кнопок не получает — решает руководитель, уже
   * получивший пуш (18.09.2026, задание В §f п.4).
   */
  const escalated = !c.acceptedAt && !!c.escalatedAt;
  // Строка едет вправо через свайп только когда звонок вообще возможен —
  // непринятому лиду номер замаскирован, звонить по чужому ещё не принятому
  // лиду нельзя (тот же разбор, что в ClientRow на ПК).
  // Маска «•» в номере звонку не мешает: CRM звонит по карточке, номер берёт
  // сервер. Проверка по маске прятала кнопку у агента без права видеть номера —
  // на компьютере она при этом была (аудит 23.09.2026, №54).

  return (
    <>
      <div className="row relative" style={{ position: "relative" }}>
        {/* Растянутая ссылка-подложка вместо самого `<Link>`: кнопки
            «Принять»/«Отклонить»/звонок нужно нажимать отдельно от открытия
            карточки, а вложенный интерактивный элемент внутри `<Link>` этого
            не позволяет (тот же приём, что у ClientRow на ПК, найден
            проверкой 10.09.2026 там же). */}
        <Link
          to={`/clients/${c.shortId}`}
          title={formatClientCode(c.shortId, c.kind)}
          aria-label={`Открыть карточку: ${name}`}
          className="absolute inset-0 z-0 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        />
        <span className={`av ${tone}`} aria-hidden="true">
          {avatarInitial(name)}
          {/* Уголок — только когда источник известен: у роли без права
              `clients.viewOrigin` сервер обнуляет `source`. */}
          {hasChannelGlyph(channel) && (
            <span className="ch">
              <ChannelIcon channel={channel} size={11} />
            </span>
          )}
        </span>
        <span className="b relative z-10" style={{ position: "relative", zIndex: 1, pointerEvents: "none" }}>
          <span className="n">
            <span className="nm">{name}</span>
            {chip && <span className={`chip ${chip.cls} xs`}>{chip.text}</span>}
            {!isOther && pending && (
              <span className={escalated ? "chip crit xs" : "chip warn xs"}>
                {escalated ? "Никто не принял" : "Ждёт принятия"}
              </span>
            )}
            {/* Приходит только во вкладке «Все мои» (задание В §f п.1/2) — OTHER/
                LOST/DEAL_CLOSED/ARCHIVED/эскалирован/СБ/Отложен/Неактивен. */}
            {c.hiddenReason && c.hiddenReason.kind !== "securityReview" && (
              <span className="chip warn xs" title={c.hiddenReason.detail}>
                {c.hiddenReason.label}
              </span>
            )}
          </span>
          <span className="s">
            {parts.length > 0 ? (
              parts.map((p, i) => (
                <span key={i} className="tx">
                  {i > 0 ? `· ${p}` : p}
                </span>
              ))
            ) : (
              <span className="tx">—</span>
            )}
          </span>
          {canAcceptRow && (
            <span className="flex items-center gap-2 flex-wrap mt-2" style={{ pointerEvents: "auto" }}>
              <button
                type="button"
                className="pill sm"
                disabled={acceptLead.isPending || declineLead.isPending}
                onClick={acceptClient}
              >
                <Check className="i" aria-hidden />
                {acceptLead.isPending ? "Принятие" : "Принять"}
              </button>
              <button
                type="button"
                className="pill ghost sm"
                disabled={acceptLead.isPending || declineLead.isPending}
                onClick={() => setConfirmDecline(true)}
              >
                Отклонить
              </button>
            </span>
          )}
          {(acceptLead.isError || declineLead.isError) && (
            <span className="block mt-2" style={{ pointerEvents: "auto" }}>
              <MutationError
                mutation={acceptLead.isError ? acceptLead : declineLead}
                fallback={acceptLead.isError ? "Не удалось принять лид" : "Не удалось отклонить лид"}
              />
            </span>
          )}
        </span>
        <span className="r relative z-10" style={{ position: "relative", zIndex: 1, pointerEvents: "none" }}>
          <span className={`tm${hot ? " hot" : ""}`}>{sinceLabel(c.lastContactAt ?? c.assignedAt)}</span>
          {c.unread && <span className="unread dot" aria-label="Клиент написал, переписка не открыта" />}
          {/* Звонок прямо из строки — непринятому лиду кнопки нет: номер у
              него замаскирован (тот же разбор, что в ClientRow на ПК). */}
          {canCall && (
            <span style={{ pointerEvents: "auto" }}>
              <CallClientButton clientId={c.id} phone={c.phone} variant="icon" title="Позвонить через CRM" />
            </span>
          )}
        </span>
      </div>
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
