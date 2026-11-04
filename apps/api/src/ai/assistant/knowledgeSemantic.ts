import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { embedText, cosineSimilarity, type EmbeddingAttemptMetadata } from "../embeddings.js";
import { GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS } from "../geminiTransport.js";
import type { CompanyKnowledge } from "./knowledgeTypes.js";
import {
  APPROVED_COMPANY_POLICY_KEYS,
  APPROVED_COMPANY_POLICY_REVISION,
  companyMemoryPolicyForTopic,
  isApprovedCompanyPolicy,
  type CompanyMemoryPolicyTopic,
} from "./knowledgePolicyQuery.js";

export const KNOWLEDGE_INDEX_BATCH_MAX = 10;
export const KNOWLEDGE_SEMANTIC_SCAN_MAX = 256;
export const KNOWLEDGE_SEMANTIC_MIN_SCORE = 0.65;
export interface KnowledgeEmbeddingOptions {
  beforeAttempt: (metadata: EmbeddingAttemptMetadata) => Promise<void>;
  signal?: AbortSignal;
}
export function knowledgeSemanticEnabled(): boolean {
  return process.env.ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED === "true";
}
export function knowledgeSemanticIndexEnabled(): boolean {
  return process.env.ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED === "true";
}
function validVector(vector: unknown): vector is number[] {
  return Array.isArray(vector) && vector.length === GEMINI_EMBEDDING_DIMENSIONS &&
    vector.every((value) => typeof value === "number" && Number.isFinite(value)) &&
    vector.some((value) => value !== 0);
}

/** A bounded explicit batch. Search/save never call this or trigger document embeddings. */
export async function pendingKnowledgeIndex(): Promise<CompanyKnowledge[]> {
  if (!knowledgeSemanticIndexEnabled()) return [];
  const rows = await prisma.$queryRaw<CompanyKnowledge[]>(Prisma.sql`
    SELECT k.* FROM "AssistantKnowledge" k LEFT JOIN "AssistantKnowledgeEmbedding" e ON e."knowledgeId" = k."id"
    WHERE k."archived" = false AND (k."validUntil" IS NULL OR k."validUntil" > now())
      AND k."key" IN (${Prisma.join(APPROVED_COMPANY_POLICY_KEYS)}) AND k."revision" = ${APPROVED_COMPANY_POLICY_REVISION}
      AND (e."knowledgeId" IS NULL OR e."revision" <> k."revision" OR e."model" <> ${GEMINI_EMBEDDING_MODEL}
        OR e."dimensions" <> ${GEMINI_EMBEDDING_DIMENSIONS})
    ORDER BY k."updatedAt" ASC, k."id" ASC LIMIT ${KNOWLEDGE_INDEX_BATCH_MAX}
  `);
  return rows.filter(isApprovedCompanyPolicy);
}

