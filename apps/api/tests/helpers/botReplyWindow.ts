import { prisma } from "../../src/db.js";

/**
 * Окно склейки быстрых сообщений (Настройки → Бот, botReplyDelaySec /
 * botReplyMaxWaitSec) на время теста — нулевое.
 *
 * С 01.10.2026 (находка №132) ответ бота в Telegram, как и в каналах Meta, ждёт
 * это окно — по умолчанию 25 секунд, и тест, проверяющий сам ответ, а не
 * склейку, иначе ждал бы его на каждом сообщении. Тот же приём, что у тестов
 * переписки Meta (conversation-races, post-acceptance-no-repeat и др.).
 *
 * Возвращает функцию, которая вернёт прежние значения — звать в afterAll.
 */
export async function instantBotReplyWindow(): Promise<() => Promise<void>> {
  const before = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 0 },
  });
  return async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: before });
  };
}
