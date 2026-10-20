import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { keepWhilePagingAt } from "../lib/keepWhilePaging";
import type { Paginated, AgentRef, Property } from "../types";
import type {
  CancelVideoHandoffInput,
  FirstSecondsResult,
  PropertyStageState,
  PropertyStatus,
  SearchOverview,
  VideoHandoffMoveBody,
  VideoHandoffMoveResult,
  VideoHandoffQueueState,
  YandexSearchOverview,
} from "@royal-home/shared";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

/** Состояние этапа конвейера — считает сервер, описывает @royal-home/shared. */
export type PipelineStageState = PropertyStageState;

/**
 * Строка конвейера — объект ТОЙ ЖЕ формы, что в списке объектов (GET /properties,
 * сервер: lib/propertyListItem.ts), чтобы экран конвейера рисовал его тем же
 * PropertyRow (24.09.2026, владелец: «карточку объекта полностью, как и везде»),
 * плюс поля конвейера.
 */
export type MarketingQueueRow = Property & {
  status: PropertyStatus;
  photoCount: number;
  responsibleAgent: AgentRef | null;
  pipeline: PipelineStageState;
  /** Место в очереди передачи видео монтажёру через бота (lib/videoHandoff.ts):
   *  1 — у монтажёра прямо сейчас, 2+ — ждёт своей очереди, null — вне хендоффа
   *  (ещё не отправляли, или монтажёр уже прислал готовый ролик). Строки «На
   *  монтаже» сервер отдаёт уже в порядке очереди. */
  videoHandoffQueuePosition: number | null;
};

export interface MarketingSummary {
  total: number;
  awaitingReview: number;
  awaitingPhotos: number;
  awaitingVideo: number;
  editing: number;
  overdue: number;
}

export interface EditorRef {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  isActive: boolean;
}

export interface EditorsLoad {
  editors: EditorRef[];
  sharedQueue: { inEditing: number; overdue: number };
}

/**
 * Рабочая очередь монтажёра: что на монтаже сейчас и что придёт следующим.
 * Строка та же, что в очереди маркетинга, — сервер собирает её одним и тем же
 * pipelineSelect (api: routes/marketing.ts).
 */
export interface EditorQueue {
  inEditing: MarketingQueueRow[];
  upcoming: MarketingQueueRow[];
  counts: { inEditing: number; overdue: number; upcoming: number };
  editingPage: number;
  upcomingPage: number;
  pageSize: number;
}

/** `status` — стадия конвейера, фильтр на сервере (02.10.2026): страница из 40
 *  строк всего конвейера, отфильтрованная на экране, теряла строки стадии,
 *  лежащие на других страницах. Без `status` — весь конвейер. */
export function useMarketingQueue(page: number, enabled = true, status?: string) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["marketing", "queue", page, status ?? "all"],
    placeholderData: keepWhilePagingAt<Paginated<MarketingQueueRow>>(["marketing", "queue", page, status ?? "all"], 2),
    queryFn: () =>
      api<Paginated<MarketingQueueRow>>(
        `/marketing/queue?page=${page}${status ? `&status=${encodeURIComponent(status)}` : ""}`
      ),
    enabled,
  });
}

export function useMarketingSummary(enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["marketing", "summary"],
    queryFn: () => api<MarketingSummary>("/marketing/summary"),
    enabled,
  });
}

/** Страницы двух списков независимы (02.10.2026, «Показать ещё» под каждым):
 *  сервер отдаёт по 50 строк на страницу и честные счётчики в `counts`. */
export function useEditorQueue(enabled = true, pages?: { editingPage?: number; upcomingPage?: number }) {
  const editingPage = pages?.editingPage ?? 1;
  const upcomingPage = pages?.upcomingPage ?? 1;
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["marketing", "editor-queue", editingPage, upcomingPage],
    queryFn: () =>
      api<EditorQueue>(`/marketing/editor-queue?editingPage=${editingPage}&upcomingPage=${upcomingPage}`),
    enabled,
  });
}

/** Раздел «Каналы» (01.09.2026) — единый статус подключения по каждой соцсети,
 *  собранный из уже существующих настроек и рубильников (routes/marketing.ts). */
