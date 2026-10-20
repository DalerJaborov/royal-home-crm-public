import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { cardToSearchHit, type PropertyCardLike, type PropertySearchHit } from "../lib/adPropertySearch";
import { keepWhilePagingAt } from "../lib/keepWhilePaging";
import type { Paginated } from "../types";
import type {
  AdBoardProperty,
  AdOfPropertyShare,
  AdSpendSharedAds,
  AdLeadStats,
  AdLeaderboardRow,
  AdReconcileReport,
  AdTrendPoint,
  AdCreativesResponse,
  AdPacingResponse,
  PropertyStatus,
  SetAdPropertiesBody,
} from "@royal-home/shared";
import { canWriteAds, type AdDelivery, type AdPeriodPreset } from "../lib/adsView";
import { useCan } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

export type { AdDelivery, AdPeriodPreset };

/**
 * Расходы на рекламу в разрезе объектов.
 *
 * Считает всё сервер (api: lib/ads/adSpendReport.ts) — здесь только доставка.
 * Суммы приходят в двух видах: в сомони (отчётная валюта CRM, по ней сравнивают
 * с комиссией) и в валюте кабинета, чтобы цифру можно было сверить с Ads Manager
 * глазами. Показывать надо обе — иначе первый же вопрос «а почему у меня в
 * кабинете другая сумма» останется без ответа.
 */
export interface AdSpendPropertyRow extends Partial<AdSpendSharedAds> {
  property: {
    id: string;
    shortId: number;
    title: string;
    status: PropertyStatus;
    coverUrl: string | null;
    instagramUrl: string | null;
  } | null;
  /** Точно до дирама: сервер считает в целых сотых (api: lib/money.ts). */
  spendTjs: number;
  /** Сумма в валюте кабинета; null — объект рекламировали из кабинетов с разной
   *  валютой, и «исходной суммы» у строки нет. */
  spendOriginal: number | null;
  currency: string | null;
  impressions: number;
  clicks: number;
  conversations: number;
  adsCount: number;
  campaigns: string[];
  platforms: string[];
  thumbnailUrl: string | null;
  comments: number | null;
  /** Прибыль по проданному объекту: доля компании минус вся реклама. null — не продан. */
  profitTjs: number | null;
  commissionTjs: number | null;
  lifetimeSpendTjs: number | null;
}

export interface AdSpendReport {
  month: string;
  from: string;
  to: string;
  label?: string;
  rows: AdSpendPropertyRow[];
  totals: {
    spendTjs: number;
    spendOriginal: number | null;
    currency: string | null;
    impressions: number;
    clicks: number;
    conversations: number;
    adsCount: number;
  };
  truncated: boolean;
  syncedAt: string | null;
  enabled: boolean;
  /** Сервер запустил фоновую сверку с кабинетом — перечитать отчёт через полминуты. */
  refreshing: boolean;
}

/** Объявление в списках «без объекта» и «чужая реклама». */
export interface AdRow {
  id: string;
  platform?: string;
  adAccountId?: string | null;
  name: string;
  campaignName: string | null;
  postUrl: string | null;
  thumbnailUrl: string | null;
  lastSyncedAt: string;
  spendOriginal: number;
  currency: string;
}

export interface AdsSyncResult {
  ads: number;
  matched: number;
  unmatched: number;
  foreign: number;
  healed: number;
  spendRows: number;
  days: number;
  /** true — сверка уже шла (крон), этот запуск пропущен: цифры обновятся её итогом. */
  skipped?: boolean;
}

/** Отчёт по объектам за тот же период, что выбран для всего раздела. */
export function useAdSpendReport(preset: AdPeriodPreset, enabled = true) {
  return useQuery({
    queryKey: ["ads", "report", preset],
    queryFn: () => api<AdSpendReport>(`/ads/report?preset=${preset}`),
    enabled,
    // «Реальное время» по-честному: сервер сам сверяется с кабинетом, когда данным
    // больше 15 минут, и отвечает refreshing — тогда перечитываем отчёт, пока
    // сверка не закончится. В остальное время запросов нет.
    refetchInterval: (query) => (query.state.data?.refreshing ? 20_000 : false),
  });
}

export interface AdInsights {
  text: string | null;
  builtAt?: string;
  cached?: boolean;
  /** Почему текста нет: "empty" — расходов не было, "ai" — модель не ответила. */
  reason?: "empty" | "ai";
}

/** ИИ-разбор рекламы за месяц. Строится по запросу, на сервере кэш на сутки. */
export function useAdInsights(month: string, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["ads", "insights", month],
    queryFn: () => api<AdInsights>(`/ads/insights?month=${month}`),
    enabled,
    staleTime: 60 * 60 * 1000,
  });
}

