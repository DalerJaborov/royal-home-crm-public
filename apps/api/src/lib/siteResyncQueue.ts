import { randomUUID } from "node:crypto";
import type { TxClient } from "../db.js";
import { isPrivateOperation } from "./investigationOperations.js";

const SITE_RESYNC_MAX_ATTEMPTS = 5;

/**
 * A property has one active site job. A write replaces the desired revision,
 * leaving an in-flight lease alone so the worker can hand off to its successor.
 */
export async function enqueueSiteResyncInTransaction(
  tx: TxClient,
  propertyId: string,
  context: string,
): Promise<void> {
  const revision = randomUUID();
  const payload = JSON.stringify({
    propertyId,
    context,
    revision,
    ...(isPrivateOperation() ? { investigationOnly: true } : {}),
  });
  await tx.$executeRaw`
    INSERT INTO "BackgroundJob" (id, type, payload, "dedupeKey", "maxAttempts", "updatedAt")
    VALUES (${revision}, 'site-resync', ${payload}::jsonb, ${`site-resync:${propertyId}`}, ${SITE_RESYNC_MAX_ATTEMPTS}, now())
    ON CONFLICT ("dedupeKey") DO UPDATE
    SET payload = CASE WHEN "BackgroundJob".payload->>'investigationOnly' = 'true'
                       THEN EXCLUDED.payload || '{"investigationOnly":true}'::jsonb
                       ELSE EXCLUDED.payload END,
        status = CASE WHEN "BackgroundJob".status = 'RUNNING' THEN 'RUNNING' ELSE 'PENDING' END::"BackgroundJobStatus",
        "runAt" = CASE WHEN "BackgroundJob".status = 'RUNNING' THEN "BackgroundJob"."runAt" ELSE now() END,
        "lockedAt" = CASE WHEN "BackgroundJob".status = 'RUNNING' THEN "BackgroundJob"."lockedAt" ELSE NULL END,
        "lockedBy" = CASE WHEN "BackgroundJob".status = 'RUNNING' THEN "BackgroundJob"."lockedBy" ELSE NULL END,
        attempts = 0,
        "lastError" = NULL,
        "maxAttempts" = EXCLUDED."maxAttempts",
        "updatedAt" = now()
  `;
}