export interface ChannelsStatus {
  autoPublishEnabled: boolean;
  publishedCount: number;
  openErrors: number;
  channels: {
    INSTAGRAM: { connected: boolean; botEnabled: boolean; commentsEnabled: boolean };
    FACEBOOK: { connected: boolean; botEnabled: boolean };
    TELEGRAM: {
      botEnabled: boolean;
      crosspostConnected: boolean;
      commentsConnected: boolean;
      commentsEnabled: boolean;
      directMessagesEnabled: boolean;
    };
    YOUTUBE: { connected: boolean };
    TIKTOK: { connected: boolean; username: string | null };
    THREADS: { connected: boolean; username: string | null };
  };
}

export function useChannelsStatus(enabled = true) {
  return useQuery({
    queryKey: ["marketing", "channels-status"],
    queryFn: () => api<ChannelsStatus>("/marketing/channels-status"),
    enabled,
  });
}

/** Счётчик для блока «Фид каталога для рекламы Meta» в Настройках (28.09.2026) —
 *  сколько объектов сейчас реально попадёт в CSV (lib/metaCatalogFeed.ts на сервере). */
export function useMetaCatalogFeedStatus(enabled = true) {
  return useQuery({
    queryKey: ["marketing", "meta-catalog-feed-status"],
    queryFn: () => api<{ count: number }>("/marketing/meta-catalog-feed/status"),
    enabled,
  });
}

export function useEditorsLoad(enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["marketing", "editors-load"],
    queryFn: () => api<EditorsLoad>("/marketing/editors-load"),
    enabled,
  });
}

/** Ключ мутаций снятия/паузы — по нему весь список гасит кнопки, пока идёт
 *  ЛЮБОЕ снятие (useIsMutating), а не только в своей строке (24.09.2026). */
export const VIDEO_HANDOFF_MUTATION_KEY = ["marketing", "video-handoff-mutation"] as const;
const VIDEO_HANDOFF_STATE_KEY = ["marketing", "video-handoff-state"] as const;

function useInvalidateHandoffQueues() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["marketing", "queue"] });
    void qc.invalidateQueries({ queryKey: ["marketing", "editor-queue"] });
    void qc.invalidateQueries({ queryKey: VIDEO_HANDOFF_STATE_KEY });
    // Список объектов и карточка одного объекта тоже читают хендофф
    // (videoHandoffBrief в списке, videoHandoff в карточке, 25.09.2026,
    // задания C/D) — без этого чип в списке и блок «Монтаж» в карточке
    // устаревали бы до следующего захода на экран.
    void qc.invalidateQueries({ queryKey: ["properties"] });
    // Открытая карточка объекта кэшируется под ["property"] (№252).
    void qc.invalidateQueries({ queryKey: ["property"] });
  };
}

/** Снять объект с очереди передачи видео монтажёру — не публикация и не
 *  возврат на доработку, просто «монтажёр этот ролик не ждёт» (см.
 *  cancelVideoHandoffQueueEntry). Обе очереди читают этот же хендофф —
 *  инвалидируем и `/queue` (маркетинг/админ/директор), и `/editor-queue`
 *  (монтажёр), не только ту, что открыта у нажавшего кнопку. `holdQueue` —
 *  снять держателя, не отдавая место следующему (очередь на паузу). */
export function useCancelVideoHandoff() {
  const invalidate = useInvalidateHandoffQueues();
  return useMutation({
    mutationKey: VIDEO_HANDOFF_MUTATION_KEY,
    mutationFn: ({ propertyId, ...body }: { propertyId: string } & CancelVideoHandoffInput) =>
      api(`/marketing/video-handoff/${propertyId}/cancel`, { method: "POST", body }),
    // И на ошибке тоже (409 «состояние изменилось»): список устарел, показывать
    // его дальше — значит предлагать снять то, чего уже нет.
    onSettled: invalidate,
  });
}

/** Передвинуть объект в очереди монтажёра (24.09.2026): «В начало», «Выше»,
 *  «Ниже». Держателя места сервер двигать не даёт (409). Ключ общий со снятием
 *  и паузой — пока идёт любой ход, весь список гасит кнопки. */
