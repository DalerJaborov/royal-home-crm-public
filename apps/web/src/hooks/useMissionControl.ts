import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CallbackRequestView, Currency, PultModuleId } from "@royal-home/shared";
import { api, ApiError } from "../lib/api";
import { invalidateAfterDealChange } from "./useDeals";

/** «Пульс компании» — экран /mission-control (routes/dashboardMissionControl.ts). */

export type McSection<T> = T | { error: true };

function isError<T>(v: McSection<T> | undefined): v is { error: true } {
  return !!v && typeof v === "object" && "error" in v && (v as { error?: true }).error === true;
}

export function mcOk<T>(v: McSection<T> | undefined): v is T {
  return v !== undefined && !isError(v);
}

/** Строка списка зоны (задача L2-T3) — до 5 штук, опциональна: старые клиенты без неё работают как раньше. */
export interface McZoneItem {
  id: string;
  title: string;
  href: string;
  tone: "ok" | "warn" | "crit";
  hint: string;
}

export interface McHero {
  /** `planIsDefault: true` — план месяца не задан (подставлен по умолчанию): «% плана» не показываем. */
  commission: { fact: number; plan: number; forecastEndOfMonth: number; forecastPercent: number; planIsDefault?: boolean } | null;
  profit: { todayTjs: number; previousTodayTjs: number } | null;
  leadsToday: { count: number; deltaVsYesterday: number };
  firstResponse: { medianMinYesterday: number | null; noneCountYesterday: number };
  missedCallsToday: number;
  dealsInPipeline: { count: number; byStage: { status: string; count: number }[]; items?: McZoneItem[] };
}

export interface McFirstLineItem {
  id: string;
  severity: "critical" | "warn" | "info";
  text: string;
  href: string;
}
export interface McFirstLine {
  items: McFirstLineItem[];
  shownCount: number;
  totalCount: number;
}

export interface McAgent {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  activeLoad: number;
  pendingAccept: number;
  acceptedToday: number;
  buyerCount: number;
  sellerCount: number;
  /** Присутствие (задача L2-T3) — ISO-строка последнего захода, либо null, если агент никогда не логинился. */
  lastSeenAt?: string | null;
  /** Принимает ли лиды сейчас: false — заморожен или приём на паузе (F2, 02.10.2026).
   *  Пульт не предлагает такому агенту «Передать». */
  takesLeads?: boolean;
}
export interface McTeamDayRow {
  agentId: string;
  name: string;
  calls: number;
  showings: number;
  tasksDone: number;
  messages: number;
  total: number;
}
export interface McTeamDay extends McEmptyable {
  rows: McTeamDayRow[];
  calls: number;
  showings: number;
  tasksDone: number;
  messages: number;
}
export interface McShowingRow {
  id: string;
  at: string;
  clientName: string;
  clientHref: string;
  propertyTitle: string | null;
  agentName: string;
  confirmed: boolean;
}
export interface McShowingsToday extends McEmptyable {
  count: number;
  confirmed: number;
  items: McShowingRow[];
}
export interface McTeam {
  agents: McAgent[];
  day?: McTeamDay;
  showingsToday?: McShowingsToday;
}

export interface McCalls {
  live: {
    incoming: { channelId: string; clientName: string | null; clientShortId: number | null; answered: boolean; seconds: number }[];
    outgoing: { channelId: string; clientName: string | null; clientShortId: number | null; state: string }[];
  };
  today: { incoming: number; outgoing: number; missed: number; unqualified: number };
}

/**
 * БЛОКИ, КОТОРЫЕ ДО 12.09.2026 ВСЕГДА ПОКАЗЫВАЛИ «НЕТ ДАННЫХ».
 *
 * Перенос артефакта скопировал их разметку дословно, а считалок на сервере не
 * было — карточка рисовалась корпусом и честной заглушкой. Теперь данные
 * приходят (apps/api/src/lib/missionControlGaps.ts), а `reason` объясняет
 * ПРИЧИНУ пустоты («за 30 дней публикаций не было») вместо безликого «нет
 * данных»: пустой блок должен отвечать на вопрос «почему», а не повторять его.
 *
 * Все поля необязательны: пульт открытый в старой вкладке переживает выкат.
 */
export interface McEmptyable {
  reason: string | null;
}

