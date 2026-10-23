import type { Prisma } from "../generated/prisma/client.js";

/**
 * «Ждут агента»: клиенты в общей очереди без агента (копятся до утренней волны или
 * пришли вне рабочих часов — messengers/conversation.ts deferAssignment,
 * services/leads/assignment.ts). `kind=OTHER` в раздачу не идёт никогда.
 *
 * ОДНО УСЛОВИЕ НА ДВА МЕСТА (23.10.2026): число `queuedTotal` в `GET /dashboard/team-live`
 * и список `GET /dashboard/unassigned-leads` обязаны совпадать — поэтому where живёт
 * здесь, а не в двух роутах. Тест `dashboard-unassigned-leads.test.ts` сверяет оба.
 */
export const UNASSIGNED_LEADS_WHERE = {
  acceptedAt: null,
  assignedAgentId: null,
  kind: { not: "OTHER" as const },
  deletedAt: null,
} satisfies Prisma.ClientWhereInput;

/** Предел списка на пульте: давние первыми, остальное — в разделе «Клиенты». */
export const UNASSIGNED_LEADS_LIMIT = 20;