export function useMoveVideoHandoff() {
  const invalidate = useInvalidateHandoffQueues();
  return useMutation({
    mutationKey: VIDEO_HANDOFF_MUTATION_KEY,
    mutationFn: ({ propertyId, ...body }: { propertyId: string } & VideoHandoffMoveBody) =>
      api<VideoHandoffMoveResult>(`/marketing/video-handoff/${propertyId}/move`, { method: "POST", body }),
    onSettled: invalidate,
  });
}

/** Отложить объект в очереди монтажа (25.09.2026, «Отложить») — держатель
 *  места (SENT_TO_EDITOR) — 409, см. lib/videoHandoff.ts::holdVideoHandoff.
 *  Ключ общий со снятием/ходом/паузой — та же гонка кнопок. */
export function useHoldVideoHandoff() {
  const invalidate = useInvalidateHandoffQueues();
  return useMutation({
    mutationKey: VIDEO_HANDOFF_MUTATION_KEY,
    mutationFn: ({ propertyId, reason }: { propertyId: string; reason?: string }) =>
      api(`/marketing/video-handoff/${propertyId}/hold`, { method: "POST", body: { reason } }),
    onSettled: invalidate,
  });
}

/** Вернуть отложенный объект в очередь — см. lib/videoHandoff.ts::releaseVideoHandoffHold. */
export function useUnholdVideoHandoff() {
  const invalidate = useInvalidateHandoffQueues();
  return useMutation({
    mutationKey: VIDEO_HANDOFF_MUTATION_KEY,
    mutationFn: ({ propertyId }: { propertyId: string }) =>
      api(`/marketing/video-handoff/${propertyId}/unhold`, { method: "POST" }),
    onSettled: invalidate,
  });
}

/** «Отправить монтажёру повторно» из карточки объекта (25.09.2026, владелец:
 *  «повторно отправить монтажёру, если мы не получили файл») — только для
 *  держателя места. Сервер отвечает сразу (`{ started: true }`), сама отправка
 *  идёт в фоне — см. POST /marketing/video-handoff/:id/resend. */
export function useResendVideoHandoff() {
  const invalidate = useInvalidateHandoffQueues();
  return useMutation({
    mutationKey: VIDEO_HANDOFF_MUTATION_KEY,
    mutationFn: ({ propertyId }: { propertyId: string }) =>
      api<{ started: true }>(`/marketing/video-handoff/${propertyId}/resend`, { method: "POST" }),
    onSettled: invalidate,
  });
}

/** Состояние очереди монтажёра: пауза, держатель места и кому место уйдёт
 *  следующим — для окна подтверждения снятия и баннера паузы. */
export function useVideoHandoffQueueState(enabled = true) {
  return useQuery({
    queryKey: VIDEO_HANDOFF_STATE_KEY,
    queryFn: () => api<VideoHandoffQueueState>("/marketing/video-handoff/queue-state"),
    enabled,
  });
}

/** Придержать / возобновить очередь монтажёра. Возобновление сразу отдаёт
 *  свободное место следующему (сервер). `reason` (25.09.2026, А4) — только у
 *  постановки на паузу, необязательный. */
export function useSetVideoHandoffQueuePaused() {
  const invalidate = useInvalidateHandoffQueues();
  return useMutation({
    mutationKey: VIDEO_HANDOFF_MUTATION_KEY,
    mutationFn: ({ paused, reason }: { paused: boolean; reason?: string }) =>
      api<VideoHandoffQueueState>(`/marketing/video-handoff/queue/${paused ? "pause" : "resume"}`, {
        method: "POST",
        body: paused ? { reason } : undefined,
      }),
    onSettled: invalidate,
  });
}

/** Раздел «Ждут публикации» (шаг 5 переноса): объекты, вышедшие из конвейера
 *  (в продажу) за последние windowDays дней — момент фиксирует AuditLog
 *  (PROPERTY_EDITING_DONE), каналы — реальное поле Property.publishedChannels.
 *  Пустой массив — пост ещё не ушёл ни в один канал (ручной путь или очередь). */
export interface RecentlyPublishedItem {
  id: string;
  shortId: number;
  title: string;
  publishedAt: string;
  publishedChannels: string[];
}