export interface McDialogRow {
  id: string;
  kind: "BOT" | "TELEGRAM";
  channel: string;
  title: string;
  clientId: string | null;
  lastMessageAt: string;
  waitingMinutes: number;
}
export interface McDialogZone extends McEmptyable {
  count: number;
  items: McDialogRow[];
}
export interface McBotAttention {
  silent: McDialogZone;
  waitingHuman: McDialogZone;
  liveCount: number;
}

export interface McBot {
  ai: { requestsToday: number; errorsToday: number; errorRatePercent: number; costUsdToday: number | null; avgMs: number };
  guardHitsToday: number;
  /** Сколько раз щит исходящих не выпустил сообщение бота за сегодня
   *  (apps/api/src/lib/outboundShield.ts). */
  outboundShieldToday: number;
  unresolvedFindings: number | null;
  attention?: McBotAttention;
}

export interface McMarketingChannel {
  source: string;
  label: string;
  leadsMonth: number;
  showingsMonth: number;
  dealsClosedMonth: number;
  spendMonthTjs: number | null;
  commissionMonthTjs: number | null;
  costPerLeadTjs: number | null;
  leadsToday: number;
  leadsTrailing7Avg: number;
  anomalyLeadsDown: boolean;
}
export interface McPublishQueue extends McEmptyable {
  count: number;
  publishedCount: number;
  items: { id: string; shortId: number; title: string; waitingDays: number }[];
}
export interface McChannelRow {
  id: string;
  label: string;
  connected: boolean;
  botEnabled: boolean | null;
  detail: string;
}
export interface McChannelsHealth extends McEmptyable {
  items: McChannelRow[];
  connectedCount: number;
  openErrors: number;
  autoPublishEnabled: boolean;
}
export interface McPulse extends McEmptyable {
  days: { date: string; leads: number; showings: number }[];
  leadsTotal: number;
  showingsTotal: number;
}
export interface McMarketing {
  instagramCommentsWaiting: number;
  funnel: McMarketingChannel[];
  funnelMonth: string;
  publishQueue?: McPublishQueue;
  channels?: McChannelsHealth;
  pulse30?: McPulse;
}

export interface McVideo {
  pipeline: { total: number; awaitingReview: number; awaitingPhotos: number; awaitingVideo: number; editing: number; overdue: number };
}

export interface McPropertiesExtra {
  topOfWeek: McEmptyable & { id: string | null; shortId?: number; title?: string; showings?: number };
  idle: McEmptyable & { count: number; items: { id: string; shortId: number; title: string; idleDays: number }[] };
  districts: McEmptyable & { rows: { id: string; name: string; available: number; showingsMonth: number }[] };
}
export interface McProperties {
  available: number;
  newThisWeek: number;
  reserved: number;
  portfolioValueTjs: number | null;
  items?: McZoneItem[];
  extra?: McPropertiesExtra;
}

export interface McSystem {
  crons: { name: string; lastRunAt: string | null; lastOkAt: string | null; lastError: string | null; healthy: boolean }[];
  jobsRunning: number;
  jobsGivenUp: number;
  jobsGivenUpLast24h: number;
  newApplications: number;
  errorsToday: number;
  /** Всего нерешённых ошибок, не только за сегодня. Поля может не быть — тогда только «за сегодня». */
  unresolvedTotal?: number;
  control?: McControlGaps;
}

export interface McAgentPhones extends McEmptyable {
  total: number;
  online: number;
  items: { agentId: string; name: string; extension: string; online: boolean }[];
}

export interface McControlGaps {
  phones: McAgentPhones;
  overdueTasks: McEmptyable & { count: number; items: { id: string; title: string; agentName: string; overdueDays: number; href: string }[] };
  atLimit: McEmptyable & { count: number; items: { agentId: string; name: string; taken: number; limit: number }[] };
  silentAfterShowing: McEmptyable & { count: number };
}

export interface McLeaderboardEntry {
  place: number;
  id: string;
  fullName: string;
  avatarUrl: string | null;
  score: number;
}
export interface McLeaderboard {
  agents: McLeaderboardEntry[];
}

