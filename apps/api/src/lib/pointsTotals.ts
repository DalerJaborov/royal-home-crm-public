import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

/**
 * Сумма начисленных баллов по агентам — считает база, а не Node.
 *
 * Зачем отдельная функция. Баллы лежат в журнале действий (`AuditLog`,
 * `action="POINTS_AWARD"`), а величина — внутри JSON-поля `meta.points`.
 * Раньше оба экрана («Команда» и история начислений агента) поднимали ВСЕ
 * записи журнала в память и складывали их там. Поставить у такой выборки
 * предел (`take`) нельзя: предел у запроса, из которого считается ИТОГ, —
 * это не пагинация, а молча заниженная сумма. Поэтому итог уезжает в
 * `SUM(...)`: одна строка на агента независимо от объёма истории, а предел
 * остаётся там, где ему и место, — у списка, который уходит в интерфейс.
 *
 * `jsonb_typeof` в условии — защита от строки в `meta.points`: без него одна
 * кривая запись роняла бы приведение к `numeric`, а с ним — просто не попадает
 * в сумму (баллы начисляются числом, см. royalScoreEvents.ts).
 */
export async function sumPointsByAgent(agentIds: string[]): Promise<Map<string, number>> {
  if (agentIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<{ entityId: string; total: number | null }[]>`
    SELECT "entityId", SUM((meta->>'points')::numeric)::float8 AS total
    FROM "AuditLog"
    WHERE action = 'POINTS_AWARD'
      AND "entityType" = 'Agent'
      AND "entityId" IN (${Prisma.join(agentIds)})
      AND jsonb_typeof(meta->'points') = 'number'
    GROUP BY "entityId"
  `;

  return new Map(rows.map((r) => [r.entityId, Number(r.total ?? 0)]));
}