/** Свободный ролик («Ролики в соцсети», 12.10.2026): вышел без объекта. Приходит только на странице 1. */
export interface RecentlyPublishedFreeVideo {
  id: string;
  title: string;
  status: string;
  publishedAt: string | null;
  publishedChannels: string[];
}

export interface RecentlyPublished {
  items: RecentlyPublishedItem[];
  freeVideos: RecentlyPublishedFreeVideo[];
  /** Событий выхода за окно — всего, не на странице. */
  total: number;
  page: number;
  pageSize: number;
  windowDays: number;
}

export function useRecentlyPublished(enabled = true, page = 1) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["marketing", "recently-published", page],
    placeholderData: keepWhilePagingAt<RecentlyPublished>(["marketing", "recently-published", page], 2),
    queryFn: () => api<RecentlyPublished>(`/marketing/recently-published?page=${page}`),
    enabled,
  });
}

/**
 * ПОДБОРКИ ОБЪЕКТОВ (28.09.2026, agent-brief.md reposts-digests) — панель
 * публикаций Центра маркетинга: последние подборки и кнопка «Собрать сейчас».
 * Сервер уже группирует три строки-канала (см. GET /marketing/digests) —
 * здесь просто типы ответа.
 */
export interface DigestChannelStatus {
  channel: string;
  status: string;
  permalink: string | null;
}

export interface DigestListItem {
  title: string;
  kind: string;
  propertyCount: number;
  createdAt: string;
  channels: DigestChannelStatus[];
}

export function useSocialDigests(enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["marketing", "digests"],
    queryFn: () => api<{ digests: DigestListItem[] }>("/marketing/digests").then((r) => r.digests),
    enabled,
  });
}

export function useRunDigestNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ran: boolean; reason?: string; kind?: string; published?: number; failed?: number }>("/marketing/digests/run", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["marketing", "digests"] }),
  });
}

/**
 * РАЗДЕЛ «РАСПИСАНИЕ» (23.09.2026, владелец: «чтобы я видел время выхода,
 * объекты, почему именно, какие площадки»).
 *
 * Всё считает сервер (`lib/publishScheduleRules.ts` — та же точка правды, из
 * которой слот берётся при приёме ролика). Здесь не пересчитывается НИЧЕГО:
 * стоит завести на экране свою арифметику часов — и «почему этот ролик выйдет
 * в 12:40» разойдётся с тем, что на самом деле сделал сервер.
 */
export interface PublishScheduleRulesView {
  enabled: boolean;
  windowStartMin: number;
  windowEndMin: number;
  minGapMin: number;
  /** Откуда взяты приоритетные часы: карта наших обращений, статистика
   *  Instagram «подписчики в сети» или постоянные окна. */
  prioritySource: "heatmap" | "instagram" | "fixed";
  priorityHours: number[];
  heatmapEvents: number;
  heatmapDays: number;
  /** Карта включена, но событий мало — считаем по постоянным окнам. */
  heatmapTooSparse: boolean;
  /** Часы по статистике Instagram включены (и тепловая карта тоже). */
  instagramOnlineEnabled: boolean;
  /** Сколько суток статистики Instagram уже собрано и сколько нужно, чтобы ей верить. */
  instagramOnlineDays: number;
  instagramOnlineMinDays: number;
  /** Свои часы выхода на каждый день недели (0 — воскресенье), только у
   *  статистики Instagram; иначе null. */
  priorityHoursByDow: number[][] | null;
  /** Сколько роликов в день вмещают окно и промежуток. */
  dailyCapacity: number;
}

export interface PublishScheduleItem {
  propertyId: string;
  shortId: number;
  title: string;
  at: string | null;
  reason: string | null;
  receivedAt: string | null;
  /** Слот уже прошёл, а публикации нет — фоновая задача застряла. */
  overdue: boolean;
  /** Что с заданием публикации: ждёт часа, публикуется прямо сейчас, застряло
   *  (сдалось или не встало в очередь) — тогда поможет «Опубликовать сейчас». */
  jobState: "waiting" | "publishing" | "stuck";
  channels: string[];
}

