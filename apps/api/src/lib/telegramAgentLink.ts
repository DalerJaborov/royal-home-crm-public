/**
 * ПРИВЯЗКА ЛИЧНОГО TELEGRAM АГЕНТА К CRM (01.09.2026, владелец: «монтажёр пусть
 * просто отвечает боту»).
 *
 * До этого дня агент не мог получать личные сообщения от CRM-бота — бот умел
 * только вести переписку с КЛИЕНТАМИ (telegram/bot.ts::handleClientMessages).
 * Первое применение — ручная передача видео монтажёру (lib/videoHandoff.ts), но
 * само поле Agent.telegramChatId общее, не привязано к одной функции.
 *
 * Самообслуживание, без участия разработчика: агент жмёт кнопку в своём профиле
 * → получает одноразовый код и прямую ссылку t.me/<бот>?start=<код> → открывает
 * ссылку (или пишет код боту вручную) → бот сам находит агента по коду и
 * запоминает chat_id. Код одноразовый: после успешной привязки обнуляется, им
 * нельзя воспользоваться дважды и нельзя перехватить, отправив тот же код позже.
 */
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { getBotUsername, sendMessage } from "../telegram/api.js";

const LINK_CODE_BYTES = 12;

/** Заводит новый код привязки для агента (или перезаписывает старый, если
 *  агент нажал кнопку второй раз, не завершив привязку первым кодом). */
export async function createTelegramLinkCode(agentId: string): Promise<{ code: string; deepLink: string | null }> {
  const code = crypto.randomBytes(LINK_CODE_BYTES).toString("base64url");
  await prisma.agent.update({ where: { id: agentId }, data: { telegramLinkCode: code } });
  const username = await getBotUsername();
  return { code, deepLink: username ? `https://t.me/${username}?start=${code}` : null };
}

/**
 * Обрабатывает `/start <код>` от личного чата в Telegram. true — код подошёл,
 * привязка состоялась (или уже была активна этим же чатом — повторный /start
 * тем же человеком не должен пугать ошибкой). false — код неизвестен/истёк:
 * вызывающий код (telegram/bot.ts) сам решает, что ответить (скорее всего это
 * клиент, впервые пишущий боту, а не монтажёр).
 */
export async function tryLinkAgentByCode(chatId: string, code: string): Promise<boolean> {
  // Только действующая учётка (G16, 02.10.2026): код, выданный до увольнения,
  // не должен привязывать чат к отключённой учётке.
  const agent = await prisma.agent.findFirst({
    where: { telegramLinkCode: code, isActive: true },
    select: { id: true, fullName: true },
  });
  if (!agent) return false;
  // Чат принадлежит тому, кто прислал код, и он выбирает, к какой учётке его
  // привязать. Прежняя привязка этого чата (обычно — учётка до увольнения и
  // нового найма) снимается: telegramChatId уникален, и без этого привязка
  // падала исключением, а бот молчал (G16, 02.10.2026).
  //
  // КОД «СЪЕДАЕТСЯ» УСЛОВНЫМ АПДЕЙТОМ ВНУТРИ ТРАНЗАКЦИИ (аудит Codex 04.10.2026,
  // ACCESS-10). Раньше запись шла по одному id без условия на сам код: два чата с
  // ещё действующим кодом проходили поиск выше оба, оба получали true, а второй
  // молча перепривязывал учётку и снимал первого. Теперь победитель один: тот, чей
  // updateMany ещё застал этот код (и действующую учётку); остальные получают
  // count=0 и false. Код, сброшенный или заменённый после поиска, тоже не сработает.
  const linked = await prisma.$transaction(async (tx) => {
    const claim = await tx.agent.updateMany({
      where: { id: agent.id, telegramLinkCode: code, isActive: true },
      data: { telegramLinkCode: null },
    });
    if (claim.count === 0) return false;
    await tx.agent.updateMany({
      where: { telegramChatId: chatId, id: { not: agent.id } },
      data: { telegramChatId: null },
    });
    await tx.agent.update({ where: { id: agent.id }, data: { telegramChatId: chatId } });
    return true;
  });
  if (!linked) return false;
  await sendMessage(chatId, `Готово, ${agent.fullName} — этот чат привязан к вашему аккаунту Royal Home CRM.`).catch(
    () => {}
  );
  return true;
}

/** Чат уже привязан к какому-то агенту? Основной способ отличить сообщение
 *  СОТРУДНИКА от сообщения клиента в общем потоке апдейтов бота.
 *
 * `isActive: true` (25.09.2026, А5) — уволенный/деактивированный сотрудник не
 * должен продолжать отвечать ботом как действующий агент (в частности как
 * монтажёр: settings.ts запрещает НАЗНАЧИТЬ неактивного, но чат мог остаться
 * привязан у того, кто был активен на момент привязки и разжалован позже). */
export async function findAgentByTelegramChatId(
  chatId: string
): Promise<{ id: string; fullName: string } | null> {
  return prisma.agent.findFirst({ where: { telegramChatId: chatId, isActive: true }, select: { id: true, fullName: true } });
}
