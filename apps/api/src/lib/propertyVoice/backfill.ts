import { prisma } from "../../db.js";

/**
 * ДОБОР «ГОЛОСА РЫНКА» ПО СТАРЫМ ДАННЫМ (03.10.2026) — запускает
 * scripts/backfill-property-voice.mjs.
 *
 * Новый код оставляет след «диалог ↔ объект» с момента выкладки, а всё, что было
 * до неё, лежит в базе без связи. Здесь она достраивается из того, что уже
 * доказано записями, — без единой догадки по тексту:
 *
 *  1. `ConversationProperty` из `PropertyExposure` (объект показали человеку из
 *     диалога: пара «канал + собеседник» это и есть диалог) и из
 *     `BotConversation.adPropertyId` (человек пришёл с рекламы объекта);
 *  2. `OwnerQuestion.propertyId` — только там, где в диалоге ровно ОДИН объект
 *     (то же правило однозначности, что в бою: singleLinkedPropertyId), причём
 *     считаются только объекты, узнанные в диалоге НЕ ПОЗЖЕ вопроса
 *     (`firstSeenAt <= askedAt`): в бою вопрос видит лишь связи, существовавшие
 *     в момент вопроса, и объект, появившийся в диалоге потом, к нему не относится;
 *  3. `InstagramComment.propertyId` — по тем же прямым привязкам, что в бою
 *     (Property.publishedPostIds, PropertyPhotoPost), без обращений к Meta;
 *  4. `CallAnalysis.propertyId` — ТОЛЬКО по `Interaction.propertyId` (объект прямо указан в
 *     записи звонка). Остальные доказательства боя (причина назначения лида, единственный
 *     объект продавца) читают СЕГОДНЯШНЕЕ состояние клиента, а не то, что было в день звонка:
 *     клиента могли перепривязать к другому объекту или продать/завести новый, и старый звонок
 *     приписался бы чужой квартире. Приписать хуже, чем не приписать.
 *
 * ИДЕМПОТЕНТНО: каждый шаг трогает только то, чего ещё нет (`ON CONFLICT DO
 * NOTHING`, `propertyId IS NULL`), повторный прогон ничего не меняет. ПО
 * УМОЛЧАНИЮ — только подсчёт (`apply: false`): та же выборка, что и при записи,
 * но без записи. Один SQL-оператор на шаг — каждый атомарен сам по себе.
 * Запросы статические, пользовательского ввода в них нет.
 */

export interface PropertyVoiceBackfillStats {
  apply: boolean;
  /** Новых пар «диалог ↔ объект» по показам и рекламе. */
  conversationLinks: number;
  /** Из них по источнику. */
  conversationLinksBySource: Record<string, number>;
  /** Вопросов собственнику, которым проставится объект. */
  ownerQuestions: number;
  /** Комментариев Instagram/Facebook/YouTube, которым проставится объект. */
  comments: number;
  /** Разборов звонков, которым проставится объект. */
  callAnalyses: number;
}

/**
 * Кандидаты пар (диалог, объект) с источником и временем первого узнавания.
 * Показ в диалоге: `PropertyExposure.channel/recipientId` = `BotConversation.channel/subscriberId`.
 * Пара, у которой уже есть строка в ConversationProperty, не кандидат.
 */
const LINK_CANDIDATES_SQL = `
  SELECT DISTINCT ON (cid, pid) cid, pid, source, first_seen, last_seen, hits FROM (
    SELECT c.id AS cid, e."propertyId" AS pid,
           (CASE WHEN bool_or(e.kind = 'CLIENT_SHARED') THEN 'SHARED_MEDIA' ELSE 'EXPOSURE' END)::"ConversationPropertySource" AS source,
           MIN(e."sentAt") AS first_seen, MAX(e."sentAt") AS last_seen, COUNT(*)::int AS hits
    FROM "PropertyExposure" e
    JOIN "BotConversation" c ON c.channel = e.channel AND c."subscriberId" = e."recipientId"
    JOIN "Property" p ON p.id = e."propertyId"
    WHERE e."propertyId" IS NOT NULL
    GROUP BY c.id, e."propertyId"
    UNION ALL
    SELECT c.id, c."adPropertyId", 'AD_REFERRAL'::"ConversationPropertySource", c."createdAt", c."createdAt", 1
    FROM "BotConversation" c
    JOIN "Property" p ON p.id = c."adPropertyId"
    WHERE c."adPropertyId" IS NOT NULL
  ) u
  WHERE NOT EXISTS (SELECT 1 FROM "ConversationProperty" cp WHERE cp."conversationId" = u.cid AND cp."propertyId" = u.pid)
  ORDER BY cid, pid, first_seen
`;

/**
 * Вопросы собственнику без объекта, у диалога которых (уже существующие + будущие пары) ровно один
 * объект, узнанный не позже вопроса (`seen <= askedAt`, как в бою: singleLinkedPropertyId).
 */
const OWNER_QUESTION_CANDIDATES_SQL = `
  SELECT q.id AS qid, MIN(l.pid) AS pid FROM "OwnerQuestion" q
  JOIN (
    SELECT "conversationId" AS cid, "propertyId" AS pid, "firstSeenAt" AS seen FROM "ConversationProperty"
    UNION
    SELECT cid, pid, first_seen AS seen FROM (${LINK_CANDIDATES_SQL}) fresh
  ) l ON l.cid = q."conversationId" AND l.seen <= q."askedAt"
  WHERE q."propertyId" IS NULL
  GROUP BY q.id
  HAVING COUNT(DISTINCT l.pid) = 1
`;

