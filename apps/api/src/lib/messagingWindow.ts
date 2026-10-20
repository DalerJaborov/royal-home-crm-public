import { prisma } from "../db.js";

/**
 * ЗАКРЫТОЕ ОКНО ПЕРЕПИСКИ У META — ОДНО ОПРЕДЕЛЕНИЕ НА ПРОЕКТ.
 *
 * WhatsApp и Instagram запрещают писать человеку свободный текст, если он не писал
 * нам последние 24 часа. Для CRM это не поломка, а штатное правило платформы, и
 * агент обязан увидеть именно его («дождитесь сообщения или позвоните»), а не общее
 * «не удалось отправить» — см. lib/conversationDelivery.ts, ветка window_closed.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ messengers/meta.ts (07.09.2026). Функция чистая, но
 * жила внутри meta.ts — модуля, который при импорте поднимает весь транспорт Meta
 * (учётные данные, аккаунты, сеть). Поэтому тест доставки её не импортировал, а
 * ДЕРЖАЛ У СЕБЯ КОПИЮ с пометкой «синхронизировать вручную»: настоящая функция не
 * проверялась ничем, а копия всегда возвращала бы «да» независимо от того, что
 * творится в оригинале. Тот же капкан, что уже стоил времени 07.09.2026 в тесте
 * ai-reply-retry (весь граф messengers ради одной функции). Здесь импорт дешёвый,
 * и копия больше не нужна.
 *
 * ОПОЗНАЁМ ПО ТЕКСТУ ОШИБКИ, А НЕ ПО КОДУ, НАМЕРЕННО: у платформ он разный и
 * меняется. Живые ответы Graph API с прода:
 *
 *   Instagram — HTTP 403, code 10, error_subcode 2534022:
 *     {"error":{"message":"This message is sent outside of allowed window.",
 *      "type":"IGApiException","code":10,"error_subcode":2534022,...}}
 *   WhatsApp — код 131047 («Re-engagement message»).
 *   Messenger — «(#470) This message is sent outside of allowed window» (добавлено
 *     12.09.2026: канал FACEBOOK формально обслуживался тем же кодом, но его
 *     формулировка в детекторе подобрана не была, и агент видел общее
 *     «не удалось отправить» вместо подсказки).
 *
 * ЧТО СЮДА НАМЕРЕННО НЕ ВХОДИТ, хотя выглядит похоже:
 *   131026 «Message undeliverable» — у WhatsApp это чаще «у номера нет WhatsApp»
 *     или отключённый приём, а не закрытое окно. Подсказка «дождитесь сообщения
 *     клиента» была бы прямо вредной: ждать нечего, нужен другой канал.
 *   (#551) «This person isn't available right now» — недоступность собеседника
 *     (блокировка, ограничение), тоже не окно.
 *   Обе формы должны доходить до агента как обычная ошибка отправки.
 *
 * Обе формы закреплены тестом tests/messaging-window-detector.test.ts дословно:
 * поменяется формулировка у Meta — упадёт тест, а не молча отвалится подсказка агенту.
 */
export function isMessagingWindowClosedError(message: string): boolean {
  // Meta отдаёт текст ошибки на языке владельца маркера, и в теле ответа он
  // приходит экранированным \uXXXX (прод 28.09.2026, Facebook: «(#10) Это
  // сообщение отправлено вне разрешенного окна»). Английских слов там нет, а
  // error_subcode срезан обрезкой тела до 300 символов, — поэтому сперва
  // раскрываем экранирование и узнаём ещё и русскую формулировку.
  const lower = message
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .toLowerCase();
  if (lower.includes("2534022")) return true;
  if (/вне\s+разреш[её]нного\s+окна/u.test(lower)) return true;
  if (lower.includes("131047")) return true;
  if (lower.includes("24 hour") && (lower.includes("pass") || lower.includes("window"))) return true;
  if (lower.includes("outside") && lower.includes("window")) return true;
  if (lower.includes("#470")) return true;
  if (lower.includes("re-engage") || lower.includes("reengagement") || lower.includes("re engagement")) return true;
  return false;
}

/** Сутки Meta: столько после сообщения клиента ему можно писать свободным текстом. */
export const META_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Открыто ли окно ДО отправки (28.09.2026) — чтобы агент видел «не дойдёт» на
 * кнопке, а не в отказе после. Правило только у каналов Meta; Telegram и чат
 * на сайте окна не знают. Клиент не писал вовсе — окно закрыто: так бывает у
 * диалога, заведённого первым сообщением из CRM.
 */
export function isMessagingWindowOpen(channel: string, lastClientMessageAt: Date | null, now = Date.now()): boolean {
  if (channel !== "WHATSAPP" && channel !== "INSTAGRAM" && channel !== "FACEBOOK") return true;
  if (!lastClientMessageAt) return false;
  return now - lastClientMessageAt.getTime() < META_MESSAGING_WINDOW_MS;
}

/**
 * ТО ЖЕ ОГРАНИЧЕНИЕ, СЧИТАННОЕ ЗАРАНЕЕ ИЗ БАЗЫ, А НЕ ИЗ ТЕКСТА ОШИБКИ.
 *
 * `isMessagingWindowClosedError` выше узнаёт закрытое окно ПОСТФАКТУМ — по ответу
 * Graph API на уже отправленное сообщение. Кронам (dealStalePipeline.ts и любому,
 * кто заранее формулирует агенту «напишите клиенту») нужен ответ ДО отправки: у
 * фронта такая же проактивная проверка на уже загруженной переписке (см.
 * apps/web/src/lib/messagingWindow.ts) — здесь то же самое, но по clientId, без
 * открытого диалога на экране.
 *
 * Единственные каналы с 24-часовым лимитом — WhatsApp/Instagram/Facebook (см.
 * doc-блок выше с живыми ответами Graph API). Telegram — отдельные модели
 * (TelegramConversation/TelegramDirectConversation), лимита у него нет: бот,
 * однажды получивший сообщение, пишет туда когда угодно, поэтому наличие ЛЮБОГО
 * телеграм-диалога у клиента уже само по себе делает «написать» возможным.
 */
const WINDOW_MS = META_MESSAGING_WINDOW_MS;
const WINDOWED_CHANNELS = ["WHATSAPP", "INSTAGRAM", "FACEBOOK"] as const;

export async function hasOpenMessagingChannel(clientId: string, now: Date = new Date()): Promise<boolean> {
  const [metaConversations, telegram, telegramDirect] = await Promise.all([
    prisma.botConversation.findMany({
      where: { clientId, channel: { in: [...WINDOWED_CHANNELS] } },
      select: { lastMessageAt: true },
    }),
    prisma.telegramConversation.findUnique({ where: { clientId }, select: { id: true } }),
    prisma.telegramDirectConversation.findFirst({ where: { clientId }, select: { id: true } }),
  ]);
  if (telegram || telegramDirect) return true;
  return metaConversations.some((c) => c.lastMessageAt && now.getTime() - c.lastMessageAt.getTime() < WINDOW_MS);
}
