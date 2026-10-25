import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

export const INTERACTION_JOB_TYPES = ["recording-search-retry", "transcription-retry"];
/** SQL applies before counts and pagination; missing legacy bindings remain private. */
export function publicBackgroundJobSql() {
  return Prisma.sql`(COALESCE("BackgroundJob".payload->>'investigationOnly', 'false') <> 'true'
    AND (NOT ("BackgroundJob".type = ANY(${INTERACTION_JOB_TYPES}::text[])) OR EXISTS (
      SELECT 1 FROM "Interaction" i WHERE i.id = "BackgroundJob".payload->>'interactionId' AND i."investigationOnly" = false
    )))`;
}
export async function isPrivateBackgroundJob(job: { type: string; payload: unknown }): Promise<boolean> {
  const p = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? job.payload as Record<string, unknown> : {};
  if (p.investigationOnly === true || p.investigationOnly === "true") return true;
  if (!INTERACTION_JOB_TYPES.includes(job.type)) return false;
  if (typeof p.interactionId !== "string") return true;
  const row = await prisma.interaction.findUnique({ where: { id: p.interactionId }, select: { investigationOnly: true } });
  return row?.investigationOnly !== false;
}
export async function countVisibleBackgroundJobs(where: Prisma.Sql, includePrivate = false): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) AS count FROM "BackgroundJob" WHERE ${where} AND ${includePrivate ? Prisma.sql`TRUE` : publicBackgroundJobSql()}`);
  return Number(rows[0]?.count ?? 0);
}
