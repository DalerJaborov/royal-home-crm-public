import { prisma } from "../db.js";

/**
 * ОДНА ДВЕРЬ ПЕРЕЕЗДА ГРУППЫ ПОМОЩНИЦЫ В СУПЕРГРУППУ (20.11.2026).
 *
 * Telegram при превращении обычной группы в супергруппу выдаёт ей НОВЫЙ chat id, а старый перестаёт
 * работать (sendChatAction → «group chat was upgraded to a supergroup chat», getChatMember → бот `left`).
 * Регистрация AssistantTelegramGroup стоит на старом id: Шабнам в рабочей группе молча оглохла, а в
 * CRM об этом не знал никто. Сюда сходятся оба пути: живое служебное сообщение (assistantBot.ts) и
 * ночной/почасовой сторож (assistantGroupWatchdog.ts), если событие уже пропущено.
 *
 * Перенос — это UPDATE первичного ключа, а не «создать новую, удалить старую»: createdAt служит в коде
 * «личностью» регистрации (устаревшие кнопки, окна диалога, страницы объектов сверяют его), а
 * registeredByAgentId, тишина, отметки приветствий и согласие на чтение контекста — настройки людей,
 * которые нельзя терять. Дочерние AssistantTelegramContext перевешивает сама база: внешний ключ
 * ON UPDATE CASCADE (миграция 20261104151000_assistant_telegram_context).
 */
export type AssistantGroupMigrationOutcome =
  /** Регистрация старого id переехала на новый. */
  | "moved"
  /** Новый id уже зарегистрирован (кто-то включил помощницу заново): новая не тронута, старая убрана. */
  | "merged"
  /** Старого id нет (событие пришло дважды или другой процесс уже перенёс): делать нечего. */
  | "absent"
  /** Пара id не похожа на переезд обычной группы в супергруппу: ничего не трогаем. */
  | "invalid";

const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set(["P2002", "P2034"]);

function isRetryable(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && RETRYABLE.has(String((err as { code: unknown }).code));
}

export async function migrateAssistantGroupChat(oldChatId: string, newChatId: string): Promise<AssistantGroupMigrationOutcome> {
  if (!oldChatId || !newChatId || oldChatId === newChatId || !newChatId.startsWith("-100")) return "invalid";
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const target = await tx.assistantTelegramGroup.findUnique({ where: { chatId: newChatId }, select: { chatId: true } });
        if (target) {
          const removed = await tx.assistantTelegramGroup.deleteMany({ where: { chatId: oldChatId } });
          return removed.count ? "merged" as const : "absent" as const;
        }
        const moved = await tx.assistantTelegramGroup.updateMany({ where: { chatId: oldChatId }, data: { chatId: newChatId } });
        return moved.count ? "moved" as const : "absent" as const;
      });
    } catch (err) {
      // Две доставки события (в старую и в новую группу) идут разными очередями и могут столкнуться:
      // уникальный ключ нового id (P2002) или сериализация (P2034). Повтор видит уже готовое состояние.
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
    }
  }
}
