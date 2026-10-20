/**
 * КОМУ СУЖАТЬ ВЫДАЧУ ПЕРЕПИСКИ — одно место на все входы.
 *
 * Правило «агент видит только своих» жило внутри `routes/conversations.ts` и
 * относилось только к диалогам. Досье собеседника (`routes/contacts.ts`) —
 * это содержание той же переписки другими словами, но открывается по своему id
 * и своим маршрутом, и сужения там не было вовсе: агент с `messages.viewOwn`
 * перебором `GET /contacts/<uuid>` получал по ЛЮБОМУ человеку агентства имя,
 * категорию, факты (бюджет, район, цену чужого объекта), код карточки и
 * телефон — прямой обход того запрета, который заголовок того же файла
 * объявляет (находка 5.1 сплошной проверки 21.09.2026).
 *
 * Поэтому правило и его проверки переехали сюда целиком: два входа в одно и то
 * же содержание обязаны спрашивать одну функцию, иначе на первой же правке один
 * из них снова начнёт отдавать то, что другой прячет.
 */

import { can } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { resolveMergedInto } from "./contactProfiles.js";
import { TG_PREFIX } from "./conversationId.js";
import { ownBotConversationWhere, ownChatClientWhere, ownPropertyInterestConversationWhere } from "./ownBotConversationScope.js";
export { ownChatClientWhere } from "./ownBotConversationScope.js";

/**
 * Условия «клиент этого агента» — общие для диалога, для досье и для значка на
 * вкладке «Сообщения» (`routes/dashboard.ts`). Условие было выписано в каждом
 * месте своими руками, а расходилось бы оно тихо: значок считал бы одно, список
 * показывал другое.
 */

/**
 * Кому сузить выдачу до своих клиентов. null — видит всё (messages.view).
 *
 * НЕ переиспользует `scopeToOwnAgent` (найдено адверсариальной проверкой мержа
 * 07.09.2026) — та функция сужает по СОВСЕМ ДРУГОМУ праву, `clients.viewAll`.
 * До той правки chatScopeAgentId звал её как запасной путь, и сотрудник без
 * messages.view, но с clients.viewAll (пресет SECURITY, или агент, которому его
 * выдали отдельно) при выданном messages.viewOwn получал ВСЮ переписку
 * агентства — ровно то, что подпись права («Чаты своих клиентов») и его
 * подсказка прямо запрещают. Сужение по чатам обязано зависеть только от прав
 * на сами чаты, не от соседнего.
 */
export function chatScopeAgentId(req: Parameters<typeof can>[0]): string | null {
  if (can(req, "messages.view")) return null;
  if (can(req, "messages.viewOwn") && req.agent) return req.agent.id;
  return null;
}

/**
 * Диалог принадлежит клиенту этого агента?
 *
 * Условия те же, что у карточки клиента (routes/clients/card.ts): карточка не в
 * Корзине и лид ПРИНЯТ. До принятия переписка закрыта и там — иначе агент прочитает
 * разговор по лиду, который ещё не взял, и решит, брать или нет, по содержимому.
 * До заявки доступен только интерес по своему действующему объекту (14.10.2026).
 * Связь EXPOSURE и клиент другого агента такого доступа не дают.
 */
export async function conversationBelongsTo(rawId: string, agentId: string): Promise<boolean> {
  if (!rawId.startsWith(TG_PREFIX)) {
    return !!(await prisma.botConversation.findFirst({
      where: { id: rawId, ...ownBotConversationWhere(agentId) }, select: { id: true },
    }));
  }
  const clientPick = { select: { assignedAgentId: true, deletedAt: true, acceptedAt: true } } as const;
  const found = await prisma.telegramConversation.findUnique({
    where: { id: rawId.slice(TG_PREFIX.length) },
    select: { client: clientPick },
  });
  const client = found?.client;
  return !!client && client.assignedAgentId === agentId && !client.deletedAt && !!client.acceptedAt;
}

/**
 * Досье принадлежит клиенту этого агента?
 *
 * Условие то же, что у диалога, и по тем же причинам — но проверяется по ЧЕТЫРЁМ
 * дорогам, которыми досье связано с карточкой: сама карточка (`clientId`), диалог
 * бота, диалог Telegram, Telegram-директ и входящий звонок. Копии условия нет:
 * оно одно и то же (`ownChatClientWhere`), просто таблиц, ссылающихся на досье,
 * несколько. Досье, не связанное ни с одной принятой карточкой этого агента, для
 * него не существует: оно в общей очереди разбора, как и диалог без карточки.
 *
 * Надгробие слитого досье разрешается по ЖИВОЙ записи (`resolveMergedInto`):
 * панель и так показывает данные выжившего, и спрашивать права у надгробия
 * значило бы отдавать чужое содержание по старому id.
 */
export async function contactProfileBelongsTo(profileId: string, agentId: string): Promise<boolean> {
  const live = await resolveMergedInto(profileId);
  const ownClient = ownChatClientWhere(agentId);
  const profile = await prisma.contactProfile.findUnique({
    where: { id: live },
    select: { client: { select: { assignedAgentId: true, deletedAt: true, acceptedAt: true } } },
  });
  const own = profile?.client;
  if (own && own.assignedAgentId === agentId && !own.deletedAt && own.acceptedAt) return true;

  const [bot, tg, tgDirect, calls] = await Promise.all([
    prisma.botConversation.count({ where: {
      contactProfileId: live,
      OR: [{ client: ownClient }, ownPropertyInterestConversationWhere(agentId)],
    } }),
    prisma.telegramConversation.count({ where: { contactProfileId: live, client: ownClient } }),
    prisma.telegramDirectConversation.count({ where: { contactProfileId: live, client: ownClient } }),
    prisma.incomingCall.count({ where: { contactProfileId: live, client: ownClient } }),
  ]);
  return bot + tg + tgDirect + calls > 0;
}