export function useRefreshAdInsights() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (month: string) => api<AdInsights>(`/ads/insights?month=${month}&force=1`),
    onSuccess: (fresh, month) => qc.setQueryData(["ads", "insights", month], fresh),
  });
}

export function useUnmatchedAds(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["ads", "unmatched", page],
    placeholderData: keepWhilePagingAt<Paginated<UnmatchedAd>>(["ads", "unmatched", page], 2),
    queryFn: () => api<Paginated<UnmatchedAd>>(`/ads/unmatched?page=${page}`),
    enabled,
  });
}

export function useForeignAds(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["ads", "foreign", page],
    placeholderData: keepWhilePagingAt<Paginated<AdRow>>(["ads", "foreign", page], 2),
    queryFn: () => api<Paginated<AdRow>>(`/ads/foreign?page=${page}`),
    enabled,
  });
}

/** Привязка объявления к объекту вручную. null — снять привязку. */
export function useLinkAd() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, propertyId }: { id: string; propertyId: string | null }) =>
      api(`/ads/${id}/property`, { method: "PATCH", body: { propertyId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ads"] }),
  });
}

/** Кто может менять привязки рекламы — ровно как `requireAdsWrite` на сервере. */
export function useCanWriteAds(): boolean {
  const can = useCan();
  const role = useAuthStore((s) => s.agent?.role);
  return canWriteAds(role, can);
}

/**
 * Полный список объектов объявления с долями (`PATCH /ads/:id/properties`).
 * Пустой `items` снимает привязку. Ошибку показывает само окно привязки, поэтому
 * общий тост выключен (`silent`), как у `useSyncAds`.
 */
export function useSetAdProperties() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, items }: { id: string } & SetAdPropertiesBody) =>
      api(`/ads/${id}/properties`, { method: "PATCH", body: { items } satisfies SetAdPropertiesBody }),
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ads"] }),
  });
}

/** «Это наше» / «это не наше» — вердикт по объявлению из общего кабинета. */
export function useAdOwnership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ours }: { id: string; ours: boolean }) =>
      api(`/ads/${id}/ownership`, { method: "PATCH", body: { ours } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ads"] }),
  });
}

/** Ручная сверка с кабинетом: обычная (неделя) или полная (квартал). */
export function useSyncAds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (full?: boolean) => api<AdsSyncResult>("/ads/sync", { method: "POST", body: { full: !!full } }),
    // silent: Ads.tsx уже показывает sync.isError своей плашкой — общий тост
    // дублировал текст (найдено аудитом 22.08.2026).
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ads"] }),
  });
}

/**
 * Подключение кабинета кнопкой: сервер выдаёт адрес окна Facebook вместе с
 * одноразовым ключом, дальше человек подтверждает доступ и возвращается обратно —
 * маркер CRM получает сама. Появилось после того, как перенести маркер руками не
 * вышло: не работал буфер обмена, а 200 символов с клавиатуры не набрать.
 */
/** Отвязать кабинет: маркер стирается, история расходов остаётся. */
export function useDisconnectAds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/ads/disconnect", { method: "POST", body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["ads"] });
    },
  });
}

