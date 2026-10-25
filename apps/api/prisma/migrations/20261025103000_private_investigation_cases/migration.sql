ALTER TABLE "Settings" ADD COLUMN "investigationCaseConfig" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "InvestigationCase" (
  "id" TEXT NOT NULL, "caseKey" TEXT NOT NULL,
  "clientId" TEXT, "propertyId" TEXT, "showingId" TEXT, "subjectAgentId" TEXT,
  "title" TEXT NOT NULL, "source" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN', "level" TEXT NOT NULL DEFAULT 'C1',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "firstOccurredAt" TIMESTAMP(3) NOT NULL, "lastSignalAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InvestigationCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvestigationCase_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "InvestigationCase_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "InvestigationCase_subjectAgentId_fkey" FOREIGN KEY ("subjectAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InvestigationCase_caseKey_key" ON "InvestigationCase"("caseKey");
CREATE INDEX "InvestigationCase_status_lastSignalAt_idx" ON "InvestigationCase"("status","lastSignalAt");
CREATE INDEX "InvestigationCase_clientId_propertyId_idx" ON "InvestigationCase"("clientId","propertyId");
CREATE INDEX "InvestigationCase_subjectAgentId_lastSignalAt_idx" ON "InvestigationCase"("subjectAgentId","lastSignalAt");

CREATE TABLE "InvestigationEvidence" (
  "id" TEXT NOT NULL, "caseId" TEXT NOT NULL, "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL, "independenceKey" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "summary" TEXT NOT NULL, "payload" JSONB, "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvestigationEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvestigationEvidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InvestigationEvidence_caseId_sourceType_sourceId_kind_key" ON "InvestigationEvidence"("caseId","sourceType","sourceId","kind");
CREATE INDEX "InvestigationEvidence_caseId_occurredAt_idx" ON "InvestigationEvidence"("caseId","occurredAt");

CREATE TABLE "InvestigationDecision" (
  "id" TEXT NOT NULL, "caseId" TEXT NOT NULL, "requestKey" TEXT NOT NULL,
  "actorId" TEXT NOT NULL, "action" TEXT NOT NULL, "note" TEXT NOT NULL,
  "previousStatus" TEXT NOT NULL, "newStatus" TEXT NOT NULL, "caseRevision" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvestigationDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvestigationDecision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InvestigationDecision_requestKey_key" ON "InvestigationDecision"("requestKey");
CREATE INDEX "InvestigationDecision_caseId_createdAt_idx" ON "InvestigationDecision"("caseId","createdAt");
