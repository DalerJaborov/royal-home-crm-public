import { prisma } from "../db.js";
import { scrubMentionedPhones, type ScrubbedTranscript } from "./telephony/callPhoneMasking.js";

/**
 * То же самое, что lib/telephony/callPhoneMasking.ts::scrubMentionedPhones даёт
 * ЗВОНКАМ — только для ТЕКСТОВОЙ переписки (WhatsApp/Instagram/Telegram/сайт),
 * требование владельца 04.09.2026 (расширение вчерашнего решения по звонкам на чат).
 *
 * Ядро (regex-разбор номеров, сама маскировка строки, шифрование) НЕ дублируется —
 * целиком переиспользуется scrubMentionedPhones. Эта обёртка добавляет ровно то,
 * чего у звонка не было: клиент чата чаще всего ЕЩЁ НЕ карточка (диалог мог не
 * дойти до приёма заявки), и это меняет то, что считать «безопасным по умолчанию».
 *
 * ПОЧЕМУ ЗДЕСЬ ДРУГОЕ НАПРАВЛЕНИЕ ОШИБКИ, ЧЕМ У ЗВОНКОВ. lib/telephony/
 * callRecordings.ts, не найдя карточку клиента (Interaction почти всегда уже
 * привязан к существующему Client — звонить некому, если карточки нет), считает
 * список известных номеров ПУСТЫМ и поэтому маскирует любой найденный номер —
 * безопасное направление ошибки для аномалии (карточку удалили посреди разбора).
 * В чате отсутствие clientId — НЕ аномалия, а нормальное большинство диалогов на
 * старте: бот только знакомится, лид ещё не принят, Client не создан. Первый же
 * номер, который называет человек, здесь обычно и есть его ОСНОВНОЙ контакт —
 * тот самый, что синхронно вытаскивает лид-квалификатор (ai/leadQualifier.ts,
 * extractTypedPhone/extractVolunteeredPhone) и кладёт в leadDraft, а затем в
 * Client.phone. Маскировать его в истории было бы не «перебдеть», а прятать
 * ровно то, ради чего заведён весь диалог, и путать агента, открывшего карточку
 * впервые. Поэтому здесь: нет clientId — не маскируем вовсе. Как только диалог
 * стал карточкой (Client создан, номера известны), ЛЮБОЙ следующий номер, не
 * совпавший с уже известными, маскируется — точно так же, как в звонке.
 */
export async function scrubMentionedClientPhonesInText(
  text: string,
  clientId: string | null
): Promise<ScrubbedTranscript> {
  if (!clientId || !text) return { text, mentionedPhonesEncrypted: [] };
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { phone: true, whatsappPhone: true, extraPhones: true },
  });
  // Карточка не найдена (удалена параллельно, гонка) — здесь, В ОТЛИЧИЕ от звонка,
  // клиента маскировать нечем: нет ни текста для сравнения c "уже известным", ни
  // смысла прятать номер в диалоге, который в этот самый момент теряет владельца.
  if (!client) return { text, mentionedPhonesEncrypted: [] };
  return scrubMentionedPhones(text, client);
}
