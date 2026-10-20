import { prisma } from "../db.js";

/**
 * ДОСТУП К DealReview ЧЕРЕЗ СЫРОЙ SQL (Пачка 11, 11.09.2026).
 *
 * Миграция (prisma/migrations/20260911190000_deal_review) написана руками — в
 * worktree, где писался этот код, `prisma generate` запрещён (общий
 * `node_modules` со всеми параллельными агентами, см. бриф). Сгенерированный
 * клиент поэтому не знает про `prisma.dealReview` до сборки на интеграционной
 * ветке. Как только сборщик прогонит `prisma generate`, эти функции можно
 * переписать на обычный `prisma.dealReview.*` — поведение не изменится, это
 * тот же самый SQL, что генерирует Prisma под capot.
 */

export interface DealReviewRow {
  id: string;
  dealId: string;
  clientId: string;
  channel: string;
  rating: number | null;
  text: string | null;
  referralPhone: string | null;
  askedAt: Date;
  answeredAt: Date | null;
}

/** Задать вопрос: одна запись на пару (сделка, клиент) — повтор no-op (см. @@unique в схеме). */
export async function createDealReviewAsk(input: {
  dealId: string;
  clientId: string;
  channel: string;
}): Promise<boolean> {
  try {
    // Ночная проверка 24.09.2026: `$executeRaw` возвращает число ЗАТРОНУТЫХ
    // строк (Prisma.PrismaPromise<number>), а не признак «запрос выполнен без
    // ошибки». `ON CONFLICT DO NOTHING` при повторе даёт 0 строк — раньше это
    // читалось как `true`, jobs/dealReviewAsk.ts принимал это за «только что
    // создано» и слал клиенту повторную просьбу оценить сделку. Приём как в
    // messengers/phoneRetryClaim.ts: `return changed > 0`.
    const changed = await prisma.$executeRaw`
      INSERT INTO "DealReview" ("id", "dealId", "clientId", "channel")
      VALUES (gen_random_uuid()::text, ${input.dealId}, ${input.clientId}, ${input.channel})
      ON CONFLICT ("dealId", "clientId") DO NOTHING
    `;
    return changed > 0;
  } catch (err) {
    console.error("[deal-review] постановка вопроса:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Снять отметку «спрошено», пока на неё никто не ответил. Нужна, когда вопрос
 * поставлен в запись ДО доставки, а доставка упала временным сбоем: без снятия
 * повтор задания видит готовую пару и выходит, вопрос теряется навсегда (JOB-03).
 */
export async function deleteUnansweredDealReviewAsk(input: { dealId: string; clientId: string }): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "DealReview"
    WHERE "dealId" = ${input.dealId} AND "clientId" = ${input.clientId} AND "answeredAt" IS NULL
  `;
}

/** Открытый вопрос по клиенту (ждёт ответа) — самый свежий, если их несколько
 *  (клиент был стороной в двух сделках подряд). */
export async function findPendingDealReview(clientId: string): Promise<DealReviewRow | null> {
  const rows = await prisma.$queryRaw<DealReviewRow[]>`
    SELECT "id", "dealId", "clientId", "channel", "rating", "text", "referralPhone", "askedAt", "answeredAt"
    FROM "DealReview"
    WHERE "clientId" = ${clientId} AND "answeredAt" IS NULL
    ORDER BY "askedAt" DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function markDealReviewAnswered(input: {
  id: string;
  rating: number;
  text: string;
  referralPhone: string | null;
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "DealReview"
    SET "rating" = ${input.rating}, "text" = ${input.text}, "referralPhone" = ${input.referralPhone},
        "answeredAt" = now()
    WHERE "id" = ${input.id}
  `;
}

/** Отзывы, отвеченные за сутки [from, to) — для утренних чисел. */
export async function countDealReviewsAnswered(from: Date, to: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM "DealReview" WHERE "answeredAt" >= ${from} AND "answeredAt" < ${to}
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Средняя оценка за месяц — по агенту сделки (для «Отчётов»), либо по всей компании. */
export async function averageDealReviewRating(input: { agentId?: string; since: Date }): Promise<number | null> {
  const rows = input.agentId
    ? await prisma.$queryRaw<{ avg: number | null }[]>`
        SELECT AVG(r."rating")::float AS avg
        FROM "DealReview" r
        JOIN "Deal" d ON d."id" = r."dealId"
        WHERE r."answeredAt" >= ${input.since} AND r."rating" IS NOT NULL AND d."agentId" = ${input.agentId}
      `
    : await prisma.$queryRaw<{ avg: number | null }[]>`
        SELECT AVG(r."rating")::float AS avg
        FROM "DealReview" r
        WHERE r."answeredAt" >= ${input.since} AND r."rating" IS NOT NULL
      `;
  const avg = rows[0]?.avg;
  return typeof avg === "number" ? Math.round(avg * 100) / 100 : null;
}

/** Отзывы клиента/сделки — для блока «Отзыв» в карточке. */
export async function listDealReviewsForDeal(dealId: string): Promise<DealReviewRow[]> {
  return prisma.$queryRaw<DealReviewRow[]>`
    SELECT "id", "dealId", "clientId", "channel", "rating", "text", "referralPhone", "askedAt", "answeredAt"
    FROM "DealReview"
    WHERE "dealId" = ${dealId}
    ORDER BY "askedAt" ASC
  `;
}