/** Свободный ролик по расписанию: у него свои кнопки на странице «Ролики в соцсети». */
export interface PublishScheduleFreeItem {
  id: string;
  title: string;
  at: string | null;
  channels: string[];
  overdue: boolean;
}

export interface PublishSchedule {
  now: string;
  schedule: PublishScheduleRulesView;
  targetChannels: string[];
  channels: { channel: string; connected: boolean }[];
  autoPublishEnabled: boolean;
  upcoming: PublishScheduleItem[];
  freeUpcoming: PublishScheduleFreeItem[];
}

/**
 * СТАТИСТИКА TIKTOK (23.09.2026) — GET /tiktok/insights.
 *
 * Тип-дубликат: та же форма живёт в packages/shared/src/tiktokInsights.ts
 * (там же и причина — @royal-home/shared резолвится через node_modules в
 * дистрибутив главного дерева, который эту правку до общей пересборки shared
 * не видит). Сверить и оставить только shared при следующей пересборке.
 */
export interface TikTokInsightsAccount {
  openId: string;
  displayName: string | null;
  avatarUrl: string | null;
  bioDescription: string | null;
  profileDeepLink: string | null;
  isVerified: boolean | null;
  followerCount: number | null;
  followingCount: number | null;
  likesCount: number | null;
  videoCount: number | null;
}

export interface TikTokInsightsVideo {
  id: string;
  title: string | null;
  videoDescription: string | null;
  createTime: number | null;
  coverImageUrl: string | null;
  shareUrl: string | null;
  duration: number | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  propertyId: string | null;
}

export type TikTokInsights =
  | { available: true; account: TikTokInsightsAccount; videos: TikTokInsightsVideo[]; fetchedAt: string }
  | { available: false; reason: string; missingScopes: string[] };

export function useTikTokInsights(enabled = true) {
  return useQuery({
    queryKey: ["marketing", "tiktok-insights"],
    queryFn: () => api<TikTokInsights>("/tiktok/insights"),
    enabled,
    // Тот же порядок, что серверный кэш (15 мин, lib/tiktokInsights.ts) — чаще
    // спрашивать смысла нет, TikTok всё равно отдаст те же кэшированные числа.
    staleTime: 15 * 60_000,
  });
}

/** «Опубликовать сейчас» из очереди «Расписание» — сдвигает уже стоящую
 *  публикацию на ближайший проход (сервер: publishHandoffNow). */
export function usePublishNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyId: string) => api<{ ok: boolean }>(`/properties/${propertyId}/publish-now`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["marketing", "publish-schedule"] }),
  });
}

/** «Перенести» — своё время выхода (ISO со смещением Душанбе). */
export function usePublishAt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ propertyId, at }: { propertyId: string; at: string }) =>
      api<{ ok: boolean; at: string }>(`/properties/${propertyId}/publish-at`, { method: "POST", body: { at } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["marketing", "publish-schedule"] }),
  });
}

export function usePublishSchedule(enabled = true) {
  return useQuery({
    queryKey: ["marketing", "publish-schedule"],
    queryFn: () => api<PublishSchedule>("/marketing/publish-schedule"),
    enabled,
    // Очередь живая: слот наступает, ролик уходит, строка пропадает. Минута —
    // тот же шаг, с которым фоновые задачи разбирают очередь публикаций.
    refetchInterval: 60_000,
  });
}

/**
 * СТАТИСТИКА РОЛИКОВ ПО ВСЕМ ПЛОЩАДКАМ (24.09.2026, владелец: «статистика всех
 * каналов, а не только Instagram»). GET /marketing/post-stats — просмотры,
 * лайки, комментарии каждого вышедшего ролика на каждой площадке. Сервер
 * держит ответ полчаса (площадки считают охваты не мгновенно).
 */
export type PostStatsChannel = "INSTAGRAM" | "FACEBOOK" | "YOUTUBE" | "TIKTOK" | "TELEGRAM";

export interface PostStatsPlatform {
  channel: PostStatsChannel;
  connected: boolean;
  available: boolean;
  reason: string | null;
  posts: number;
  views: number;
  likes: number;
  comments: number;
}

