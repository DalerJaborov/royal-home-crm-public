import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DemandSupplyResponse, ResponseSpeedResponse } from "@royal-home/shared";
import { api } from "../lib/api";

/** Выгрузка объектов (CSV/JSON) — общая для десктопных и мобильных «Отчётов»:
 *  логика скачивания блоба одна, копия в каждом экране разъезжалась бы. */
export async function downloadPropertiesExport(format: "csv" | "json") {
  const blob = await api<Blob>(`/properties/export?format=${format}`, { responseType: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `royal-home-properties.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** null — у смотрящего нет права на финансы (аудит 23.09.2026, №44). */
  commission?: number | null;
}

export function useFunnelReport(range: { from?: string; to?: string }, enabled = true) {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  return useQuery({
    queryKey: ["report-funnel", range],
    queryFn: () => api<{ from: string; to: string; funnel: FunnelStage[] }>(`/reports/funnel?${params}`),
    enabled,
    // Данные месячные: глобальный опрос раз в 25 секунд гонял бы тяжёлый
    // запрос впустую на каждой открытой вкладке.
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

export interface AgentReportRow {
  agentId: string;
  agentName: string;
  /** false — агент уже не работает, но в периоде у него есть сделки (C17). */
  isActive?: boolean;
  avatarUrl?: string | null;
  showings: number;
  dealsClosed: number;
  /** null — у смотрящего нет права на финансы (аудит 23.09.2026, №44). */
  commission: number | null;
}

export function useAgentsReport(range: { from?: string; to?: string }, enabled = true) {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  return useQuery({
    queryKey: ["report-agents", range],
    queryFn: () => api<AgentReportRow[]>(`/reports/agents?${params}`),
    enabled,
    // Данные месячные: глобальный опрос раз в 25 секунд гонял бы тяжёлый
    // запрос впустую на каждой открытой вкладке.
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

export interface SourcesReport {
  /** wrote — сколько человек НАПИСАЛО в канал (не только дошедших до заявки).
   *  0 у непереписочных источников: у сайта и звонка «написал» и «оставил заявку»
   *  это одно событие. */
  sources: { source: string; total: number; closed: number; wrote: number }[];
  avgDaysNewToClosed: number | null;
}

export function useSourcesReport(range: { from?: string; to?: string }, enabled = true) {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  return useQuery({
    queryKey: ["report-sources", range],
    queryFn: () => api<SourcesReport>(`/reports/sources?${params}`),
    enabled,
    // Данные месячные: глобальный опрос раз в 25 секунд гонял бы тяжёлый
    // запрос впустую на каждой открытой вкладке.
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

/** Один канал полной воронки маркетинга — то же, что apps/api/src/lib/marketingFunnel.ts::ChannelFunnel. */
export interface MarketingFunnelChannel {
  source: string;
  label: string;
  leadsMonth: number;
  showingsMonth: number;
  dealsClosedMonth: number;
  /** null — у смотрящего нет finance.view, деньги не отдаются вовсе. */
  spendMonthTjs: number | null;
  commissionMonthTjs: number | null;
  costPerLeadTjs: number | null;
  leadsToday: number;
  leadsTrailing7Avg: number;
  anomalyLeadsDown: boolean;
}

export interface MarketingFunnelReport {
  month: string;
  channels: MarketingFunnelChannel[];
}

/**
 * Полная воронка расход→лиды→показы→сделки→комиссия по каналу (01.09.2026) —
 * тот же builder, что в mission-control (там урезан до топ-3 каналов и 4 полей
 * с явным комментарием «полная воронка — в /sources»), здесь без урезания.
 * Месяц — всегда текущий календарный (Душанбе), диапазон дат не запрашивает.
 */
export function useMarketingFunnel(enabled = true) {
  return useQuery({
    queryKey: ["report-marketing-funnel"],
    queryFn: () => api<MarketingFunnelReport>("/reports/marketing-funnel"),
    enabled,
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LostByChannel {
  source: string;
  label: string;
  lost: number;
  totalLeads: number;
  /** null — за период не было ни одного лида этим каналом, доля не считается. */
  lostShare: number | null;
  topReason: string | null;
}

/** «Где теряем клиентов», по каналу за 90 дней (01.09.2026) — см. reports.ts. */
export function useLostByChannel(enabled = true) {
  return useQuery({
    queryKey: ["report-lost-by-channel"],
    queryFn: () => api<{ days: number; channels: LostByChannel[] }>("/reports/lost-by-channel"),
    enabled,
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

export interface WaitingNowChannel {
  source: string;
  label: string;
  waiting: number;
  longestMinutes: number;
}

/** «Сейчас ждут ответа», по каналу — живой снимок, не история (01.09.2026). */
export function useWaitingNow(enabled = true) {
  return useQuery({
    queryKey: ["report-waiting-now"],
    queryFn: () => api<{ channels: WaitingNowChannel[]; totalWaiting: number }>("/reports/waiting-now"),
    enabled,
    // Живые данные — опрашиваем чаще, чем месячные срезы, но не агрессивно:
    // это фоновая плитка на экране отчётов, а не рабочий инбокс.
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (13.09.2026). Свежесть держит поток событий
    // (lib/liveEvents.ts), таймер оставлен на случай, когда поток не дошёл.
    refetchInterval: 300_000,
    staleTime: 30_000,
  });
}

export interface MarketingInsights {
  headline: string | null;
  insights: string[];
  builtAt?: string;
  cached?: boolean;
}

/** ИИ-разбор маркетинга — headline + 3-5 наблюдений по воронке/потерям/очереди/
 *  возражениям (01.09.2026). Кэш на бэке 6ч; force пересобирает сейчас. */
export function useMarketingInsights(enabled = true) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["report-marketing-insights"],
    queryFn: () => api<MarketingInsights>("/reports/marketing-insights"),
    enabled,
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
  const refresh = useMutation({
    mutationFn: () => api<MarketingInsights>("/reports/marketing-insights?force=1"),
    onSuccess: (data) => qc.setQueryData(["report-marketing-insights"], data),
  });
  return { ...query, refresh };
}

/** Объект, которым интересуются прямо сейчас (GET /reports/hot-properties). */
export interface HotPropertyRow {
  propertyId: string;
  shortId: number;
  title: string;
  districtName: string | null;
  price: number;
  /** Сумма весов сигналов интереса за окно. */
  score: number;
  events: number;
  /** Сколько разных людей проявили интерес. */
  people: number;
}

/**
 * «Горячие объекты» (28.09.2026): сервер считает с 09.09.2026 (владелец: «каким
 * объектом интересуются больше всего, чтобы запустить его на таргетинг»), а
 * экрана не было. Окно — 7 или 30 дней, в выдаче только объекты в продаже.
 */
export function useHotProperties(days: 7 | 30, enabled = true) {
  return useQuery({
    queryKey: ["report-hot-properties", days],
    queryFn: () => api<{ days: number; items: HotPropertyRow[] }>(`/reports/hot-properties?days=${days}&limit=10`),
    enabled,
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * «Спрос и предложение» (03.10.2026): матрица район × комнаты по ждущим покупателям
 * и квартирам в продаже. Срез «на сейчас», поэтому без периода и без частых опросов.
 */
export function useDemandSupply(enabled = true) {
  return useQuery({
    queryKey: ["report-demand-supply"],
    queryFn: () => api<DemandSupplyResponse>("/reports/demand-supply?unsoughtLimit=10"),
    enabled,
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

/** «Скорость ответа против показа» (03.10.2026): корзины времени до первого ответа агента за 90 дней. */
export function useResponseSpeed(enabled = true) {
  return useQuery({
    queryKey: ["report-response-speed"],
    queryFn: () => api<ResponseSpeedResponse>("/reports/response-speed?days=90"),
    enabled,
    refetchInterval: false as const,
    staleTime: 10 * 60 * 1000,
  });
}
