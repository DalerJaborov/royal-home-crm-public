import { prisma } from "../db.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";
import { translateToRussian } from "../ai/translateTranscript.js";

/**
 * Перевод ОДНОЙ реплики клиента в переписке (Instagram/WhatsApp/сайт — таблица
 * BotConversation) — по клику сотрудника, тот же приём, что и у звонков
 * (routes/interactions.ts POST /:id/translate, ai/translateTranscript.ts).
 *
 * ГЕЙТ — `detectClientLanguage`, А НЕ `looksTajik` (13.09.2026). `looksTajik`
 * писался для многословной расшифровки звонка и на короткой реплике переписки
 * («хуб», «ок», «5») ошибается заметно чаще: не отличает смесь языков, путает
 * английские «hello» с таджикской латиницей, не режет совсем короткие реплики.
 * `detectClientLanguage` уже прошёл боевую проверку именно на переписке (см.
 * ai/clientLanguage.ts — история находок 01.08/16.08/17.08.2026) — используем его
 * как решатель «надо ли», а саму модель зовём через ту же `translateToRussian`,
 * что и звонки: два вызова модели ради одной и той же задачи были бы дублем.
 *
 * ПОЧЕМУ НЕ АВТОМАТИЧЕСКИ ПРИ ПОЛУЧЕНИИ СООБЩЕНИЯ. Перевод звонков раньше делался
 * заранее для каждого таджикского разговора, и 19.08.2026 от этого отказались —
 * «переводился каждый, читали не все», лишний расход на молчащий выключатель. У
 * переписки сообщений на порядок больше, чем звонков, — автоматический перевод
 * каждой реплики был бы той же самой ошибкой, только дороже.
 */
export async function translateChatMessage(
  conversationId: string,
  /** `at` реплики (ISO-штамп, проставляется один раз в appendMessages.ts) — по
   *  нему находим ИМЕННО эту реплику в jsonb-массиве, не по позиции: массив мог
   *  сдвинуться (MAX_STORED_MESSAGES обрезает хвост) между чтением списка на
   *  экране и кликом «Показать перевод». */
  at: string,
  content: string
): Promise<string | null> {
  const language = detectClientLanguage(content);
  if (language !== "tg" && language !== "mixed") return null;

  const translated = await translateToRussian(content, "chat-message-translate");
  if (!translated) return null;

  /**
   * Тот же приём точечного обновления элемента jsonb-массива, что и
   * markMessageDeliveryStatus (messengers/conversation.ts): ищем позицию через
   * `jsonb_array_elements WITH ORDINALITY`, а не читаем-меняем-пишем весь массив
   * в Node — конкурентный append (новое сообщение подоспело, пока считался
   * перевод) не должен затереться устаревшим снимком. `role='user'` в условии —
   * переводим только реплики клиента, а не свои же/бота с тем же `at` случайно.
   */
  await prisma.$executeRaw`
    WITH idx AS (
      SELECT (t.ord - 1) AS pos
      FROM "BotConversation" c, jsonb_array_elements(c."messages") WITH ORDINALITY AS t(elem, ord)
      WHERE c."id" = ${conversationId}
        AND t.elem->>'role' = 'user'
        AND t.elem->>'at' = ${at}
      ORDER BY t.ord DESC
      LIMIT 1
    )
    UPDATE "BotConversation" b
    SET "messages" = jsonb_set(b."messages", ARRAY[idx.pos::text, 'translatedRu'], to_jsonb(${translated}::text))
    FROM idx
    WHERE b."id" = ${conversationId}`;

  return translated;
}
