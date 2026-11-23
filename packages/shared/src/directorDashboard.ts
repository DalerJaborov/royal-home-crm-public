import { z } from "zod";
import { CLIENT_SOURCES } from "./enums.js";

/**
 * ДАШБОРД ДИРЕКТОРА (ТЗ владельца, 21.11.2026) — договор между сервером
 * (GET /api/v1/reports/director, /director/drill, /director/export.xlsx) и экраном.
 *
 * Деньги (комиссия, план) — null без права finance.view: null значит «не положено
 * видеть», а не «ноль». Даты — ISO-строки в UTC; границы суток считаются по Душанбе.
 */

export const DIRECTOR_PERIOD_PRESETS = ["day", "week", "month", "quarter", "year", "custom"] as const;
export type DirectorPeriodPreset = (typeof DIRECTOR_PERIOD_PRESETS)[number];

/** Плитки KPI в порядке показа. */
export const DIRECTOR_KPI_KEYS = [
  "newLeads",
  "contacted",
  "noContact",
  "showings",
  "meetings",
  "negotiations",
  "deals",
  "revenue",
] as const;
export type DirectorKpiKey = (typeof DIRECTOR_KPI_KEYS)[number];

/**
 * Что можно открыть списком. Сумма записей списка за тот же период и фильтры
 * равна цифре плитки (критерий приёмки ТЗ №1). У «Выручки» список — сделки ("deals").
 */
export const DIRECTOR_DRILL_KEYS = [
  "newLeads",
  "contacted",
  "noContact",
  "showings",
  "meetings",
  "negotiations",
  "deals",
  "overdueTasks",
  "lost",
] as const;
export type DirectorDrillKey = (typeof DIRECTOR_DRILL_KEYS)[number];

export const DIRECTOR_CLIENT_KINDS = ["BUYER", "SELLER"] as const;

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Дата в формате ГГГГ-ММ-ДД");

/** Фильтры дашборда — общие для сводки, списка и выгрузки. */
export const directorDashboardQuerySchema = z.object({
  preset: z.enum(DIRECTOR_PERIOD_PRESETS).default("month"),
  /** Только для preset=custom (иначе игнорируются): включительно, по Душанбе. */
  from: ymd.optional(),
  to: ymd.optional(),
  agentId: z.string().min(1).max(64).optional(),
  source: z.enum(CLIENT_SOURCES).optional(),
  kind: z.enum(DIRECTOR_CLIENT_KINDS).optional(),
});
export type DirectorDashboardQuery = z.infer<typeof directorDashboardQuerySchema>;

export const directorDrillQuerySchema = directorDashboardQuerySchema.extend({
  key: z.enum(DIRECTOR_DRILL_KEYS),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type DirectorDrillQuery = z.infer<typeof directorDrillQuerySchema>;

const isoDate = z.string();

export const directorPeriodSchema = z.object({
  from: isoDate,
  to: isoDate,
  preset: z.enum(DIRECTOR_PERIOD_PRESETS),
});

export const directorKpiSchema = z.object({
  key: z.enum(DIRECTOR_KPI_KEYS),
  label: z.string(),
  /** null — нет права видеть (деньги без finance.view). */
  value: z.number().nullable(),
  /** То же за предыдущий период той же длины. */
  prev: z.number().nullable(),
  unit: z.enum(["count", "tjs"]),
  /** В какую сторону изменение хорошее: «без контакта» растёт — плохо. */
  goodWhen: z.enum(["up", "down"]),
  drillKey: z.enum(DIRECTOR_DRILL_KEYS).nullable(),
});
export type DirectorKpi = z.infer<typeof directorKpiSchema>;

export const directorFunnelStepSchema = z.object({
  key: z.enum(["leads", "contacted", "showings", "negotiations", "deals"]),
  label: z.string(),
  count: z.number(),
  /** % от предыдущего шага, одна десятая; null у первого шага или при нуле в предыдущем. */
  conversionFromPrev: z.number().nullable(),
  /** % от первого шага (заявок когорты). */
  conversionFromFirst: z.number().nullable(),
});

export const directorFunnelSchema = z.object({
  /** Когорта: заявки периода и сколько ИЗ НИХ дошло до шага (шаг ≤ предыдущего). */
  method: z.literal("cohort"),
  steps: z.array(directorFunnelStepSchema),
});

export const directorLossReasonSchema = z.object({
  /** Код причины (REFUSAL_REASONS) или "NONE" — отказ без причины. */
  reason: z.string(),
  label: z.string(),
  count: z.number(),
});

export const directorSpeedSchema = z.object({
  /** Минуты от заявки до первого контакта сотрудника, по заявкам периода с контактом. */
  medianMin: z.number().nullable(),
  avgMin: z.number().nullable(),
  /** Сколько заявок периода вошло в расчёт (с первым контактом). */
  answered: z.number(),
  noContactCount: z.number(),
  noContactDrillKey: z.literal("noContact"),
  /** Открытые задачи со сроком в прошлом — на сейчас, не за период. */
  overdueTasks: z.number(),
  overdueDrillKey: z.literal("overdueTasks"),
});

export const directorAgentRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  /** Новые заявки периода, где он ответственный. */
  leads: z.number(),
  /** Из них — с которыми связались. */
  contacted: z.number(),
  calls: z.number(),
  messages: z.number(),
  meetings: z.number(),
  showings: z.number(),
  /** Закрытые сделки периода. */
  deals: z.number(),
  commission: z.number().nullable(),
  /** % сделок от его новых заявок периода; null при нуле заявок. */
  conversion: z.number().nullable(),
  overdueTasks: z.number(),
  lastActivityAt: isoDate.nullable(),
});
export type DirectorAgentRow = z.infer<typeof directorAgentRowSchema>;

