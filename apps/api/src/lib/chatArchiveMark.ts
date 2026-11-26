import { prisma } from "../db.js";
import { TG_PREFIX } from "./conversationId.js";
import { ownBotConversationWhere } from "./ownBotConversationScope.js";
import { CHAT_ARCHIVE_MARKED, CHAT_ARCHIVE_RESTORED, type ChatArchiveMark } from "./chatArchive.js";

/**
 * РУЧНОЙ АРХИВ ЧАТА (владелец 27.11.2026): «В архив» и «Вернуть» из строки списка.
 *
 * Хранится отметка на самой переписке (archiveMark + время archiveMarkAt) и действует, пока в диалоге нет нового
 * входящего: правило списка сравнивает archiveMarkAt с lastMessageAt (lib/chatArchive.ts). Новое сообщение клиента
 * двигает lastMessageAt вперёд, отметка «устаревает», и чат сам возвращается в основной список. Ничего не удаляется.
 * «Вернуть» ставит свою отметку RESTORED: она же не даёт правилу «30 дней тишины» убрать чат обратно.
 *
 * Идентификатор — как в списке чатов: `client:<uuid>` (все переписки карточки разом), `tg_…`, `td_…` или id диалога бота.
 * Агент (ownAgentId) трогает только переписки своих принятых клиентов, чужие для него не существуют (как везде в инбоксе).
 */
const CLIENT_PREFIX = "client:";
const DIRECT_PREFIX = "td_";

export async function setChatArchiveMark(input: { id: string; mark: ChatArchiveMark; ownAgentId: string | null; now?: Date }): Promise<number> {
  const { id, mark, ownAgentId } = input;
  const data = { archiveMark: mark, archiveMarkAt: input.now ?? new Date() };
  const ownClient = ownAgentId ? { is: { assignedAgentId: ownAgentId, deletedAt: null, acceptedAt: { not: null } } } : undefined;

  if (id.startsWith(CLIENT_PREFIX)) {
    const clientId = id.slice(CLIENT_PREFIX.length);
    if (ownAgentId) {
      const client = await prisma.client.findFirst({ where: { id: clientId, assignedAgentId: ownAgentId, deletedAt: null, acceptedAt: { not: null } }, select: { id: true } });
      if (!client) return 0;
    }
    const [bots, telegrams, directs] = await prisma.$transaction([
      prisma.botConversation.updateMany({ where: { clientId }, data }),
      prisma.telegramConversation.updateMany({ where: { clientId }, data }),
      prisma.telegramDirectConversation.updateMany({ where: { clientId }, data }),
    ]);
    return bots.count + telegrams.count + directs.count;
  }
  if (id.startsWith(TG_PREFIX)) {
    return (await prisma.telegramConversation.updateMany({ where: { id: id.slice(TG_PREFIX.length), ...(ownClient ? { client: ownClient } : {}) }, data })).count;
  }
  if (id.startsWith(DIRECT_PREFIX)) {
    return (await prisma.telegramDirectConversation.updateMany({ where: { id: id.slice(DIRECT_PREFIX.length), ...(ownClient ? { client: ownClient } : {}) }, data })).count;
  }
  return (await prisma.botConversation.updateMany({ where: { id, ...(ownAgentId ? ownBotConversationWhere(ownAgentId) : {}) }, data })).count;
}

export { CHAT_ARCHIVE_MARKED, CHAT_ARCHIVE_RESTORED };
