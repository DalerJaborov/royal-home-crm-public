import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Interaction, Property } from "../types";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

export interface DashboardSummary {
  kpis: {
    availableProperties: number;
    hotClients: number;
    showingsWeek: number;
    commissionMonth: number;
    commissionPlan: number;
    /**
     * Чья комиссия в `commissionMonth`: «own» — своя (агент), «company» — всего
     * агентства. План месяца при этом всегда общий: личных планов в CRM нет.
     * От этого зависит подпись, а не числа — см. routes/dashboard.ts.
     */
    commissionScope: "own" | "company";
    /** Стоимость всего, что сейчас в продаже, в сомони. */
    portfolioValue: number;
    /** Комиссия компании с этого портфеля, если всё продастся по текущим ценам. */
    potentialCommission: number;
  };
  funnel: { key: string; label: string; count: number; commission?: number }[];
  /** Только у агента: сколько лидов у него в работе и лимит, после которого новые не назначаются. */
  activeLeadLoad?: { count: number; limit: number };
  tasksToday: Interaction[];
  /** Принятые карточки этого агента, по которым срок первого звонка ещё не
   *  закрыт (задание 17.09.2026) — сортировано по dueAt, самая срочная первой.
   *  Пусто у руководства и когда непрозвоненных карточек нет. */
  firstCallDue: { id: string; shortId: number; fullName: string; phone: string; dueAt: string }[];
  /** Клиенты, которых руководитель сам назначил этому агенту (принятые сразу) и
   *  с которыми он ещё не связался — не дольше трёх суток (владелец 23.09.2026).
   *  Необязательное: старый сервер поля не присылает. */
  assignedBySupervisor?: { id: string; shortId: number; fullName: string; phone: string; assignedAt: string; byName: string | null }[];
  recentActivity: Interaction[];
  topProperties: Property[];
  districtBreakdown: { district: string; count: number; pricePerSqm: number | null }[];
}

/**
 * live — режим живой панели: экран сам подтягивает свежие данные раз в 20 секунд
 * и при возврате во вкладку. Классический дашборд вызывает без аргумента и, как
 * и раньше, обновляется только при заходе на страницу.
 *
 * Почему опрос, а не постоянное соединение: при потоке в десятки лидов в день
 * разница между «мгновенно» и «в течение двадцати секунд» человеку незаметна,
 * а соединение через прокси добавляет целый класс новых поломок — обрывы,
 * буферизация, переподключения. Если 20 секунд окажется мало, поверх этого
 * ставится push, ничего не переписывая.
 */
export function useDashboardSummary(live = false) {
  return useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => api<DashboardSummary>("/dashboard/summary"),
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (12.09.2026). Свежесть держит поток
    // событий (lib/liveEvents.ts): сервер сам говорит, что обновилось.
    // Таймер оставлен на случай, когда поток не дошёл — прокси срезал
    // соединение, телефон спал, флаг LIVE_EVENTS=0, — поэтому он редкий,
    // а не выключенный.
    refetchInterval: live ? 120_000 : false,
    refetchOnWindowFocus: live,
  });
}

/** Слабое звено недели: у какого агента какая категория Royal Score просела. */
export interface WeakLinkInsight {
  agentId: string;
  agentName: string;
  category: string;
  categoryLabel: string;
  sum: number;
}

/** Где застревают клиенты: сколько их на стадии и сколько в среднем висят. */
export interface StalledStageInsight {
  status: string;
  label: string;
  count: number;
  avgAgeHours: number;
}

/** Прогноз плана комиссии к концу месяца при текущем темпе. */
export interface PlanForecastInsight {
  commissionMonth: number;
  plan: number;
  forecastEndOfMonth: number;
  forecastPercent: number;
  daysElapsed: number;
  daysInMonth: number;
}

/** Нагрузка: сколько активных клиентов у каждого агента. */
export interface WorkloadInsight {
  agentId: string;
  agentName: string;
  activeClients: number;
}

export interface DashboardInsights {
  weakLink: WeakLinkInsight | null;
  stalledStages: StalledStageInsight[];
  /** null без права finance.view: прогноз плана — деньги компании. */
  planForecast: PlanForecastInsight | null;
  workload: WorkloadInsight[];
}

/**
 * Четыре директорских инсайта: слабое звено недели, где застревают клиенты,
 * прогноз плана и нагрузка агентов.
 *
 * Сервер считает их с 05.08.2026, а фронт не вызывал этот эндпоинт НИ РАЗУ
 * (совет экспертов 26.08, пункт 10: «довезти готовое до экрана») — оплаченная
 * разработкой ценность лежала мёртвой. Право то же, что у эндпоинта
 * (dashboard.analytics): вызывающий экран сам решает, показывать ли блок.
 */
export function useDashboardInsights(enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["dashboard-insights"],
    queryFn: () => api<DashboardInsights>("/dashboard/insights"),
    enabled,
    staleTime: 60_000,
  });
}
