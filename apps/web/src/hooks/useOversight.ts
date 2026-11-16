import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Paginated, AgentRef } from "../types";
import type { ClientStatus, RefusalReason } from "@royal-home/shared";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

/** «Контроль руководителя» — экран /oversight (routes/oversight.ts на сервере). */

export interface OversightSummary {
  overdueTasks: number;
  staleHotClients: number;
  recentTransfers: number;
  /** Красные флаги (антифрод, мозговой штурм владельца 20-21.08.2026). */
  silentAfterShowing: number;
  silentAfterShowingDays: number;
  refusedHighScore: number;
  sellerPropertyMissingWarn: number;
  sellerPropertyMissingCritical: number;
  sellerPropertyMissingWarnDays: number;
  sellerPropertyMissingCriticalDays: number;
  /** «Вечные переговоры» / «Серия у одного агента» (владелец 01.09.2026). */
  endlessNegotiations: number;
  sellerNegotiationMaxRounds: number;
  agentLossSeries: number;
  agentLossSeriesThreshold: number;
  agentLossSeriesWindowDays: number;
  recentWindowDays: number;
}

interface ClientRef {
  id: string;
  shortId: number;
  fullName: string;
}

export interface OverdueTaskRow {
  id: string;
  notes: string;
  nextAction: string | null;
  nextActionDate: string | null;
  client: ClientRef;
  agent: AgentRef;
}

export interface StalledClientRow {
  id: string;
  shortId: number;
  fullName: string;
  status: ClientStatus;
  aiScore: number | null;
  aiScoreReason: string | null;
  lastContactAt: string;
  assignedAgent: AgentRef | null;
}

export interface EventLogRow {
  id: string;
  notes: string;
  createdAt: string;
  client: ClientRef;
  agent: AgentRef;
}

export function useOversightSummary(enabled = true) {
  return useQuery({
    queryKey: ["oversight", "summary"],
    queryFn: () => api<OversightSummary>("/oversight/summary"),
    enabled,
    // Без своего интервала наследует глобальные 25 с (lib/queryClient.ts) — а
    // вызывается этот хук из lib/navigation.ts (счётчик в меню, рендерится на
    // КАЖДОМ экране у DIRECTOR/ADMIN/MANAGER), гоняя самый тяжёлый запрос CRM
    // (11 детекторов) на каждой странице каждые 25 с (найдено аудитом
    // 02.09.2026, docs/audit-02-09-2026/06-dashboard.md). Это счётчик-бейдж, а
    // не живые данные — 60 с достаточно, тот же интервал, что у других бейджей
    // (useCounters.ts, useMe.ts).
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (13.09.2026). Свежесть держит поток событий
    // (lib/liveEvents.ts), таймер оставлен на случай, когда поток не дошёл.
    refetchInterval: 300_000,
  });
}

export function useOverdueTasks(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "overdue-tasks", page],
    queryFn: () => api<Paginated<OverdueTaskRow>>(`/oversight/overdue-tasks?page=${page}`),
    enabled,
  });
}

export function useStalledClients(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "stalled-clients", page],
    queryFn: () => api<Paginated<StalledClientRow>>(`/oversight/stalled-clients?page=${page}`),
    enabled,
  });
}

export function useLeadTransfers(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "lead-transfers", page],
    queryFn: () => api<Paginated<EventLogRow>>(`/oversight/lead-transfers?page=${page}`),
    enabled,
  });
}

/** Красный флаг «Тишина после показа» (антифрод, мозговой штурм владельца
 *  20-21.08.2026): показ проведён, а после — ни одного касания через CRM. */
export interface SilentAfterShowingRow {
  id: string;
  shortId: number;
  fullName: string;
  lastContactAt: string;
  assignedAgent: AgentRef | null;
}

export function useSilentAfterShowing(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "silent-after-showing", page],
    queryFn: () => api<Paginated<SilentAfterShowingRow> & { days: number }>(`/oversight/silent-after-showing?page=${page}`),
    enabled,
  });
}

/** Красный флаг «Отказ при хорошем скоринге»: клиент отказался, пока ИИ-скоринг
 *  был высоким, а служба безопасности карточку ещё не увидела. */
export interface RefusedHighScoreRow {
  id: string;
  createdAt: string;
  agent: AgentRef;
  client: {
    id: string;
    shortId: number;
    fullName: string;
    status: ClientStatus;
    aiScore: number | null;
    aiScoreReason: string | null;
    refusalReason: RefusalReason | null;
    securityReview: string | null;
  };
}

export function useRefusedHighScore(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "refused-high-score", page],
    queryFn: () =>
      api<Paginated<RefusedHighScoreRow> & { threshold: number; windowDays: number }>(
        `/oversight/refused-high-score?page=${page}`
      ),
    enabled,
  });
}

/** Красный флаг «Маршруты передач между агентами»: топ-10 пар «от кого → кому»
 *  за 30 дней — просто список для глаз руководителя, без автоматических выводов. */
