import { z } from "zod";

/**
 * КАРТОЧКА СОТРУДНИКА «ОДНИМ ВЗГЛЯДОМ» (22.11.2026) — общий договор сервера и экрана.
 *
 * Плитка за период и список записей за ней считаются одним кодом (apps/api/src/lib/agentGlance.ts):
 * цифра на плитке всегда равна числу строк в списке, который открывается по клику.
 */
export const AGENT_GLANCE_PERIODS = ["week", "month"] as const;
export type AgentGlancePeriod = (typeof AGENT_GLANCE_PERIODS)[number];

/** Сколько суток в периоде и сколько дней рисует график. */
export const AGENT_GLANCE_DAYS: Record<AgentGlancePeriod, number> = { week: 7, month: 30 };

export const AGENT_GLANCE_DRILL_KEYS = [
  "buyers",
  "sellers",
  "calls",
  "missed",
  "showings",
  "deals",
  "commission",
  "overdue",
  "waiting",
] as const;
export type AgentGlanceDrillKey = (typeof AGENT_GLANCE_DRILL_KEYS)[number];

export const agentGlanceQuerySchema = z.object({
  period: z.enum(AGENT_GLANCE_PERIODS).default("week"),
});

export const agentGlanceDrillQuerySchema = agentGlanceQuerySchema.extend({
  key: z.enum(AGENT_GLANCE_DRILL_KEYS),
});

/** Какой группе клиентов принадлежит замечание: покупатели и продавцы разделены, остальные — отдельно. */
export type AgentIssueKind = "BUYER" | "SELLER" | "OTHER";

export type AgentIssueCode = "waiting" | "overdue" | "noContact" | "sellerNoProperty";
export type AgentIssueSeverity = "crit" | "warn";

export interface AgentGlanceIssue {
  code: AgentIssueCode;
  kind: AgentIssueKind;
  severity: AgentIssueSeverity;
  clientShortId: number;
  clientName: string;
  /** Одна короткая строка: «написал 2 ч назад», «просрочено на 3 дня». */
  sub: string;
  /** Момент, от которого считается «давно»: чем раньше, тем важнее. */
  at: string;
}

export interface AgentGlanceDayPoint {
  /** ГГГГ-ММ-ДД по Душанбе. */
  date: string;
  calls: number;
  showings: number;
  /** null — KPI за этот день не считался. */
  kpi: number | null;
}

export interface AgentGlance {
  period: AgentGlancePeriod;
  days: number;
  buyersInWork: number;
  sellersInWork: number;
  calls: { total: number; talked: number; missed: number };
  showings: number;
  /** Сделки, начатые или закрытые за период (`total`), и из них закрытые (`completed`). */
  deals: { total: number; completed: number };
  /** Комиссия закрытых за период сделок, сомони. null — у смотрящего нет finance.view. */
  commission: number | null;
  overdueTasks: number;
  waitingForReply: number;
  series: AgentGlanceDayPoint[];
  /** Замечания: покупатели и продавцы раздельно, самые срочные первыми. */
  issues: AgentGlanceIssue[];
  /** Список упёрся в потолок выборки — «ещё» точное только до этого числа. */
  issuesCapped: boolean;
}

export interface AgentGlanceDrillItem {
  id: string;
  /** Куда вести строку: карточка клиента или объекта. */
  clientShortId: number | null;
  propertyShortId: number | null;
  title: string;
  sub: string;
  at: string | null;
  /** Сумма, сомони; только при праве на деньги. */
  amount: number | null;
}

export interface AgentGlanceDrill {
  key: AgentGlanceDrillKey;
  period: AgentGlancePeriod;
  total: number;
  items: AgentGlanceDrillItem[];
}