export interface PostStatsItem {
  propertyId: string;
  shortId: number;
  title: string;
  publishedAt: string | null;
  publishHour: number | null;
  stats: { channel: string; views: number | null; likes: number | null; comments: number | null; url: string | null }[];
}

export interface PostStatsFreeVideo {
  id: string;
  title: string;
  publishedAt: string | null;
  publishHour: number | null;
  stats: PostStatsItem["stats"];
}

export interface PostStats {
  fetchedAt: string;
  platforms: PostStatsPlatform[];
  posts: PostStatsItem[];
  /** Свободные ролики (без объекта) — в итогах площадок уже учтены. */
  freeVideos: PostStatsFreeVideo[];
  byHour: { hour: number; posts: number; avgViews: number }[];
}

export function usePostStats(enabled = true) {
  return useQuery({
    queryKey: ["marketing", "post-stats"],
    queryFn: () => api<PostStats>("/marketing/post-stats"),
    enabled,
    staleTime: 10 * 60_000,
  });
}

/**
 * «ПОЧЕМУ ВЗЛЕТЕЛИ» (24.09.2026) — GET /marketing/post-analysis: лучшие ролики
 * против остальных по часу и дню выхода, площадке, типу объекта, району, цене,
 * длине ролика и подписи, плюс разбор ИИ обычными словами раз в сутки.
 */
export interface PostAnalysisFactor {
  key: string;
  /** «Час выхода», «Район»… */
  title: string;
  /** Лучшее значение словами: «вечер 18–21», «Сино». */
  best: string;
  bestAvg: number;
  overallAvg: number;
  /** На сколько процентов лучшее значение выше среднего. */
  lift: number;
  /** На скольких роликах держится вывод. */
  sample: number;
}

export interface PostAnalysis {
  ready: boolean;
  reason: string | null;
  postsCounted: number;
  factors: PostAnalysisFactor[];
  top: { propertyId: string; shortId: number; title: string; views: number }[];
  summary: string | null;
  summaryAt: string | null;
}

export function usePostAnalysis(enabled = true) {
  return useQuery({
    queryKey: ["marketing", "post-analysis"],
    queryFn: () => api<PostAnalysis>("/marketing/post-analysis"),
    enabled,
    staleTime: 30 * 60_000,
  });
}

/**
 * «САЙТ И ПОИСК» (24.09.2026) — GET /search-console/overview: Google Search
 * Console о royalhome.tj за 7/28/90 дней. `redirectUri` — адрес возврата, который
 * нужно вписать в Google-приложение; экран показывает его, пока поиск не подключён.
 */
export type SearchOverviewResponse = SearchOverview & { redirectUri: string };

export function useSearchOverview(days: number, enabled = true) {
  return useQuery({
    queryKey: ["marketing", "search-overview", days],
    queryFn: () => api<SearchOverviewResponse>(`/search-console/overview?days=${days}`),
    enabled,
    staleTime: 30 * 60_000,
  });
}

/** «Сайт и поиск» → Яндекс Вебмастер: то же, что Google, плюс адрес возврата для приложения Яндекса. */
export type YandexOverviewResponse = YandexSearchOverview & { redirectUri: string };

export function useYandexOverview(days: number, enabled = true) {
  return useQuery({
    queryKey: ["marketing", "yandex-overview", days],
    queryFn: () => api<YandexOverviewResponse>(`/search-console/yandex/overview?days=${days}`),
    enabled,
    staleTime: 30 * 60_000,
  });
}

/**
 * «ПЕРВЫЕ СЕКУНДЫ» (24.09.2026) — GET /marketing/first-seconds: сколько
 * листают дальше в начале ролика и что ИИ увидел в первых трёх секундах.
 * Разборы появляются фоном, поэтому экран сам переспрашивает раз в 2 минуты,
 * пока очередь не пуста.
 */
export function useFirstSeconds(enabled = true) {
  return useQuery({
    queryKey: ["marketing", "first-seconds"],
    queryFn: () => api<FirstSecondsResult>("/marketing/first-seconds"),
    enabled,
    staleTime: 10 * 60_000,
    refetchInterval: (query) => ((query.state.data?.pending ?? 0) > 0 ? 2 * 60_000 : false),
  });
}