export const directorSourceRowSchema = z.object({
  source: z.string(),
  label: z.string(),
  leads: z.number(),
  deals: z.number(),
  commission: z.number().nullable(),
});

export const directorPlanSchema = z.object({
  /** План комиссии на месяц из Настроек; null — не задан или нет права. */
  commissionPlan: z.number().nullable(),
  /** true — в Настройках стоит умолчание, план по сути не задан (commissionPlan тогда null). */
  planIsDefault: z.boolean(),
  fact: z.number().nullable(),
  pct: z.number().nullable(),
  left: z.number().nullable(),
  /** Месяц плана (ГГГГ-ММ) — план месячный, берётся месяц конца периода. */
  month: z.string(),
});

export const directorDashboardResponseSchema = z.object({
  period: directorPeriodSchema,
  prevPeriod: z.object({ from: isoDate, to: isoDate }),
  filters: z.object({
    agentId: z.string().nullable(),
    source: z.string().nullable(),
    kind: z.enum(DIRECTOR_CLIENT_KINDS).nullable(),
  }),
  seesMoney: z.boolean(),
  kpis: z.array(directorKpiSchema),
  funnel: directorFunnelSchema,
  lossReasons: z.array(directorLossReasonSchema),
  speed: directorSpeedSchema,
  agents: z.array(directorAgentRowSchema),
  sources: z.array(directorSourceRowSchema),
  plan: directorPlanSchema,
  updatedAt: isoDate,
  /** Сервер кэширует сводку на столько секунд. */
  cacheSeconds: z.number(),
});
export type DirectorDashboardResponse = z.infer<typeof directorDashboardResponseSchema>;

export const directorDrillItemSchema = z.object({
  /** id записи: клиента, показа/встречи (взаимодействия), сделки или задачи. */
  id: z.string(),
  entity: z.enum(["client", "interaction", "deal"]),
  clientId: z.string(),
  /** Имя клиента; без права на номера цифры номера в имени скрыты. */
  clientName: z.string(),
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  /** Дата, по которой запись попала в период (создание, показ, закрытие, срок задачи). */
  date: isoDate,
  source: z.string(),
  sourceLabel: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  /** Комиссия сделки в сомони; null — не сделка или нет права finance.view. */
  amount: z.number().nullable(),
});
export type DirectorDrillItem = z.infer<typeof directorDrillItemSchema>;

export const directorDrillResponseSchema = z.object({
  key: z.enum(DIRECTOR_DRILL_KEYS),
  label: z.string(),
  total: z.number(),
  items: z.array(directorDrillItemSchema),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
  /** Сколько записей скрыто, потому что клиент в Корзине, а у смотрящего нет archive.view (0 — ничего). */
  hiddenInTrash: z.number().optional(),
});
export type DirectorDrillResponse = z.infer<typeof directorDrillResponseSchema>;
