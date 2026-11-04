CREATE TABLE "AssistantKnowledgeEmbedding" (
  "knowledgeId" TEXT NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL,
  "model" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
  "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantKnowledgeEmbedding_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "AssistantKnowledge"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
