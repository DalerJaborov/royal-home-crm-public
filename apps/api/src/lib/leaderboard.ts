import { prisma } from "../db.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { RATED_ROLES } from "@royal-home/shared";

/**
 * Лидерборд недели для «Пульса компании» (план §6, фаза 4, п.7).
 *
 * НЕ ПОВТОРЯЕТ /hall-of-fame — источник тот же (`KpiDailyScore`, «источник истины
 * для Agent.kpi», schema.prisma:504), но срез другой: скользящие 7 дней вместо
 * календарного месяца. «Доска почёта»/TOP AGENTS уже показывают итог месяца —
 * здесь нужна подсказка «кто в ударе прямо сейчас», а не тот же самый месяц ещё
 * раз (план §5: «не плодить дубли», «одно число — одно место»).
 */

const WEEK_DAYS = 7;
const LEADERBOARD_LIMIT = 5;

export interface LeaderboardEntry {
  place: number;
  id: string;
  fullName: string;
  avatarUrl: string | null;
  score: number;
}

export async function loadWeeklyLeaderboard(now: Date = new Date()): Promise<LeaderboardEntry[]> {
  const start = new Date(dushanbeStartOfToday(now).getTime() - (WEEK_DAYS - 1) * 24 * 60 * 60 * 1000);

  const rows = await prisma.kpiDailyScore.groupBy({
    by: ["agentId"],
    where: { date: { gte: start } },
    _sum: { score: true },
  });
  if (rows.length === 0) return [];

  const agents = await prisma.agent.findMany({
    where: { id: { in: rows.map((r) => r.agentId) }, role: { in: [...RATED_ROLES] } },
    select: { id: true, fullName: true, avatarUrl: true },
  });
  const byId = new Map(agents.map((a) => [a.id, a]));

  return rows
    .map((r) => ({ id: r.agentId, score: r._sum.score ?? 0, agent: byId.get(r.agentId) }))
    .filter((r): r is { id: string; score: number; agent: { id: string; fullName: string; avatarUrl: string | null } } =>
      !!r.agent && r.score > 0
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, LEADERBOARD_LIMIT)
    .map((r, i) => ({ place: i + 1, id: r.id, fullName: r.agent.fullName, avatarUrl: r.agent.avatarUrl, score: r.score }));
}