export function useConnectAds() {
  return useMutation({
    mutationFn: () => api<{ url: string }>("/ads/connect", { method: "POST", body: {} }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
}

export interface UnmatchedCandidate {
  id: string;
  shortId: number;
  title: string;
  address: string;
  status: string;
  coverUrl: string | null;
  score: number;
}

/** Объявление без объекта — вместе с публикацией и подсказками (api: routes/ads.ts). */
export interface UnmatchedAd {
  id: string;
  platform: string;
  name: string;
  campaignName: string | null;
  postUrl: string | null;
  lastSyncedAt: string;
  spendOriginal: number;
  currency: string;
  conversations: number;
  impressions: number;
  previewUrl: string | null;
  caption: string | null;
  isOurPost: boolean;
  candidates: UnmatchedCandidate[];
}

/** Поиск объекта для ручной привязки — по номеру или адресу. */
export function useProperties(query: string, enabled = true) {
  return useQuery({
    queryKey: ["ads", "property-search", query],
    queryFn: async () => {
      // `q`, а не `search`: сервер читает только `q`, а неизвестный параметр
      // молча пропускал — вместо поиска приходили пять новых объектов, и к
      // рекламе привязывали не тот (аудит 23.09.2026, №59).
      const res = await api<{ items: UnmatchedCandidate[] }>(`/properties?q=${encodeURIComponent(query)}&page=1`);
      return res.items ?? [];
    },
    enabled,
  });
}

/**
 * Объект по короткому номеру (03.10.2026): текстовый поиск номера не знает, а
 * `GET /properties/:shortId` его принимает. null — такого объекта нет или он в
 * корзине; сбой сети — ошибка запроса (это не «объекта нет»).
 */
export function usePropertyByShortId(shortId: number | null) {
  return useQuery({
    queryKey: ["ads", "property-by-short-id", shortId],
    queryFn: async (): Promise<PropertySearchHit | null> => {
      try {
        return cardToSearchHit(await api<PropertyCardLike>(`/properties/${shortId}`));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: shortId != null,
  });
}

export interface AdBoardSpend {
  spendTjs: number;
  spendOriginal: number;
  impressions: number;
  clicks: number;
  conversations: number;
}

export interface AdBoardRow {
  id: string;
  name: string;
  campaignName: string | null;
  /** Сырой статус Meta — оставлен для поддержки, показывать его нельзя. */
  status: string | null;
  /**
   * ЧТО НА САМОМ ДЕЛЕ С ОБЪЯВЛЕНИЕМ. Считает сервер по факту трат: у Meta
   * завершённое объявление навсегда остаётся ACTIVE (api: lib/ads/adDelivery.ts).
   */
  delivery: AdDelivery;
  /** Расход объявления за СЕГОДНЯ по Душанбе (всё объявление, без деления на объекты); нет — старый сервер. */
  todayTjs?: number;
  objective: string | null;
  createdTime: string | null;
  startTime: string | null;
  stopTime: string | null;
  firstSpendAt: string | null;
  lastSpendAt: string | null;
  activeDays: number;
  postUrl: string | null;
  previewUrl: string | null;
  /** Первая строка текста публикации — чем строка без объекта называет себя. */
  headline: string | null;
  /** Реклама самого агентства: объекта у неё нет и не ждём. */
  brand: boolean;
  property: { id: string; shortId: number; title: string; status: string; coverUrl: string | null } | null;
  /**
   * ВСЕ объекты объявления с долями и деньгами на каждый (03.10.2026): в одном
   * объявлении Ads Manager бывает несколько роликов про разные квартиры.
   * `property` остаётся основным объектом — для старых мест экрана.
   */
  properties: AdBoardProperty[];
  /** Сколько материалов (роликов, фото) в объявлении по данным Meta. */
  assetCount: number;
  /** Сервер просит человека посмотреть: объекты привязаны не все или доли сломаны. */
  needsReview: boolean;
  matchSource: string | null;
  period: AdBoardSpend;
  lifetime: AdBoardSpend;
  currency: string | null;
  /** Клиенты CRM с этого объявления за период и их цена (волна 1, 03.10.2026). Нет поля — старый сервер. */
  leadStats?: AdLeadStats;
}

export interface AdsBoard {
  from: string;
  to: string;
  label: string;
  rows: AdBoardRow[];
  /** true — объявлений больше, чем влезло в один ответ: итоги неполные. */
  truncated?: boolean;
  /** true — клиентов в периоде больше предела выборки: цена клиента по неполному набору. */
  leadsTruncated?: boolean;
  /** Когда последний раз сверялись с кабинетом Meta. */
  syncedAt: string | null;
  /** Подключён ли рекламный кабинет вообще. */
  enabled: boolean;
  /** Сервер запустил фоновую сверку — цифры сейчас обновятся сами. */
  refreshing: boolean;
  totals: {
    /** Клиенты CRM с рекламы и цена клиента по всем показанным объявлениям; null — расчёт не удался. */
    leadStats?: AdLeadStats | null;
    periodTjs: number;
    lifetimeTjs: number;
    /** Идут по факту трат, а не по статусу Meta. */
    running: number;
    /** Включены, но денег не тратят. */
    stalled: number;
    /** Остановлены руками или завершены по сроку. */
    stopped: number;
    total: number;
    linked: number;
    /** Сколько объявлений признано чужими — число на ярлыке вкладки. */
    foreign: number;
    /** Деньги и число объявлений, продвигающих само агентство. */
    brandTjs: number;
    brandCount: number;
    /** Квартиры, которые ещё ждут привязки, — без брендовых. */
    pending: number;
    conversations: number;
  };
}

/** Дашборд объявлений за произвольный период: сроки, состояние и деньги. */
export function useAdsBoard(preset: AdPeriodPreset, enabled = true) {
  return useQuery({
    queryKey: ["ads", "board", preset],
    queryFn: () => api<AdsBoard>(`/ads/board?preset=${preset}`),
    enabled,
    // Сервер сам сверяется с кабинетом, когда данным больше 15 минут, и отвечает
    // refreshing — тогда перечитываем каждые 20 с, пока сверка не закончится. Пока
    // хоть одно объявление идёт — раз в минуту (13.10.2026, «идущие в реальном времени»):
    // блок «Идут сейчас» и сегодняшние траты не стоят на месте, пока открыт экран.
    refetchInterval: (query) =>
      query.state.data?.refreshing
        ? 20_000
        : query.state.data?.rows.some((r) => r.delivery === "RUNNING")
          ? 60_000
          : false,
  });
}

export interface AdAccountInfo {
  id: string;
  name: string | null;
  currency: string;
  fundingSource: string | null;
  balance: number | null;
  spendCap: number | null;
  timezone: string | null;
}

/** Кабинеты и чем за них платят — карта списания, валюта, долг. */
export function useAdAccounts(enabled = true) {
  return useQuery({
    queryKey: ["ads", "accounts"],
    queryFn: () => api<{ accounts: AdAccountInfo[] }>("/ads/accounts"),
    enabled,
    staleTime: 30 * 60 * 1000,
  });
}

export interface PropertyAdSummary {
  promoting: boolean;
  ads: number;
  spendTjs?: number;
  impressions?: number;
  clicks?: number;
  conversations?: number;
  firstSpendAt?: string | null;
  lastSpendAt?: string | null;
  postUrl?: string | null;
  /** Клиенты CRM с рекламы объекта за всё время и их цена (волна 1, 03.10.2026). */
  leadStats?: AdLeadStats;
  /**
   * По объявлениям объекта: доля в объявлении и деньги именно на него
   * (договор `adsOfProperty[].share`). Пока сервер поля не отдаёт, оно
   * undefined — плашка в карточке объекта тогда ничего лишнего не рисует.
   */
  adsOfProperty?: PropertyAdShare[];
}

/** Доля объекта в объявлении — общий договор с сервером (packages/shared/src/adsMultiObject.ts). */
export type PropertyAdShare = AdOfPropertyShare;

/** Реклама одного объекта — для плашки в его карточке. */
export function usePropertyAds(propertyId: string, enabled = true) {
  return useQuery({
    queryKey: ["ads", "property", propertyId],
    queryFn: () => api<PropertyAdSummary>(`/ads/property/${propertyId}`),
    enabled,
  });
}

/** Сверка денег CRM с итогом кабинета Meta. Раз в минуту, как просил экран. */
export function useAdReconcile(preset: AdPeriodPreset, enabled = true) {
  return useQuery({
    queryKey: ["ads", "reconcile", preset],
    queryFn: () => api<AdReconcileReport>(`/ads/reconcile?preset=${preset}`),
    enabled,
    refetchInterval: 60_000,
    // Сверка — проверка, а не данные: повторять сразу и много раз нет смысла.
    retry: 1,
  });
}

/** Расход, обращения и показы по дням за период. */
export function useAdTrend(preset: AdPeriodPreset, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["ads", "trend", preset],
    queryFn: () => api<AdTrendPoint[]>(`/ads/trend?preset=${preset}`),
    enabled,
  });
}

/**
 * Строка рейтинга. Миниатюра — сверх договора `AdLeaderboardRow`: без неё в
 * рейтинге объекты узнают только по номеру. Нет поля — рисуем значок.
 */
export type AdLeaderboardItem = AdLeaderboardRow & { thumbUrl?: string | null };

/** Объекты по цене обращения за период. */
export function useAdLeaderboard(preset: AdPeriodPreset, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["ads", "leaderboard", preset],
    queryFn: () => api<AdLeaderboardItem[]>(`/ads/leaderboard?preset=${preset}`),
    enabled,
  });
}

/** Рейтинг креативов за период: какие объявления дают клиента дешевле всего (api: lib/ads/adCreativeRank.ts). */
export function useAdCreatives(preset: AdPeriodPreset, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["ads", "creatives", preset],
    queryFn: () => api<AdCreativesResponse>(`/ads/creatives?preset=${preset}`),
    enabled,
  });
}

/**
 * Темп расхода и прогноз бюджета (api: lib/ads/adPacing.ts). Реквизиты кабинета сервер берёт
 * из кэша `/ads/accounts` и сам Meta не зовёт — поэтому запрос пересоздаётся, когда этот
 * кэш прогрет (список объявлений читает `/ads/accounts` на любой вкладке); прежний ответ
 * остаётся на экране, пока приходит новый, и блок не мигает.
 */
export function useAdPacing(enabled = true) {
  const accounts = useAdAccounts(enabled);
  return useQuery({
    queryKey: ["ads", "pacing", accounts.dataUpdatedAt],
    queryFn: () => api<AdPacingResponse>("/ads/pacing"),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  });
}
