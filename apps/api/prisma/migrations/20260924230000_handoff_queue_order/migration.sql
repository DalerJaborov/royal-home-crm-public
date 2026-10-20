-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "videoHandoffQueueOrder" INTEGER;

-- CreateIndex
CREATE INDEX "Property_videoHandoffStatus_videoHandoffQueueOrder_idx" ON "Property"("videoHandoffStatus", "videoHandoffQueueOrder");

-- Уже стоящие в очереди получают места 1..N тем порядком, каким их выдавали
-- до этой правки (по времени постановки) — очередь после выката не перемешается.
UPDATE "Property" AS p
SET "videoHandoffQueueOrder" = q.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "videoHandoffSentAt" ASC NULLS LAST, "id" ASC) AS rn
  FROM "Property"
  WHERE "videoHandoffStatus" = 'QUEUED' AND "deletedAt" IS NULL
) AS q
WHERE p."id" = q."id";
