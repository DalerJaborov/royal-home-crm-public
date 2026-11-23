import { prisma } from "../db.js";
import { logSystemAudit } from "./audit.js";

/**
 * ОДНА ДВЕРЬ ПЕРЕЕЗДА ЧАТА TELEGRAM В НАСТРОЙКАХ (20.11.2026, тот же класс, что #317 у групп помощницы).
 *
 * Telegram при превращении обычной группы в супергруппу выдаёт ей НОВЫЙ chat id, а старый перестаёт работать.
 * В Настройках chat id лежит в трёх полях, и каждое молча ломается:
 *  - telegramDiscussionGroupId — группа комментариев канала: комментарии клиентов под постами перестают
 *    приниматься (bot.ts сравнивает chat.id с этим полем), и никто об этом не узнаёт;
 *  - telegramExtraChatIds — дополнительные чаты публикации роликов (список через запятую/пробел/строку);
 *  - telegramChannelId — основной канал (канал не переезжает, но владелец мог вписать туда обычную группу).
 * Сюда сходятся живое служебное сообщение (telegram/bot.ts), почасовой сторож (settingsTelegramChatWatchdog.ts),
 * суточная проверка (integrationHealth.ts) и отказ при ответе на комментарий (telegramGroupComments.ts).
 *
 * Каждое поле обновляется УЗКО и только если в нём всё ещё старое значение (сравнение-и-замена одним UPDATE).
 * Экран Настроек сохраняет поля по одному, поэтому перенос не затирает чужую правку соседнего поля, а правку
 * этого же поля, сделанную человеком между чтением и записью, не перезаписывает: UPDATE увидит другое значение
 * и ничего не сделает. Повтор события и два процесса сразу безвредны — второй не найдёт старого id.
 * В чат ничего не пишет.
 */
export type SettingsChatField = "telegramDiscussionGroupId" | "telegramExtraChatIds" | "telegramChannelId";

export type SettingsChatMigrationOutcome =
  /** Пара id не похожа на переезд обычной группы в супергруппу: ничего не трогаем. */
  | { kind: "invalid" }
  /** Поля, в которых старый id заменён на новый (пустой список — старого id в Настройках нет). */
  | { kind: "done"; moved: SettingsChatField[] };

const MAX_ATTEMPTS = 3;

/** Замена одного адреса внутри списка «через запятую, пробел или строку» с сохранением разделителей. */
export function replaceChatIdInList(raw: string, oldChatId: string, newChatId: string): string | null {
  let changed = false;
  const next = raw
    .split(/([\s,]+)/)
    .map((part) => {
      if (part !== oldChatId) return part;
      changed = true;
      return newChatId;
    })
    .join("");
  return changed ? next : null;
}

type FieldRewrite = (raw: string) => string | null;

async function readField(field: SettingsChatField): Promise<string | null> {
  const row = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { telegramDiscussionGroupId: true, telegramExtraChatIds: true, telegramChannelId: true },
  });
  return row?.[field] ?? null;
}

/** UPDATE … WHERE поле = прочитанное значение. Отдельной строкой на поле, чтобы Prisma проверяла имена полей. */
async function compareAndSet(field: SettingsChatField, expected: string, next: string): Promise<boolean> {
  const where = { id: "singleton" };
  const result =
    field === "telegramDiscussionGroupId"
      ? await prisma.settings.updateMany({ where: { ...where, telegramDiscussionGroupId: expected }, data: { telegramDiscussionGroupId: next } })
      : field === "telegramExtraChatIds"
        ? await prisma.settings.updateMany({ where: { ...where, telegramExtraChatIds: expected }, data: { telegramExtraChatIds: next } })
        : await prisma.settings.updateMany({ where: { ...where, telegramChannelId: expected }, data: { telegramChannelId: next } });
  return result.count > 0;
}

async function moveField(field: SettingsChatField, rewrite: FieldRewrite): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await readField(field);
    if (!raw) return false;
    const next = rewrite(raw);
    if (next === null || next === raw) return false;
    if (await compareAndSet(field, raw, next)) return true;
    // Между чтением и записью поле поменяли (человек с экрана или второй процесс) — читаем заново:
    // если старого id там уже нет, следующий круг честно вернёт false.
  }
  return false;
}

const singleId = (oldChatId: string, newChatId: string): FieldRewrite => (raw) => (raw.trim() === oldChatId ? newChatId : null);

export async function migrateSettingsTelegramChat(oldChatId: string, newChatId: string): Promise<SettingsChatMigrationOutcome> {
  if (!/^-\d+$/.test(oldChatId) || !/^-100\d+$/.test(newChatId) || oldChatId === newChatId) return { kind: "invalid" };
  const moved: SettingsChatField[] = [];
  if (await moveField("telegramDiscussionGroupId", singleId(oldChatId, newChatId))) moved.push("telegramDiscussionGroupId");
  if (await moveField("telegramExtraChatIds", (raw) => replaceChatIdInList(raw, oldChatId, newChatId))) moved.push("telegramExtraChatIds");
  if (await moveField("telegramChannelId", singleId(oldChatId, newChatId))) moved.push("telegramChannelId");
  if (moved.length > 0) {
    // След для разбора «кто поменял адрес в Настройках»: сама система, после переезда группы.
    logSystemAudit("SETTINGS_TELEGRAM_CHAT_MIGRATED", "Settings", "singleton", { fields: moved, oldChatId, newChatId });
  }
  return { kind: "done", moved };
}
