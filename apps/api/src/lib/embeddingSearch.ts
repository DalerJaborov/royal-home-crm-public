import type { PropertyStatus } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { cosineSimilarity, embedText } from "../ai/embeddings.js";

/**
 * ПОИСК ОБЪЕКТОВ ПО СМЫСЛУ ЗАПРОСА — семантический слой ПОВЕРХ структурного
 * подбора (routes/matching.ts), не вместо него. «Светлая двушка рядом со школой»
 * не бьётся ни в одно структурное поле, но может лежать в description/amenities.
 *
 * НЕ pgvector (архитектурное решение зафиксировано в комментарии к Property.embedding,
 * prisma/schema.prisma): полный линейный проход по каталогу — миллисекунды при
 * размере агентства (сотни-низкие тысячи объектов), считать в Node.js дешевле, чем
 * менять образ Postgres в проде ради индекса ANN, который на таком объёме не нужен.
 */

export interface SemanticMatch {
  propertyId: string;
  score: number;
}

/**
 * ТЕ ЖЕ ГРАНИЦЫ ВИДИМОСТИ, ЧТО У СТРУКТУРНОГО ПОДБОРА (`{ status: "AVAILABLE",
 * deletedAt: null }`). Расхождение означало бы, что семантический поиск предлагает
 * то, что структурный подбор намеренно скрывает.
 *
 * Фильтр `offSite: false` снят 09.09.2026 (решение владельца): объект «только в
 * CRM» участвует в подборе наравне с остальными. Он и так виден всем агентам в
 * разделе «Объекты» и отправляется клиенту приватной ссылкой — прятать его от
 * подбора значило требовать, чтобы агент вспомнил про него сам. На сайт он
 * по-прежнему не идёт никогда.
 *
 * Объект из Корзины (deletedAt) не предлагается никому.
 */
export async function semanticPropertySearch(
  queryText: string,
  options: { statusFilter?: PropertyStatus; limit?: number } = {}
): Promise<SemanticMatch[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];

  const queryVector = await embedText(trimmed, "RETRIEVAL_QUERY");
  // Эмбеддинг запроса не получен (ключ не настроен, сеть, лимит) — embedText уже
  // залогировал причину; здесь просто нет результата, а не ошибка поиска.
  if (!queryVector) return [];

  const candidates = await prisma.property.findMany({
    where: {
      deletedAt: null,
      status: options.statusFilter ?? "AVAILABLE",
      // Признак «эмбеддинг есть» — embeddingUpdatedAt, не длина массива (см.
      // комментарий у Property.embedding: Prisma не допускает необязательный
      // список, поэтому пустой массив — не то же самое, что «не считан»).
      embeddingUpdatedAt: { not: null },
    },
    select: { id: true, embedding: true },
  });

  return candidates
    .map((c) => ({ propertyId: c.id, score: cosineSimilarity(queryVector, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 20);
}