export interface McAttentionClient extends McEmptyable {
  id: string | null;
  shortId?: number;
  fullName?: string;
  status?: string;
  kind?: string;
  source?: string | null;
  agentName?: string | null;
  hoursSinceContact?: number;
  why?: string;
}
export interface McDeleteRequests extends McEmptyable {
  clients: number;
  properties: number;
  total: number;
  items: { id: string; kind: "CLIENT" | "PROPERTY"; title: string; reason: string; requestedBy: string | null; createdAt: string; href: string }[];
}
export interface McReturnedClients extends McEmptyable {
  count: number;
  items: { id: string; shortId: number; fullName: string; returnedAt: string; agentName: string | null }[];
}
/** Раздел «Клиенты» на пульте — без тумблера, приходит всегда (см. buildZones). */
export interface McClientsZone {
  attentionClient: McAttentionClient;
  deleteRequests: McDeleteRequests;
  returned: McReturnedClients;
}
export interface McCommission12 extends McEmptyable {
  months: { month: string; amountTjs: number; deals: number }[];
  totalTjs: number;
  bestMonth: string | null;
  /** Расходы текущего месяца — строка «Расходы месяца» в разделе «Деньги». */
  expensesMonthTjs: number;
}

/**
 * Секции, кроме hero, необязательны: выключенный в настройках модуль пульта
 * (routes/pultModules.ts) не считается на сервере и в ответе ОТСУТСТВУЕТ —
 * его id лежит в modulesOff, и экран не рисует ни плитку, ни «не удалось загрузить».
 */
export interface MissionControlData {
  generatedAt: string;
  seesMoney: boolean;
  modulesOff: PultModuleId[];
  hero: McSection<McHero>;
  firstLine?: McSection<McFirstLine>;
  team?: McSection<McTeam>;
  calls?: McSection<McCalls>;
  bot?: McSection<McBot>;
  marketing?: McSection<McMarketing>;
  video?: McSection<McVideo>;
  properties?: McSection<McProperties>;
  system?: McSection<McSystem>;
  leaderboard?: McSection<McLeaderboard>;
  clientsZone?: McSection<McClientsZone>;
  /** Только при finance.view — без права ключа в ответе нет вовсе. */
  commission12?: McSection<McCommission12>;
}

type McEnvelope = Pick<MissionControlData, "generatedAt" | "seesMoney" | "modulesOff">;
export type McLive = McEnvelope & Pick<MissionControlData, "hero" | "firstLine" | "calls">;
type McZones = McEnvelope &
  Pick<
    MissionControlData,
    "team" | "bot" | "marketing" | "video" | "properties" | "system" | "leaderboard" | "clientsZone" | "commission12"
  >;

/**
 * Два темпа опроса (аудит 02.09.2026 §2 п.2): живое — герой-строка, первая линия,
 * звонки — раз в 15 с; зоны по сферам — раз в 60 с (портфель объектов и воронка
 * не меняются каждые пятнадцать секунд, а стоят базе тысяч строк). Отдельного
 * WebSocket-сервера в системе нет, при нашем масштабе это неотличимо от «живого».
 * Экран получает один объект, как раньше: live поверх zones. `enabled` — право
 * dashboard.analytics, чтобы не долбить 403 у тех, кому сюда нельзя.
 * Ключ ["mission-control"] у обоих запросов — сброс из настроек модулей
 * (usePultModules) перечитывает оба одним invalidateQueries.
 */
export function useMissionControlLive(enabled = true) {
  return useQuery({
    queryKey: ["mission-control", "live"],
    queryFn: () => api<McLive>("/dashboard/mission-control/live"),
    enabled,
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (12.09.2026). Свежесть держит поток
    // событий (lib/liveEvents.ts): сервер сам говорит, что обновилось.
    // Таймер оставлен на случай, когда поток не дошёл — прокси срезал
    // соединение, телефон спал, флаг LIVE_EVENTS=0, — поэтому он редкий,
    // а не выключенный.
    refetchInterval: enabled ? 120_000 : false,
  });
}

const LIVE_SECTIONS: ReadonlySet<string> = new Set(["hero", "firstLine", "calls"]);

