ALTER TABLE "Client"
  ADD COLUMN "assignmentRefusedAt" TIMESTAMP(3),
  ADD COLUMN "assignmentRefusedByAgentId" TEXT,
  ADD COLUMN "assignmentCompletedAt" TIMESTAMP(3);

ALTER TABLE "Interaction" ADD COLUMN "investigationOnly" BOOLEAN NOT NULL DEFAULT false;
