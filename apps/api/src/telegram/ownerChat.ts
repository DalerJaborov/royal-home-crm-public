import { prisma } from "../db.js";

/**
 * Служебный чат директора с клиентским ботом.
 *
 * Нужен ровно для одного: не дать квалификатору лидов принять владельца за
 * клиента. Директор пишет боту в личку — и без этой проверки бот начинал
 * выпытывать у него бюджет, район и номер телефона, заводя на владельца лид.
 *
 * Раньше жило в telegram/teamRequests.ts (задачи от сотрудников через Telegram
 * Business). Функция удалена, а защита осталась нужна клиентскому боту, поэтому
 * переехала сюда.
 *
 * Откуда берётся chat_id: поле Settings.telegramOwnerChatId заполнял бот в момент
 * подключения Telegram Business — этого обработчика больше нет, так что у новых
 * установок поле останется пустым, и единственный способ задать чат — переменная
 * TELEGRAM_DIRECTOR_CHAT_ID. У действующей установки значение в базе уже есть,
 * и оно продолжает работать.
 */
async function resolveOwnerChatId(): Promise<string | null> {
  const fromEnv = process.env.TELEGRAM_DIRECTOR_CHAT_ID;
  if (fromEnv) return fromEnv;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { telegramOwnerChatId: true },
  });
  return settings?.telegramOwnerChatId ?? null;
}

/** Это личный чат директора с ботом, а не диалог с клиентом? */
export async function isOwnerChat(chatId: string): Promise<boolean> {
  return (await resolveOwnerChatId()) === chatId;
}
