import { prisma } from "../db.js";
import { isTelegramEnabled } from "../telegram/api.js";
import { describeError } from "./describeError.js";
import { migrateSettingsTelegramChat } from "./settingsTelegramChatMigration.js";
import { logSystemError } from "./systemError.js";
import { inspectTelegramChat, isBasicGroupChatId, telegramChatLabel } from "./telegramChatInspect.js";
import { parseTelegramChatIds } from "./telegramChats.js";

/**
 * СТОРОЖ ЧАТОВ TELEGRAM ИЗ НАСТРОЕК (20.11.2026, тот же класс, что #317 у групп помощницы).
 *
 * Идёт тем же почасовым проходом, что и сторож групп помощницы (sweepAssistantGroups зовёт его в конце), и тем же
 * осмотром (telegramChatInspect.ts). Ничего не пишет в чаты.
 *
 *  - Группа комментариев канала (telegramDiscussionGroupId). Переехала — адрес в Настройках заменяется дверью
 *    migrateSettingsTelegramChat. Бота в группе нет — одна запись в журнал в сутки: другой проверки у этой
 *    группы нет, а без бота комментарии клиентов под постами молча не принимаются.
 *  - Дополнительные чаты публикации (telegramExtraChatIds) и основной канал (telegramChannelId) — только переезд.
 *    «Бот не может писать» о них уже говорит суточная проверка интеграций (integrationHealth.ts); вторая запись
 *    о той же беде каждый час была бы шумом. Основной канал смотрим, только если там записана обычная группа.
 *  - sendChatAction (проба переезда) уходит ТОЛЬКО в обычную группу, где бота уже нет: каналы и супергруппы не
 *    переезжают, и слать им ничего не нужно. Личные чаты (положительный id) не осматриваются вовсе.
 *  - Сетевой сбой, таймаут, 429/5xx — строка в лог процесса, повтор в следующий обход.
 */
export interface SettingsChatSweepResult {
  checked: number;
  migrated: number;
  botAbsent: number;
  unknown: number;
}

type ChatRole = "discussion" | "extra" | "main";

const ABSENT_REMINDER_MS = 24 * 60 * 60 * 1000;

const isInspectable = (chatId: string): boolean => /^-\d+$/.test(chatId) || /^@[A-Za-z0-9_]{5,32}$/.test(chatId);

async function chatsToInspect(): Promise<Array<{ chatId: string; role: ChatRole }>> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { telegramDiscussionGroupId: true, telegramExtraChatIds: true, telegramChannelId: true },
  });
  const chats: Array<{ chatId: string; role: ChatRole }> = [];
  const seen = new Set<string>();
  const add = (chatId: string | null | undefined, role: ChatRole) => {
    const id = chatId?.trim();
    if (!id || seen.has(id.toLowerCase()) || !isInspectable(id)) return;
    seen.add(id.toLowerCase());
    chats.push({ chatId: id, role });
  };
  add(settings?.telegramDiscussionGroupId, "discussion");
  const main = settings?.telegramChannelId?.trim() || null;
  for (const id of parseTelegramChatIds(settings?.telegramExtraChatIds ?? null, main)) add(id, "extra");
  if (main && isBasicGroupChatId(main)) add(main, "main");
  return chats;
}

/** Один обход. Никогда не бросает и ничего не отправляет в чаты. */
export async function sweepSettingsTelegramChats(): Promise<SettingsChatSweepResult> {
  const result: SettingsChatSweepResult = { checked: 0, migrated: 0, botAbsent: 0, unknown: 0 };
  if (!isTelegramEnabled()) return result;
  try {
    for (const { chatId, role } of await chatsToInspect()) {
      result.checked++;
      try {
        const verdict = await inspectTelegramChat(chatId, { probeWhenLeft: isBasicGroupChatId(chatId) });
        if (verdict.kind === "migrated") {
          const outcome = await migrateSettingsTelegramChat(chatId, verdict.newChatId);
          result.migrated++;
          console.log(`[settings-telegram-chat] чат стал супергруппой, адрес в Настройках заменён (${outcome.kind === "done" ? outcome.moved.join(", ") || "уже заменён" : outcome.kind})`);
        } else if (verdict.kind === "absent") {
          result.botAbsent++;
          if (role !== "discussion") continue;
          await logSystemError(
            "telegram",
            `Бот не состоит в группе комментариев канала «${await telegramChatLabel(chatId)}»: комментарии клиентов под постами не принимаются — верните бота в группу администратором. Ответ Telegram: ${verdict.detail}`,
            { dedupKey: `settings-discussion-bot-absent:${chatId}`, dedupWindowMs: ABSENT_REMINDER_MS },
          );
        } else if (verdict.kind === "unknown") {
          result.unknown++;
          console.warn(`[settings-telegram-chat] проверка чата не удалась, повтор в следующий обход: ${verdict.detail}`);
        }
      } catch (err) {
        result.unknown++;
        await logSystemError("telegram", `Проверка чата Telegram из Настроек не удалась: ${describeError(err)}`, {
          dedupKey: `settings-telegram-chat-check-failed:${chatId}`,
        });
      }
    }
  } catch (err) {
    await logSystemError("telegram", `Обход чатов Telegram из Настроек не удался: ${describeError(err)}`, {
      dedupKey: "settings-telegram-chat-sweep-failed",
    });
  }
  return result;
}
