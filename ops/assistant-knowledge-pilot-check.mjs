// Run from /repo/apps/api inside the released container: node --input-type=module < this file.
import { Prisma } from "./dist/generated/prisma/client.js";
import { prisma } from "./dist/db.js";
import { GEMINI_EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_MODEL } from "./dist/ai/geminiTransport.js";
import {
  APPROVED_COMPANY_POLICY_KEYS, APPROVED_COMPANY_POLICY_REVISION, isApprovedCompanyPolicy,
} from "./dist/ai/assistant/knowledgePolicyQuery.js";

try {
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT k."key", k."title", k."content", k."source", k."revision", e."embedding"
    FROM "AssistantKnowledge" k LEFT JOIN "AssistantKnowledgeEmbedding" e ON e."knowledgeId" = k."id"
      AND e."revision" = k."revision" AND e."model" = ${GEMINI_EMBEDDING_MODEL}
      AND e."dimensions" = ${GEMINI_EMBEDDING_DIMENSIONS}
    WHERE k."archived" = false AND (k."validUntil" IS NULL OR k."validUntil" > now())
      AND k."key" IN (${Prisma.join(APPROVED_COMPANY_POLICY_KEYS)}) AND k."revision" = ${APPROVED_COMPANY_POLICY_REVISION}
  `);
  const approved = rows.filter(isApprovedCompanyPolicy);
  const ready = approved.filter(({ embedding }) => Array.isArray(embedding) &&
    embedding.length === GEMINI_EMBEDDING_DIMENSIONS && embedding.every(Number.isFinite) &&
    embedding.some(value => value !== 0));
  console.log(JSON.stringify({
    expected: APPROVED_COMPANY_POLICY_KEYS.length,
    approved: approved.length,
    ready: ready.length,
    lookupEnabled: process.env.ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED === "true",
    indexingEnabled: process.env.ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED === "true",
  }));
  if (ready.length !== APPROVED_COMPANY_POLICY_KEYS.length) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