/** Комментарии без объекта и объект по прямой привязке публикации (приоритет: карточка, потом фото-пост; свежий объект первым). */
const COMMENT_CANDIDATES_SQL = `
  SELECT DISTINCT ON (cid) cid, pid FROM (
    SELECT ic.id AS cid, p.id AS pid, 1 AS pri, p."createdAt" AS ts
    FROM "InstagramComment" ic
    JOIN "Property" p ON p."deletedAt" IS NULL
      AND (p."publishedPostIds" ->> ic.channel = ic."mediaId"
           OR (ic.channel = 'FACEBOOK' AND p."publishedPostIds" ->> ic.channel = substring(ic."mediaId" from '[^_]*$')))
    WHERE ic."propertyId" IS NULL AND ic.channel IN ('INSTAGRAM', 'FACEBOOK', 'YOUTUBE')
    UNION ALL
    SELECT ic.id, pp."propertyId", 2, pp."createdAt"
    FROM "InstagramComment" ic
    JOIN "PropertyPhotoPost" pp ON pp.channel = ic.channel AND pp.status = 'PUBLISHED'
      AND (pp."mediaId" = ic."mediaId" OR pp."secondaryId" = ic."mediaId"
           OR (ic.channel = 'FACEBOOK' AND (pp."mediaId" = substring(ic."mediaId" from '[^_]*$')
                                            OR pp."secondaryId" = substring(ic."mediaId" from '[^_]*$'))))
    WHERE ic."propertyId" IS NULL AND ic.channel IN ('INSTAGRAM', 'FACEBOOK')
  ) u
  ORDER BY cid, pri, ts DESC
`;

/**
 * Разборы звонков без объекта: объект берётся ТОЛЬКО из самой записи звонка
 * (`Interaction.propertyId`) — «доказано» на день звонка. Состояние клиента сегодня (matchedPropertyId,
 * объекты продавца) для давнего звонка не доказательство, см. шапку файла.
 */
const CALL_CANDIDATES_SQL = `
  SELECT ca.id AS caid, i."propertyId" AS pid
  FROM "CallAnalysis" ca
  JOIN "Interaction" i ON i.id = ca."interactionId"
  WHERE ca."propertyId" IS NULL AND i."propertyId" IS NOT NULL
`;

async function count(sql: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (${sql}) x`);
  return Number(rows[0]?.n ?? 0);
}

export async function backfillPropertyVoice(options: { apply: boolean }): Promise<PropertyVoiceBackfillStats> {
  const stats: PropertyVoiceBackfillStats = {
    apply: options.apply,
    conversationLinks: 0,
    conversationLinksBySource: {},
    ownerQuestions: 0,
    comments: 0,
    callAnalyses: 0,
  };

  // Подсчёт ВСЕГДА идёт по той же выборке, что и запись, и до неё: при записи
  // последующие шаги видят уже вставленные пары, а счётчик должен показать то,
  // что было бы создано с нуля. Поэтому все числа снимаются до первого изменения.
  const bySource = await prisma.$queryRawUnsafe<{ source: string; n: bigint }[]>(
    `SELECT source::text AS source, COUNT(*) AS n FROM (${LINK_CANDIDATES_SQL}) x GROUP BY source`
  );
  for (const row of bySource) {
    stats.conversationLinksBySource[row.source] = Number(row.n);
    stats.conversationLinks += Number(row.n);
  }
  stats.ownerQuestions = await count(OWNER_QUESTION_CANDIDATES_SQL);
  stats.comments = await count(COMMENT_CANDIDATES_SQL);
  stats.callAnalyses = await count(CALL_CANDIDATES_SQL);

  if (!options.apply) return stats;

  // 1. Пары «диалог ↔ объект». Вопросы собственнику (шаг 2) читают их уже из
  // таблицы, поэтому порядок важен: сначала связи.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "ConversationProperty" (id, "conversationId", "propertyId", source, "firstSeenAt", "lastSeenAt", hits)
    SELECT gen_random_uuid()::text, cid, pid, source, first_seen, last_seen, hits FROM (${LINK_CANDIDATES_SQL}) fresh
    ON CONFLICT ("conversationId", "propertyId") DO NOTHING
  `);
  // 2. Вопросы собственнику — только там, где объект диалога один. Теперь все пары
  // уже в таблице, и «кандидаты пар» пусты — условие читает одну таблицу.
  await prisma.$executeRawUnsafe(`
    UPDATE "OwnerQuestion" q SET "propertyId" = m.pid
    FROM (${OWNER_QUESTION_CANDIDATES_SQL}) m
    WHERE q.id = m.qid AND q."propertyId" IS NULL
  `);
  // 3. Комментарии.
  await prisma.$executeRawUnsafe(`
    UPDATE "InstagramComment" ic SET "propertyId" = m.pid
    FROM (${COMMENT_CANDIDATES_SQL}) m
    WHERE ic.id = m.cid AND ic."propertyId" IS NULL
  `);
  // 4. Разборы звонков.
  await prisma.$executeRawUnsafe(`
    UPDATE "CallAnalysis" ca SET "propertyId" = m.pid
    FROM (${CALL_CANDIDATES_SQL}) m
    WHERE ca.id = m.caid AND ca."propertyId" IS NULL
  `);
  return stats;
}