export function useMissionControl(enabled = true) {
  const live = useMissionControlLive(enabled);
  const zones = useQuery({
    queryKey: ["mission-control", "zones"],
    queryFn: () => api<McZones>("/dashboard/mission-control/zones"),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
  });
  const data: MissionControlData | undefined = useMemo(
    () => (live.data && zones.data ? { ...zones.data, ...live.data } : undefined),
    [live.data, zones.data]
  );
  return {
    data,
    isLoading: live.isLoading || zones.isLoading,
    isError: live.isError || zones.isError,
    error: live.error ?? zones.error,
    dataUpdatedAt: Math.max(live.dataUpdatedAt, zones.dataUpdatedAt),
    /** Идёт обновление любого из двух опросов — этим кольцо пульта решает,
     *  дышать ореолу или нет (движение конечно: ровно на время запроса). */
    isFetching: live.isFetching || zones.isFetching,
    refetch: () => Promise.allSettled([live.refetch(), zones.refetch()]),
    /** Перезапросить только тот опрос, в котором лежит секция: герой, первая линия и звонки — «живой», остальное — зоны. */
    refetchSection: (key: string) => Promise.allSettled([LIVE_SECTIONS.has(key) ? live.refetch() : zones.refetch()]),
  };
}

export interface McTickerItem {
  id: string;
  kind: "audit" | "interaction" | "lead";
  createdAt: string;
  text: string;
  href: string | null;
}
export interface McTickerPage {
  items: McTickerItem[];
  nextCursor: string | null;
}

/**
 * Живой тикер (Ярус 4, план §6 п.6) — отдельный от основного экрана опрос,
 * реже (25с, см. обоснование в routes/dashboardMissionControl.ts): три
 * источника на каждый тик дороже остальных секций mission-control.
 */
export function useMissionControlTicker(enabled = true) {
  return useQuery({
    queryKey: ["mission-control-ticker"],
    queryFn: () => api<McTickerPage>("/dashboard/mission-control/ticker"),
    enabled,
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (12.09.2026). Свежесть держит поток
    // событий (lib/liveEvents.ts): сервер сам говорит, что обновилось.
    // Таймер оставлен на случай, когда поток не дошёл — прокси срезал
    // соединение, телефон спал, флаг LIVE_EVENTS=0, — поэтому он редкий,
    // а не выключенный.
    refetchInterval: enabled ? 120_000 : false,
  });
}

/**
 * «Вопрос к данным» (план §6, фаза 4, п.8) — один вопрос/ответ, без истории.
 * Мутация, а не запрос: намеренно НЕ участвует в опросе 15с основного экрана —
 * медленный или неудачный ответ модели не должен задерживать остальной дашборд
 * (routes/dashboardMissionControl.ts: POST — отдельный роут, свой таймаут внутри).
 */
export function useMissionControlAsk() {
  return useMutation({
    mutationFn: (question: string) => api<{ answer: string }>("/dashboard/mission-control/ask", { method: "POST", body: { question } }),
  });
}

/* ---------------------------------------------------------------------------
 * Строки-действия «Решить одной кнопкой» (задача L2-T6, спецификация v8 §3).
 *
 * Каждая мутация ниже отвечает ровно одному решению из
 * `components/pult/ActionInventory.ts` — метод/путь совпадает буква в букву.
 * Общий контракт: `mutationFn` возвращает `boolean` для `ActionRow.onRun`
 * (см. ActionRow.tsx — строка не переходит в «Одобрено», пока onRun не вернёт
 * true), успех инвалидирует ["mission-control"] сразу (обе секции — live и
 * zones — префикс общий), не дожидаясь опроса 15/60 с. Ошибка сети/сервера не
 * трогает состояние строки — ActionRow сам остаётся в "idle", кнопки снова
 * активны (никакого отдельного отката не нужно: оптимизма ДО ответа сервера
 * нет, строка меняется только после успешного onRun).
 * ------------------------------------------------------------------------- */

function invalidateMissionControl(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["mission-control"] });
}

/** Список сделок, ждущих одобрения директора (реальный существующий роут,
 *  не выдумка mission-control: `GET /deals?stage=PENDING_APPROVAL`, деталь
 *  задачи L2-T6 — hero.dealsInPipeline.items из L2-T3 отдаёт клиентов
 *  воронки в целом, не конкретные сделки на подпись). */
