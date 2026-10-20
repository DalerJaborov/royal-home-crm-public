import { useQuery } from "@tanstack/react-query";
import type { ClientSource, PropertyStatus } from "@royal-home/shared";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

export interface DashboardCharts {
  // commission — null без права finance.view (сервер закрывает деньги компании).
  commissionByMonth: { month: string; commission: number | null; deals: number }[];
  sourcesThisMonth: { source: ClientSource; count: number }[];
  // byType уже приходит с API (dashboardRouter «/charts»), но в веб-типе раньше
  // не был объявлен — мобильной «Неделе в цифрах» нужна разбивка (показы отдельно
  // от прочих обращений), а не только общий count.
  pulse: { date: string; count: number; byType?: Record<string, number> }[];
  propertiesByMonth: { month: string; added: number; sold: number }[];
  propertiesByStatus: { status: PropertyStatus; count: number }[];
}

export function useDashboardCharts(enabled = true, live = false) {
  return useQuery({
    queryKey: ["dashboard-charts"],
    queryFn: () => api<DashboardCharts>("/dashboard/charts"),
    enabled,
    // Графики меняются медленнее сводки — опрашиваем реже, чтобы не гонять
    // тяжёлый запрос впустую.
    staleTime: live ? 30_000 : 60_000,
    refetchInterval: live ? 60_000 : false,
    refetchOnWindowFocus: live,
  });
}

export type HeatmapSignal = "all" | "calls" | "comments" | "chats" | "contacts" | "followers" | "site";
export type HeatmapChannel = "ALL" | "INSTAGRAM" | "FACEBOOK" | "WHATSAPP" | "TELEGRAM" | "WEBSITE" | "PHONE";

export interface DashboardHeatmap {
  /** Час — настоящий час 0-23 по Душанбе; в две колонки их сводит сама карта. */
  cells: { dow: number; hour: number; count: number }[];
  days: number;
  /** На сколько часов раньше всплеска ставить публикацию — из Настроек, то же
   *  число, по которому расставляются ролики. */
  leadHours: number;
  signal: HeatmapSignal;
  channel: HeatmapChannel;
  /** Какие каналы осмысленны для выбранного сигнала — считает сервер. */
  channels: HeatmapChannel[];
  total: number;
  peak: { dow: number; hour: number; count: number } | null;
  liveliestHours: number[];
  publishHours: number[];
}

/** Тепловая карта активности (GET /dashboard/heatmap) — отдельный запрос от
 *  /dashboard/charts: считается за 90 дней (или сколько задано в Настройках) сырым SQL, тяжелее и меняется ещё
 *  медленнее графиков месяца, гонять его вместе с ними на каждый чих незачем.
 *  Срез входит в ключ запроса — иначе переключение канала отдавало бы
 *  прошлый ответ из кэша. */
/** Активность по каналам рядом (GET /dashboard/heatmap/channels, 24.09.2026):
 *  тот же сигнал, что у карты, по каждому каналу — сколько, куда движется,
 *  по часам суток, свой лучший час. */
export interface ChannelActivity {
  channel: Exclude<HeatmapChannel, "ALL">;
  total: number;
  previousTotal: number;
  byHour: number[];
  byDow: number[];
  liveliestHours: number[];
  publishHours: number[];
  busiestDow: number | null;
}

export interface DashboardHeatmapChannels {
  signal: HeatmapSignal;
  days: number;
  leadHours: number;
  channels: ChannelActivity[];
}

export function useDashboardHeatmapChannels(enabled = true, signal: HeatmapSignal = "all") {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["dashboard-heatmap-channels", signal],
    queryFn: () => api<DashboardHeatmapChannels>(`/dashboard/heatmap/channels?signal=${signal}`),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useDashboardHeatmap(enabled = true, signal: HeatmapSignal = "all", channel: HeatmapChannel = "ALL") {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["dashboard-heatmap", signal, channel],
    queryFn: () => api<DashboardHeatmap>(`/dashboard/heatmap?signal=${signal}&channel=${channel}`),
    enabled,
    staleTime: 5 * 60_000,
  });
}