/** Approve IDs/revisions before calling: a changed record is skipped, never silently substituted. */
export async function indexCompanyKnowledge(
  approved: readonly { id: string; revision: number }[], options: KnowledgeEmbeddingOptions,
): Promise<{ indexed: number; skipped: number }> {
  if (!knowledgeSemanticIndexEnabled()) throw new Error("Индексация общих знаний выключена");
  if (typeof options?.beforeAttempt !== "function") throw new Error("Не настроен учёт стоимости эмбеддингов");
  if (approved.length < 1 || approved.length > KNOWLEDGE_INDEX_BATCH_MAX ||
      new Set(approved.map((row) => row.id)).size !== approved.length ||
      approved.some((row) => !row.id || !Number.isSafeInteger(row.revision) || row.revision < 1)) {
    throw new Error("Неверный ограниченный пакет индексации знаний");
  }
  let indexed = 0, skipped = 0;
  for (const expected of approved) {
    options.signal?.throwIfAborted();
    const rows = await prisma.$queryRaw<CompanyKnowledge[]>(Prisma.sql`
      SELECT k.* FROM "AssistantKnowledge" k WHERE k."id" = ${expected.id} AND k."revision" = ${expected.revision}
        AND k."archived" = false AND (k."validUntil" IS NULL OR k."validUntil" > now())
        AND k."key" IN (${Prisma.join(APPROVED_COMPANY_POLICY_KEYS)}) AND k."revision" = ${APPROVED_COMPANY_POLICY_REVISION}
        AND NOT EXISTS (
          SELECT 1 FROM "AssistantKnowledgeEmbedding" e WHERE e."knowledgeId" = k."id" AND e."revision" = k."revision"
            AND e."model" = ${GEMINI_EMBEDDING_MODEL} AND e."dimensions" = ${GEMINI_EMBEDDING_DIMENSIONS}
        ) LIMIT 1
    `);
    const row = rows[0];
    if (!row || !isApprovedCompanyPolicy(row)) { skipped++; continue; }
    const vector = await embedText(`${row.title}\n${row.content}\nИсточник: ${row.source}`, "RETRIEVAL_DOCUMENT", {
      ...options, maxAttempts: 1,
    });
    if (!validVector(vector)) throw new Error("Google не вернул допустимый вектор знания; пакет остановлен");
    // The paid response may arrive after an edit/archive. Only the approved current revision may be indexed.
    const saved = await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "AssistantKnowledgeEmbedding" ("knowledgeId", "revision", "model", "dimensions", "embedding", "indexedAt")
      SELECT "id", "revision", ${GEMINI_EMBEDDING_MODEL}, ${GEMINI_EMBEDDING_DIMENSIONS}, ${vector}::double precision[], now()
      FROM "AssistantKnowledge" WHERE "id" = ${row.id} AND "revision" = ${row.revision}
        AND "archived" = false AND ("validUntil" IS NULL OR "validUntil" > now())
        AND "key" = ${row.key} AND "title" = ${row.title} AND "content" = ${row.content} AND "source" = ${row.source}
      ON CONFLICT ("knowledgeId") DO UPDATE SET "revision" = EXCLUDED."revision", "model" = EXCLUDED."model",
        "dimensions" = EXCLUDED."dimensions", "embedding" = EXCLUDED."embedding", "indexedAt" = EXCLUDED."indexedAt"
      WHERE "AssistantKnowledgeEmbedding"."revision" <= EXCLUDED."revision"
    `);
    if (saved) indexed++; else skipped++;
  }
  return { indexed, skipped };
}

/** At most one query embedding with a product-owned phrase, never caller-supplied text. */
export async function semanticKnowledgeSearch(topic: CompanyMemoryPolicyTopic, options: KnowledgeEmbeddingOptions): Promise<CompanyKnowledge[]> {
  const policy = companyMemoryPolicyForTopic(topic);
  if (!knowledgeSemanticEnabled() || !policy) return [];
  if (typeof options?.beforeAttempt !== "function") throw new Error("Не настроен учёт стоимости эмбеддингов");
  const rows = await prisma.$queryRaw<(CompanyKnowledge & { embedding: number[] })[]>(Prisma.sql`
    SELECT k.*, e."embedding" FROM "AssistantKnowledge" k JOIN "AssistantKnowledgeEmbedding" e ON e."knowledgeId" = k."id"
    WHERE k."archived" = false AND (k."validUntil" IS NULL OR k."validUntil" > now())
      AND k."key" IN (${Prisma.join(APPROVED_COMPANY_POLICY_KEYS)}) AND k."revision" = ${APPROVED_COMPANY_POLICY_REVISION}
      AND e."revision" = k."revision" AND e."model" = ${GEMINI_EMBEDDING_MODEL} AND e."dimensions" = ${GEMINI_EMBEDDING_DIMENSIONS}
    ORDER BY k."id" ASC LIMIT ${KNOWLEDGE_SEMANTIC_SCAN_MAX + 1}
  `);
  if (rows.length > KNOWLEDGE_SEMANTIC_SCAN_MAX) throw new Error("Индекс общих знаний превысил предел семантического прохода");
  const usable = rows.filter((row) => isApprovedCompanyPolicy(row) && validVector(row.embedding));
  if (!usable.some((row) => row.key === policy.key)) return [];
  const vector = await embedText(policy.providerQuery, "RETRIEVAL_QUERY", { ...options, maxAttempts: 1 });
  if (!validVector(vector)) return [];
  const selected = usable.map((row) => ({ row, score: cosineSimilarity(row.embedding, vector) }))
    .filter(({ score }) => score >= KNOWLEDGE_SEMANTIC_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  // Disagreement with the topic selector is a low-confidence result, not a different answer.
  const winner = selected[0]?.row;
  if (!winner || winner.key !== policy.key) return [];
  // Recheck after the external request so edits, archive, or a changed index cannot return stale facts.
  const current = await prisma.$queryRaw<CompanyKnowledge[]>(Prisma.sql`
    SELECT k.* FROM "AssistantKnowledge" k JOIN "AssistantKnowledgeEmbedding" e ON e."knowledgeId" = k."id"
    WHERE k."id" = ${winner.id} AND k."revision" = ${winner.revision}
      AND k."archived" = false AND (k."validUntil" IS NULL OR k."validUntil" > now())
      AND e."revision" = k."revision" AND e."model" = ${GEMINI_EMBEDDING_MODEL} AND e."dimensions" = ${GEMINI_EMBEDDING_DIMENSIONS}
  `);
  return current.filter(isApprovedCompanyPolicy);
}