export interface McDealPendingApproval {
  id: string;
  client: { id: string; shortId: number; fullName: string };
  property: { id: string; shortId: number; title: string } | null;
  commissionAmount?: number | null;
  /** Цена продажи — приходит тому, кто видит деньги этой сделки (в том числе
   *  одобряющему без права на финансы, C15 02.10.2026). */
  soldPrice?: number | null;
  /** Валюта сделки — GET /deals уже отдаёт её (Deal.currency — скалярное поле,
   *  Prisma включает его в ответ независимо от include), просто раньше это
   *  поле не было объявлено в типе на фронте и PultActions печатал «сомони»
   *  для любой валюты. */
  currency?: Currency;
  /** Версия сделки для замка от одновременной правки (F14, 02.10.2026). */
  version?: number;
}
export function useDealsPendingApproval(enabled = true) {
  return useQuery({
    queryKey: ["deals", "pending-approval"],
    queryFn: () => api<{ items: McDealPendingApproval[] } | McDealPendingApproval[]>("/deals?stage=PENDING_APPROVAL"),
    enabled,
    select: (data) => (Array.isArray(data) ? data : data.items),
    staleTime: 10_000,
  });
}

/**
 * Тело одобрения сделки. С версией сервер отвечает 409, если сделку успели
 * поменять, пока директор смотрел на пульт (F14, 02.10.2026): без неё замок
 * от одновременной правки на этом пути не работал.
 */
export function approveDealBody(version: number | undefined): { stage: "COMPLETED"; version?: number } {
  return version === undefined ? { stage: "COMPLETED" } : { stage: "COMPLETED", version };
}

export function useApproveDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ dealId, version }: { dealId: string; version?: number }) => {
      await api(`/deals/${dealId}`, { method: "PATCH", body: approveDealBody(version) });
      return true;
    },
    onSuccess: () => invalidateAfterDealChange(qc),
    onError: (error) => {
      // A stale optimistic version must refresh before the next approval attempt.
      if (error instanceof ApiError && error.status === 409) invalidateAfterDealChange(qc);
    },
  });
}

/** Объекты, ждущие проверки материалов (реальный роут: `GET /properties?status=PENDING_REVIEW`). */
export interface McPropertyPendingReview {
  id: string;
  shortId: number;
  title: string;
  /**
   * Фотографии объекта. Роут — обычный список объектов
   * (`routes/properties/list.ts`), и он ВСЕГДА отдавал их вместе с карточкой;
   * тип просто не объявлял поле, поэтому на пульте «Ждут вашей проверки»
   * выглядели строками без единой картинки — при том, что проверяют там
   * ровно фотографии (12.09.2026). Сервер не менялся: описан тот же ответ.
   * Поле необязательное — у объекта без фотографий массива в ответе нет.
   */
  photos?: { id: string; thumbUrl: string }[];
}
export function usePropertiesPendingReview(enabled = true) {
  return useQuery({
    queryKey: ["properties", "pending-review"],
    queryFn: () => api<{ items: McPropertyPendingReview[] } | McPropertyPendingReview[]>("/properties?status=PENDING_REVIEW"),
    enabled,
    select: (data) => (Array.isArray(data) ? data : data.items),
    staleTime: 10_000,
  });
}

/** Нет обратного эндпоинта (§3) — только «Одобрено», без «Отменить». */
/**
 * Одобряет ФОТО объекта (`material: "photos"`) — реальный роут одобряет фото и
 * видео РАЗДЕЛЬНО (`routes/properties/moderation.ts:88`, тело обязательно:
 * `{material:"photos"|"video"}`, без него — 400). «Одобрить материалы» на
 * пульте намеренно бьёт по фото — самый частый первый шаг конвейера; одобрение
 * видео отдельной строкой в инвентарь этой задачи не входит (не выдумываем
 * вторую кнопку сверх таблицы §3 спецификации, которая говорит про решение
 * одной кнопкой, а не про весь конвейер модерации).
 */
export type ReviewMaterial = "photos" | "video";

function invalidateAfterPropertyReview(qc: ReturnType<typeof useQueryClient>) {
  invalidateMissionControl(qc);
  void qc.invalidateQueries({ queryKey: ["properties"] });
  void qc.invalidateQueries({ queryKey: ["property"] });
}

export function useApprovePropertyMaterials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (arg: string | { propertyId: string; material?: ReviewMaterial }) => {
      const { propertyId, material = "photos" } = typeof arg === "string" ? { propertyId: arg } : arg;
      await api(`/properties/${propertyId}/review/approve`, { method: "POST", body: { material } });
      return true;
    },
    onSuccess: () => invalidateAfterPropertyReview(qc),
  });
}