export interface TransferPair {
  from: AgentRef;
  to: AgentRef;
  count: number;
  frequent: boolean;
}

export function useTransferPairs(enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "transfer-pairs"],
    queryFn: () => api<{ pairs: TransferPair[]; windowDays: number; frequentThreshold: number }>("/oversight/transfer-pairs"),
    enabled,
  });
}

/** Жёлтый/красный флаг «Продавец без объекта» (см. lib/sellerPropertyMissingAntifraud.ts
 *  на сервере): продавец принят в работу, а карточки объекта всё ещё нет. */
export interface SellerPropertyMissingRow {
  id: string;
  shortId: number;
  fullName: string;
  propertyAcceptedAt: string;
  daysSince: number;
  level: "WARN" | "CRITICAL";
  assignedAgent: AgentRef | null;
  securityReview: "PENDING" | "CLEARED" | "CONFIRMED" | null;
}

export function useSellerPropertyMissing(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "seller-property-missing", page],
    queryFn: () =>
      api<Paginated<SellerPropertyMissingRow> & { warnDays: number; criticalDays: number }>(
        `/oversight/seller-property-missing?page=${page}`
      ),
    enabled,
  });
}

/** Красный флаг «Вечные переговоры» (владелец 01.09.2026): ветка «Переговоры»
 *  окна «Итог приёмки» повторилась подряд Settings.sellerNegotiationMaxRounds
 *  раз без выхода в другую ветку — см. findEndlessNegotiations на сервере. */
export interface EndlessNegotiationRow {
  id: string;
  subjectName: string;
  dueAt: string;
  rounds: number;
  agent: AgentRef;
  client: { id: string; shortId: number; fullName: string };
}

export function useEndlessNegotiations(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "endless-negotiations", page],
    queryFn: () =>
      api<Paginated<EndlessNegotiationRow> & { maxRounds: number }>(`/oversight/endless-negotiations?page=${page}`),
    enabled,
  });
}

/** Красный флаг «Серия у одного агента» (владелец 01.09.2026): 3+ переводов в
 *  «Неактивные» ИЛИ прямых потерь у ОДНОГО агента за 7 дней — см.
 *  findAgentLossSeries на сервере. Список короткий (штат агентов), без пагинации. */
export interface AgentLossSeriesRow {
  agentId: string;
  agentName: string;
  avatarUrl: string | null;
  count: number;
}

export function useAgentLossSeries(enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "agent-loss-series"],
    queryFn: () =>
      api<{ items: AgentLossSeriesRow[]; threshold: number; windowDays: number }>("/oversight/agent-loss-series"),
    enabled,
  });
}

/**
 * ЗВОНКИ-ОПРОСЫ ПОСЛЕ ПОКАЗА (антифрод, владелец 13.09.2026) — экран для
 * директора: результат каждого звонка, включая те, где находок не было. До сих
 * пор это было видно только пуш-уведомлением при найденном флаге.
 *
 * Источник с 17.09.2026 — единственный механизм опроса (`PostShowingCall`,
 * lib/postShowingCallFeed.ts на сервере). Путь и форма ответа те же, что были,
 * плюс новые необязательные поля исхода и цитаты.
 */
export interface ShowingSurveyCallRow {
  id: string;
  agent: AgentRef | null;
  client: { id: string; shortId: number; fullName: string } | null;
  property: { id: string; shortId: number; title: string } | null;
  calledAt: string | null;
  createdAt: string;
  transcriptPreview: string | null;
  hasRecording: boolean;
  redFlags: { category: string; detail: string }[];
  escalatedAt: string | null;
  /** Исход разбора разговора и дословная фраза клиента (17.09.2026). Приходят с
   *  сервера начиная с этой даты; у звонков, разобранных раньше, пусто. */
  outcome?: string | null;
  outcomeLabel?: string | null;
  quote?: string | null;
  summary?: string | null;
}

export function useShowingSurveyCalls(page: number, onlyFlagged: boolean, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["oversight", "showing-survey-calls", page, onlyFlagged],
    queryFn: () =>
      api<Paginated<ShowingSurveyCallRow>>(
        `/oversight/showing-survey-calls?page=${page}${onlyFlagged ? "&onlyFlagged=1" : ""}`
      ),
    enabled,
  });
}

export interface ShowingSurveyCallDetail extends Omit<ShowingSurveyCallRow, "transcriptPreview"> {
  transcript: string | null;
}

export function useShowingSurveyCall(id: string | null) {
  return useQuery({
    queryKey: ["oversight", "showing-survey-calls", "detail", id],
    queryFn: () => api<ShowingSurveyCallDetail>(`/oversight/showing-survey-calls/${id}`),
    enabled: !!id,
  });
}

export function useShowingSurveyRecordingUrl() {
  return useMutation({
    mutationFn: (id: string) => api<{ url: string }>(`/oversight/showing-survey-calls/${id}/recording`),
    meta: { silent: true },
  });
}

