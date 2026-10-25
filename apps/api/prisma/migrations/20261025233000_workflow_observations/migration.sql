-- CreateTable
CREATE TABLE "ClientWorkflowObservation" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "propertyId" TEXT,
    "subjectAgentId" TEXT,
    "assignmentAt" TIMESTAMP(3) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "executionMode" TEXT NOT NULL DEFAULT 'PREVIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientWorkflowObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientWorkflowObservation_sourceKey_key" ON "ClientWorkflowObservation"("sourceKey");

-- CreateIndex
CREATE INDEX "ClientWorkflowObservation_clientId_assignmentAt_occurredAt_idx" ON "ClientWorkflowObservation"("clientId", "assignmentAt", "occurredAt");

-- CreateIndex
CREATE INDEX "ClientWorkflowObservation_kind_occurredAt_idx" ON "ClientWorkflowObservation"("kind", "occurredAt");

INSERT INTO "WorkflowCheckpoint" ("key", "revision", "createdAt", "updatedAt")
VALUES ('client-workflow-observations-v1', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

