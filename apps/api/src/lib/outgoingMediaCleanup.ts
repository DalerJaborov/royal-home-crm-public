import { prisma } from "../db.js";
import { r2Delete } from "./r2Client.js";
import { logSystemError } from "./systemError.js";
import type { ConversationMessage } from "@royal-home/shared";

/**
 * Уборка ИСХОДЯЩИХ фото/видео (фото/видео, которые ОПЕРАТОР отправил клиенту, см.
 * lib/outgoingMedia.ts, deliverMediaToConversation в conversationDelivery.ts) —
 * 18.08.2026, по просьбе владельца.
 *
 * СРОК — 7 СУТОК. Это НЕ требование Meta (у неё своя копия сразу после доставки,
 * своим сроком мы не управляем) — это чисто наш лимит места в R2: владелец решил
 * не копить платное хранилище под файлы, которые агент уже отправил и которые
 * клиент, если нужно, попросит повторно. Семь дней — тот же порядок, что и
 * подстраховка по зависшим видео объектов (см. propertyVideoCleanup.ts), с запасом
 * на то, что руководитель откроет переписку и посмотрит присланное не в тот же день.
 *
 * ХРАНЕНИЕ БЕЗ ОТДЕЛЬНОЙ ТАБЛИЦЫ. Метаданные исходящего вложения (`kind`, `mime`,
 * `url`) и так лежат в `BotConversation.messages` (jsonb) — заводить под уборку
 * ещё одну Prisma-модель означало бы дублировать то, что уже есть, ради одного
 * джоба. Вместо этого при истечении срока в САМ объект вложения дописывается
 * `expiredAt` (см. @royal-home/shared::MessageAttachment) — UI (MessageAttachments.tsx)
 * по этому полю рисует понятную пометку вместо битой картинки, а routes/mediaProxy.ts
 * отвечает 410, если кто-то всё же дёрнет старую ссылку. Сама реплика и текст
 * остаются в истории НАВСЕГДА — стирается только файл в R2 и метка на вложении.
 *
 * Порядок ТОТ ЖЕ, что и в propertyVideoCleanup/videoUploadCleanup: сначала файл
 * из R2, и только потом отметка в базе — обратный порядок терял бы файл навсегда
 * при обрыве между шагами (запись «expired», а объект в R2 всё ещё платно лежит).
 */
const OUTGOING_MEDIA_TTL_DAYS = 7;
const MAX_CONVERSATIONS_PER_RUN = 200;

export interface OutgoingMediaCleanupResult {
  conversations: number;
  attachmentsExpired: number;
  failed: number;
}

/** Ключ вложения в R2 — единственное, что позволяет отличить исходящее фото/видео
 *  оператора от вложения клиента: только у наших есть стабильный путь через
 *  routes/mediaProxy.ts (см. deliverMediaToConversation). */
const CHAT_MEDIA_URL_RE = /^\/api\/v1\/media\/chat\/([^/]+)\/([a-zA-Z0-9-]+\.[a-z0-9]+)$/;

function r2KeyFromUrl(url: string): string | null {
  const m = CHAT_MEDIA_URL_RE.exec(url);
  if (!m) return null;
  return `chat-media/${decodeURIComponent(m[1])}/${m[2]}`;
}

/**
 * Проставляет `expiredAt` на вложениях с данными url ОДНИМ UPDATE по текущему jsonb
 * (тот же приём, что appendConversationMessages: без чтения-изменения-записи в коде,
 * иначе поздняя запись снимка затирает сообщения, пришедшие за время удаления из R2).
 * Порядок и длина массива не меняются, чужие вложения и уже убранные не трогаются.
 */
async function markAttachmentsExpired(conversationId: string, urls: string[]): Promise<void> {
  const expiredAt = new Date().toISOString();
  await prisma.$executeRaw`
    UPDATE "BotConversation"
    SET "messages" = (
      SELECT COALESCE(jsonb_agg(
        CASE WHEN jsonb_typeof(m.elem->'attachments') = 'array' THEN
          jsonb_set(m.elem, '{attachments}', (
            SELECT COALESCE(jsonb_agg(
              CASE WHEN a.att->>'url' = ANY(${urls}::text[]) AND a.att->>'expiredAt' IS NULL
                THEN a.att || jsonb_build_object('expiredAt', ${expiredAt}::text)
                ELSE a.att END
              ORDER BY a.ord), '[]'::jsonb)
            FROM jsonb_array_elements(m.elem->'attachments') WITH ORDINALITY AS a(att, ord)
          ))
        ELSE m.elem END
        ORDER BY m.ord), '[]'::jsonb)
      FROM jsonb_array_elements("messages") WITH ORDINALITY AS m(elem, ord)
    ),
    "updatedAt" = now()
    WHERE "id" = ${conversationId}
      AND jsonb_typeof("messages") = 'array'`;
}
export async function cleanupExpiredOutgoingMedia(): Promise<OutgoingMediaCleanupResult> {
  const result: OutgoingMediaCleanupResult = { conversations: 0, attachmentsExpired: 0, failed: 0 };
  const cutoff = new Date(Date.now() - OUTGOING_MEDIA_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Кандидаты — диалоги, где ПОСЛЕДНЕЕ сообщение старше порога: раз последняя
  // реплика старая, все предыдущие — тем более, и грузить содержимое можно только
  // тем, у кого шанс найти истёкшее вложение вообще есть. Диалоги моложе порога
  // пропускаем целиком — это дёшево (индекс по lastMessageAt) и избавляет от
  // разбора jsonb там, где заведомо нечего искать.
  const candidates = await prisma.botConversation.findMany({
    where: { lastMessageAt: { lte: cutoff } },
    select: { id: true, messages: true },
    take: MAX_CONVERSATIONS_PER_RUN,
  });

  for (const conv of candidates) {
    const messages = (Array.isArray(conv.messages) ? conv.messages : []) as unknown as ConversationMessage[];
    const expiredUrls: string[] = [];

    for (const message of messages) {
      if (!message.attachments || message.attachments.length === 0) continue;
      for (const attachment of message.attachments) {
        if (attachment.expiredAt) continue; // уже убрано раньше
        if (!attachment.url) continue; // вложение клиента — не наше, не трогаем
        const key = r2KeyFromUrl(attachment.url);
        if (!key) continue; // не chat-media/... — чужой формат url, пропускаем
        const at = message.at ? new Date(message.at) : null;
        if (!at || at.getTime() > cutoff.getTime()) continue; // реплика моложе TTL

        if (await r2Delete(key)) {
          expiredUrls.push(attachment.url);
          result.attachmentsExpired++;
        } else {
          result.failed++;
        }
      }
    }

    if (expiredUrls.length > 0) {
      result.conversations++;
      // Пока шёл r2Delete (сетевой вызов на каждый файл), клиент мог написать в этот
      // диалог: вебхук дописывает историю атомарным jsonb «||». Запись старого снимка
      // `messages` стёрла бы такое сообщение (CHANNEL-NEW-07), поэтому отметку
      // expiredAt ставит один UPDATE на стороне БД по СВЕЖЕЙ истории, а не мы по снимку.
      await markAttachmentsExpired(conv.id, expiredUrls);
    }
  }
  if (result.failed > 0) {
    void logSystemError(
      "storage",
      `Уборка исходящих фото/видео: ${result.failed} файлов не удалось удалить из R2 (см. лог выше по каждому)`
    );
  }

  return result;
}
