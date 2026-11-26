import { Prisma } from "../generated/prisma/client.js";

/**
 * АРХИВ ЧАТОВ (владелец 26.11.2026): переписка БЕЗ карточки клиента, в которой 30 дней нет новых сообщений,
 * не показывается в «Все / Ждут / Мои», а лежит в «Архиве».
 *
 * Ничего не удаляется и не переносится: архивность не хранится, её каждый раз считает запрос списка
 * (routes/conversations.ts, loadGroupedInboxRows) по этому одному правилу. Новое сообщение клиента двигает
 * `lastMessageAt` вперёд, и чат сам возвращается в основной список. С карточкой клиента чат не архивируется никогда.
 * Поиск (`q`) находит и архивные. Включает правило рубильник `chatArchiveEnabled` (по умолчанию ВКЛ).
 *
 * КОНСЕРВАТИВНО (ревью #469): чат без карточки, где кто-то чего-то ждёт, в архив НЕ уходит, сколько бы он ни молчал:
 *  - бот на паузе (человек взял диалог на себя);
 *  - клиент просил живого агента (`agentAttentionRequestedAt`);
 *  - заявка не доведена: стадия leadDraft «ждём номер» или «принимаем»;
 *  - обращение нового агента (CustomerInquiry), которое ведёт сотрудник или бот: не закрыто и режим не `HOLD`.
 *    Само по себе обращение есть у КАЖДОГО диалога (его заводит триггер базы) и по умолчанию стоит в `HOLD`, поэтому
 *    `HOLD` ничего не значит и в расчёт не берётся.
 *
 * ПОСЛЕДНЯЯ АКТИВНОСТЬ ЛЮБОЙ СТОРОНЫ. `lastMessageAt` двигают только ВХОДЯЩИЕ сообщения, поэтому чат, где последним
 * писал агент или бот, по нему выглядел бы молчащим. Берётся позднейшее из `lastMessageAt` (или `updatedAt`, если его
 * нет) и времени `at` последней реплики переписки (в том числе исходящей).
 *
 * Срок: ровно 30 суток по 24 часа. Разница двух моментов не зависит от часового пояса (Душанбе UTC+5 нужен
 * только там, где считаются календарные границы дня, а здесь их нет).
 */
export const CHAT_ARCHIVE_DAYS = 30;
const CHAT_ARCHIVE_MS = CHAT_ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

/** Ручные отметки (27.11.2026): ARCHIVED — убрали в архив, RESTORED — вернули. Хранятся в archiveMark/archiveMarkAt. */
export const CHAT_ARCHIVE_MARKED = "ARCHIVED";
export const CHAT_ARCHIVE_RESTORED = "RESTORED";
export type ChatArchiveMark = typeof CHAT_ARCHIVE_MARKED | typeof CHAT_ARCHIVE_RESTORED;

/** Граница: всё, что тише этого момента (строго раньше), без карточки уходит в архив. */
export function chatArchiveCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - CHAT_ARCHIVE_MS);
}

/** Признаки «кто-то ждёт», при которых чат без карточки не архивируется. */
export interface ChatArchiveWaiting {
  botPaused?: boolean;
  agentAttention?: boolean;
  /** Стадия заявки в leadDraft. */
  leadStage?: string | null;
  /** Обращение нового агента ведёт сотрудник или бот (не закрыто, режим не HOLD). */
  openInquiry?: boolean;
}

export function chatIsWaiting(w: ChatArchiveWaiting = {}): boolean {
  return !!w.botPaused || !!w.agentAttention || !!w.openInquiry || w.leadStage === "awaiting_phone" || w.leadStage === "accepting";
}

/** То же правило над одной строкой: проверка согласованности с SQL и тесты границы. Ровно 30 суток: ещё не архив. */
export function isChatArchived(
  row: { clientId: string | null | undefined; lastActivityAt: Date; lastMessageAt?: Date | null; archiveMark?: string | null; archiveMarkAt?: Date | null } & ChatArchiveWaiting,
  now: Date = new Date()
): boolean {
  // Ручная отметка главнее правила, но только пока нового входящего нет: новое сообщение само возвращает чат.
  if (row.archiveMark && row.archiveMarkAt && row.archiveMarkAt.getTime() >= (row.lastMessageAt ?? row.lastActivityAt).getTime()) {
    return row.archiveMark === CHAT_ARCHIVE_MARKED;
  }
  return !row.clientId && !chatIsWaiting(row) && row.lastActivityAt.getTime() < chatArchiveCutoff(now).getTime();
}

/**
 * Правило над колонками объединённой выборки списка (`s`): тот же смысл, что у `isChatArchived`. Тяжёлые проверки
 * стоят под CASE и считаются только для чатов без карточки старше границы, а не для всех трёх тысяч.
 * `pg_input_is_valid`: битая дата в реплике не должна ронять весь список.
 */
export function chatArchivedSql(input: { cutoff: Date; now: Date }): Prisma.Sql {
  const { cutoff, now } = input;
  // Дешёвое условие впереди: дорогие (дата последней реплики, проверки ожидания) считаются только для давних чатов без карточки.
  return Prisma.sql`(CASE
    WHEN s."archiveMark" IS NOT NULL AND s."archiveMarkAt" >= COALESCE(s."lastMessageAt", s."createdAt") THEN s."archiveMark" = ${CHAT_ARCHIVE_MARKED}
    ELSE CASE WHEN s."clientId" IS NULL AND COALESCE(s."lastMessageAt", s."updatedAt") < ${cutoff}
      AND COALESCE(CASE WHEN pg_input_is_valid(s."lastMessage"->>'at', 'timestamptz')
          THEN ((s."lastMessage"->>'at')::timestamptz AT TIME ZONE 'UTC') END, '-infinity'::timestamp) < ${cutoff}
    THEN NOT (
      (s."pausedUntil" IS NOT NULL AND s."pausedUntil" > ${now})
      OR s."agentAttentionRequestedAt" IS NOT NULL
      OR CASE left(s."sourceId", 3)
        WHEN 'tg_' THEN EXISTS (SELECT 1 FROM "TelegramConversation" t WHERE t.id = substr(s."sourceId", 4) AND t."leadDraft"->>'stage' IN ('awaiting_phone', 'accepting'))
          OR EXISTS (SELECT 1 FROM "CustomerInquiry" i WHERE i."telegramConversationId" = substr(s."sourceId", 4) AND i."closedAt" IS NULL AND i."ownerMode" <> 'HOLD')
        WHEN 'td_' THEN EXISTS (SELECT 1 FROM "TelegramDirectConversation" d WHERE d.id = substr(s."sourceId", 4) AND d."leadDraft"->>'stage' IN ('awaiting_phone', 'accepting'))
          OR EXISTS (SELECT 1 FROM "CustomerInquiry" i WHERE i."telegramDirectConversationId" = substr(s."sourceId", 4) AND i."closedAt" IS NULL AND i."ownerMode" <> 'HOLD')
        ELSE EXISTS (SELECT 1 FROM "BotConversation" b WHERE b.id = s."sourceId" AND b."leadDraft"->>'stage' IN ('awaiting_phone', 'accepting'))
          OR EXISTS (SELECT 1 FROM "CustomerInquiry" i WHERE i."conversationId" = s."sourceId" AND i."closedAt" IS NULL AND i."ownerMode" <> 'HOLD')
      END
    ) ELSE FALSE END END)`;
}
