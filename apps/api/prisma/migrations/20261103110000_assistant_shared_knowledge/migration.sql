CREATE TABLE "AssistantKnowledge" (
 "id" TEXT NOT NULL PRIMARY KEY, "key" TEXT NOT NULL, "title" TEXT NOT NULL, "content" TEXT NOT NULL,
 "source" TEXT NOT NULL, "authorId" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
 "archived" BOOLEAN NOT NULL DEFAULT false, "validUntil" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "AssistantKnowledge_key_key" ON "AssistantKnowledge"("key");
CREATE INDEX "AssistantKnowledge_archived_updatedAt_idx" ON "AssistantKnowledge"("archived", "updatedAt");
CREATE TABLE "AssistantKnowledgeRevision" (
 "id" TEXT NOT NULL PRIMARY KEY, "knowledgeId" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "title" TEXT NOT NULL, "content" TEXT NOT NULL, "source" TEXT NOT NULL, "authorId" TEXT NOT NULL,
 "archived" BOOLEAN NOT NULL, "validUntil" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AssistantKnowledgeRevision_knowledgeId_revision_key" ON "AssistantKnowledgeRevision"("knowledgeId", "revision");