/** «Вернуть с причиной»: POST /properties/:id/review/reject (причина обязательна на сервере). */
export function useRejectPropertyMaterials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ propertyId, material, reason }: { propertyId: string; material: ReviewMaterial; reason: string }) => {
      await api(`/properties/${propertyId}/review/reject`, { method: "POST", body: { material, reason: reason.trim() } });
      return true;
    },
    onSuccess: () => invalidateAfterPropertyReview(qc),
  });
}

/** «Закрыть все ошибки системы» — массовое действие, без отмены (§3). */
export function useResolveAllSystemErrors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (scope: "today" | "all" = "today") => {
      // По умолчанию только сегодняшние — ровно те, что пульт посчитал (аудит 23.09.2026, №56).
      // «all» — когда сервер прислал общее число нерешённых и директор видел именно его.
      await api("/errors/resolve-all", { method: "POST", body: { scope } });
      return true;
    },
    onSuccess: () => invalidateMissionControl(qc),
  });
}

/**
 * Что гасить после передачи клиента (F14, 02.10.2026). Передача идёт с пульта,
 * экрана клиентов и телефона, а гасила только пульт — строка «ждёт агента…
 * Передать» в списке клиентов и открытая карточка висели до живого события.
 */
export function invalidateAfterClientTransfer(qc: Pick<ReturnType<typeof useQueryClient>, "invalidateQueries">) {
  void qc.invalidateQueries({ queryKey: ["mission-control"] });
  void qc.invalidateQueries({ queryKey: ["clients"] });
  void qc.invalidateQueries({ queryKey: ["client"] });
}

/** Передать зависшего клиента наименее загруженному агенту (§3 «Передать»).
 *  Для отмены запоминаем прежнего агента ДО назначения (assign не отдаёт его сам). */
export function useTransferClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ clientId, toAgentId }: { clientId: string; toAgentId: string }) => {
      await api(`/clients/${clientId}/assign`, { method: "POST", body: { agentId: toAgentId } });
      return true;
    },
    onSuccess: () => invalidateAfterClientTransfer(qc),
  });
}
export function useUndoTransferClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, toAgentId }: { clientId: string; toAgentId: string }) =>
      api(`/clients/${clientId}/assign`, { method: "POST", body: { agentId: toAgentId } }),
    onSuccess: () => invalidateAfterClientTransfer(qc),
  });
}

/** Адрес решения по заявке: клиентские и объектные заявки живут в разных роутерах. */
export function deleteRequestPath(kind: "CLIENT" | "PROPERTY", id: string, decision: "approve" | "reject"): string {
  return `/${kind === "CLIENT" ? "clients" : "properties"}/delete-requests/${id}/${decision}`;
}

/** Отказ без причины сервер не принимает (decisionNote обязателен), одобрение идёт с пустым телом. */
export function deleteRequestBody(decision: "approve" | "reject", note?: string): { decisionNote?: string } {
  return decision === "reject" ? { decisionNote: (note ?? "").trim() } : {};
}

/** Заявка агента на удаление клиента/объекта: решает руководство (clients.delete / properties.delete). */
export function useDeleteRequestDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, id, decision, note }: { kind: "CLIENT" | "PROPERTY"; id: string; decision: "approve" | "reject"; note?: string }) => {
      await api(deleteRequestPath(kind, id, decision), { method: "POST", body: deleteRequestBody(decision, note) });
      return true;
    },
    onSuccess: () => {
      invalidateMissionControl(qc);
      void qc.invalidateQueries({ queryKey: ["clients"] });
      void qc.invalidateQueries({ queryKey: ["properties"] });
    },
  });
}

/** «Просят перезвонить»: очередь GET /me/callback-requests (право messages.view). */
export function useCallbackRequests(enabled = true) {
  return useQuery({
    queryKey: ["callback-requests", "pult"],
    queryFn: () => api<{ items: CallbackRequestView[] }>("/me/callback-requests"),
    enabled,
    select: (data) => data.items,
    staleTime: 20_000,
  });
}

/** «Готово» у просьбы о звонке; для управляемой просьбы сервер требует ревизию. */
export function useCallbackDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: Pick<CallbackRequestView, "id" | "lifecycleRevision">) => {
      await api(`/me/callback-requests/${item.id}/done`, { method: "POST", body: item.lifecycleRevision ? { expectedRevision: item.lifecycleRevision } : {} });
      return true;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["callback-requests"] });
      invalidateMissionControl(qc);
    },
  });
}
